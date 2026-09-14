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
| `index.js` | the dsh host process | writes the URL file, widens the browser session cookie, registers the two VS Code routes |
| `lib/client.js` | the browser (`dsh.client` bundle) | diverts file opens to those routes, hands copied text to the page that embeds the GUI |

**The login URL, in a file.** While this process serves the GUI, the authenticated URL is written to one text file, so a launcher, supervisor, or script reads a file instead of scraping stdout. The bytes land in a sibling temporary name and are renamed into place, so a polling reader never sees half a line. The default destination is `web-url.txt` in the Web profile directory.

**Clicking a file opens it in VS Code.** The document preview is the product's answer to "show me this file", and it is the wrong one when the page is already running inside a VS Code panel: the file belongs in the editor, one window away. With `openFileIn: vscode`, a click is handed to `Code.exe -r -g "<file>:<line>"` — the plain CLI launch a person would type — which lands in the window the click came from. Any failure (no VS Code, a refused launch, a session whose workspace cannot be resolved, a file that is gone) falls back to the document preview, so a click never does nothing.

**Copy goes to the real clipboard.** A webview cannot delegate its clipboard permission to a second, cross-origin iframe, so the page inside the panel cannot write the system clipboard by itself. The browser half therefore hooks the two doors every copy goes through — `navigator.clipboard.writeText` for the copy controls, the `copy` event for the keyboard and a context menu — and posts `{ type: "copy", text }` to its parent frame; the VS Code extension relays it to the extension host, where the write is never denied. Needs [rainfishs/dsh-vscode](https://github.com/rainfishs/dsh-vscode). A page with no parent (the GUI opened directly in a browser) keeps its original copy path, untouched.

**The panel can keep its session.** The Web app's session cookie is `SameSite=Strict`, and a `vscode-webview://` panel is a different site: the cookie would never be sent, and every `/api` call inside the panel would answer 401 before any of the app's own request checks ran. This row widens exactly that one attribute to `SameSite=None; Secure` — loopback is a trustworthy origin in Chromium, so `Secure` is honoured over plain HTTP — and restores the method when the row unloads.

## Requirements

| Need | Why |
|---|---|
| DeepSeek Harness (`@deepseek-ai/dsh`) | the runtime this bundle is installed into; `dsh plugin` needs `pnpm` on `PATH` |
| VS Code | for the file hand-off and the clipboard bridge |
| [rainfishs/dsh-vscode](https://github.com/rainfishs/dsh-vscode) | the clipboard bridge's other half; without it, copies stay inside the page |

No build step and no dependencies of its own: the package ships the sources it runs.

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
    openFileIn: vscode
```

| Key | Default | Meaning |
|---|---|---|
| `path` | `null` → `%DSH_HOME%\profiles\web\web-url.txt` | Where the login URL is written. |
| `openFileIn` | `null` → `preview` | `vscode` hands file clicks to VS Code; anything else keeps the document preview. |
| `vscodeExecutablePath` | `null` → auto-detect | An absolute path to `Code.exe` (or `code` on macOS and Linux), or a bare command name found on `PATH`. |
| `reuseWindow` | `null` → reuse | `true` forces `-r`, the last active window — the one the click came from. `false` lets the CLI choose. |

A patch replaces the targeted row's whole `config`, so every key that must survive has to be restated.

**Quote Windows paths with single quotes.** In YAML double quotes `\U` is an escape, and `"D:\path\to\web-url.txt"` fails to parse.

**Auto-detection order.** A configured path wins; then the installer's own locations (Windows: `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, `%ProgramFiles%\Microsoft VS Code\Code.exe`, and the Insiders names; macOS: `/Applications/Visual Studio Code.app/...`; Linux: `code` on `PATH`); then the user-first Windows `App Paths` registry. A configured path that cannot run is reported rather than silently replaced.

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

## The routes

The browser half reads its per-click verdict from `GET /dsh-vscode-bridge/config` and posts an open to `POST /dsh-vscode-bridge/open-file`. Both pass the product's own trust fence (`connection.requestRejection`: the Host/Origin fence plus the login cookie) before they touch a filesystem or a process, and the open route validates at the wire what it can — media type, a 64 KB body ceiling, the address grammar — before it locates anything.

The open route understands `dsh-resource://file/…` addresses in two scopes: `session/<id>/<path>` resolves through that session's workspace root, `absolute/<path>` carries the whole path itself. The process it starts is spawned detached, with stdio dropped, a scrubbed environment (credential-shaped and `DSH_*` names removed), and a one-second watch that turns a spawn failure or an instant non-zero exit into an answer.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No URL file appears | Whether the row is in `dsh.profile.bundles` (`dsh --profile web --dump-config`), and whether the host logged `dsh web: login URL written to …`. |
| The URL in the file is rejected | The token belongs to one launch. A file left behind by a hard kill is stale; restart `dsh web`. |
| Clicking a file still opens the Sidebar preview | `openFileIn: vscode` is not in effect — usually a row id that does not match, since a patch only reaches the row it names. |
| Clicking a file does nothing | The fallback failed too: check the browser console for `[dsh-vscode-bridge]` lines and the host log for `no VS Code launcher found`; set `vscodeExecutablePath` if detection cannot see your install. |
| Copy buttons do not reach the system clipboard | The VS Code extension is not installed or not active, or the page is not embedded in a webview. |
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

Early preview, `0.2.x`. The bundle stays small on purpose: it writes a file and answers two routes, and it is not trying to become a general VS Code integration.

## License

[MIT](LICENSE)
