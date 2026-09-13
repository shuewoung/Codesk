# 下一阶段方案（Codesk 工作台）

基线提交：`51afd95`（OneDesk 控制面：附件 / 技能 / MCP / 模型 / follower 发停）。

当前优先 Expo Web + Tailscale / 二维码，APK 专项后置；下文 PWA 实现记录仅作历史参考。产品总定义见 `docs/product/`。本文只管工作台体验包。中继 / 配对 / E2E 以产品定义为准。

**2026-08-22 按代码核对：** 鉴权、时间线卡、`/` 菜单（PWA+Expo）、审批接线、pin/归档 sidecar、速度菜单、推理折叠已经在树上。PLAN 下文仍保留原设计，避免再当「没做」。现状表见 `docs/product/README.md`。

出门 E2E 与 Desktop 持锁审批**代码已落地**（见 `docs/product/06-e2e.md`）：旧设备重扫带 `hk=` 的出门码；持锁审批建议本机再点一次确认。日常电脑 UI 走 Expo Web `:18991`；Hub `:18990` 探测到 18991 会 302 过去。

## 现在就做（Expo 缺口 + 主机台 + 推送）

按序（2026-08-19 已开工）：

1. **会话结束判定** — 已做。
2. **Windows 主机台** — 已做安装脚本。
3. **Expo**
   - 出门 E2E — 已接线（须重新扫带 `hk=` 的码）
   - 斜杠 `/review` 等 — 已做
   - 只读 Git / `$ 命令` — 已做
   - 交互终端（ConPTY + xterm）— Expo 右栏「终端」
   - 局域网口令登录 — 已做
   - 重命名 — 原本已有
    - 会话内搜索 — 已做（PWA overlay + Expo 更多菜单）
   - 极光 — Hub + 客户端登记已接；`android/` 已含 `JPUSH_APPKEY` 与通知权限。须用此工程重打 APK。Expo Go 收不到
4. Desktop 持锁审批 — 已做：follow 直播 snapshot 优先、`kind` 可回退三种 follower 方法。本机仍建议开 Desktop 点一次确认「手机批完桌面继续跑」

安装包现状：`pack-hub.ps1` 会带上 `node.exe` 和 `node_modules`（含 `node-pty`）。打 zip 的机器需要能编 Windows 原生模块。

## 已有能力

- 会话列表、历史、发 / steer / 停
- Hub 本机口令鉴权（HTTP + WS）
- 空闲会话：本端 app-server 审批（三按钮，含 `acceptForSession`）
- Desktop 持锁：IPC follower 发 / steer / 停；审批优先用直播 JSON-RPC `requestId`（follow snapshot），JSONL 条目 id 只作兜底
- Diff 卡、命令卡、子智能体（PWA）
- `/` 菜单（PWA + Expo：`/review` `/plan` `/mcp` `/plugin` `/goal` 等）
- `run_command` / `git_status` / `pty_*`（Expo 右栏：文件 / Git / 终端）
- 技能开关、MCP 列表/reload（REST + WS `get_skills` / `get_mcp`）、模型 / 推理 / 速度、访问模式
- 远程 pin / 归档（`pins.jsonl` / `archives.jsonl` sidecar，空闲物化到 Desktop）
- 文件树预览、上传附件、会话内搜索、Web Push、额度条
- 已安装插件列表/开关（写 config.toml）、MCP 工具与登录态、Git 改动文件列表、文件树按需展开、Desktop 持锁提示

## 下一包（按序做）

### 1. Hub 鉴权

共享口令即可，不做账号体系。

- 环境变量或本地文件放 token（不要提交）
- 登录页 → cookie / `Authorization`
- HTTP + WebSocket 同一套校验
- 未登录不读 `~/.codex`、不开命令面板

有鉴权后，局域网才敢开写操作。

### 2. 命令面板 + 交互终端

一次命令：在当前 thread `cwd` 跑一条命令，stdout/stderr 经 WS `command_output` 流回（composer `$ `）。

交互终端：Hub `node-pty` / ConPTY 起 PowerShell；Expo 右栏 xterm，消息 `pty_open` / `pty_input` / `pty_resize` / `pty_close` / `pty_data` / `pty_exit`。与一次命令并存。

### 3. 时间线补齐

数据已在 JSONL，主要是前端渲染。

| 项 | 说明 |
|---|---|
| Diff / 改动卡片 | `fileChange` 已有，CSS 有，JS 未发出 |
| 命令 / 工具卡片 | `function_call` 已解析，`flushCommandBatch` 是空函数 |
| 本会话始终允许 | `acceptForSession` 协议已通，差第三个按钮 |
| 真子智能体 | 读 rollout，去掉写死的「1 个运行中」 |
| 文件下载 | `/api/file` 已有，预览里加出口 |

### 4. 只读 Git 面板

当前会话 cwd 上跑 `git status` / `git diff` / `git log`。

- 先只读
- Desktop 持锁时也只读
- 不做 hunk stage、commit、push、PR 侧栏

### 5. `/` 快捷菜单

`/compact` `/init` `/status` 点了当普通消息发出去。`/plan` `/review` 打开专用工作台（步骤列表 / 待审文件），再从页里发出。

已有入口接到现成菜单：`/model` `/reasoning` `/mcp`

### 6. Follower 审批（代码已落地）

IPC 方法、`send_approval` 分支、直播 snapshot `requestId`、`kind` 回退都在。空闲走本端 `decideApproval`；有活锁走 follower。PWA/Expo 都会带 `kind`。建议本机再点一次确认「手机批完桌面继续跑」。

VSCode 与 Desktop 走同一条 `\\.\pipe\codex-ipc`。本机扩展 `openai.chatgpt-26.5810.52044` 已确认方法（均为 v1）：

| 类型 | 方法 |
|---|---|
| 跑命令 | `thread-follower-command-approval-decision` |
| 改文件 | `thread-follower-file-approval-decision` |
| 权限 | `thread-follower-permissions-request-approval-response` |

路由与已通的发/停相同：`thread-owner-discovery` → `targetClientId` → 上表。

Hub 现状：

- JSONL 已能点亮「需审批」横幅
- `ipc-client.js` 已有三个 follower 审批方法
- `send_approval`：有活锁走 follower，无活锁走本端 `decideApproval`

做法：

1. 仿 `tests/ipc/host-router-spike.mjs` 写审批探针：Desktop 开着等审批时，从 Hub 发一条 decision
2. 对上入参（预期 `conversationId` + `requestId` + `decision`）
3. 有活锁则走 follower，无活锁仍走本端 `decideApproval`

`requestId` 必须以 Desktop app-server 等待的 JSON-RPC id 为准；JSONL 条目 id 可能对不上，探针先验证。

## 顺手可做（穿插，不单独开大项）

- 「速度」菜单接到 `config.toml`（和推理强度同一套路）— **已做**（`update_config` `speed` → `service_tier`）
- 推理块可折叠展开 — **已做**（PWA/Expo 默认折叠，点开看全文）

### Pin / Metadata 写入 Desktop（含会话 pin、项目 pin、归档、顺序同步）

**现状（2026-08-22）**：已做 sidecar `pins.jsonl` + `pinOverrideMap`、WS `pin_item` / `pin_thread` / `unpin_thread`、空闲时物化 `.codex-global-state.json` 与 sqlite、global-state 双向 watch、PWA 右键/长按置顶、Expo `togglePin` 走 Hub。远程永远先写 sidecar，不抢 turn writer。

**目标**：PWA / Expo 设置的 pin（线程 / 项目）、归档等，能让 Desktop 看到（重启或下次加载列表即可）。反之 Desktop 改 pin，远程也能感知。**不抢正在跑的 turn writer**。

**核心思路（多层安全，参考 title sidecar）**：
- **Sidecar journal 优先**（推广 session_index.jsonl + titleOverrideMap 模式）：
  - 新增 `pins.jsonl`（或扩展 session_index 格式）：`{ "id": "...", "pinned": true/false, "at": ms, "source": "remote"|"desktop", "kind": "thread"|"project" }`
  - 内存 `pinOverrideMap`（类似 titleOverrideMap）。
  - 构建 thread_list / project 列表时 fold 最新状态，远程永远以 sidecar 为准，立即生效。
- **投影到 Desktop 可见存储（opportunistic materialization）**：
  - 优先原子写 `.codex-global-state.json`（pinned-thread-ids / pinned-project-ids / unified-sidebar-pinned-order-v1），因为这是 Desktop 侧边栏 UI 主源，JSON 写比 sqlite 安全。
  - 安全时再写 state_5.sqlite 的 `threads.is_pinned`（用 node:sqlite + busy timeout，或短暂 resume 我们的 app-server 只做 metadata）。
- **Idle / Safe 检测触发物化**（不抢活锁）：
  - 复用 `discoverThreadOwner` + `threadIsLive` + writer-lock 文件 + stale 逻辑。
  - 增强：全局无 owner + 锁过期 + 可选 codex.exe 进程不存在 → 认为 Desktop idle，可全量 flush pending pins。
  - 单个线程：`!owner && !live` 即可写该线程的 pin。
  - Desktop 正在 follow 的线程：只更新 sidecar，不碰它的 turn writer；等它 idle 再 materialze。
- **双向 merge + 时间戳来源**：
  - 读 global-state / sqlite 时带时间戳。
  - 最后写入者胜出（或 Desktop active 时临时让 Desktop 优先）。
  - 加 fs.watch global-state + 现有 rollout watcher 做双向：Desktop 改 pin → 拉回 sidecar → 广播 thread_list。
- **Metadata-only ownership**（可选轻量）：
  - Metadata 不需要完整 turn writer。只为 pin 短时拿锁或直接写 global-state，不影响 rollout。
- **进程级 + 兜底**：
  - 检测 codex.exe 是否在跑（tasklist / 进程列表）。
  - Desktop 完全关闭时 100% 安全写。
  - 失败时只保 sidecar，Desktop 下次自己加载也能看到（或提供 host.html “立即同步到 Desktop” 按钮）。

**实现拆分**：
1. Sidecar 读写 + 内存 map + 在 `getThreadList` / project 构建处 merge（复用现有 pinnedThreadSet 逻辑）。
2. WS 消息 `pin_thread` / `unpin_thread`（threadId / projectId + kind），更新 sidecar，广播 thread_list。
3. 实现 `materializePinsIfSafe()`：判断 idle → 原子写 global-state → 尝试写 sqlite。
4. 增强 idle 检测函数（owner + live + lock age + 可选进程）。
5. global-state watch + reconcile（Desktop 改 pin 也能推给远程）。
6. 更新 PWA（app.js toggle + 持久化）和 Expo（session.tsx togglePin 改走 WS，不只写本地）。
7. 验收 + 文档：在 product/README + PLAN 里把“pin 写入 Desktop”从“未做”改成“已做（sidecar + 物化）”。**已做。**
8. 可选：速度菜单 + 推理折叠 一起顺手接上。**已做。**

**验收标准**：
- 远程 pin 一个会话后，关 Desktop 重启，侧边栏能看到 📌。
- Desktop 正在跑 A 会话时，远程仍可 pin B 会话，B 的 pin 在 Desktop 空闲后可见。
- Desktop 手动改 pin，远程列表能同步。
- Expo 不再“只写本机”，所有端一致。
- 不出现 writer lock 错误、不损坏 sqlite / global-state。

**相关**：会话归档已同批做（`archives.jsonl` sidecar + sqlite `archived` 空闲物化；Desktop 改归档按 sqlite 差分拉回）。标题仍用 `session_index.jsonl`。

## 本包明确不做

不要在中继上跑 Codex，不要把 `auth.json` 发到中继或前端。其余（官方 Remote、SSO、Plugin 市场、Browser Use 等）按需要再开，不再当禁令。

## 建议开工顺序

1. 鉴权
2. 命令面板
3. 时间线 Diff + 命令卡 + 本会话允许
4. 只读 Git
5. `/` 菜单
6. Follower 审批探针 → 接线

1 是门槛。2 与 4 共用本机命令管道。3 与 5 几乎纯前端。6 独立探针，成功再合进 `send_approval`。

## 关键文件

| 文件 | 角色 |
|---|---|
| `apps/web-hub/server/index.js` | HTTP / WS / 审批路由 |
| `apps/web-hub/server/ipc-client.js` | `codex-ipc` follower |
| `apps/web-hub/server/appserver.js` | 本端 app-server |
| `archive/web/app.js` | 旧 PWA 时间线（仅归档，不回退） |
| `apps/mobile/` | 日常 UI（Expo Web `:18991` + APK） |
| `tests/ipc/host-router-spike.mjs` | IPC 探针样板 |
| `docs/ARCHITECTURE.md` | 控制面契约 |

## 验收

- 无 token 打不开 Hub，也读不到本机会话
- 手机能在当前项目 cwd 跑一条命令并看到输出
- 运行中能看到命令卡和文件改动卡，不只是聊天气泡
- Desktop 持锁出现审批时，手机允许/拒绝后 Desktop 继续跑（代码已优先直播 requestId；请本机再点一次确认）
- 右侧能看到当前仓库 `git status` / diff
