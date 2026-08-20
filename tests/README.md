# Codesk 测试与诊断

所有本地验证脚本统一放在 `tests/` 下，按被测层分组：

- `browser/`：原版 Web UI、移动端和项目/会话渲染验证；
- `app-server/`：真实 `codex.exe app-server` 与共享 catalog 的只读探针；
- `hub/`：本机口令、命令面板、只读 Git、Hub 出站中继；
- `ipc/`：`codex-ipc` Host Router / follower 探针；
- `asar/`：桌面 `app.asar` 的只读提取和逆向诊断。

默认从仓库根目录运行，例如：

```powershell
node tests/hub/run.mjs
node tests/app-server/session-count.mjs
node tests/browser/verify-codexweb.mjs
```

脚本会优先使用 `CODEX_HOME`；未设置时使用当前 Windows 用户的 `~/.codex`。测试产物统一写入 `tests/artifacts/`，不会再写入 `D:\tmp` 或覆盖仓库根目录截图。

涉及真实 app-server 的脚本只读查询会话和 catalog，不创建会话、不发送 turn、不修改会话内容。
