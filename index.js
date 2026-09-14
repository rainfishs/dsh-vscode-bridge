/**
 * dsh-vscode-bridge — write the Web GUI's authenticated login URL to a file
 * while this process serves it, so a launcher, supervisor, or script can pick
 * the URL up instead of scraping stdout.
 *
 * This is the plugin module of a profile bundle (`cordis.patch.yml` beside it
 * inserts the row). The destination comes from the row's `config.path` when it
 * names one, and otherwise defaults to `web-url.txt` inside the Web profile
 * directory — the shipped Web app's own commander program rejects any option it
 * does not declare, so an out-of-tree bundle cannot add a startup flag instead.
 *
 * The same row owns the rest of the VS Code panel case. It widens the browser
 * session cookie, without which the panel cannot keep a session at all, and it
 * owns where a clicked file opens: its browser half (`lib/client.js`, the
 * package's `dsh.client` bundle) diverts file opens from the right Sidebar's
 * document preview to VS Code when the row's `config.openFileIn` asks for it,
 * through the routes this half registers below.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, win32 } from 'node:path'

/** Stable Cordis plugin name; the patch row and every log line use it. */
export const name = 'dsh-vscode-bridge'

/**
 * `webServer` owns the bound port and `connection` mints the token-bearing login
 * URL. Declaring both is what makes the write correct rather than merely early:
 * a row activates only after its injections resolve, and `WebServer` completes
 * `[Service.init]` by listening, so `port` already reports the port actually in
 * use (the OS-assigned one when the composition asked for `0`).
 */
export const inject = ['webServer', 'connection']

/** The redirect target's host: the GUI is served on loopback. */
const LOOPBACK = '127.0.0.1'

/** File name the row writes when it names no `path` of its own. */
const DEFAULT_FILE_NAME = 'web-url.txt'

/**
 * The Web profile directory, `$DSH_HOME/profiles/web`. `@deepseek-ai/dsh-home-paths`
 * resolves the home for the workspace, but this bundle is installed outside it and
 * has to stand alone, so the two rules that matter are restated here: an explicit
 * `DSH_HOME` wins, and `~/.dsh` is the fallback.
 * @param env - environment to read; a parameter so the fallback is testable.
 * @returns the profile directory.
 */
function profileDirectory(env) {
  const configured = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : undefined
  return join(configured ?? join(homedir(), '.dsh'), 'profiles', 'web')
}

/**
 * The destination this row's config names. A plugin that declares no schema
 * receives whatever YAML held, so the value is validated here.
 * @param config - the row's `config`.
 * @param env - environment read for the default; defaults to `process.env`.
 * @returns the configured path, else `web-url.txt` beside the Web profile —
 * never `undefined`, so a row that configures nothing still writes.
 */
export function configuredPath(config, env = process.env) {
  const value = config?.path
  return typeof value === 'string' && value.trim() !== '' ? value : join(profileDirectory(env), DEFAULT_FILE_NAME)
}

/**
 * The browser session the Web app mints carries `SameSite=Strict`, and a VS Code
 * webview is a different site (`vscode-webview://`): the panel therefore never
 * sends that cookie, and every `/api` call inside it answers 401 long before any
 * of the app's own request checks run. Widening just that attribute to
 * `SameSite=None; Secure` is what lets the panel keep the session; loopback is a
 * trustworthy origin in Chromium, so `Secure` is honoured over plain HTTP.
 *
 * Connection writes the cookie inside its index authentication, whose only
 * outward seam is that method, so the widening is a runtime patch of the service
 * instance: `frontend-static` reads `ctx.connection.authorizeIndex` per request,
 * and unloading this row restores the prototype method. Instances are tracked in
 * a module-level WeakSet so a live config reload re-patches once, not twice.
 */
const PATCHED_CONNECTIONS = new WeakSet()

/** Widen one Set-Cookie value, preserving the array shape node accepts. */
function widenSetCookie(value) {
  if (typeof value === 'string') return value.replaceAll('SameSite=Strict', 'SameSite=None; Secure')
  if (Array.isArray(value)) return value.map((entry) => widenSetCookie(entry))
  return value
}

/** Rewrite a `writeHead` headers object in place; other arguments pass through. */
function widenHeaders(argument) {
  if (typeof argument !== 'object' || argument === null) return
  for (const key of Object.keys(argument)) {
    if (key.toLowerCase() !== 'set-cookie') continue
    argument[key] = widenSetCookie(argument[key])
  }
}

/**
 * A proxy that widens Set-Cookie on the way out and binds every other member to
 * the real response, so the handler's own `res.end()` still reaches node.
 * @param res - the response Connection is about to write.
 * @returns the response the handler should use instead.
 */
function wideningResponse(res) {
  return new Proxy(res, {
    get(target, property) {
      if (property === 'writeHead') {
        return (...args) => {
          for (const argument of args) widenHeaders(argument)
          return target.writeHead(...args)
        }
      }
      if (property === 'setHeader') {
        return (name, value) => target.setHeader(
          name,
          String(name).toLowerCase() === 'set-cookie' ? widenSetCookie(value) : value,
        )
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Widen the browser session cookie for the lifetime of this row.
 * @param ctx - plugin context carrying the injected `connection` service.
 */
function widenBrowserCookie(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined || PATCHED_CONNECTIONS.has(connection)) return
  PATCHED_CONNECTIONS.add(connection)
  const original = connection.authorizeIndex.bind(connection)
  connection.authorizeIndex = (req, res) => original(req, wideningResponse(res))
  ctx.effect(() => () => {
    PATCHED_CONNECTIONS.delete(connection)
    delete connection.authorizeIndex
  })
}

/**
 * Write the URL so a reader polling the path never observes a partial file: the
 * bytes land in a sibling name and are renamed into place, which is atomic on
 * both POSIX and Windows.
 *
 * `mode: 0o600` is honoured on POSIX. Windows ignores it — the file inherits
 * the directory's ACL — which is why the README treats the path itself as the
 * thing to keep private.
 * @param path - destination file; missing parent directories are created.
 * @param url - the authenticated login URL.
 * @returns a disposer removing both the destination and any leftover temporary.
 */
export function writeUrlFile(path, url) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${url}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return () => {
    rmSync(temporary, { force: true })
    rmSync(path, { force: true })
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Clicked files, opened in VS Code instead of the Sidebar
 *
 * The right Sidebar's document preview is the product's answer to "show me
 * this file", and it is the wrong one when the page is already running inside a
 * VS Code panel: the file is in the editor, one window away. The browser half
 * therefore asks this half for a verdict on every file open and, when the row
 * asks for it, posts the address here instead of opening a tab. The launch is
 * the plain CLI one a person would type — `Code.exe -r -g "<file>:<line>"` —
 * which lands in the window that was active a moment ago, i.e. the one the
 * click came from.
 *
 * Every route carries the same trust fence as the rest of the product
 * (`connection.requestRejection`: the Host/Origin fence plus the login cookie),
 * and the open route validates at the wire what it can — media type, body
 * ceiling, address grammar — before it touches the filesystem or a process.
 */

/** Route answering the browser half's per-open configuration read. */
const CONFIG_ROUTE = '/dsh-vscode-bridge/config'

/** Route launching one file address in VS Code. */
const OPEN_ROUTE = '/dsh-vscode-bridge/open-file'

/** The scheme and type every file address this feature understands carries. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * How long a launch is watched for an immediate failure. A launcher still
 * running when the window closes counts as launched and is left alone; the
 * watch only turns a spawn failure or an instant non-zero exit into an answer.
 */
const LAUNCH_WATCH_MS = 1000

/**
 * Credential-shaped environment names never reach a spawned application.
 *
 * This restates the subprocess seam's own scrub (`scrubbedParentEnv`) instead of
 * importing it: the profile links this package, Node resolves imports through
 * the link's real path, and no `@deepseek-ai/*` package exists there — so the
 * host half may import `node:` builtins only. Nothing here is harness policy
 * that can drift silently; the pattern is the seam's own.
 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Prefix of every variable the harness adds for its own children. */
const DSH_ENV_PREFIX = 'DSH_'

/**
 * Where a click on a file goes.
 * @param config - the row's config.
 * @returns `vscode` when the row asks for the hand-off; everything else is the
 * shipped document preview.
 */
export function configuredOpenFileIn(config) {
  return config?.openFileIn === 'vscode' ? 'vscode' : 'preview'
}

/**
 * The VS Code command the row names.
 * @param config - the row's config.
 * @returns the configured path or PATH name, else `undefined` so detection
 * decides.
 */
export function configuredVSCodeExecutable(config) {
  const value = config?.vscodeExecutablePath
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Whether a launch forces the last active window.
 * @param config - the row's config.
 * @returns `false` only when the row says so; reuse is the useful default.
 */
export function configuredReuseWindow(config) {
  return config?.reuseWindow !== false
}

/**
 * Read a `dsh-resource://file/…` address into its parts, without touching a
 * filesystem. The grammar has two scopes: `session/<id>/<path>` resolves
 * through that Session's workspace root, `absolute/<path>` carries the whole
 * path itself. Segments are component-encoded and `:` stays literal, so a
 * Windows drive letter reads as written.
 * @param address - a candidate address.
 * @returns `{ sessionId, path }`, `{ path }`, or `undefined` when the string is
 * not a file address in a known scope.
 */
export function parseFileAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const end = address.search(/[?#]/)
  const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
  try {
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      // An empty first segment with more behind it is a UNC path's `//`.
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { path: `//${segments.join('/')}` }
      return { path: /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
    }
  } catch {
    // `decodeURIComponent` throws on a malformed escape, which is not a path.
    return undefined
  }
  return undefined
}

/** Which spelling an address path carries: a Windows drive, a UNC share, or a POSIX path. */
function pathKind(path) {
  if (/^[A-Za-z]:/.test(path)) return 'win32'
  if (path.startsWith('//')) return 'win32'
  if (path.startsWith('/')) return 'posix'
  return undefined
}

/**
 * The absolute native path one address names.
 * @param parsed - the parts `parseFileAddress` read.
 * @param base - absolute directory an address that is not itself absolute
 * resolves against; the session's workspace root.
 * @returns the absolute native path, or `undefined` when a relative path has no
 * base to resolve against.
 */
export function absolutePathFor(parsed, base) {
  const kind = pathKind(parsed.path)
  // Either Windows spelling is normalized by the Windows rules even when this
  // process runs elsewhere, exactly as the address was written.
  if (kind === 'win32') return win32.normalize(parsed.path)
  if (kind === 'posix') return posix.normalize(parsed.path)
  if (typeof base !== 'string' || base === '') return undefined
  return join(base, parsed.path)
}

/**
 * The VS Code CLI arguments for one file.
 * @param file - absolute native path.
 * @param line - 1-based line, when the caller had one; `-g` carries it.
 * @param reuseWindow - whether to force the last active window with `-r`.
 * @returns argv after the executable.
 */
export function vscodeArgs(file, line, reuseWindow) {
  return [
    ...reuseWindow ? ['-r'] : [],
    ...line === undefined ? [file] : ['-g', `${file}:${String(line)}`],
  ]
}

/**
 * The ambient environment minus credential-shaped and harness-owned names.
 * @param source - environment to read; a parameter so the scrub is testable.
 * @returns a fresh object safe to hand a child process.
 */
export function scrubbedEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key) || key.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    env[key] = value
  }
  return env
}

/**
 * The install locations VS Code's own installer uses, most specific first.
 * @param env - environment carrying the root variables.
 * @param platform - `process.platform` of the host.
 * @returns candidate absolute paths, or the bare command name where the
 * platform installs one on PATH.
 */
export function vscodeCandidates(env, platform) {
  if (platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Programs'),
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramW6432,
    ]
    const relatives = ['Microsoft VS Code\\Code.exe', 'Microsoft VS Code Insiders\\Code - Insiders.exe']
    const candidates = []
    for (const root of roots) {
      if (typeof root !== 'string' || root === '') continue
      for (const relative of relatives) candidates.push(join(root, relative))
    }
    return candidates
  }
  if (platform === 'darwin') {
    return ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'code']
  }
  return ['code']
}

/** Whether a bare command name is found on PATH. */
function onPath(name, env, platform) {
  const path = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : ''
  const separator = platform === 'win32' ? ';' : ':'
  return path.split(separator).some(directory => directory !== '' && existsSync(join(directory, name)))
}

/**
 * Run one host command with a deadline.
 * @param command - executable path or PATH name.
 * @param args - argv, never a shell string.
 * @param timeoutMs - command deadline.
 * @returns stdout on exit 0, else `null` (spawn failure, non-zero exit, or
 * timeout all mean the same thing to a probe).
 */
function runCaptured(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? String(stdout) : null)
    })
  })
}

/**
 * Read one executable's registered path from a Windows `App Paths` hive.
 *
 * `reg.exe` prints the key line, then one indented `name  type  data` line; the
 * default value's name is localized, so the type token is what identifies it.
 * @param exeName - registered executable name, e.g. `Code.exe`.
 * @param hive - `HKCU` or `HKLM`.
 * @param timeoutMs - deadline for the query.
 * @returns the registered path, or `undefined` when the hive does not answer.
 */
async function appPathsProbe(exeName, hive, timeoutMs = 5000) {
  const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
  const output = await runCaptured('reg.exe', ['query', key, '/ve'], timeoutMs)
  if (output === null) return undefined
  const value = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(output)?.[1]
  return value === undefined ? undefined : value.trim().replace(/^"|"$/g, '')
}

/**
 * The VS Code launcher this host can actually run.
 *
 * Detection order is the shipped open-in-app resolver's, minus the parts a
 * single-application probe does not need: a configured path wins, then the
 * installer's own locations, then the user-first Windows `App Paths` registry.
 * A configured path that cannot run is an error rather than a silent fallback,
 * because the row naming one is the row asking for this.
 * @param options - configured path, environment, platform, and probe seams.
 * @returns the resolved launcher, or `undefined` when this host has none.
 */
export async function detectVSCode(options = {}) {
  const {
    configured,
    env = process.env,
    platform = process.platform,
    probe = appPathsProbe,
    exists = existsSync,
  } = options
  if (configured !== undefined) {
    // A bare name is a PATH request and is spawned as written; an absolute path
    // is checked here so a stale one is reported now rather than at a click.
    if (isAbsolute(configured) && !exists(configured)) return undefined
    return { path: configured, source: 'configured' }
  }
  for (const candidate of vscodeCandidates(env, platform)) {
    if (isAbsolute(candidate) ? exists(candidate) : onPath(candidate, env, platform)) {
      return { path: candidate, source: 'known-path' }
    }
  }
  if (platform === 'win32') {
    for (const exeName of ['Code.exe', 'Code - Insiders.exe']) {
      for (const hive of ['HKCU', 'HKLM']) {
        const target = await probe(exeName, hive)
        if (target !== undefined && exists(target)) return { path: target, source: 'app-paths' }
      }
    }
  }
  return undefined
}

/**
 * Spawn one application detached from this process: no stdio pipe, a scrubbed
 * environment, and a lifetime that outlives dsh.
 * @param command - executable path or PATH name.
 * @param args - argv.
 * @param watchMs - early-failure window.
 * @returns `launched` (a live child, or a clean exit), `missing` (the command
 * is gone, which tells the caller to re-detect), or `failed`.
 */
export function launchDetached(command, args, watchMs = LAUNCH_WATCH_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      // A GUI editor's own window is the point; hiding it would hide the launch.
      windowsHide: false,
      env: scrubbedEnv(),
    })
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.unref()
      resolve(outcome)
    }
    const watch = setTimeout(() => { settle('launched') }, watchMs)
    child.on('error', (error) => {
      settle(error?.code === 'ENOENT' ? 'missing' : 'failed')
    })
    child.on('exit', (code) => { settle(code === 0 ? 'launched' : 'failed') })
  })
}

/** JSON response (no-store: availability and launch outcomes are live facts). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one open-route body at the wire.
 * @param text - the request body.
 * @returns the address and optional line, or `undefined` when the body is not
 * the JSON object this route declares.
 */
function parseOpenBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON body is exactly the undefined case.
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const { address, line } = body
  if (typeof address !== 'string' || address === '') return undefined
  if (line === undefined) return { address }
  if (!Number.isInteger(line) || line < 1) return undefined
  return { address, line }
}

/**
 * The Session's workspace root, from the live store or, for a Session that is
 * only persisted, its stored header. Both are the same fact the file service
 * resolves relative paths with, so a click and a preview agree on the file.
 * @param ctx - plugin context.
 * @param sessionId - the Session the address belongs to.
 * @returns the absolute root, or `undefined` when neither source knows it.
 */
async function sessionWorkspaceRoot(ctx, sessionId) {
  const live = ctx.get('sessions')?.get?.(sessionId)
  const cwd = live?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  try {
    const stored = await ctx.get('sessionPersistence')?.stat?.(sessionId)
    const storedCwd = stored?.header?.cwd
    return typeof storedCwd === 'string' && storedCwd !== '' ? storedCwd : undefined
  } catch {
    // A backend that cannot answer leaves the address unresolved, which the
    // route reports as a bad request rather than as a missing file.
    return undefined
  }
}

/**
 * Locate the file one address names.
 * @param ctx - plugin context.
 * @param parsed - the address parts.
 * @returns the absolute path of an existing regular file, else the error code
 * the route answers with.
 */
async function locateFile(ctx, parsed) {
  const base = parsed.sessionId === undefined ? undefined : await sessionWorkspaceRoot(ctx, parsed.sessionId)
  if (parsed.sessionId !== undefined && base === undefined) return { error: 'session-unknown' }
  const absolute = absolutePathFor(parsed, base)
  if (absolute === undefined) return { error: 'unresolvable-path' }
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return { error: 'not-a-file' }
  } catch {
    // ENOENT and EACCES both mean there is no file to hand to the editor.
    return { error: 'not-found' }
  }
  return { path: absolute }
}

/**
 * Register the configuration and open routes for the lifetime of this row.
 *
 * The configuration route answers on every click, so the browser half follows
 * a live `cordis.patch.yml` reload without a page refresh; detection runs once
 * and is cached until a launch finds the executable gone.
 * @param ctx - plugin context carrying the injected `webServer` and `connection`.
 * @param config - the row's config.
 */
export function registerOpenRoutes(ctx, config) {
  const openFileIn = configuredOpenFileIn(config)
  const configured = configuredVSCodeExecutable(config)
  const reuseWindow = configuredReuseWindow(config)
  const connection = ctx.connection

  /** Detection runs at most once per row life, and never twice in parallel. */
  let resolution
  const resolve = async () => {
    const found = await detectVSCode({ configured })
    if (found === undefined) {
      console.error(configured === undefined
        ? `[${name}] no VS Code launcher found; file opens stay in the document preview`
        : `[${name}] vscodeExecutablePath is not runnable: ${configured}`)
    }
    return found
  }
  /** The cached launcher, detected on first use. */
  const executable = () => (resolution ??= resolve())

  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 401
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      const found = await executable()
      sendJson(res, 200, {
        openFileIn,
        executable: found === undefined ? null : found.path,
        reuseWindow,
      })
    },
  }), `${name}: GET ${CONFIG_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      // The essence must be exactly application/json; String(undefined) never matches.
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const parsedBody = parseOpenBody(text)
      if (parsedBody === undefined) {
        sendJson(res, 400, {
          code: 'bad-request',
          message: 'request body must be JSON with a string "address" and an optional positive integer "line"',
        })
        return
      }
      const opened = parseFileAddress(parsedBody.address)
      if (opened === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'address must be a dsh-resource://file/ address' })
        return
      }
      const located = await locateFile(ctx, opened)
      if (located.error !== undefined) {
        const status = located.error === 'not-found' ? 404 : 400
        sendJson(res, status, { code: located.error, message: `cannot open "${opened.path}" (${located.error})` })
        return
      }
      let found = await executable()
      let outcome = found === undefined
        ? 'failed'
        : await launchDetached(found.path, vscodeArgs(located.path, parsedBody.line, reuseWindow))
      if (outcome === 'missing') {
        // The cached launcher is gone (uninstalled, or a PATH entry removed):
        // detect once more before reporting a failure.
        resolution = undefined
        found = await executable()
        outcome = found === undefined
          ? 'failed'
          : await launchDetached(found.path, vscodeArgs(located.path, parsedBody.line, reuseWindow))
      }
      if (outcome === 'launched') {
        sendJson(res, 200, { ok: true })
      } else {
        sendJson(res, 502, {
          code: found === undefined ? 'vscode-unavailable' : 'launch-failed',
          message: found === undefined ? 'no VS Code launcher is available on this host' : `failed to launch ${found.path}`,
        })
      }
    },
  }), `${name}: POST ${OPEN_ROUTE}`)
}

/**
 * Resolve the destination, wait until the whole tree has settled, write once,
 * and undo the file when this row unloads.
 * @param ctx - plugin context carrying the injected services.
 * @param config - the row's config; `{ path }` is the standing destination.
 */
export function apply(ctx, config) {
  // The widening is independent of `path`: it belongs to the panel use case, and
  // a row with no destination should still make the Web app embeddable.
  widenBrowserCookie(ctx)

  // Independent of `path` as well: a row that writes no URL file may still be
  // the row that moves clicked files into the editor.
  registerOpenRoutes(ctx, config)

  const path = configuredPath(config)

  // Registered before the write, because the URL carries a live launch token:
  // it should not outlive the server that accepts it. A hard kill leaves the
  // file behind, which is the one case this cannot cover.
  let undo
  ctx.effect(() => () => {
    if (undo === undefined) return
    const remove = undo
    undo = undefined
    try {
      remove()
    } catch { /* a file already gone is the state we wanted */ }
  })

  const write = () => {
    const port = ctx.get('webServer')?.port
    if (!Number.isInteger(port)) {
      console.error(`[${name}] the Web server reports no bound port; nothing was written`)
      return
    }
    const url = ctx.connection.authenticatedUrl(`http://${LOOPBACK}:${String(port)}`)
    try {
      undo = writeUrlFile(path, url)
    } catch (error) {
      console.error(`[${name}] could not write ${path} because ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    console.log(`dsh web: login URL written to ${path}`)
  }

  // The file is a readiness signal: a supervisor reads it and connects at once,
  // while sibling rows such as the /api route owner may still be mounting.
  // Await Loader settlement first; a hand-built tree without a Loader is already
  // the complete tree.
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) write()
  else {
    void settled.then(() => {
      // The tree can be disposed while the boot is in flight (early SIGTERM);
      // reading torn-down services would turn a clean shutdown into a crash,
      // and a URL for a dead server would only mislead.
      if (ctx.get('webServer') !== undefined && ctx.get('connection') !== undefined) write()
    }, () => {})
  }
}
