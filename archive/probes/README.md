# 归档探针

v1/v2 逆向与冒烟脚本，**不是产品入口**。

- `pipe-probe*` / `smoke-ipc*`：`\\.\pipe\codex-ipc` 早期探测（握手不完整，`thread/list` 会 `no-client-found`）
- `probe-appserver.mjs`：stdio app-server 只读
- `verify-*.mjs`：原版 UI Playwright
- `run-proxy.js` / `host-polyfill.js`：已废弃的字节透传

当前只读探针在仓库根 `tests/`。Host Router spike 写在 `tests/ipc/`。
