# dsh-vscode-bridge

**把 DSH Web GUI 和 VS Code 接起來的 profile 組合包。** 它把 Web GUI 的登入網址寫進一個檔案、把你在 GUI 裡點的檔案交給 VS Code 開（不是右側欄的文件預覽），也把複製的字送到真正的系統剪貼簿。

[English](README.md) | **繁體中文**

> [!NOTE]
> 獨立的社群專案，與 DeepSeek 官方無隸屬關係，也未經其背書或發行。

## 為什麼需要它

`dsh web` 把 GUI 跑在 loopback 上，並印出一條帶登入權杖的網址。實務上有兩件事很卡：

- 啟動器、supervisor 或腳本只能去撈 stdout，才知道那條網址。
- GUI 跑在 VS Code 面板裡時，點檔案開的是側欄的文件預覽 —— 一個你已經在看的頁面底下的分頁；而 iframe 裡的複製鈕也碰不到系統剪貼簿。

這兩個答案都該落在 DSH 執行環境裡，而不是啟動器裡。這個組合包是一層 profile（一個 npm 套件加一份 `cordis.patch.yml`）：裝一次進 profile，每個 session 看到同一份事實。它改的是系統層（host composition），不是某個 agent preset —— 跟 agent 無關，而且一列就夠。

## 它做什麼

| 半邊 | 跑在哪 | 做什麼 |
|---|---|---|
| `index.js` | dsh host 行程 | 寫 URL 檔、放寬瀏覽器 session cookie、回答「開檔案去哪」那條判定路由 |
| `lib/client.js` | 瀏覽器（`dsh.client` 組合包） | 把「開檔案」與複製的字往上送給外層頁面 |

**登入網址，落在檔案裡。** 這個行程在服務 GUI 的時候，把帶權杖的網址寫進一個純文字檔 —— 啟動器、supervisor 或腳本讀檔案，不用撈 stdout。位元組先寫進同目錄的暫存名再 rename 上去，所以輪詢的讀者不會讀到寫一半的內容。預設位置是 Web profile 目錄下的 `web-url.txt`。

**點檔案，交給 VS Code 開。** 文件預覽是產品對「給我看這個檔案」的答案，但當頁面已經在 VS Code 面板裡時，那個答案是錯的：檔案該在編輯器裡，只隔一個視窗。這是**預設行為，不用設定**：每一次點擊都往上送給外層頁面 —— `{ type: "open-file", path, line? }` —— 由面板的擴充原生開啟，落在剛才點擊的那個視窗；想改回隨附的文件預覽就填 `openFileIn: preview`。host 行程完全不 spawn `Code.exe`、也不探測 VS Code 裝在哪：判斷「點擊來自哪個視窗」是擴充的事，命令列啟動只能用猜的。檔案叫不出路徑的點擊（session 問不到、檔案不見了）退回文件預覽，所以點了不會沒反應。

**複製，送到真正的剪貼簿。** webview 沒辦法把剪貼簿權限往下轉授給第二層的跨來源 iframe，所以面板裡的頁面自己寫不了系統剪貼簿。前端因此掛在每次複製都會經過的兩道門上 —— 複製鈕走 `navigator.clipboard.writeText`，鍵盤與右鍵走 `copy` 事件 —— 再 `postMessage` `{ type: "copy", text }` 給父層；VS Code 擴充把它轉到 extension host，那裡的寫入不會被拒。需要 [rainfishs/dsh-vscode](https://github.com/rainfishs/dsh-vscode)。沒有外層（直接用瀏覽器開 GUI）時，複製照原本的路走，完全沒動。

**面板留得住 session。** Web app 的 session cookie 是 `SameSite=Strict`，而 `vscode-webview://` 面板是不同 site：cookie 永遠不會送出，面板裡的每一個 `/api` 呼叫都會在 app 自己的請求檢查之前先回 401。這一列只把那個屬性放寬成 `SameSite=None; Secure`（loopback 在 Chromium 眼中是可信任的來源，所以純 HTTP 下 `Secure` 照樣有效），卸載時把方法還原。

## 需求

| 需要什麼 | 為什麼 |
|---|---|
| DeepSeek Harness（`@deepseek-ai/dsh`） | 這個組合包裝進去的執行環境；`dsh plugin` 需要 `PATH` 上的 `pnpm` |
| [rainfishs/dsh-vscode](https://github.com/rainfishs/dsh-vscode) | VS Code 那一側：負責嵌入 GUI、接收兩種往上丟的訊息；沒裝的話檔案留在文件預覽、複製留在頁面裡 |

沒有 build 步驟、也沒有自己的依賴：套件交出去的就是它跑的原始碼。

**同一台機器，兩半都在。** 往上丟的 `path` 是 dsh 行程自己看到的路徑，所以 VS Code 要開得到同一個檔案系統 —— 本機 `dsh web` 配本機視窗，或 Remote／WSL／容器視窗的遠端就是 dsh 跑的那台。本機 dsh 配遠端視窗，會丟出那個遠端碰不到的路徑。

## 安裝

```powershell
dsh plugin --profile web add github:rainfishs/dsh-vscode-bridge
```

套件宣告了 `dsh.bundle`，所以這個指令會把它接在 profile 的 `dsh.profile.bundles` 最後面，它的 patch 就成為一層組合。

先不啟動、只驗證那一層：

```powershell
dsh --profile web --dump-config
```

輸出裡應該多一段 `# == dsh-vscode-bridge`。

## 設定

設定寫在 profile 自己的 patch 層：`%DSH_HOME%\profiles\web\cordis.patch.yml`（沒設 `DSH_HOME` 時是 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`），或寫在 home 層 `%DSH_HOME%\cordis.patch.yml`（所有 profile 共用）。profile 那層在每個組合包之後才套用，所以一定蓋得掉。

```yaml
- id: dsh-vscode-bridge
  config:
    openFileIn: preview
```

| 鍵 | 預設 | 意思 |
|---|---|---|
| `path` | `null` → `%DSH_HOME%\profiles\web\web-url.txt` | 登入網址要寫到哪。 |
| `openFileIn` | `null` → `vscode` | 點檔案去哪。預設把檔案交給外層頁面（VS Code 面板會原生開起來）；填 `preview` 就改用隨附的文件預覽。 |

「開在哪、怎麼開」是擴充的事，所以由擴充自己的設定決定 —— `window.openFoldersInNewWindow`、`window.revealIfOpen` 之類。DSH 的一列沒有辦法伸進另一個應用程式的設定裡，這裡也就不重複它們。

patch 會整份取代目標行的 `config`，所以每個要留的鍵都得重寫一次。

**Windows 路徑用單引號。** YAML 雙引號裡 `\U` 是轉義字元，`"D:\path\to\web-url.txt"` 會直接解析失敗。

**什麼時候要重啟 dsh。**

- 只改設定值 → 不用重啟。前端每次點擊都會問一次判定，下一次點擊就吃到新的 patch。
- 動到 `lib/client.js`，或第一次裝這個版本 → 要重啟。前端 bundle 在啟動時組進 `window.__DSH_BOOT__`，之後不會重讀。

## 結果

GUI 在服務的時候，檔案內容是一行：

```text
http://127.0.0.1:3080/?token=<這次啟動的登入權杖>
```

host 也會多印一行：

```text
dsh web: login URL written to <path>
```

## 這個檔案等於一把鑰匙

`?token=` 是這個行程的登入權杖。誰讀到它，誰就能直接進 GUI。

- POSIX 上檔案以 `0600` 建立。**Windows 會忽略 mode**，權限繼承資料夾 —— 所以「放哪個資料夾」才是你要控制的事。
- 行程正常關閉時檔案會被刪掉。被硬殺（工作管理員、SIGKILL）才會留下來，而且那個權杖已經不能用了。
- 寫入是原子的，輪詢的讀者不會讀到寫一半的內容。

## 路由與訊息

前端每次點擊都讀一次判定：`GET /dsh-vscode-bridge/config`。這條路由先過產品自己的信任圍籬（`connection.requestRejection`：Host/Origin 圍籬加登入 cookie），回答 `{ "openFileIn": "vscode" | "preview" }` —— 整條路由就這些，而且除非那一列填 `preview`，否則一律回 `vscode`。**已經沒有開檔路由了**：檔案不再經過 host。

開檔改成往框架樹上丟，跟複製走同一條路。頁面被內嵌時（`window.parent !== window`）就往父層丟：

```js
window.parent.postMessage({ type: 'open-file', path: 'C:/work/notes.md', line: 42, address: 'dsh-resource://file/…' }, '*')
```

| 欄位 | 意思 |
|---|---|
| `type` | `"open-file"` |
| `path` | 檔案的 host 絕對路徑。一律用 `/` 分隔，所以 Windows 路徑長成 `C:/work/notes.md`。有行號時會帶。 |
| `line` | 1-based 行號；opener 沒帶就沒有這個欄位。 |
| `address` | 原本的 `dsh-resource://file/…` 位址，給接收端記 log 或想自己解析時用。 |

接收的擴充把 `vscode.Uri.file(path)` 開起來、跳到 `line`。沒有外層的頁面（直接用瀏覽器開 GUI）什麼都不丟，照原本走文件預覽；叫不出路徑的點擊也一樣。`path` 是送出前先解好的：`absolute` 位址本來就帶著完整路徑；`session` 位址帶相對路徑時，透過 host 的 `remote.workspaceFiles.stat` 解析 —— host 手上有那個 session 的工作區根，只有存檔沒有活著的 session 也答得出來。解析兩秒內沒回來，這次點擊就退回預覽。

### 外部連結

訊息裡的連結是帶 `target="_blank"` 的錨點，而 webview 擋掉那個彈窗：點了完全沒反應。所以外部連結也照同一條路往上丟，由接收的擴充請編輯器自己跳確認：

```js
window.parent.postMessage({ type: 'open-link', url: 'https://example.com/…' }, '*')
```

只認 `http` 與 `https`，而且 origin 要和頁面自己的不同 —— app 自己的路由、`mailto:`、`dsh-resource://` 位址都維持產品原本的處理。掛兩道門，app 用哪種方式開連結都攔得到：document 的捕捉層 `click`（shell 實際走的就是這道，它把連結渲染成錨點、讓瀏覽器自己跟隨），以及 `window.open` 的 patch（新分頁路線）。同一次點擊不會送兩次；沒有外層的頁面完全不動。

## 疑難排解

| 症狀 | 先檢查什麼 |
|---|---|
| 沒出現 URL 檔 | 那一列在不在 `dsh.profile.bundles`（`dsh --profile web --dump-config`），以及 host 有沒有印 `dsh web: login URL written to …`。 |
| 檔案裡的網址被拒絕 | 權杖只屬於一次啟動。被硬殺留下的檔案是舊的，重開 `dsh web`。 |
| 點檔案還是開側欄預覽 | 這個頁面沒有被內嵌（直接用瀏覽器分頁開沒有擴充可以接），或設定成 `openFileIn: preview`。 |
| 點檔案完全沒反應 | 點擊已經丟給面板，面板那一側沒接：確認擴充有裝、有啟用，並看瀏覽器 console 的 `[dsh-vscode-bridge]` 警告。host 兩秒內叫不出路徑的檔案是退回預覽（不是沒反應），所以完全沒反應代表連預覽那條也失敗了。 |
| 複製鈕沒進系統剪貼簿 | VS Code 擴充沒裝或沒啟用，或頁面不在 webview 裡。 |
| 點外部連結還是沒反應 | 擴充沒裝或沒啟用（沒有 `open-link` 的接收端），或這個頁面沒有被內嵌。輸出面板（來源 DSH）沒有 `[OpenExternal]` 那行，代表這半邊沒送出去。 |
| 面板裡每個 `/api` 都回 401 | 放寬 cookie 的那半沒載入 —— bundle 不在 profile 裡，或 app 的 cookie 形狀變了。 |
| 改了設定卻沒生效 | patch 會整份取代目標行的 `config`，要重寫每個鍵；`lib/client.js` 的改動要重啟 dsh。 |

## 為什麼沒有 `--url-file` 參數

官方 Web app 的 commander program 既沒有 `allowUnknownOption()`，也不接受多餘的 operand —— 它不認識的參數會在任何一列讀到之前就讓啟動失敗，而樹外的組合包改不了隨附的 app。所以目的地放在這一列的 config 裡，預設是 Web profile 目錄下的 `web-url.txt`。

## 移除

先刪掉 patch 裡覆蓋它的那一列，再：

```powershell
dsh plugin --profile web remove dsh-vscode-bridge
```

先移除套件會讓那一層指向不存在的套件，profile 起不來。

## 開發

```powershell
dsh plugin --profile web add link:/absolute/path/to/dsh-vscode-bridge
```

`link:` 安裝把 profile 指到你的 checkout，所以改 `index.js` 就是改到本體 —— 但 Node 對 ESM 有快取，重啟 profile 才會生效。`lib/client.js` 同理，它在啟動時就組成。

## 狀態

早期預覽，`0.2.x`。這個組合包刻意保持小：寫一個檔案、回答一條判定路由、往上丟兩種訊息。它不啟動任何程式，也沒有自己的 VS Code 偵測。

## 授權

[MIT](LICENSE)
