# 3. VPS 中继

## 是什么

一台公网 Node（或同类）服务：邀请、配对、把手机的业务消息转到对应 Hub 的出站连接。

## 做

- TLS（前面可挂 Caddy/Nginx）
- 邀请额度（目标 200–300 个 `hubId`）
- Hub 出站长连接登记：`hubId → socket`
- 设备配对：兑换一次性码 → `deviceToken`
- 转发：校验 token 后把 `enc`（或不透明 `payload`）送到该 `hubId`。禁止解密、禁止当 JSON 打开业务字段
- 心跳；Hub 掉线则告诉手机 `hub_offline`
- 托管与 Hub 相同的 Web 静态文件
- 审计：谁在何时连了哪个 `hubId`（不记消息正文）
- 极光代发：Hub `push_register` / `push_send`。Master Secret 只放中继环境变量，不进 APK、不进用户 Hub

## 不做

- 不跑 `codex.exe`，不读用户磁盘
- 不解析、不落盘聊天 / 文件 / 命令输出
- 不实现审批、Git、模型列表（回源 Hub）
- 不做邮箱/密码/OAuth 用户系统
- 不做离线消息队列
- 不做 WebRTC / STUN / 打洞 / 同网探测。中继只转发，发现直连地址由 Hub 写进 `pairUrl` 的 `lan=`，客户端自己探

现网部署见 `docs/OPS.md`（东京机 `/opt/codesk`，`codesk-relay.service`，入口仍是 `hub.codesk.icu:8787`）。

## 窗口 3 负责

- 新建 `apps/relay/`（自己的 `package.json`）
- 配对与转发的最小实现
- 一份简短 README：怎么起、环境变量、邀请怎么加
- 压测不必做；300 在线按 600 条 WS 设计即可
- `fwd` / `e2e_hello` / `e2e_welcome` 当不透明字节转发（[06-e2e.md](06-e2e.md)）

## 安全底线

- 全站 HTTPS/WSS
- 配对码短效、一次性、可吊销
- 日志默认不打印 `payload` / `enc.ct`
- 出门 `fwd` 必须是密文（见 [06-e2e.md](06-e2e.md)）。运营者不能打开业务 JSON。不要宣传「连元数据也没有」

## 验收

- 未配对手机连不上任何 Hub
- Hub A 的流量到不了 Hub B
- Hub 进程杀掉后，手机在数秒内看到离线
- 吊销设备后旧 token 立即失效
