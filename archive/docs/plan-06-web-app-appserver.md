# 06_web_app（Codex Remote Hub）接入真实 app-server 后端 — 第一阶段

## 背景结论（已探查确认）
- 06_web_app 的 `send_message`/`send_steer`/`send_stop`/`send_approval`（server/index.js:1356-1384）是空壳：只回假 "submitted" 反馈，无真实控制；`createNewSession`（:896）手写 rollout 文件，无 writer，桌面不会真正执行。
- 协议面已由 codex-vscode-remote-research 摸清：`thread/list(useStateDbOnly)`、`thread/read`、`thread/resume`、`thread/start`、`turn/start`、`turn/steer`、`turn/interrupt`、`item/*/requestApproval` decision 响应。
- CodexWeb v2 已验证：spawn `codex.exe app-server` 与桌面共存、共享 CODEX_HOME、codex.exe 需复制出 WindowsApps（spawn EPERM）。

## 硬约束
**不碰正在运行的 Codex 桌面**：不杀/不重启桌面进程与它的 app-server；所有写操作测试只用 06_web_app 自建会话；对桌面持有的会话仅做只读（thread/read）验证；有 writer-lock 冲突时明确报错提示"该会话正由桌面运行"，不重试抢锁。

## 实施步骤（全部在 D:\00_智能工作区\01_项目工作区\06_web_app）

### 1. 冒烟探针：确认 app-server stdio JSON-RPC 帧格式
新增 `server/probe-appserver.mjs`：spawn `codex.exe app-server`（复用 20260816-CodexWeb\codex-bin\codex.exe 副本），验证消息分帧（JSON-RPC over stdio 的具体格式）、`initialize` 握手、`thread/list` 返回。只读探查，不写任何会话。

### 2. 新增 `server/appserver.js` — app-server 客户端模块
- spawn + 帧编解码 + 请求/通知分发（id↔promise 映射、notification 事件总线）
- 方法集中定义（协议漂移时只改这一处）：initialize / thread/list / thread/read / thread/resume / thread/start / turn/start / turn/steer / turn/interrupt / 审批 decision 响应
- 订阅通知流：agent message delta、turn 状态、requestApproval 服务端请求 → 转发到现有 WebSocket 广播通道（复用 `pushThreadUpdate`/`broadcastToClients`）
- writer-lock 冲突识别：捕获 "already has an active writer" 类错误 → 转成用户可读状态（不重试）

### 3. 替换 server/index.js 的四个空壳 handler
- `send_message` → `thread/resume` + `turn/start`（自建/空闲会话；桌面持有则报"由桌面运行中"）
- `send_steer` → `turn/steer`（带 expectedTurnId）
- `send_stop` → `turn/interrupt`
- `send_approval` → 匹配 pendingApproval 的 requestId，回 decision 响应（打通现有推送通知 → 真实决策回路）
- `create_thread` → 改走 `thread/start`（真 writer），替代手写 rollout 文件；保留原函数作降级路径

### 4. 验证（不碰桌面）
- 后端冒烟：自建会话 → 发消息 → 收流式回复 → steer → interrupt → 审批回路（如触发）
- Playwright 验证手机视口下四件套 UI 真实可用（沿用 20260816-CodexWeb 的 verify-* 脚本模式）
- 对桌面会话仅 `thread/read` 只读对照，确认列表/历史与 jsonl 解析一致

### 5. 文档
更新 README.md 与 TECHNICAL_ARCHITECTURE.md：架构图加 app-server 通道、说明锁语义与"桌面活跃会话 = 只读"边界。

## 第二阶段（本次不做，单独规划）
桌面活跃会话的实时跟随与接管：协调管道 Observer/Controller 路由（send-cli-request-for-host 等价，VS Code 扩展机制）。第一阶段先交付"自有+空闲会话完整控制"。

## 风险与对策
- app-server 协议非官方、会漂移 → RPC 客户端单文件隔离、方法名集中、探针脚本可快速复验
- codex.exe 版本与桌面不一致 → 统一使用与桌面同版本的副本（codex-bin 已有），升级时同步换