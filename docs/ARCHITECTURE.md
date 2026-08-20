# 架构

## 本仓定位

Codesk：本机已登录 Codex 的远程控制面。手机/平板入口是 `apps/web-hub`（自有 PWA）。多端拆分与中继定义见 `docs/product/`。

| 层 | 实现 | 说明 |
|---|---|---|
| 读 | `state_5.sqlite` + rollout + `thread/list(useStateDbOnly)` / `thread/read` | 不抢 writer lock |
| 写（有活锁） | `\\.\pipe\codex-ipc` follower | 与 VSCode 相同：把 send/stop/审批交给持锁 Host |
| 写（无活锁） | 本端 `thread/resume` + `turn/start` | Hub 自己的 app-server |
| 原版 UI | `scripts/start-codexweb.cmd` :8214 | 外观实验，不是控制面 |

## 为什么不是两个 app-server 互转

`features.code_mode_host=true` 是 code-mode 工具宿主，不是 Host Router。

`send-cli-request-for-host` 是 VSCode/桌面 **JS Host** 内部 IPC。真正跨端写操作走管道方法：

- `initialize { clientType }`
- `thread-owner-discovery`
- `thread-follower-start-turn` / `steer-turn` / `interrupt-turn`
- 审批 `thread-follower-*-decision`

对端必须是活着的 Desktop 或 VSCode JS Host。两个裸 `codex.exe` 不能互相转发。

## 已验证（2026-08-17）

`tests/ipc/host-router-spike.mjs` 在本机 Desktop 开着时：

- `initialize { clientType: "vscode" }` → 分配 `clientId`
- 仅对桌面正在 follow 的 thread，`thread-owner-discovery { hostId: "local" }` 返回 `handledByClientId`
- `thread-follower-interrupt-turn { conversationId }` → `{ ok: true, interruptedTurnId: null }`（当时无活动 Turn，但路由成功）

未打开/未 follow 的历史 thread 会 `no-client-found`，这时 Hub 才走本端 `thread/resume`。

## 不做的路径

- **Broker**：逼桌面共用一个 app-server。仅当对端 Host 不在且用户明确要求时再考虑。
- **CDP**：点桌面 DOM。不作为发送/停止主路径。
- **官方 Remote Relay / auth.json**：不复制凭据，不调 `/wham/remote/control/*`。

## 端口

| 服务 | 地址 |
|---|---|
| Web Hub | `18990`（可局域网） |
| 原版 UI | `127.0.0.1:8214` |
| `codex-ipc` | `\\.\pipe\codex-ipc`（只本机） |
