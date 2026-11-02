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
 * owns where a clicked file opens. Its browser half (`lib/client.js`, the
 * package's `dsh.client` bundle) does the work: when the row's
 * `config.openFileIn` asks for it, a click is posted to the page that embeds the
 * GUI — the VS Code webview — and that panel's own extension opens the file
 * natively. No subprocess is spawned and no VS Code install is probed here; this
 * half only answers the verdict the browser half reads per click, so the row's
 * config stays live across a reload.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
  if (typeof value === 'string') {
    // 只動 Strict 的 session cookie；其他 cookie 原樣通過。
    // 0.2 起 Connection 自己會依 listener 的協定追加 `; Secure`，
    // 所以先拿掉再補一次，免得寫出兩個 Secure 屬性。
    if (!value.includes('SameSite=Strict')) return value
    return `${value.replaceAll('SameSite=Strict', 'SameSite=None').replace(/;\s*Secure/gi, '')}; Secure`
  }
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
  // 多餘的參數照傳：0.2 的 Connection 會在內部依 listener 的協定決定 `secure`。
  connection.authorizeIndex = (req, res, ...rest) => original(req, wideningResponse(res), ...rest)
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
 * Clicked files, handed to VS Code instead of the Sidebar
 *
 * The right Sidebar's document preview is the product's answer to "show me
 * this file", and it is the wrong one when the page is already running inside a
 * VS Code panel: the file is in the editor, one window away. A launch from here
 * would only guess at that window with the VS Code CLI; the panel's own
 * extension host opens it natively instead. The browser half therefore posts
 * the file to the page that embeds the GUI, and the panel's extension receives
 * it — the same passage the clipboard hand-off uses.
 *
 * That leaves this half one job: answer whether the row asks for the hand-off
 * at all. The route carries the product's own trust fence as the rest of the
 * product does (`connection.requestRejection`: the Host/Origin fence plus the
 * login cookie), and no request here reaches a filesystem or a process.
 */

/** Route answering the browser half's per-open configuration read. */
const CONFIG_ROUTE = '/dsh-vscode-bridge/config'

/**
 * Where a click on a file goes.
 *
 * The hand-off is the default, because the page it matters for is the one
 * inside a VS Code panel and a click there is asking for the editor. A row that
 * wants the shipped document preview back names it.
 * @param config - the row's config.
 * @returns `preview` only when the row asks for it; everything else is the
 * hand-off to the embedding page.
 */
export function configuredOpenFileIn(config) {
  return config?.openFileIn === 'preview' ? 'preview' : 'vscode'
}

/** JSON response (no-store: the verdict follows a live config reload). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** The route's one supported method, answered on any other. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Register the configuration route for the lifetime of this row.
 *
 * The route answers on every click, so the browser half follows a live
 * `cordis.patch.yml` reload without a page refresh.
 * @param ctx - plugin context carrying the injected `webServer` and `connection`.
 * @param config - the row's config.
 */
export function registerOpenRoute(ctx, config) {
  const openFileIn = configuredOpenFileIn(config)
  const connection = ctx.connection

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (req, res) => {
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 401
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, { openFileIn })
    },
  }), `${name}: GET ${CONFIG_ROUTE}`)
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
  registerOpenRoute(ctx, config)

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
