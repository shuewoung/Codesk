# 协议（三窗口共同遵守）

改消息先改本文件。应用协议 = 现有 Hub REST/WS。中继只多一层信封。

## 应用协议（Hub ↔ Web，经中继时放在 `payload`）

### REST

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/threads` | 列表 + config + quota |
| POST | `/api/threads` | 新建 |
| POST | `/api/threads/rename` | 重命名 |
| GET | `/api/thread-history` | `threadId` `all` `baseRev` |
| GET | `/api/workspace-tree` | `cwd` |
| GET | `/api/file` | `path` `cwd` |
| POST | `/api/upload` | 附件 |
| GET | `/api/models` | 模型 |
| GET/POST | `/api/skills` `/api/skills/config` | 技能 |
| GET/POST | `/api/mcp-servers` `.../reload` | MCP |
| GET | `/api/search` | 会话内搜索 |
| GET/POST | `/api/push/public-key` `/api/push/subscribe` | 本机 PWA Web Push |

鉴权后新增（Hub 实现，Web 调用）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/login` | `{ password }` 或 `{ token }` → cookie |
| POST | `/api/auth/logout` | 清 cookie |
| GET | `/api/auth/status` | 是否已登录、`hubId`、中继态（无需登录） |
| GET | `/api/discover` | 未登录探测本机 Hub：`{ ok, hub, port, hubId }` |
| GET | `/api/auth/pair-code` | 向中继申请一次性配对码（需已登录） |
| GET | `/api/host/status` `/api/host/clients` `/api/host/pair-code` | 本机主机台，仅 127.0.0.1 |
| POST | `/api/host/kick` | `{ kind: "lan"|"relay", id }` 踢客户端，仅 127.0.0.1 |

中继新增（仅 VPS）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/relay/pair` | `{ code }` → `{ deviceToken, hubId }` |
| POST | `/api/relay/revoke` | 吊销本设备 |
| GET | `/api/relay/hubs` | 当前 token 能看的 Hub 在线态 |
| GET | `/api/relay/devices` | Hub 凭证列出该 Hub 设备 |
| POST | `/api/relay/kick` | Hub 凭证踢掉 `{ deviceId }` |

### 本机鉴权

- 本机打开 `http://127.0.0.1:18990` / `http://localhost:18990`：回环且 Origin 为空或同端口，视为已登录，不需要配对码或口令。局域网 IP 与中继仍要码。
- 未登录：除 `/api/auth/login` `/api/auth/logout` `/api/auth/status` `/api/discover` 和静态资源外，所有 `/api/*` 返回 `401`；WS 升级拒绝。
- 未登录不得读 `~/.codex`、不得跑命令、不得上传。
- Cookie 名仍是 `onedesk_session`（兼容已配对设备），`Path=/`，`HttpOnly`，`SameSite=Lax`。HTTP 与 WS 同一套：Cookie、`Authorization: Bearer <session|口令>`，或 query `?token=<session>`。对外产品名是 Codesk，协议字段不改。
- 浏览器 WebSocket 不能自定义头。Expo Web / 跨端口页面连局域网 Hub 时用 `ws://<hub>/?token=<session>`。Hub 与中继都认 query token。
- `GET /api/auth/status` → `{ success, loggedIn, configured, hubId, relay: { configured, online, url } }`。不要返回 `hubSecret`、口令、`auth.json`。
- `GET /api/discover` → `{ ok: true, hub: true, port, hubId }`。未登录可访问。不要返回口令、配对码、`hubSecret`、密钥。`port` 是当前监听端口。
- 局域网跨 Origin（至少开发态 Expo Web，如 `http://localhost:8081`、`http://127.0.0.1:8081`，以及 `http(s)://<私网IP>:<任意端口>`）允许 CORS：反射允许的 `Origin`，`GET`/`POST`/`OPTIONS`，允许 `Content-Type` 与 `Authorization`。不允许任意公网 Origin。不要把口令或配对码放进 CORS 响应。
- `GET /api/auth/pair-code` → `{ success, code, expiresAtMs, relayOnline, pairUrl, hubE2ePub }`。
- `pairUrl` 给手机扫**出门码**：`http(s)://<中继>/?pair=<code>&hk=<hubE2ePub>&lan=<hubLanUrl>`。`hk` 是 Hub 长期公钥。`lan` 是 Hub 当前局域网地址（如 `http://192.168.1.8:18990`）。
- **两套码不要混：** 家里码 = Hub 常驻 `lanCode`，只 `POST <hub>/api/auth/login`。出门码 = 中继一次性 `pair`，只 `POST /api/relay/pair`。主机台左边是家里，右边是出门。手输必须让用户选哪一种。
- 扫出门码后：只兑换出门码。不要用出门码去登录家里。仅当本机已存家里口令且 `lan` 探通时，才改走家里直连。未连家里 WiFi 不要扫网段。不要做成 WebRTC。

### WebSocket 应用消息（已有，禁止改名）

客户端 → 服务端：`get_threads` `get_config` `update_config` `create_thread` `rename_thread` `get_thread_history` `send_message` `send_steer` `send_stop` `send_approval` `get_file` `get_models` `get_workspace_tree` `upload_file` `search_thread` `register_push`

服务端 → 客户端：`thread_list` `config_data` `thread_created` `thread_renamed` `thread_history` `thread_update` `approval_request` `action_feedback` `ping` `file_data` `models_list` `workspace_tree` `upload_result` `search_results`

`send_approval` 可带可选 `kind`（`command` / `file` / `permissions`，或 app-server 方法名）。`decision`：`accept` | `acceptForSession` | `denied`（Hub 归一化，不改消息名）。有活锁时 Hub 走 follower；无活锁仍走本端 `decideApproval`。

`/` 菜单项当普通 `send_message` 文本发出（`/review` `/compact` `/init` `/status` `/plan`），不另起 type。`/model` `/reasoning` `/mcp` 只打开已有前端菜单。

### 命令面板 / 只读 Git（新增 type）

客户端 → 服务端：

```json
{ "type": "run_command", "threadId": "...", "command": "echo hi" }
{ "type": "git_status", "threadId": "...", "action": "all" }
```

`git_status.action`：`status` | `diff` | `log` | `all`（默认 `all`）。cwd 以该 thread 为准，客户端不要另传可写路径。

服务端 → 客户端：

```json
{ "type": "command_output", "threadId": "...", "runId": "...", "stream": "stdout", "chunk": "hi\n" }
{ "type": "command_output", "threadId": "...", "runId": "...", "stream": "stderr", "chunk": "" }
{ "type": "command_output", "threadId": "...", "runId": "...", "stream": "exit", "exitCode": 0, "signal": null, "cwd": "..." }
{ "type": "git_status", "threadId": "...", "cwd": "...", "action": "all", "status": "", "diff": "", "log": "", "error": null }
```

不是真 PTY。Git 只读，即使 Desktop 持锁也只读。

### 出门读文件 / 模型目录（WS，中继可转发）

中继不代理业务 REST。Expo 出门预览文件、拉模型列表走 WS，放在 `fwd.payload` 里。

```json
{ "type": "get_file", "threadId": "...", "path": "src/a.ts", "cwd": "" }
{ "type": "file_data", "threadId": "...", "path": "src/a.ts", "fileName": "a.ts", "ext": ".ts", "encoding": "utf8", "content": "...", "truncated": false, "error": null }

{ "type": "get_models" }
{ "type": "models_list", "models": [{ "id": "gpt-5.4", "displayName": "gpt-5.4", "description": "", "supportedReasoningEfforts": [] }] }
```

- `get_file.path` 可以是绝对路径或相对 `cwd` / 该 thread 工作目录。
- `encoding`：`utf8` 文本，`base64` 图片或二进制。单文件读取上限约 800KB，超出 `truncated=true`。
- 找不到或读失败：`content` 为空，`error` 为短文案。
- `thread_list` / `config_data` 可带可选 `hostName`（本机 Windows 计算机名）。没有就不传。
- `get_models` 与 `GET /api/models` 同一份目录，含每模型 `supportedReasoningEfforts` / `defaultReasoningEffort`。当前选用的模型仍走 `get_config` / `update_config`（`key`: `model` | `effort` | `permission`）。思考强度选项跟当前模型走，不要写死。
- `get_thread_history` 可带 `all: true` 拉更早记录（上限与 REST `?all=true` 相同）。默认只给尾部窗口。
```json
{ "type": "get_workspace_tree", "threadId": "...", "cwd": "" }
{ "type": "workspace_tree", "threadId": "...", "cwd": "...", "rootName": "...", "tree": [], "error": null }

{ "type": "upload_file", "threadId": "...", "name": "a.jpg", "mime": "image/jpeg", "encoding": "base64", "content": "..." }
{ "type": "upload_result", "threadId": "...", "path": "C:\\\\...\\\\hub-uploads\\\\uuid.jpg", "name": "a.jpg", "error": null }

{ "type": "register_push", "vendor": "jpush", "registrationId": "..." }
```

- `get_workspace_tree` 的 cwd 默认该 thread 工作目录；树深度与 REST `/api/workspace-tree` 相同（约 2 层）。
- `upload_file` 经中继，单文件解码后上限 4MB。成功后客户端把 `path` 放进 `send_message.input` 的 `localImage` 或 `mention`。更大文件仍走局域网 `POST /api/upload`。
- `register_push`：原生 Android 把极光 `registrationId` 交给 **自己的 Hub**。Hub 再经出站连接发给中继 `push_register`。审批/任务完成时 Hub 发 `push_send`，由中继调极光 REST，只推该 Hub 名下的 RID。Master Secret 只在中继。Expo Go / Web 拿不到 RID。

## 中继信封

Hub 出站、手机连 VPS，外层都是：

```json
{ "v": 1, "type": "register_hub|request_pair_code|pair_code|pair|fwd|ping|pong|hub_offline|e2e_hello|e2e_welcome|push_register|push_send|error", "hubId": "...", "deviceId": null, "payload": {}, "enc": null }
```

- `register_hub`：`payload` = `{ hubSecret }`。首次登记可带 `inviteCode`（中继邀请开通）。禁止夹带 `auth.json` / access token / 本机口令。
- `request_pair_code`：Hub 向中继要一次性码。
- `pair_code`：中继回 `{ code, expiresAtMs }`。
- `pair`：手机提交一次性码（也可用 REST `/api/relay/pair`）。
- `fwd`：出门必须带 `enc`（见 [06-e2e.md](06-e2e.md)），`enc.ct` 解开后才是一条完整应用协议消息。禁止同时带明文 `payload`。可选 `deviceId`，Hub 回包原样带回；无 `deviceId` 时中继向该 Hub 已配对设备广播同一 `enc`。
- `e2e_hello` / `e2e_welcome`：握手密文，中继当不透明转发，不要当应用消息解析。
- `ping`/`pong`：两侧保活。不要把应用层 `ping` 再包进 `fwd`。
- `hub_offline`：只发给该 Hub 的设备。
- `error`：`{ code, message }`，不要把内部堆栈传出去。
- `push_register`：仅已登记 Hub。`payload = { registrationId }`。中继把 RID 绑到该 `hubId`（同一 RID 换 Hub 则改绑）。回 `{ ok: true }`。
- `push_send`：仅已登记 Hub。`payload = { title, body, tag }`。中继只向 **该 Hub 已登记 RID** 调极光，禁止 `audience: all`、禁止 Hub 指定别人的 RID。回 `{ ok, n }`。未配 Secret 时 `ok: false`（`push_unconfigured`），不断开连接。

手机和 Hub 连中继都走 `https://hub.codesk.icu:8787`（Let’s Encrypt，端口仍是 8787，不用 443）。不要把 Cloudflare 边缘证书拷到 VPS。

手机连中继的 WS：原生客户端用 `Authorization: Bearer <deviceToken>`。浏览器 WebSocket 不能自定义头，Web 用同一条连接加 query：`wss://hub.codesk.icu:8787/?token=<deviceToken>`。中继两种都认。Hub 出站用 `hubId` + `hubSecret`。

中继对 localhost / 127.0.0.1 / 局域网私网 Origin 允许 CORS（含 OPTIONS），方便 Expo Web 调 `POST /api/relay/pair`。不要对任意公网 Origin 开放。

## 鉴权关系

```
局域网:  浏览器 --本机口令 cookie--> Hub
出门:    浏览器 --配对 deviceToken--> 中继 --已登记出站连接--> Hub
```

中继不得用本机口令登录 Hub。Hub 从中继进来的转发视为「已由中继验过的设备」，但仍只处理自己的 `hubId`。

禁止把 `auth.json`、Codex access token、本机口令、`hubSecret` 发给前端。`hubSecret` 只出现在 Hub→中继的 `register_hub`。

## 连接策略（Web）

1. 若用户选了局域网地址（或探测 `:18990` 成功）→ 直连 Hub
2. 否则连 VPS WSS，`fwd` 到上次配对的 `hubId`
3. 两种都失败 → 「主机离线」

局域网探测只走 HTTP `GET /api/discover`（浏览器不能做 mDNS/UDP，也不扫 `1-254`）。顺序：

1. 当前页已在 `:18990`，或 `origin` 就是 Hub → `window.location.origin`
2. 上次登录成功的 `lanUrl`
3. `http://127.0.0.1:18990`、`http://localhost:18990`
4. `http://<当前页 hostname>:18990`（hostname 是局域网 IP 时；原生可用 Expo `debuggerHost`）
5. 最多再试同网段 `.1` / `.2` 两三个常见地址。每地址超时约 400ms，失败静默。

探测成功只自动填局域网地址并提示「已发现本机 Hub」，仍要用户输入电脑上的 6 位码再 `POST /api/auth/login`。不要自动登录、不要自动 pair。

出门时业务 REST 仍只打 Hub。页面若是中继静态站：会话走 WS 信封；`/api/file` 等 REST 仅在已选局域网地址时发往该 Hub。中继不代理业务 REST。

正式壳是 Expo（`apps/mobile`，含 `npx expo start --web`）。旧 PWA 仍由 Hub 在 `:18990/` 提供，不要拆。开发态 Expo Web 与 Hub 不同端口，靠 CORS + 上述探测；下一步若要把 Expo 静态包挂到 Hub 做 same-origin，另开窗口。

Web 入口 URL 只在 `connectWS()` / `apiUrl()` 拼接，不要写死公网 IP。未登录不拉 `/api/threads`。收到 `hub_offline` 或探测失败显示「主机离线」，不是无限转圈。
