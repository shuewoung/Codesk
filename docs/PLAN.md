# 下一阶段方案（Codesk 工作台）

基线提交：`51afd95`（OneDesk 控制面：附件 / 技能 / MCP / 模型 / follower 发停）。

产品总定义见 `docs/product/`。本文只管工作台体验包。中继 / 配对 / E2E 以产品定义为准。

**2026-08-19 按代码核对：** 鉴权、时间线卡、`/` 菜单、审批接线已经在树上。PLAN 下文仍保留原设计，避免再当「没做」。现状表见 `docs/product/README.md`。

出门 E2E（主要保手机经中继）与 Desktop 持锁审批是门闩，见 `docs/product/06-e2e.md`。PWA Git / 命令面板已接上后端管道。

## 现在就做（Expo 缺口 + 主机台 + 推送）

按序（2026-08-19 已开工）：

1. **会话结束判定** — 已做。
2. **Windows 主机台** — 已做安装脚本。
3. **Expo**
   - 出门 E2E — 已接线（须重新扫带 `hk=` 的码）
   - 斜杠 `/review` 等 — 已做
   - 只读 Git / `$ 命令` — 已做
   - 局域网口令登录 — 已做
   - 重命名 — 原本已有
    - 会话内搜索 — 已做（PWA overlay + Expo 更多菜单）
   - 极光 — Hub + 客户端登记已接；须打 APK，Expo Go 收不到
4. Desktop 持锁审批 — `request_id` 已优先读取；须你开 Desktop 点一次验收

不要：官方 Remote、真 PTY、邮箱账号、把 Hub 打成绿色免 Node 包（本机已有 Node 即可）。

## 已有能力

- 会话列表、历史、发 / steer / 停
- Hub 本机口令鉴权（HTTP + WS）
- 空闲会话：本端 app-server 审批（三按钮，含 `acceptForSession`）
- Desktop 持锁：IPC follower 发 / steer / 停；审批已接线，持锁 `requestId` 未验收
- Diff 卡、命令卡、子智能体（PWA）
- `/` 菜单（PWA）
- `run_command` / `git_status`（PWA 右侧面板 + Expo `$ ` / 加号菜单）
- 技能开关、MCP 列表/reload、模型与推理强度、访问模式
- 文件树预览、上传附件、会话内搜索、Web Push、额度条

## 下一包（按序做）

### 1. Hub 鉴权

共享口令即可，不做账号体系。

- 环境变量或本地文件放 token（不要提交）
- 登录页 → cookie / `Authorization`
- HTTP + WebSocket 同一套校验
- 未登录不读 `~/.codex`、不开命令面板

有鉴权后，局域网才敢开写操作。

### 2. 命令面板（不是真 PTY）

在当前 thread `cwd` 跑一条命令，stdout/stderr 经 WS 流回。

- `child_process.spawn`，跟随会话 cwd
- 前端一个输出面板即可，不要 xterm + `node-pty` / ConPTY
- 与第 4 项 Git 只读共用「本机跑命令」管道

真交互终端（vim / resize / 多会话 PTY）单独立项，本包不做。

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

点了当普通消息发出去，不复刻 Desktop 整页。

优先：`/review` `/compact` `/init` `/status` `/plan`

已有入口接到现成菜单：`/model` `/reasoning` `/mcp`

### 6. Follower 审批（已接线，持锁未验收）

IPC 方法、`send_approval` 分支、探针都在。空闲会话可用。Desktop 持锁时 `requestId` 仍可能是 JSONL 条目 id，PWA 必须带 `kind`。必须验收「手机批完桌面继续跑」。

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

- 「速度」菜单接到 `config.toml`（和推理强度同一套路）
- 会话 pin / 归档（桌面状态文件已在读，差写入）
- 推理块可折叠展开

## 本包明确不做

- 真 PTY / xterm
- 官方 Remote Relay、Codex Cloud、IDE 扩展、企业 SSO
- Plugin 市场 / MCP OAuth
- Browser / Computer Use / Appshots 画面
- Sites / Visualizations / 产物工作室
- 行内评论审阅台、hunk 级 stage、PR 全流程
- Worktree 开聊（命令面板稳定后再说）

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
| `apps/web-hub/public/app.js` | 时间线与操作 |
| `tests/ipc/host-router-spike.mjs` | IPC 探针样板 |
| `docs/ARCHITECTURE.md` | 控制面契约 |

## 验收

- 无 token 打不开 Hub，也读不到本机会话
- 手机能在当前项目 cwd 跑一条命令并看到输出
- 运行中能看到命令卡和文件改动卡，不只是聊天气泡
- Desktop 持锁出现审批时，手机允许/拒绝后 Desktop 继续跑（此项仍是门闩，未验收）
- 右侧能看到当前仓库 `git status` / diff
