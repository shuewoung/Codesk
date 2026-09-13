# 1. Web 前端

## 是什么

手机 / 平板 / 桌面浏览器里的 Codesk Expo Web。只负责界面和调用协议，不碰 `~/.codex`，不spawn 进程。

## 连谁

| 场景 | 页面来源 | 数据面 |
|---|---|---|
| 同一 WiFi | 日常 Expo Web `:18991`；Hub `:18990` 探测到 18991 会 302。无 Metro 时 18990 只托管 Expo `dist-web` | `ws://` Hub `:18990` |
| 出门 | VPS 静态站点 | `wss://<中继>` ，信封里带 `hubId` |
| 原生壳（以后） | 同一套页面 | 同一套协议 |

入口 URL 只在一处拼接（现有 `connectWS()`）。不要写死 `localhost`。

对话和 Markdown 里的本机路径（`D:\...`、`file:///`、工作区相对路径，含图片、Office、目录）渲染成同源 `/api/file?path=...&raw=1`，让局域网和 Cloudflare Tunnel / Zero Trust 的 Web 能打开。不要改成中继转发，也不要改会话存档里的绝对路径。

## 窗口 1 负责

- 活跃源码在 `apps/mobile/`；开发态 Expo Web `:18991`，Hub `:18990` 托管 Expo `dist-web`。旧 PWA 在 `archive/web/`、`archive/web-hub-public/`，不再回退；主机台与必要图标单独维护在 `apps/web-hub/assets/`。优先 Tailscale / WiFi 直连，APK 后置。
- Hub 同源就是本地：不探测、不扫网。中继静态页只显示出门码，禁止探测局域网。Expo Web 的探测归窗口 4，不在本窗口做。
- 扫码配对（`?pair=` + `hk=` + `lan=`）/ 主机离线态
- 电脑上的「出门扫码」弹层只出中继长期配对码，文案须写明不是家里码
- 中继模式下握手并加解密 `fwd.enc`（[06-e2e.md](06-e2e.md)）
- 会话列表、时间线、审批按钮、设置
- 侧栏置顶：右键 / 长按 / 点 📌，发 `pin_item`（不要只改本机 DOM）。会话菜单里可归档、复制会话 ID；项目菜单可复制路径。文件树右键 / 预览标题可复制路径。
- 模型菜单「速度」发 `update_config` `speed`。时间线推理块默认折叠，点开展开。
- PLAN 里的纯前端：Diff 卡、命令卡、`acceptForSession`、`/` 菜单、`/plan` `/review` 专用页、子智能体展示、文件下载按钮
- PWA 清单、离线壳不要抢回（保持网络直取）

## 不准做

- 不要改 `server/` 或新建 `apps/relay`
- 不要第二套消息名
- 不要在前端解析 rollout / 调 `codex-ipc`
- 不要为 APK 加原生桥（第 4 项再做）

## 验收

- 断线重连、70s 看门狗仍在
- 未登录看不到会话
- Hub 离线有明确文案，不是无限转圈
- 局域网与中继两种入口能切，业务消息形状不变
