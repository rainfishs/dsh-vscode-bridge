/**
 * dsh-vscode-bridge — browser half: hand a clicked file, a clicked external
 * link, and copied text to the page that embeds the GUI.
 *
 * This file is the package's `dsh.client` bundle. The host serves it verbatim
 * under `/plugins/dsh-vscode-bridge/client.js` and the web shell registers the
 * factory below, exactly the path a shipped `@deepseek-ai/dsh-client-*` package
 * takes. It is written by hand rather than built: it is plain browser
 * JavaScript with no imports, because the profile links this package and Node
 * resolves imports through the link's real path, where no `@deepseek-ai/*`
 * module exists — and a bundle this small has nothing to compile.
 *
 * The file interception point is `ctx.sidebarRight`, the product's whole
 * navigation controller for the right column: the conversation's file links, a
 * tool row's line reference, the workspace file tree, and a tab's own link all
 * end in its two resource entry points. Diverting both means a click never
 * opens a document tab at all — but only while the row's `openFileIn` says
 * `vscode`, a verdict this half reads per click from the host's
 * {@link CONFIG_ROUTE}, and only when this page can name the file absolutely.
 *
 * Every hand-off then travels the same way, out of the page rather than through
 * the host. A copy is posted upwards because a cross-origin iframe's own
 * clipboard permission is not something this page can grant itself; a file open
 * and an external link are posted upwards for the same reason — a launch or a
 * browser from the host process would only guess at which window the click came
 * from, while the panel's extension host opens the file natively and asks the
 * editor itself to open the website. A page with no parent is the GUI standing
 * alone: it keeps the document preview, keeps its copy, and lets the browser
 * take an external link.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Route answering whether clicks go to the panel's extension. */
    const CONFIG_ROUTE = '/dsh-vscode-bridge/config'

    /** The one address family this half diverts; every other resource keeps its tab. */
    const FILE_PREFIX = 'dsh-resource://file/'

    /** How long the Host may take to name a file before the preview takes the click. */
    const RESOLVE_DEADLINE_MS = 2000

    /** Controllers already wrapped, so a page never patches one twice. */
    const PATCHED = new WeakSet()

    /** Whether this page's copy doors are already hooked. */
    let LISTENING = false

    /**
     * Whether one decoded path is already absolute in either spelling the Host
     * uses: POSIX, a Windows drive, or a UNC share. An address in the
     * `absolute` scope always is; one in the `session` scope may not be.
     * @param path - a decoded address path.
     * @returns whether the path needs no workspace root to resolve.
     */
    function isAbsolutePath(path) {
      return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
    }

    /** The scheme every address this half hands upwards must carry. */
    const EXTERNAL_PROTOCOL = /^https?:$/

    /**
     * Whether one candidate is an address the embedder should open, rather than
     * a route of this app's own.
     *
     * Only http/https qualifies: a `dsh-resource://` address is a document, a
     * `mailto:` one is the mail client's, and `file:` or `javascript:` never
     * leave this page. A candidate that does not parse, or whose origin is this
     * page's own, is the app talking to itself and keeps its default handling.
     * @param candidate - the href or argument a door produced.
     * @returns whether the address is external, absolute, and http/https.
     */
    function isExternalLink(candidate) {
      if (typeof candidate !== 'string' || candidate === '') return false
      let url
      try {
        url = new URL(candidate, location.href)
      } catch {
        // A string no URL can be built from is not a link.
        return false
      }
      if (!EXTERNAL_PROTOCOL.test(url.protocol)) return false
      return url.origin !== location.origin
    }

    /**
     * Read a `dsh-resource://file/…` address; mirrors the Host's own grammar.
     * @param address - a candidate address.
     * @returns `{ scope, sessionId, path }` with decoded segments, else
     * `undefined` when the string is not a file address in a known scope.
     */
    function parseAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined
      const end = address.search(/[?#]/)
      const [scope, ...rest] = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split('/')
      try {
        if (scope === 'session') {
          const [id, ...segments] = rest
          if (id === undefined || id === '' || segments.length === 0) return undefined
          return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
        }
        if (scope === 'absolute') {
          // An empty first segment with more behind it is a UNC path's `//`.
          const unc = rest[0] === '' && rest.length > 1
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
          if (segments.length === 0 || segments[0] === '') return undefined
          if (unc) return { scope, sessionId: undefined, path: `//${segments.join('/')}` }
          return {
            scope,
            sessionId: undefined,
            path: /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}`,
          }
        }
      } catch {
        // `decodeURIComponent` throws on a malformed escape, which is not a path.
        return undefined
      }
      return undefined
    }

    /**
     * The Host's absolute path for one address, when this page can name it.
     *
     * An `absolute` address carries the whole path. A `session` address that
     * carries a relative one is resolved through the Host, which holds that
     * Session's workspace root; a Session that is only persisted still answers,
     * because the Host keeps its stored header.
     * @param ctx - the browser plugin context.
     * @param address - the address that was clicked.
     * @returns the absolute path, else `undefined` when nothing answers in time
     * or the file is not there.
     */
    async function resolvePath(ctx, address) {
      const parsed = parseAddress(address)
      if (parsed === undefined) return undefined
      if (isAbsolutePath(parsed.path)) return parsed.path
      if (parsed.sessionId === undefined) return undefined
      const controller = new AbortController()
      const deadline = setTimeout(() => { controller.abort() }, RESOLVE_DEADLINE_MS)
      try {
        // A Remote call does not reject: the result carries the failure.
        const result = await ctx.remote.workspaceFiles.stat(parsed.sessionId, parsed.path, controller.signal)
        return result.ok ? result.value.absolutePath : undefined
      } catch {
        return undefined
      } finally {
        clearTimeout(deadline)
      }
    }

    /**
     * Read the host row's verdict for this page.
     * @returns the payload this half reads `openFileIn` from.
     * @throws when the host cannot answer.
     */
    async function readConfig() {
      const response = await fetch(new URL(CONFIG_ROUTE, hostBase()), { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`config: HTTP ${String(response.status)}`)
      return await response.json()
    }

    /**
     * The page's own origin; a webview's opaque origin reports `"null"`, and no
     * relative URL can be built from it, so the connection carrier's own
     * fallback stands in.
     * @returns the base a route URL resolves against.
     */
    function hostBase() {
      const origin = typeof location === 'object' && location !== null ? location.origin : undefined
      return typeof origin === 'string' && origin !== '' && origin !== 'null' ? origin : 'http://dsh.internal'
    }

    /**
     * Hand one file open to the page that embeds this one.
     *
     * That page is the VS Code webview's relay: it forwards the message to the
     * extension host, whose `workspace.openTextDocument` opens the file in the
     * window the click came from. A page with no parent is the GUI standing
     * alone and keeps the file to its own document preview.
     * @param path - absolute host path of the file, with `/` separators.
     * @param address - the `dsh-resource://file/…` address that was clicked.
     * @param line - 1-based line to land on, when the opener had one.
     * @returns whether the open went upwards.
     */
    function reportFile(path, address, line) {
      if (typeof path !== 'string' || path === '') return false
      if (typeof window !== 'object' || window === null || window.parent === window) return false
      window.parent.postMessage({
        type: 'open-file',
        path: path.replace(/\\/g, '/'),
        ...line === undefined ? {} : { line },
        address,
      }, '*')
      return true
    }

    /**
     * The line an opener's navigation parameters carried.
     * @param options - the open's options.
     * @returns the positive integer line, else `undefined`.
     */
    function lineOf(options) {
      const line = options?.params?.line
      return Number.isInteger(line) && line >= 1 ? line : undefined
    }

    /**
     * Send one file open to the embedding page, or leave it to the product.
     *
     * The verdict is read per open rather than cached for the page's life: the
     * row's config reloads with the profile, and a click should follow it at
     * once. An address opened with an explicit `kind` is a caller asking for
     * that implementation, so it is never diverted; a path this page cannot
     * name is not posted either, because a message without a file is not a
     * hand-off — the product's preview takes that click as it always did.
     * An external link is the one address that needs no config: it has no
     * document preview to fall back to, so it goes up whenever the page is
     * embedded.
     * @param client - the browser plugin context, read for the Remote face that
     * names a workspace-relative path absolutely.
     * @param address - the address a caller wants opened.
     * @param options - its placement, kind, and navigation parameters.
     * @param fallthrough - the product's own open, called when this half declines.
     */
    async function divert(client, address, options, fallthrough) {
      // A synchronous throw here is the product's own wiring error and belongs
      // to the caller, so this half reports a fallback that throws instead of
      // turning it into an unhandled rejection.
      const resume = () => {
        try {
          fallthrough()
        } catch (error) {
          console.error('[dsh-vscode-bridge] the document preview refused the open:', error)
        }
      }
      if (typeof address !== 'string') {
        resume()
        return
      }
      // An external link on this door is the same hand-off the other two doors
      // post, so it never opens a document tab.
      if (reportLink(address)) return
      if (!address.startsWith(FILE_PREFIX) || options?.kind !== undefined) {
        resume()
        return
      }
      if (typeof window !== 'object' || window === null || window.parent === window) {
        // The GUI standing alone: a parentless page has no extension to post to.
        resume()
        return
      }
      let config
      try {
        config = await readConfig()
      } catch (error) {
        // A host that cannot answer leaves the click to the product: a file the
        // user asked for must still open somewhere.
        console.warn('[dsh-vscode-bridge] no answer from the host; the document preview takes it:', error)
        resume()
        return
      }
      if (config?.openFileIn !== 'vscode') {
        resume()
        return
      }
      let path
      try {
        path = await resolvePath(client, address)
      } catch (error) {
        // Resolution is best-effort: an address this page cannot name is the
        // product's own document.
        console.warn('[dsh-vscode-bridge] the file could not be named; the document preview takes it:', error)
        resume()
        return
      }
      if (path === undefined) {
        console.warn('[dsh-vscode-bridge] the file could not be named; the document preview takes it:', address)
        resume()
        return
      }
      if (!reportFile(path, address, lineOf(options))) {
        // A page that stopped being embedded between the check and the post
        // keeps its click: the preview takes it rather than the void.
        resume()
      }
    }

    /**
     * Wrap one controller's two resource entry points.
     * @param ctx - the browser plugin context carrying the live `sidebarRight`.
     * @returns the disposer, or `undefined` when this controller is already wrapped.
     */
    function wrap(ctx) {
      const controller = ctx.sidebarRight
      if (controller === undefined || PATCHED.has(controller)) return undefined
      PATCHED.add(controller)
      const openResource = controller.openResource.bind(controller)
      const openResourceIn = controller.openResourceIn.bind(controller)
      controller.openResource = (address, options) => {
        void divert(ctx, address, options, () => { openResource(address, options) })
      }
      controller.openResourceIn = (sessionId, address, options) => {
        void divert(ctx, address, options, () => { openResourceIn(sessionId, address, options) })
      }
      return () => {
        PATCHED.delete(controller)
        // Deleting the own properties lets the prototype's methods resume.
        delete controller.openResource
        delete controller.openResourceIn
      }
    }

    /**
     * Hand one copied text to the page that embeds this one.
     *
     * That page is the VS Code webview's relay: it forwards the message to the
     * extension host, where a clipboard write is never denied. A page with no
     * parent is the GUI standing alone and keeps its copy to itself.
     * @param text - the exact text a copy asked to place on the clipboard.
     * @returns whether the text went upwards.
     */
    function report(text) {
      if (typeof text !== 'string' || text === '') return false
      if (typeof window !== 'object' || window === null || window.parent === window) return false
      window.parent.postMessage({ type: 'copy', text }, '*')
      return true
    }

    /**
     * Listen at the page's two copy doors.
     *
     * Neither door knows the product's UI: the Clipboard API is where every copy
     * control ends, and the `copy` event is what the keyboard and a context menu
     * raise. A write the embedder has taken over must not report failure, so the
     * denial is swallowed exactly when the text went upwards.
     * @returns the disposer that puts both doors back.
     */
    function listenCopy() {
      const clipboard = navigator?.clipboard
      const writeText = clipboard?.writeText?.bind(clipboard)
      if (writeText !== undefined) {
        clipboard.writeText = (text) => {
          const reported = report(text)
          const write = writeText(text)
          return reported ? write.catch(() => undefined) : write
        }
      }
      const onCopy = () => {
        const selection = document.getSelection()
        report(selection === null ? '' : selection.toString())
      }
      document.addEventListener('copy', onCopy, true)
      return () => {
        document.removeEventListener('copy', onCopy, true)
        if (writeText !== undefined) delete clipboard.writeText
      }
    }

    /**
     * Hand one external link to the page that embeds this one.
     *
     * That page is the VS Code webview's relay: it forwards the message to the
     * extension host, which asks the editor to open the address externally and
     * the editor raises its own confirmation. Only the previous frame is
     * addressed, and only when this page was embedded at all; a page standing
     * alone lets the browser take the link as it always did.
     * @param url - the absolute http/https address a click resolved to.
     * @returns whether the link went upwards.
     */
    function reportLink(url) {
      if (!isExternalLink(url)) return false
      if (typeof window !== 'object' || window === null || window.parent === window) return false
      window.parent.postMessage({ type: 'open-link', url }, '*')
      return true
    }

    /**
     * Listen at the page's two link doors.
     *
     * The product renders a link as an anchor in one place and opens it through
     * `window.open` in another, so both doors are hooked: a capture-phase click
     * sees the anchor whatever the app's own handlers do with it, and the
     * `window.open` patch catches the new-tab route. An external link the app
     * has already handled (`defaultPrevented`) belongs to the app, and so does
     * one whose click was not the plain primary gesture.
     * @returns the disposer that puts both doors back.
     */
    function listenLinks() {
      const onOpen = window.open?.bind(window)
      if (onOpen !== undefined) {
        window.open = (url, ...rest) => (reportLink(url) ? null : onOpen(url, ...rest))
      }
      const onClick = (event) => {
        const target = event.target
        if (typeof target?.closest !== 'function') return
        const anchor = target.closest('a[href]')
        if (anchor === null) return
        if (!reportLink(anchor.href)) return
        event.preventDefault()
        event.stopPropagation()
      }
      document.addEventListener('click', onClick, true)
      return () => {
        document.removeEventListener('click', onClick, true)
        if (onOpen !== undefined) window.open = onOpen
      }
    }

    /**
     * Required browser services: the right Sidebar's navigation controller, and
     * the Remote face that names a workspace file absolutely.
     */
    const inject = ['sidebarRight', 'remote', 'remote.workspaceFiles']

    /**
     * Install the diversion for this page's lifetime.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      if (!LISTENING) {
        LISTENING = true
        const restore = [listenCopy(), listenLinks()]
        ctx.effect(() => () => {
          LISTENING = false
          for (const undo of restore) undo()
        })
      }
      const restore = wrap(ctx)
      if (restore !== undefined) ctx.effect(() => restore)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
