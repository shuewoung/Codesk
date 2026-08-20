# Codesk Relay

VPS 哑管道：邀请、配对、把手机的业务消息转到对应 Hub。不跑 Codex，不存聊天正文。

现网在东京 VPS，systemd `codesk-relay`，目录 `/opt/codesk/`。入口主机名见 `docs/OPS.md`。不要把旧机 `/opt/onedesk` 当现网。

官网静态页在 `apps/www/`，不要和连接入口抢主机名。

极光代发：环境变量 `JPUSH_APP_KEY`、`JPUSH_MASTER_SECRET`。Hub 只发 `push_register` / `push_send`，中继按 `hubId` 绑定 RID，禁止全员推。
