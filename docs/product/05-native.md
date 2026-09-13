# 5. Expo 客户端（窗口 4）

日常电脑 UI 是 Expo Web `:18991`（大屏三栏）。Hub `:18990` 在 18991 在跑时会 302 过去。本窗口只改 `apps/mobile/`。出门 Skill / MCP 走 WS `get_skills` / `get_mcp`。

## 是什么

一套 Expo（React Native）客户端，Android / iOS 同一份代码。出门连 VPS 中继，业务消息仍是 Hub 的 REST/WS，经中继时放在 `fwd` 信封里。

不是套 PWA 的 TWA/Capacitor，不是 Happy 换皮，不是微信小程序，不是第二套协议。

## 和现有产品的关系

| 端 | 目录 | 命运 |
|---|---|---|
| 旧 PWA | `archive/web/`、`archive/web-hub-public/` | 仅归档，不再托管 |
| Hub | `apps/web-hub/server/` | 保留，本窗口禁止改 |
| 中继 | `apps/relay/` | 保留，本窗口禁止改 |
| Expo | `apps/mobile/` | 正式壳（Android / iOS / `expo start --web`） |

协议以 [04-protocol.md](04-protocol.md) 为准。缺字段先改协议文档，再停下来问，不要私自加消息名。

```
出门:  Expo --deviceToken--> 中继 --已登记出站连接--> Hub
局域网（v1 可不做）: Expo --本机口令--> Hub :18990
```

## 已拍板

1. **Expo 单源。** 旧 PWA 已归档；优先 Expo Web + Tailscale / 二维码，APK 专项后置。
2. **Expo，不是安卓原生，也不是先写安卓再移植。**
3. **不 fork Happy。** 不接他们的 `sync/`、socket.io、E2E、`happy` CLI。手感可以像，数据层必须是我们的协议。
4. **不恢复归档 PWA。** 中继协议不改。Hub 可按 [04-protocol.md](04-protocol.md) 增加未登录 `GET /api/discover`、局域网 CORS、以及 WS `?token=`（浏览器不能自定义头）。原生 WS 仍可用 `Authorization: Bearer <deviceToken>`。
5. **出门走中继，家里直连 Hub。** 原生 App 配对页两套入口。日常浏览器走 Expo Web `:18991`；Hub `:18990` 是协议 + 主机台，探测到 18991 时只把**本机**工作台重定向过去。回环免码；从其他电脑打开 Expo Web 时 Hub 用当前主机 `:18990`，只输家里码，不填 IP。公网隧道打开 Expo Web 时用当前页同源（Metro 转到 Hub），不要拼 `:18990`。隧道指到 `:18990` 时不要 302 到 `127.0.0.1`。`hub.codesk.icu` 中继页禁止探测。
6. **token 用 SecureStore。** 扫一次，以后打开自动连。退出才 `POST /api/relay/revoke`。
7. **电脑休眠 = 主机离线。** UI 显示「主机离线」。
8. **Claude Code / OpenCode 页签本窗口不做。**

## 窗口 4 负责

- 维护 `apps/mobile/`（自己的 `package.json`、Expo SDK）
- 只改本分册；跨界写 [04-protocol.md](04-protocol.md)
- 一份短 README：怎么 `expo start`、怎么填中继地址、怎么打开发包

## 不准做

- 不要改归档 PWA、`apps/relay/`、`docs/PLAN.md`
- 不要建仓库根目录 `android/` `ios/`
- 不要把 `archive/web-hub-public/app.js` 搬进 RN
- 不要抄 slopus/happy 的加密和同步
- 不要 Web Push / VAPID。不要上架、不要冒充 Happy

## v1 范围（按序，做完再往下）

### 1. 脚手架

- `apps/mobile/`：Expo + TypeScript
- 可配置 `RELAY_URL`（设置页可改，默认空，首次必填）
- 开发用 Expo Go 即可，不必先 EAS

### 2. 配对

- 配对页拆两块，文案对齐主机台：
  - **家里**：家里码 + 电脑局域网地址 → `loginLan`（`POST <hub>/api/auth/login`）
  - **出门**：出门码或扫右边二维码 → `pair`（`POST {RELAY_URL}/api/relay/pair`）
- 相机只扫出门 QR：`http(s)://<中继>/?pair=<code>&hk=<hubE2ePub>&lan=...`
- 成功：LAN session 或 `deviceToken` + `hubId` 写入 SecureStore。状态文案写「家里直连」或「中继已连接」
- 失败：明确文案，不要白屏。不要做成一个框两用

### 3. 连接

- `wss://<中继>`，请求头 `Authorization: Bearer <deviceToken>`
- 应用消息包进 `{ v:1, type:'fwd', hubId, payload }`
- 收到 `fwd` 拆 `payload`；收到 `hub_offline` 显示「主机离线」
- 断线自动重连（指数退避，上限约 15s）
- 应用层不要再包一层 `ping` 进 `fwd`；保活用信封 `ping`/`pong`

### 4. 会话列表

- 连上后发 `get_threads`
- 渲染 `thread_list`（按项目分组能做就做，做不了就平铺）
- 未配对、未连接、主机离线三种空态分开

### 5. 时间线 + 发送

- 进会话发 `get_thread_history`
- 收 `thread_history` / `thread_update`，先渲染用户/助手文本即可
- 输入框发 `send_message`；停止发 `send_stop`
- 补丁卡、命令卡、子智能体 v1 可折叠成纯文本

### 6. 审批

- 收 `approval_request` 弹出条
- `send_approval`：`accept` / `acceptForSession` / `denied`
- 这是 v1 必须有的，不能只做聊天

### 7. 设置

- 中继 URL
- 当前 `hubId`（可复制）
- 退出：revoke + 清 SecureStore + 回到配对页

## 已上线（v1 + 完善）

| 能力 | 说明 |
|---|---|
| 配对 | 手输 / 扫 `/?pair=`，SecureStore 记 token |
| 中继 WSS | `fwd` 信封、断线重连、`hub_offline` |
| 会话 | 按项目分组、搜索、新聊天 `create_thread`；当前对话可开同目录「辅助会话」（不抢 Desktop 主会话锁） |
| 聊天 | 发消息、运行中 `send_steer`、停止、审批三按钮 |
| 展示 | Markdown、改文件卡、命令卡；点路径 `get_file` 预览 |
| 模型 | 底栏芯片：模型 / 推理 / 权限 |
| 会话顶栏 | 上下文环、项目+绿/红点+主机、⋯ 置顶/复制ID/重命名/开辅助会话/归档 |
| 设置 | 浅/深色、中继 URL、hubId、访问权限、退出吊销 |
| 导航 | 左栏会话（项目可折叠/置顶/最近），右栏文件树 |
| 附件 | 拍照 / 选图 / 选文件，经 `upload_file` 再随消息发出 |
| 用量 | 右栏底部：账号剩余 + 上下文剩余 |
| 预览 | `.md` 渲染 Markdown；图看图；其它纯文本 |
| 品牌 | 产品名 Codesk |

协议增量见 [04-protocol.md](04-protocol.md)：`get_file` / `get_models` / `get_workspace_tree` / `upload_file`。Hub 已实现。

## 已有能力与后续验收

当前源码已包含出门 E2E（[06-e2e.md](06-e2e.md)）、斜杠命令、重命名会话、Git/命令/交互终端、局域网直连及 REST 上传、会话内搜索，不再将这些列为待从零新增的功能。极光推送的 Expo Go 无 RID；正式 Android 包使用 `register_push`，iOS 能力需单独验收。

本轮重点是这些能力在断线、慢网、失败和切换会话时的可靠性，以及附件来源、产物分区和文件原件获取。完整任务与实际验收结论见 [09-ux-improvements.md](09-ux-improvements.md)，不能以源码存在代替发布或真机验收。

## Expo Web

开发态正式入口是 `apps/mobile` 的 `npx expo start --web` → `http://localhost:18991`，Hub `:18990` 托管 Expo 静态导出。不要把 `archive/web/app.js` 抄进 RN。

- Web 依赖按 SDK 54 用 `npx expo install react-dom react-native-web @expo/metro-runtime`。
- 配对页自动 HTTP 探测本机 Hub（见 04-protocol），不要手填默认局域网 IP。
- Web 隐藏相机扫码；推送 no-op；存储先试 SecureStore，不行就 `localStorage`。
- Web 认 `#thread-<uuid>`（也认 `?threadId=`）。打开时若带会话 ID：先不渲染任何会话，等 WS `connected` 再 `get_thread_history`；切会话用 `replaceState` 写成 hash。配对 query `?pair=` 不动。
- 出门地址是 `https://hub.codesk.icu:8787`。Android 必须 `expo-crypto` 给 tweetnacl 补 PRNG，否则握手停在「正在连中继」并报 `no PRNG`。
- 本窗口不打 EAS 上架；Expo 静态包已通过 `export:web` 供 Hub 同源托管。已装的旧 APK 不含上述修复，须重打。

## 界面改版（对照官方 Remote，不 1:1）

对照 ChatGPT App Remote 截图，只学信息架构和对比度，不复刻插件/语音/多主机/虚拟宠物。

### 列表页

官方：顶栏主机绿点 → **项目只显示文件夹** → **最近**扁平会话+相对时间 → 底栏搜索 + 黑圆「新聊天」。

我们做：

- **窄屏先列表后会话。** 宽度不到 1100 不自动打开第一条；列表是首页，点进会话用返回回到列表。宽屏仍三栏。
- **连接过程可见。** 中继：连接中继 → 设备鉴权 → 加密握手 → 同步工作区。局域网跳过加密。失败写人话（旧 APK、没 `hk=`、主机离线）。
- **项目默认真叠。** 只展开「当前打开会话所在项目」；点文件夹才开合。搜索时全部展开并过滤。工作区行可带本机路径。
- **置顶。** `thread.isPinned` / `project.isPinned` 单独一节，在项目之上。`togglePin` 发 Hub `pin_item`，不要只写本机 `onedesk.pins`。项目文件夹长按同样走 Hub。
- **归档。** `archiveThread` 发 `archive_item`，不要只写本机 `onedesk.archived`。
- **最近。** 全量按 `mtimeMs` 取约 20 条，标题 + 相对时间（2分钟），不套在项目里。
- 顶栏：返回不必；一行主机状态（绿点+在线/离线）。右上 `⋯` → 添加配对 / 设置。
- 底栏：圆角搜索 + 黑圆新聊天。新聊天先弹出「选择项目」（当前目录 / 最近项目 / 无项目），再 `create_thread`。

### 聊天页

官方：用户=黑胶囊白字靠右；助手=左侧白底纯字；过程默认看不见；输入在底栏胶囊，键盘顶起来。

我们做：

- **用户消息：** 深色胶囊、白字、靠右（浅色主题黑底，深色主题浅灰底）。
- **助手消息：** 无卡片、通栏、只留 Markdown 正文。下挂复制。
- **默认藏过程：** 推理块默认折叠成一行「思考」，点开展开。命令卡默认折叠。改文件卡收成一行「改了 x 个文件 +N -M」，点开再看补丁或预览。审批条保留。
- **可选「显示过程」。** 设置里关开，默认关。
- **顶栏：** 返回 + 中间标题胶囊（标题 / 项目名 / 主机）+ 状态 + `⋯`（复制 threadId、重命名）。
- **输入区上方：** 模型、权限两个浅灰芯片（已有数据）。
- **输入区：** `+` | 圆角输入（「在 {主机} 上…」）| 发送。早期“只放换项目/新聊天”的范围已被后续附件实现替代；本轮区分“从当前设备上传”和“从宿主机选择”，保留拍照/相册入口，不新增语音。
- **键盘：** Android `softwareKeyboardLayoutMode=resize` + 用键盘高度把底栏顶上去，禁止被输入法挡住。

### 明确不做（官方有、我们本轮没有）

本轮不新增多主机切换、离线自动发送队列、解锁 Remote、虚拟宠物、插件管理或语音。照片上传与计划展示已经在后续源码中实现，不再列为未实现项。

### 验收

- 列表先看到项目名和最近会话，不会一屏全是展开的对话
- 打开某会话后，只有该项目展开
- 用户泡和助手字一眼能分开
- 时间线默认几乎只有人话
- 点输入框，输入条贴在键盘上方

---

## UI

- 中文 UI。手感学官方 Remote 的层次，不像素级复刻。

## 验收

- 电脑主机台生成长期配对码，Expo 扫一次（或手输）进入
- 杀进程再开，不用再扫，直接进上次 Hub
- Hub 在线：能看到会话、能发、能批
- 关掉 Hub：数秒内看到「主机离线」，不是转圈
- 退出后旧 token 失效
- `git checkout pwa-stable` 后 PWA 行为与 `a562688` 一致
- 本窗口 diff 基本只在 `apps/mobile/` 和本分册

## 新窗口怎么开

1. `git checkout feat/expo-client`（没有则从 `pwa-stable` 拉）
2. 只读：本文件 + `04-protocol.md` + `03-relay.md` + [SYNC.md](SYNC.md)
3. 只写：`apps/mobile/` + 本文件
4. 按上面 1→7 做；做到第 6 项能验收就可以停，不要膨胀

开场提示词可直接复制：

```
你在 Codesk 仓库的 feat/expo-client 分支。只做 docs/product/05-native.md 里的 Expo v1。
禁止改 apps/web-hub/ 和 apps/relay/。协议见 docs/product/04-protocol.md。
先建 apps/mobile/，按分册第 1→7 步做：配对、SecureStore、中继 WSS、会话列表、发消息、审批。
做完第 6 步就停，跑通验收项。
```
