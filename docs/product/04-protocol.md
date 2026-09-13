# 协议（三窗口共同遵守）

改消息先改本文件。应用协议 = 现有 Hub REST/WS。中继只多一层信封。

## 应用协议（Hub ↔ Web，经中继时放在 `payload`）

### REST

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/threads` | 列表 + config + quota |
| POST | `/api/threads` | 新建 |
| POST | `/api/threads/rename` | 重命名 |
| POST | `/api/threads/pin` | 置顶/取消置顶。`{ id, kind: "thread"\|"project", pinned }`。先写入 `pins.jsonl` sidecar，安全时再物化到 Desktop |
| POST | `/api/threads/archive` | 归档/取消归档。`{ id, archived }`。先写入 `archives.jsonl` sidecar，安全时再写 sqlite `threads.archived` |
| GET | `/api/thread-history` | `threadId` `all` `baseRev` |
| GET | `/api/workspace-tree` | `cwd` |
| GET | `/api/file` | `path` `cwd` 可选 `raw=1` |
| POST | `/api/upload` | 附件 |
| GET | `/api/models` | 模型 |
| GET/POST | `/api/skills` `/api/skills/config` | 技能 |
| GET/POST | `/api/mcp-servers` `.../reload` | MCP |
| GET/POST | `/api/plugins` `/api/plugins/config` | 已安装插件列表；POST `{ id, enabled }` 写 `config.toml` |
| GET | `/api/search` | 会话内搜索 |
| GET/POST | `/api/push/public-key` `/api/push/subscribe` | 本机 PWA Web Push |

鉴权后新增（Hub 实现，Web 调用）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/login` | `{ password }` 或 `{ token }` → cookie |
| POST | `/api/auth/logout` | 清 cookie |
| GET | `/api/auth/status` | 是否已登录、`hubId`、中继态（无需登录） |
| GET | `/api/discover` | 未登录探测本机 Hub：`{ ok, hub, port, hubId }` |
| GET | `/api/auth/pair-code` | 向中继申请长期配对码（需已登录） |
| GET/POST | `/api/thread-goal` | 当前会话目标。GET `threadId`；POST `{ threadId, objective }`，空 objective 清除 |
| GET | `/api/host/status` `/api/host/clients` `/api/host/pair-code` | 本机主机台，仅 127.0.0.1 |
| POST | `/api/host/pair-code` | 手动撤销旧配对码并生成新码；不撤销已配对设备。仅 127.0.0.1 |
| POST | `/api/host/kick` | `{ kind: "lan"|"relay", id }` 撤销设备凭证并断开连接，仅 127.0.0.1 |
| POST | `/api/host/lan-code` | `{ code }` 设 4 位家里码；空则随机。仅 127.0.0.1 |
| POST | `/api/host/sync-pins` | 尝试把 sidecar pin 物化进 Desktop `global-state.json` / sqlite。仅 127.0.0.1。Desktop 正在跑时返回 `pending`，不抢 writer |

中继新增（仅 VPS）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/relay/pair` | `{ code }` → `{ deviceToken, hubId }` |
| POST | `/api/relay/revoke` | 吊销本设备 |
| GET | `/api/relay/hubs` | 当前 token 能看的 Hub 在线态 |
| GET | `/api/relay/devices` | Hub 凭证列出该 Hub 设备 |
| POST | `/api/relay/kick` | Hub 凭证踢掉 `{ deviceId }` |

### 本机鉴权

- 本机打开 `http://127.0.0.1:18990` / `http://localhost:18990`，或本机 Expo Web `http://127.0.0.1:18991` / `http://localhost:18991`：回环且 Origin 为空、Hub 端口或 Expo Web 端口 `18991`，视为已登录，不需要配对码或口令。局域网 IP 与中继仍要码。不要信任其它本机端口。
- 未登录：除 `/api/auth/login` `/api/auth/logout` `/api/auth/status` `/api/discover` 和静态资源外，所有 `/api/*` 返回 `401`；WS 升级拒绝。
- Cloudflare Tunnel / Zero Trust 进来的请求（带 `CF-Connecting-IP`、`Cf-Access-Jwt-Assertion`、`X-Forwarded-For`、`X-Forwarded-Proto` 等）不算本机回环，不能免登录。主机台 `/host` 同样拒绝。
- 公网域名打开 Expo Web（隧道指到 `:18991`，如 `https://cds.zhangsw.work`）时，Hub 地址是**当前页同源**，不要再拼公网 `:18990`。Expo HTTP 服务器在 CORS 之前把 `/api` 和 `/api/ws` 转到本机 Hub `:18990`，保留原 `Host`，并转发 `X-Forwarded-*` / `CF-*`。隧道若指到 Hub `:18990`，Metro 在跑也不要把浏览器 302 到 `127.0.0.1`，应托管 `dist-web`。家里直连 WS 用 `/api/ws?token=`。局域网 IP 上的 Expo Web 仍连同主机 `:18990`。Cloudflare Access 若挡 WebSocket，页面能开也会连不上服务。
- `GET /api/file?raw=1`：png/jpg/gif/webp/bmp/ico/svg 返回图像字节；html/htm/pdf/txt/csv/md/json 按 MIME 返回；目录返回 HTML 列表。Office（doc/docx/xls/xlsx/ppt/pptx）若同目录有 `.web-preview/<同名>.pdf|.html` 则返回预览，否则按附件下载。鉴权与普通 `/api/file` 相同。对话里的本机绝对路径（文件和目录）由 Web 改写成这个 URL，不走中继。
- 未登录不得读 `~/.codex`、不得跑命令、不得上传。
- Cookie 名仍是 `onedesk_session`（兼容已配对设备），`Path=/`，`HttpOnly`，`SameSite=Lax`。HTTP 与 WS 同一套：Cookie、`Authorization: Bearer <session|口令>`，或 query `?token=<session>`。对外产品名是 Codesk，协议字段不改。
- 浏览器 WebSocket 不能自定义头。Expo Web / 跨端口页面连局域网 Hub 时用 `ws://<hub>/?token=<session>`。Hub 与中继都认 query token。
- `GET /api/auth/status` → `{ success, loggedIn, configured, hubId, relay: { configured, online, url } }`。不要返回 `hubSecret`、口令、`auth.json` 或 Codex access token。
- Hub **本机读** `~/.codex/auth.json` 里的 `tokens.access_token` 去拉 ChatGPT 用量，只把套餐名 / 已用百分比 / 重置时间放进 `thread_list` / `config_data` 的 `quota`。禁止把 `auth.json` 文件或 token 发给中继、前端或日志。
- `GET /api/discover` → `{ ok: true, hub: true, port, hubId }`。未登录可访问。不要返回口令、配对码、`hubSecret`、密钥。`port` 是当前监听端口。
- 局域网跨 Origin（至少开发态 Expo Web，如 `http://localhost:18991`、`http://127.0.0.1:18991`，以及 `http(s)://<私网IP>:<任意端口>`）允许 CORS：反射允许的 `Origin`，`GET`/`POST`/`OPTIONS`，允许 `Content-Type` 与 `Authorization`。不允许任意公网 Origin。不要把口令或配对码放进 CORS 响应。
- `GET /api/auth/pair-code` → `{ success, code, expiresAtMs, relayOnline, pairUrl, hubE2ePub }`。长期码 `expiresAtMs: null`；GET 复用有效码，不自动换码。主机台 POST 手动换码，设备凭证独立撤销。
- `pairUrl` 给手机扫**出门码**：`http(s)://<中继>/?pair=<code>&hk=<hubE2ePub>&lan=<hubLanUrl>`。`hk` 是 Hub 长期公钥。`lan` 是 Hub 当前局域网地址（如 `http://192.168.1.8:18990`）。
- **两套码不要混：** 家里码 = Hub 常驻 `lanCode`，只 `POST <hub>/api/auth/login`。出门码 = 中继长期 `pair`，只 `POST /api/relay/pair`。主机台左边是家里，右边是出门。手输必须让用户选哪一种。
- 扫出门码后：只兑换出门码。不要用出门码去登录家里。仅当本机已存家里口令且 `lan` 探通时，才改走家里直连。未连家里 WiFi 不要扫网段。

### WebSocket 应用消息（已有，禁止改名）

客户端 → 服务端：`get_threads` `get_config` `update_config` `create_thread` `rename_thread` `pin_item` `pin_thread` `unpin_thread` `archive_item` `archive_thread` `unarchive_thread` `get_thread_history` `send_message` `send_steer` `send_stop` `send_approval` `get_file` `get_models` `get_workspace_tree` `upload_file` `search_thread` `register_push` `get_goal` `set_goal` `get_skills` `set_skill` `get_mcp` `reload_mcp` `get_plugins` `set_plugin` `search_workspace` `list_artifacts` `stop_command` `run_command` `git_status` `pty_open` `pty_input` `pty_resize` `pty_close`

服务端 → 客户端：`thread_list` `config_data` `thread_created` `thread_renamed` `thread_history` `thread_update` `approval_request` `action_feedback` `ping` `file_data` `models_list` `workspace_tree` `upload_result` `search_results` `goal_data` `skills_list` `mcp_list` `plugins_list` `workspace_search` `artifacts_list` `command_output` `git_status` `pty_data` `pty_exit`

- `file_data` 成功时 `path` 是解析后的绝对路径，同时带请求时的 `requestPath`，客户端按两个 key 缓存，避免 Git 相对路径点进去一直转圈。
- `get_threads` 先回缓存额度；拉到最新额度后用现有 `config_data` 再推一次 `quota`，不要新消息名。
- 局域网大文件走 REST `POST /api/upload`（20MB）；中继 `upload_file` 仍是 4MB。

`action_feedback` 把一次操作的结果对回客户端：

```json
{ "type": "action_feedback", "status": "success"|"error", "threadId": "...", "action": "send"|"steer"|"command"|"create_thread", "interim": false, "message": "..." }
```

- `threadId`、`action`：有则带。客户端用它们对上最后一次 `send_message` / `send_steer` / `run_command`，不要只靠文案。
- `interim: true`：还在等桌面 owner、故意不抢锁。不是最终成功，不要清 lastOutgoing，不要当已经发出去。
- `status: error` 且 `action` 为 `send` / `steer` / `command`：客户端应保留草稿并允许重试，不要只 toast 就丢。

置顶走 sidecar，不抢 Desktop turn writer：

```json
{ "type": "pin_item", "kind": "thread"|"project", "id": "...", "pinned": true }
{ "type": "pin_thread", "threadId": "...", "pinned": true }
{ "type": "unpin_thread", "threadId": "..." }
```

- `pin_item` 是统一消息。`kind` 缺省 `thread`；`id` 也可用 `threadId` / `projectId`。
- `pin_thread` / `unpin_thread` 是会话别名（`unpin` 视为 `pinned: false`）。
- Hub 立即写入 `~/.codex/pins.jsonl` + 内存 override，广播 `thread_list`（`thread.isPinned` / `project.isPinned` / `pinnedOrder`）。Desktop 空闲（无 live turn、无新鲜 writer-lock、最好进程已退出）时再物化 `.codex-global-state.json` 的 `pinned-thread-ids` / `pinned-project-ids` / `unified-sidebar-pinned-order-v1`，并尝试 sqlite `threads.is_pinned`。
- 失败只保 sidecar，用 `action_feedback` `{ action: "pin_item", status: "success"|"error" }` 回执；物化未完成不算错误。

归档同一套路，只作用于会话：

```json
{ "type": "archive_item", "id": "...", "archived": true }
{ "type": "archive_thread", "threadId": "..." }
{ "type": "unarchive_thread", "threadId": "..." }
```

- Hub 立即写入 `~/.codex/archives.jsonl`，已归档会话从 `thread_list` 消失。
- Desktop 空闲时写 sqlite `threads.archived`。Desktop 在 sqlite 里改归档时，Hub 按集合差分拉回 sidecar 并广播。

`send_approval` 可带可选 `kind`（`command` / `file` / `permissions`，或 app-server 方法名）。`decision`：`accept` | `acceptForSession` | `denied`（Hub 归一化，不改消息名）。有活锁时 Hub `follow` 直播 snapshot，**JSON-RPC `requestId` 优先于 JSONL 条目 id**，`kind` 对不上则回退三种 follower 方法；无活锁仍走本端 `decideApproval`。

`send_message` / `send_steer` 可带可选 `mode`：`plan` | `review`。`plan` 会传给 app-server / follower `collaborationMode: "plan"`。

`/` 菜单不要放分享、侧边、聊天分支、反馈、宠物、用量计费、初始化、推理、快速、新聊天、星标、模型、状态、记忆、重命名。现有项：`/compact` 当普通 `send_message`；`/plan` `/review` 打开专用工作台（规划步骤 / 待审文件），再从页里发出；`/mcp` 打开已有菜单；`/goal` 打开目标面板（`get_goal` / `set_goal`，读写 `~/.codex/goals_1.sqlite`）。

### 跨端工作台扩展（2026-09）

以下为增量协议，保留旧消息名。`hello`、`thread_list`、`config_data` 返回稳定 `hubId` 和 `capabilities`；客户端仅在 `capabilities[命令名] === true` 时启用对应操作。嵌套 `handoff` 能力对象不当作布尔命令开关。

| 请求 | 响应 | 字段与语义 |
|---|---|---|
| `send_message` / `send_steer` | `action_feedback` | 增加稳定 `requestId`、`clientUserMessageId`，回包带 `commandStatus`。同 ID 同内容复用结果，异内容拒绝 `IDEMPOTENCY_CONFLICT` |
| `query_command` | `command_status` | 请求 `requestId` 就是被查询命令 ID；返回 `command: null` 或包含 IDs、threadId、status、result/error 的记录 |
| `get_execution_state` | `execution_state` | `{threadId,requestId}` → `executionState:{threadId,location,status,canHandoff,reason?,pendingUserInputs?}`；location 为 desktop/hub/unknown |
| `handoff_thread` | `handoff_result` | `{threadId,requestId}` → `result,executionState`；仅允许全部 Hub-owned 会话权威 idle 且无在途动作/审批/输入时释放全局 app-server |
| `queue_message` | `queue_list` | `{threadId,text,input?,images?,requestId,clientUserMessageId}` → `queue:{items}`；仅权威 idle 才 dispatch，不隐式转 steer |
| `list_queue` | `queue_list` | `{threadId,requestId}`；无 requestId 的队列更新是状态广播，不应显示主动操作成功提示 |
| `cancel_queued_message` | `queue_list` | `{threadId,queueId,requestId}`；仅取消尚未 dispatch 的 queued 项 |
| `get_draft` | `draft_data` | `{threadId,requestId}` → `draft:{version,text,attachments,updatedAt?}` |
| `save_draft` | `draft_data` | `{threadId,expectedVersion,text,attachments,requestId}`；版本不符返回 `code:CAS_CONFLICT` 和当前远端草稿，不静默覆盖 |
| `get_git_status` | `git_status` | `{threadId,requestId}` → `git:{branch?,statusText?,truncated?}`；cwd 由已知会话解析 |
| `get_git_diff` | `git_diff` | `{threadId,requestId}` → `git:{branch?,diff?,truncated?}`；与 status 按同线程、存在字段合并，不互相清空 |
| `send_user_input` | `user_input_result` | `{threadId,requestId,inputRequestId,answers:{questionId:{answers:[text]}}}` → `{requestId,threadId,result:{ok,code?}}` |

命令状态为 `pending/running/succeeded/failed/uncertain`。`succeeded` 仅表示请求被接受或路由成功，**不表示模型任务完成**。25 秒未获确认、断线或进程重启后的在途动作只能查询，不自动重发；旧协议“错误可重试”的规则不适用于 uncertain。客户端发送前持久化不含正文的待确认 IDs，按稳定 Hub 隔离；恢复时只查询原命令。

`handoff_result.result` 的 `releaseRequested:true` 与 `writerReleaseConfirmed:false` 必须分别呈现；不删除 writer 锁，不把 `thread/unsubscribe` 当成已证实的 writer 释放，不保证 Desktop 已接管。

补充输入推送：`user_input_request:{threadId,requestId,method,payload,at}`，其中 requestId 是执行器 RPC ID；payload.questions 含 id/header/question/isSecret/options。`user_input_resolved` 使用同一个 RPC ID。`send_user_input.requestId` 则是本次回答动作 ID。点击提交不立即移除卡片，收到 resolved 或权威空快照才清除。Desktop IPC 不支持回答时明确拒绝，不发送空答案冒充处理。

`config_data` 增加 `applicationScope`、`confirmation` 与 `message`：model/effort 为 `hub_new_turn_request`，speed 为 `saved_only`，desktopFollower 为 `execution_owner_settings_unconfirmed`，activeTurn 为 `unchanged`。`confirmation.saved` 为 true/false/null（写成功/写失败/读取），`executionConfirmed:false`。Hub 新轮次显式提交模型与推理参数；活动 steer 不改变参数，速度保存不代表 serviceTier 被执行端采用。

安全边界：登录按实际 transport 地址限流并返回 429 与 Retry-After，撤销后的 socket 立即失效。客户端收到明确 unauthorized/revoked 或 4401/4403 时，按当前 transport 失效凭据并停止自动重连，成功重新认证后才恢复；保留稳定 Hub 身份、草稿和待确认命令。普通 1006 网络关闭仍走退避，不能冒充认证失败。Relay 上行 deviceId 来自认证连接，定向响应不得回退广播；下载缺设备身份拒绝。只读 Git 禁用 external diff、textconv、fsmonitor 与用户 clean/smudge/process filter，不写用户 Git 配置。完整验收与未支持能力见 [11-cross-device-workbench.md](11-cross-device-workbench.md)。

### 命令面板 / 只读 Git / 交互终端

一次命令与只读 Git（cwd 以该 thread 为准，客户端不要另传可写路径）：

```json
{ "type": "run_command", "threadId": "...", "command": "echo hi" }
{ "type": "stop_command", "threadId": "..." }
{ "type": "git_status", "threadId": "...", "action": "all" }
```

`git_status.action`：`status` | `diff` | `log` | `all`（默认 `all`）。Git 只读，即使 Desktop 持锁也只读。

```json
{ "type": "command_output", "threadId": "...", "runId": "...", "stream": "stdout", "chunk": "hi\n" }
{ "type": "command_output", "threadId": "...", "runId": "...", "stream": "stderr", "chunk": "" }
{ "type": "command_output", "threadId": "...", "runId": "...", "stream": "exit", "exitCode": 0, "signal": null, "cwd": "..." }
{ "type": "git_status", "threadId": "...", "cwd": "...", "action": "all", "status": "", "diff": "", "log": "", "files": [{ "path": "src/a.ts", "status": "M", "add": 1, "del": 1 }], "error": null }
```

交互终端（Windows ConPTY + PowerShell，Expo 用 xterm）。与 `run_command` 并存：composer 里 `$ ` 仍走一次命令，右栏「终端」走 PTY。

```json
{ "type": "pty_open", "threadId": "...", "cols": 80, "rows": 24 }
{ "type": "pty_input", "threadId": "...", "data": "dir\r" }
{ "type": "pty_resize", "threadId": "...", "cols": 120, "rows": 32 }
{ "type": "pty_close", "threadId": "..." }
{ "type": "pty_data", "threadId": "...", "data": "..." }
{ "type": "pty_exit", "threadId": "...", "exitCode": 0, "signal": null }
```

- `data` 是 UTF-8 文本（可含控制字符）。Hub 把 stdout 按 16–32ms 或满 8KB 合并成一帧 `pty_data`，避免出门每字节一次 E2E。
- 每个 thread 最多一个活 PTY。同一 thread 再 `pty_open` 接到现有壳（重放一小段 scrollback），不先杀。Hub 全局最多 4 个活 PTY，超出关掉最久没用的。
- 客户端断开不立刻杀壳。`pty_close` 或 Hub 退出才关。无 120 秒超时。
- cwd 仍是该 thread 工作目录。`node-pty` 装不上时 `pty_open` 回 `action_feedback` error，一次命令面板仍可用。

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
- `get_models` 与 `GET /api/models` 同一份目录，含每模型 `supportedReasoningEfforts` / `defaultReasoningEffort`。当前选用的模型仍走 `get_config` / `update_config`（`key`: `model` | `effort` | `permission` | `speed`）。思考强度选项跟当前模型走，不要写死。
- `speed` 写入 `config.toml` 的 `service_tier`。取值：`default`（标准）| `fast`（快速）| `flex` | `priority`。`config_data` 带 `speed`。
- `get_thread_history` 可带 `all: true` 拉更早记录（上限与 REST `?all=true` 相同）。默认只给尾部窗口。
```json
{ "type": "get_workspace_tree", "threadId": "...", "cwd": "" }
{ "type": "workspace_tree", "threadId": "...", "cwd": "...", "rootName": "...", "tree": [], "error": null }

{ "type": "upload_file", "threadId": "...", "name": "a.jpg", "mime": "image/jpeg", "encoding": "base64", "content": "..." }
{ "type": "upload_result", "threadId": "...", "path": "C:\\\\...\\\\hub-uploads\\\\uuid.jpg", "name": "a.jpg", "error": null }

{ "type": "register_push", "vendor": "jpush", "registrationId": "..." }
```

- `get_workspace_tree` 的 cwd 默认该 thread 工作目录。可带 `path` 只列该目录的一层子项（`hasChildren` 表示还能展开）。REST `/api/workspace-tree?cwd=&path=` 相同。
- `thread_list` / `thread_history` 可带 `lockHolder`: `"desktop"` | `"hub"` | 缺省空。desktop 表示 writer-lock / IPC owner 在桌面，远程审批走 follower。
- `upload_file` 经中继，单文件解码后上限 4MB。成功后客户端把 `path` 放进 `send_message.input` 的 `localImage` 或 `mention`。更大文件仍走局域网 `POST /api/upload`。
- `register_push`：原生 Android 把极光 `registrationId` 交给 **自己的 Hub**。Hub 再经出站连接发给中继 `push_register`。审批/任务完成时 Hub 发 `push_send`，由中继调极光 REST，只推该 Hub 名下的 RID。Master Secret 只在中继。Expo Go / Web 拿不到 RID。

出门 Skill / MCP 走 WS（与 REST `/api/skills` `/api/mcp-servers` 同一份数据）：

```json
{ "type": "get_skills", "cwd": "" }
{ "type": "skills_list", "skills": [{ "name": "...", "path": "...", "enabled": true, "description": "" }], "error": null }

{ "type": "set_skill", "path": "...", "name": "...", "enabled": false }
{ "type": "skills_list", "skills": [], "error": null }

{ "type": "get_mcp" }
{ "type": "mcp_list", "servers": [{ "name": "...", "authStatus": null, "needsAuth": false, "toolCount": 0, "tools": [] }], "error": null }

{ "type": "get_plugins" }
{ "type": "plugins_list", "plugins": [{ "id": "chrome@openai-bundled", "name": "chrome", "enabled": true, "displayName": "Chrome", "mention": "@chrome", "needsDesktopUi": true }], "error": null }
{ "type": "set_plugin", "id": "chrome@openai-bundled", "enabled": false }

{ "type": "reload_mcp" }
{ "type": "mcp_list", "servers": [], "error": null }
```

### 体验计划增量（2026-09-11，向后兼容）

- 请求可带 `requestId`；history/search/tree/artifacts/get_file/threads 响应（含失败）原样回传，旧请求不强制添加。上传 REST/WS 回传可选 `taskId` / `requestId` / `threadId`（REST query）。
- 文件授权根仅为服务端已知会话 cwd 与 Hub 上传目录；请求 `cwd` 只可选择已授权根内目录，不能扩大权限。所有实际读取路径（含预览 sidecar、树与搜索）须 realpath 校验，拒绝符号链接越界。
- `artifacts_list` 增加 `artifacts` 与 `recentDocuments`，`files` 为 `artifacts` 兼容别名（不再混入近期文档）。真实产物需成功工具明确输出路径和当前文件 stat 证据；近期文档不得冒充产物。元数据包含 `path/name/ext/size/mtimeMs/source`，真实产物 source=`tool_output`、近期文档 source=`recent_document`。产物另带 `threadId/turnId/timestamp/callId/evidence:{toolSuccess:true,outputPath,stat:true}`。
- 产物列表默认只索引最新 `task_started` / `turn_context` 边界后的证据，带 `scope:"latest_turn"`、`turnId`（无真实 ID 时 null）、`startedAt/completedAt`。未发现边界时 `scope:"session_confirmed"`，只能标“会话已确认文件”，不能称“本次产物”。仅读取 rollout 尾部最多 4MiB，`coverage:{truncated,bytesRead,totalBytes,unavailable?}` 明示不完整/不可用；不根据 mtime 推断生成归属。当前采用保守白名单（成功结构化 outputPath/output_path/savedPath/outputPaths，或成功退出且明确 Saved/Created/Written/Output 标签），遗漏比误报优先。
- 原件下载：HTTP `GET /api/file?download=original&threadId=...&path=...` 强制原件，不选择 Office sidecar。返回 `Content-Disposition: attachment; filename*=UTF-8''...` 与完整原件摘要头 `X-File-SHA256`，并通过 `Access-Control-Expose-Headers` 暴露摘要/文件名/长度。最多 20MiB，使用单描述符限量快照读，不在 stat 后无界 readFile。
- WS 请求 `download_file {requestId,threadId,path,cwd?}`，取消 `cancel_download {requestId}`。requestId 必须非空且同连接不可重复；最多 20MiB，每块 262144 字节。依次回 `download_start {requestId,threadId,path,fileName,totalBytes,chunkSize,totalChunks}`、`download_chunk {requestId,seq,encoding:"base64",content,totalBytes}`（seq 从 0 开始）、`download_complete {requestId,totalBytes,totalChunks,sha256}`（原件完整字节 SHA-256 十六进制）。失败回 `download_error {requestId,error,code}`，取消 code=`CANCELLED`。客户端需核对序号、字节数、摘要；失败/取消丢弃部分数据。断连释放任务，慢连接/文件变更可失败，不发送 complete。
- WS 下载每连接最多 2 个、Hub 全局最多 4 个活任务，120 秒总时限；直连发送缓冲超过 1MiB 时等待，15 秒不恢复则 `SLOW_CLIENT`。中继适配器目前不暴露原生发送缓冲，因此另按每块至少 10ms 节流；中继必须提供 deviceId，断链取消，不向设备广播下载。重复活跃 requestId 取消原任务，仅返回一次 CANCELLED 终态；未知取消返回 NOT_FOUND。
- 仅本机 `/api/host/status` 顶层增加 `version/build/launchId/instanceId/pid`；`launchId` 使用环境变量 `CODESK_LAUNCH_ID`，`instanceId` 每进程随机生成。`version` 为 Hub package version，`build` 优先 `CODESK_BUILD`，缺省同 version。

## 中继信封

Hub 出站、手机连 VPS，外层都是：

```json
{ "v": 1, "type": "register_hub|request_pair_code|pair_code|pair|fwd|ping|pong|hub_offline|e2e_hello|e2e_welcome|push_register|push_send|error", "hubId": "...", "deviceId": null, "payload": {}, "enc": null }
```

- `register_hub`：`payload` = `{ hubSecret }`。首次登记可带 `inviteCode`（中继邀请开通）。禁止夹带 `auth.json` / access token / 本机口令。
- `request_pair_code`：Hub 向中继获取长期配对码。
- `pair_code`：中继回 `{ code, expiresAtMs }`。
- `pair`：手机提交长期配对码（也可用 REST `/api/relay/pair`）。
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

禁止把 `auth.json`、Codex access token、本机口令、`hubSecret` 发给前端或中继。Hub 只在本机读 `auth.json` 拉用量。`hubSecret` 只出现在 Hub→中继的 `register_hub`。

## 连接策略

页面从哪来，就按哪条连。不要用探测去猜中继页。

1. **Hub 托管的 Expo Web（`:18990`，来自 `apps/mobile/dist-web`）**：同源就是 Hub。不探测、不扫网、不走中继。回环免码；非回环只输 4 位家里码。
2. **中继页（`hub.codesk.icu` 静态站）**：只出门码配对。禁止 `GET /api/discover`，禁止扫网段。
3. **原生 App（iOS / Android）**：允许探测家里 Hub。
4. **Expo Web（`:18991`）**：开发态入口；`:18990` 托管同一 Expo 客户端的静态导出。Hub 地址 = 当前页的主机名 `:18990`。不要让用户填 IP。回环免码；从其他电脑打开只输 4 位家里码。页面 hostname 是中继域名时按第 2 条。

出门时业务 REST 仍只打 Hub。页面若是中继静态站：会话走 WS 信封；`/api/file` 等 REST 仅在已选局域网地址时发往该 Hub。中继不代理业务 REST。

只维护 Expo（`apps/mobile/`，含开发态与 Web 静态导出）；旧 PWA 已归档，不再由 Hub / 中继托管。固定 4 字符家里码用于 WiFi / Tailscale 直连；二维码与设备连接长期保留到手动撤销，不做定时轮换。

Web 入口 URL 只在 `connectWS()` / `apiUrl()` 拼接，不要写死公网 IP。未登录不拉 `/api/threads`。收到 `hub_offline` 或探测失败显示「主机离线」，不是无限转圈。
