# 2. 本机 Hub

## 是什么

跑在用户 Windows 电脑上的控制面服务。唯一允许接触本机 Codex 的进程。

## 职责

- 读：`~/.codex`（sqlite / JSONL / 锁 / 桌面目录）
- 写：空闲走本端 `codex.exe app-server`；Desktop/VSCode 持锁走 `codex-ipc` follower
- 给局域网提供静态 Web + REST + WS（`:18990`）
- **出站**连 VPS，把已鉴权的业务消息原样转发
- 本机口令；向中继申请一次性**出门码**
- 本机主机台（仅 127.0.0.1）：**左家里 / 右出门**、已连接客户端、踢人
- 家里码（`lanCode`）常驻 6 位，只用于 `POST /api/auth/login`。出门码是中继一次性码，只用于 `POST /api/relay/pair`。UI 禁止把两个码画成同一个
- 命令面板、只读 Git、follower 审批（见 `docs/PLAN.md`）都在这一侧实现

## 窗口 2 负责

- `apps/web-hub/server/**`
- 本机鉴权（cookie `Path=/`，HTTP 与 WS 同一套）
- 未登录拒绝读 `~/.codex`、拒命令、拒上传
- Hub 出站客户端：注册 `hubId`、心跳、收发信封；出门加解密（[06-e2e.md](06-e2e.md)）
- IPC：在 PLAN 第 6 项做 follower 审批探针并接线
- 不要再 `taskkill` 误杀无关进程（可留端口占用提示）

## 不准做

- 不要把 `auth.json` 或 access token 发给中继 / 前端
- 不要在中继上 resume 别人的 thread
- 不要改 `public/` 外观（协议字段除外，先改 `04-protocol.md`）
- 不要做 macOS/Linux Hub

## 身份

- 安装时生成 `hubId`（UUID）和 Hub E2E 密钥对，存在本机数据目录，不入库、不给中继
- 本机口令存在本机，明文只进本地文件/环境变量
- 配对成功后中继发 `deviceToken`；Hub 只认「已配对设备」从中继进来的转发

## 验收

- 无口令：局域网也读不到会话
- Desktop 持锁时发/停仍走 follower
- 无公网端口时，Hub 仍能连上中继
- 中继断开时局域网直连不受影响
