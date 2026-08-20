# 升级

## 桌面 / VSCode Codex

1. 对照当前扩展或桌面版本，重跑 `tests/ipc/` 探针（initialize + discovery + interrupt）。
2. 管道方法版本表若变（`thread-follower-interrupt-turn` v3/v4、流状态 v11），只改 IpcClient 一处。
3. 不要改 `public/` 去跟桌面 DOM。

## 原版 UI asar

仅当还要用 `:8214` 镜像时：

1. 按上游 `codex-web-upstream/UPGRADING.md` 换 asar。
2. 按 `patches/README.md` 顺序重打补丁。
3. 补丁冲突就停，不要手改压缩 bundle 充数。

## CLI 副本

`codex-bin/` 与 `vendor/` 不入库。需要完整工具宿主时，从 MSIX `app\resources\` 或 `07_cdp_bridge\vendor\resources\codex.exe` 复制，并用 `CODEX_CLI_PATH` 指向它。不要用缺 `codex-command-runner.exe` 的研究解包版。
