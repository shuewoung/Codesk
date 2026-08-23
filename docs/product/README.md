# Codesk 产品定义

四个子项目，一个产品。本文是总定义；各窗口只读自己的分册，协议以 `04-protocol.md` 为准。

| 编号 | 子项目 | 目录 | 分册 |
|---|---|---|---|
| 1 | Web 前端 | `apps/web/` | [01-web.md](01-web.md) |
| 2 | 本机 Hub | `apps/web-hub/server/` | [02-hub.md](02-hub.md) |
| 3 | VPS 中继 | `apps/relay/` | [03-relay.md](03-relay.md) |
| 4 | Expo 客户端 | `apps/mobile/`（新建） | [05-native.md](05-native.md) |
| — | 端到端加密 | 三端 + 中继 | [06-e2e.md](06-e2e.md) |

先不拆仓。PWA（`apps/web/`）和 Expo（`apps/mobile/`）两套壳都保留，协议同一份。

**其他窗口先读 [SYNC.md](SYNC.md)**（2026-08-19：HTTPS 中继、两套码、Expo Web、E2E/`no PRNG`）。

## 一句话

Codesk 是本机已登录 Codex 的远程控制面。口号：进了 ICU，还要遥控 Codex。电脑上的 Hub 读写 `~/.codex` 并驱动 `codex.exe`；手机连回自己的 Hub。不是云端 Codex，不是多人共用一个账号。

## 已拍板（不要再争论）

1. **300 人 = 300 台 Hub + 1 台中继**，一人一 Codex 账号。禁止转发 `auth.json`。
2. **中继是哑管道**。不跑 agent、不读 JSONL、不存聊天正文。
3. **v1 无邮箱账号。** 邀请开通 + 设备配对。局域网可另设本机口令。
4. **出门必须 E2E。** 中继只看见信封（type / hubId / 大小 / 时间），看不见业务 JSON。Hub 公钥走二维码 `hk=`，不经中继明文传密钥。局域网直连仍明文。见 [06-e2e.md](06-e2e.md)。
5. **同一套协议，两套壳。** 日常 UI 是 Expo（原生 + Web `:18991`）。Hub `:18990` 仍可回退旧 PWA，但旧壳不再加功能。VPS 出门页与 Expo 协议同一份。
6. **业务协议不改名。** 现有 REST + WS 消息原样走。中继只加信封（注册 / 配对 / 转发 / 心跳）。
7. **能局域网则直连 Hub**，失败再走中继。不做 WebRTC / 打洞 / 对外说 P2P。
8. **电脑休眠 = 不能干活。** UI 必须显示「主机离线」，不做消息离线队列。
9. **Hub 只做 Windows。** 出站连中继，不要求用户开端口。
10. **协议先改文档再改代码。** 三个窗口不准私自加字段。
11. **两套码。** 家里码常驻，只给同一 WiFi 登录 Hub；出门码一次性，只给中继 `POST /api/relay/pair`。主机台 / 手机配对页必须左右分开，禁止一个输入框两用。

## 窗口纪律

- 窗口 1 只改 `apps/web/` 和本分册。
- 窗口 2 只改 `apps/web-hub/server/`、`tests/` 和本分册。
- 窗口 3 只建/改 `apps/relay/` 和本分册。
- 窗口 4 只建/改 `apps/mobile/` 和 [05-native.md](05-native.md)。禁止改 PWA / Hub / 中继。
- 跨界需求写在 `04-protocol.md`，不要直接改别人的树。
- 工作台体验（Diff 卡、Git、命令面板、follower 审批）仍按 `docs/PLAN.md`，但 **中继相关以本文为准**（配对优先于「只有共享口令」）。

## 本轮不做

官方 Remote Relay、Codex Cloud、真 PTY、Plugin 市场、邮箱登录、多机房、在中继上跑 Codex、WebRTC/P2P 打洞。

## 工作台现状（对照 PLAN，2026-08-22 按代码核对）

| 项 | 状态 | 还缺 |
|---|---|---|
| Hub 鉴权 | **已做** | — |
| Diff / 命令卡 / 子智能体 / 第三审批按钮 | **已做** | PWA + Expo；命令卡默认折叠 |
| `/` 菜单 | **已做**（PWA + Expo） | `/plan` `/review` 打开专用页，不再只当普通消息 |
| 命令面板 / 只读 Git | **已做** | PWA 右侧「Git & 终端」；Expo 右栏 Git / 命令 |
| 文件下载 | **已做** | PWA 先 WS `get_file`（中继可走），失败才 REST `/api/file`；Expo 出门一直走 WS |
| Follower 审批 | **已做** | 直播 JSON-RPC `requestId` 优先；`kind` 可回退三种方法。本机再点一次确认即可 |
| 速度菜单 / pin 写入 Desktop / 推理折叠 | **已做** | pin + 归档 sidecar 物化；速度菜单写 `service_tier`；推理块默认折叠可展开 |
| 出门 E2E | **已接线** | 旧配对须重新扫带 `hk=` 的出门码；新扫的不用 |
| Windows 托盘 / 主机台 | **已做** | 左右拆开：家里码 / 出门码 |
| 手机配对页 | **已拆** | Expo + PWA 都是家里一块、出门一块 |
| 极光推送 | **已接线进 APK** | AppKey / `JPUSH_*` 占位符 / 通知权限已进 `android/`；连上 Hub 后 `register_push`。Expo Go 仍无 RID |

**必须做完：** 旧设备重新扫带 `hk=` 的出门码；极光须用含 `JPUSH_APPKEY` 的新 APK（Expo Go 仍无 RID）。持锁审批代码已落地，本机再点一次确认即可。
