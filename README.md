# dsh-vscode-bridge

**A DSH profile bundle that bridges the Web GUI and VS Code.** It writes the Web GUI's authenticated login URL to a file, hands a file you click to VS Code instead of the right Sidebar's document preview, and gets copied text onto the real system clipboard.

**English** | [繁體中文](README.zh-TW.md)

> [!NOTE]
> An independent community project. Not affiliated with, endorsed by, or published by DeepSeek.

## Why

`dsh web` serves its GUI on loopback and prints an authenticated login URL. Two things about that are awkward in practice:

- A launcher, supervisor, or script has to scrape stdout to learn that URL.
- When the GUI runs inside a VS Code panel, a click on a file opens the Sidebar's document preview — a tab in the page you are already looking past — and a copy button inside the iframe cannot reach the system clipboard.

Both answers belong in the DSH runtime rather than in the launcher. This bundle is a profile layer (an npm package plus a `cordis.patch.yml`), so it is installed once into a profile and every session sees the same facts. It patches the host composition, not an agent preset: it is agent-agnostic, and one row covers all of it.

## What it does

| Half | Runs in | Does |
|---|---|---|
| `index.js` | the dsh host process | writes the URL file, widens the browser session cookie, answers the file-open verdict route |
| `lib/client.js` | the browser (`dsh.client` bundle) | posts file opens and copied text up to the page that embeds the GUI |

**The login URL, in a file.** While this process serves the GUI, the authenticated URL is written to one text file, so a launcher, supervisor, or script reads a file instead of scraping stdout. The bytes land in a sibling temporary name and are renamed into place, so a polling reader never sees half a line. The default destination is `web-url.txt` in the Web profile directory.

**Clicking a file opens it in VS Code.** The document preview is the product's answer to "show me this file", and it is the wrong one when the page is already running inside a VS Code panel: the file belongs in the editor, one window away. This is the default, no configuration needed: a click is posted to the page that embeds the GUI — `{ type: "open-file", path, line? }` — and the panel's extension opens it natively, in the window the click came from. Name `openFileIn: preview` to keep the shipped document preview instead. The host process never spawns `Code.exe` and never probes for a VS Code install: resolving which window a click came from is the extension's job, not something a CLI launch can guess. A click whose file cannot be named (a Session this page cannot reach, a file that is gone) falls back to the document preview, so a click never does nothing.

**Copy goes to the real clipboard.** A webview cannot delegate its clipboard permission to a second, cross-origin iframe, so the page inside the panel cannot write the system clipboard by itself. The browser half therefore hooks the two doors every copy goes through — `navigator.clipboard.writeText` for the copy controls, the `copy` event for the keyboard and a context menu — and posts `{ type: "copy", text }` to its parent frame; the VS Code extension relays it to the extension host, where the write is never denied. Needs [rainfishs/dsh-vscode](https://github.com/rainfishs/dsh-vscode). A page with no parent (the GUI opened directly in a browser) keeps its original copy path, untouched.

**The panel can keep its session.** The Web app's session cookie is `SameSite=Strict`, and a `vscode-webview://` panel is a different site: the cookie would never be sent, and every `/api` call inside the panel would answer 401 before any of the app's own request checks ran. This row widens exactly that one attribute to `SameSite=None; Secure` — loopback is a trustworthy origin in Chromium, so `Secure` is honoured over plain HTTP — and restores the method when the row unloads.

## Requirements

| Need | Why |
|---|---|
| DeepSeek Harness (`@deepseek-ai/dsh`) | the runtime this bundle is installed into; `dsh plugin` needs `pnpm` on `PATH` |
| [rainfishs/dsh-vscode](https://github.com/rainfishs/dsh-vscode) | the VS Code side: it embeds the GUI and receives the two hand-offs; without it, files stay in the document preview and copies stay inside the page |

`0.3.0` is the DSH 0.2 compatibility pass. It was checked against 0.2.1: `webServer.register`/`port`, `connection.authenticatedUrl`/`authorizeIndex`/`requestRejection`, the exact-route handler shape, and the client `sidebarRight`/`remote.workspaceFiles` names all keep their 0.1 meanings. The one behavioural change is the cookie rewrite: 0.2 appends `; Secure` itself when the listener serves TLS, so the widening now leaves exactly one `Secure` instead of two, and it no longer touches cookies that carry no `SameSite`.

No build step and no dependencies of its own: the package ships the sources it runs.

**One machine, both halves.** A posted `path` is the host path the dsh process itself sees, so VS Code must open that same filesystem — a local window for a local `dsh web`, or a Remote/WSL/container window whose remote is the machine dsh runs on. A Windows-local dsh paneled into a remote window would name a path that remote cannot reach.

## Install

```powershell
dsh plugin --profile web add github:rainfishs/dsh-vscode-bridge
```

The package declares `dsh.bundle`, so the command appends it to the profile's `dsh.profile.bundles`, and its patch becomes one more layer of the composition.

Confirm the layer without booting anything:

```powershell
dsh --profile web --dump-config
```

The output should carry a `# == dsh-vscode-bridge` section.

## Configure

Keys go in the profile's own patch layer, `%DSH_HOME%\profiles\web\cordis.patch.yml` (`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` when `DSH_HOME` is unset), or in the home-level `%DSH_HOME%\cordis.patch.yml`, which every profile shares. The profile layer applies after every bundle layer, so it always wins.

```yaml
- id: dsh-vscode-bridge
  config:
    openFileIn: preview
```

| Key | Default | Meaning |
|---|---|---|
| `path` | `null` → `%DSH_HOME%\profiles\web\web-url.txt` | Where the login URL is written. |
| `openFileIn` | `null` → `vscode` | Where a file click goes. The default hands the file to the embedding page, which a VS Code panel opens natively; `preview` keeps the shipped document preview instead. |

Opens are the extension's business, so its own settings decide how they land — `window.openFoldersInNewWindow`, `window.revealIfOpen`, and so on. A DSH row cannot reach into another application's settings, so nothing here repeats them.

A patch replaces the targeted row's whole `config`, so every key that must survive has to be restated.

**Quote Windows paths with single quotes.** In YAML double quotes `\U` is an escape, and `"D:\path\to\web-url.txt"` fails to parse.

**When a restart is needed.**

- Config values only → no restart. The browser half reads a verdict on every click, so the next click follows a live patch reload.
- `lib/client.js`, or the first install of a new version → restart dsh. The browser bundle is composed into `window.__DSH_BOOT__` at boot and is not re-read afterwards.

## Result

While the GUI is being served, the file holds one line:

```text
http://127.0.0.1:3080/?token=<this launch's login token>
```

and the host logs one line:

```text
dsh web: login URL written to <path>
```

## The file is a key

`?token=` is this process's login token. Anyone who reads it can enter the GUI.

- On POSIX the file is created with mode `0600`. Windows ignores the mode and inherits the directory's ACL, so where you put the file is the thing to control.
- The file is removed when the process shuts down cleanly. A hard kill (Task Manager, SIGKILL) leaves it behind, and that stale token no longer works.
- The write is atomic, so a reader polling the path never sees a partial file.

## The routes and the messages

The browser half reads its per-click verdict from `GET /dsh-vscode-bridge/config`. The route passes the product's own trust fence (`connection.requestRejection`: the Host/Origin fence plus the login cookie) and answers `{ "openFileIn": "vscode" | "preview" }` — that is the whole route, and it answers `vscode` unless the row names `preview`. There is no open route any more: the file never travels through the host.

The open travels up the frame tree instead, exactly as a copy does. A page that is embedded (`window.parent !== window`) posts to its parent:

```js
window.parent.postMessage({ type: 'open-file', path: 'C:/work/notes.md', line: 42, address: 'dsh-resource://file/…' }, '*')
```

| Field | Meaning |
|---|---|
| `type` | `"open-file"` |
| `path` | Absolute host path of the file. Always `/`-separated, so a Windows path reads `C:/work/notes.md`. With a `line`. |
| `line` | 1-based line, when the opener had one; absent otherwise. |
| `address` | The original `dsh-resource://file/…` address, for logging or a receiver that would rather resolve it itself. |

The receiving extension opens `vscode.Uri.file(path)` and reveals `line`. A page with no parent — the GUI opened directly in a browser — posts nothing and keeps the document preview; so does a page whose file cannot be named. The `path` is resolved before the post: an `absolute` address carries it already, and a `session` address that carries a relative one is resolved through the Host (`remote.workspaceFiles.stat`), which holds that Session's workspace root — a persisted Session still answers. If that resolution does not come back within two seconds, the click falls back to the preview.

### External links

A link in a message is an anchor with `target="_blank"`, and a webview blocks the popup that would open: the click does nothing at all. The page therefore posts an external link upwards the same way, and the receiving extension opens it with the editor's own confirmation:

```js
window.parent.postMessage({ type: 'open-link', url: 'https://example.com/…' }, '*')
```

Only `http` and `https` qualify, and only when the origin differs from the page's own — a route, a `mailto:`, a `dsh-resource://` address, or anything else keeps whatever the product does with it. Two doors are hooked, so a link is caught whichever way the app opens it: a capture-phase `click` on the document (the door the shell actually uses, since it renders anchors and lets the browser follow them), and a `window.open` patch for the new-tab route. The same click is never posted twice, and a page with no parent is left entirely alone.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No URL file appears | Whether the row is in `dsh.profile.bundles` (`dsh --profile web --dump-config`), and whether the host logged `dsh web: login URL written to …`. |
| The URL in the file is rejected | The token belongs to one launch. A file left behind by a hard kill is stale; restart `dsh web`. |
| Clicking a file still opens the Sidebar preview | The page is not embedded (a plain browser tab has no extension to hand the file to), or `openFileIn: preview` is in effect. |
| Clicking a file does nothing | The click was handed to the panel and nothing there answered: check that the extension is installed and active, and the browser console for `[dsh-vscode-bridge]` warnings. A file the Host could not name within two seconds falls back to the preview instead, so nothing at all means the preview failed too. |
| Copy buttons do not reach the system clipboard | The VS Code extension is not installed or not active, or the page is not embedded in a webview. |
| Clicking an external link does nothing | Same two reasons: no extension to receive `open-link`, or the page is not embedded. No `[OpenExternal]` line in the output panel (source **DSH**) means this half never posted. |
| Every `/api` call inside the VS Code panel answers 401 | The cookie-widening part of the row did not load — the bundle is missing from the profile, or the app's cookie shape changed. |
| Config changes have no effect | A patch replaces the whole `config` of the row it targets; restate every key. `lib/client.js` changes need a dsh restart. |

## Why there is no `--url-file` flag

The shipped Web app's commander program declares no `allowUnknownOption()` and accepts no extra operands, so any option it does not know fails the boot before a single row reads it — and an out-of-tree bundle cannot change the shipped app. The destination therefore lives in this row's config, with `web-url.txt` beside the Web profile as the default.

## Uninstall

Delete the row that overrides it from your patch file first, then:

```powershell
dsh plugin --profile web remove dsh-vscode-bridge
```

Removing the package first would leave that layer pointing at a package that no longer exists, and the profile would not start.

## Development

```powershell
dsh plugin --profile web add link:/absolute/path/to/dsh-vscode-bridge
```

A `link:` install points the profile at your checkout, so editing `index.js` is editing the running copy — but Node caches ESM, so a profile restart is what applies it. `lib/client.js` is composed at boot for the same reason.

## Status

Early preview, `0.3.x`. The bundle stays small on purpose: it writes a file, answers one verdict route, and posts two kinds of messages upwards. It does not launch anything and holds no VS Code detection of its own.

## License

[MIT](LICENSE)
