/**
 * dsh-vscode-bridge — browser half: hand a clicked file to VS Code, and hand
 * copied text to the page that embeds the GUI.
 *
 * This file is the package's `dsh.client` bundle. The host serves it verbatim
 * under `/plugins/dsh-vscode-bridge/client.js` and the web shell registers the
 * factory below, exactly the path a shipped `@deepseek-ai/dsh-client-*` package
 * takes. It is written by hand rather than built: it is plain browser
 * JavaScript with no imports, because the profile links this package and Node
 * resolves imports through the link's real path, where no `@deepseek-ai/*`
 * module exists — and a bundle this small has nothing to compile.
 *
 * The one interception point is `ctx.sidebarRight`, the product's whole
 * navigation controller for that column: the conversation's file links, a tool
 * row's line reference, the workspace file tree, and a tab's own link all end
 * in its two resource entry points. Diverting both means a click never opens a
 * document tab at all. A host that is off, unreachable, or has no VS Code to
 * launch falls through to the built-in behaviour, so the product keeps working
 * with this row configured but idle.
 *
 * The second interception point is the page's copy path: a copy the embedder
 * has taken over is posted upwards instead of being written here, because a
 * cross-origin iframe's own clipboard permission is not something this page can
 * grant itself. The VS Code webview that embeds it relays the message to the
 * extension host, where the write is never denied.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Route answering whether clicks go to VS Code, and where it lives. */
    const CONFIG_ROUTE = '/dsh-vscode-bridge/config'

    /** Route launching one file address in VS Code. */
    const OPEN_ROUTE = '/dsh-vscode-bridge/open-file'

    /** The one address family this half diverts; every other resource keeps its tab. */
    const FILE_PREFIX = 'dsh-resource://file/'

    /** Controllers already wrapped, so a page never patches one twice. */
    const PATCHED = new WeakSet()

    /** Whether this page's copy doors are already hooked. */
    let LISTENING = false

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
     * Read the host row's verdict for this page.
     * @returns the payload this half reads `openFileIn` and `executable` from.
     * @throws when the host cannot answer.
     */
    async function readConfig() {
      const response = await fetch(new URL(CONFIG_ROUTE, hostBase()), { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`config: HTTP ${String(response.status)}`)
      return await response.json()
    }

    /**
     * Ask the host to launch one address.
     * @param address - the `dsh-resource://file/…` address that was clicked.
     * @param line - 1-based line to land on, when the opener had one.
     * @throws when the host did not acknowledge a launch.
     */
    async function launchInVSCode(address, line) {
      const response = await fetch(new URL(OPEN_ROUTE, hostBase()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(line === undefined ? { address } : { address, line }),
      })
      if (!response.ok) throw new Error(`open-file: HTTP ${String(response.status)}`)
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
     * Send one file open to VS Code, or leave it to the product.
     *
     * The verdict is read per open rather than cached for the page's life: the
     * row's config reloads with the profile, and a click should follow it at
     * once. An address opened with an explicit `kind` is a caller asking for
     * that implementation, so it is never diverted.
     * @param address - the address a caller wants opened.
     * @param options - its placement, kind, and navigation parameters.
     * @param fallthrough - the product's own open, called when this half declines.
     */
    async function divert(address, options, fallthrough) {
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
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX) || options?.kind !== undefined) {
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
      if (config?.openFileIn !== 'vscode' || typeof config.executable !== 'string' || config.executable === '') {
        resume()
        return
      }
      try {
        await launchInVSCode(address, lineOf(options))
      } catch (error) {
        console.warn('[dsh-vscode-bridge] VS Code refused the hand-off; the document preview takes it:', error)
        resume()
      }
    }

    /**
     * Wrap one controller's two resource entry points.
     * @param controller - the live `ctx.sidebarRight`.
     * @returns the disposer, or `undefined` when this controller is already wrapped.
     */
    function wrap(controller) {
      if (PATCHED.has(controller)) return undefined
      PATCHED.add(controller)
      const openResource = controller.openResource.bind(controller)
      const openResourceIn = controller.openResourceIn.bind(controller)
      controller.openResource = (address, options) => {
        void divert(address, options, () => { openResource(address, options) })
      }
      controller.openResourceIn = (sessionId, address, options) => {
        void divert(address, options, () => { openResourceIn(sessionId, address, options) })
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

    /** Required browser services: the right Sidebar's navigation controller. */
    const inject = ['sidebarRight']

    /**
     * Install the diversion for this page's lifetime.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      if (!LISTENING) {
        LISTENING = true
        const restore = listenCopy()
        ctx.effect(() => () => {
          LISTENING = false
          restore()
        })
      }
      const controller = ctx.sidebarRight
      if (controller === undefined) return
      const restore = wrap(controller)
      if (restore !== undefined) ctx.effect(() => restore)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
