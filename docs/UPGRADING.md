# 升级

## Windows Hub 安装包

官网安装命令为 `irm https://codesk.icu/install.ps1 | iex`。包内带 Node 与生产依赖，不要求系统 Node；源码运行另行准备 Node/npm 与 Expo 导出。

- 安装器只解析一次 GitHub latest 发布，显示明确的目标稳定版本，然后使用该 tag 的固定下载地址。网络/发布元数据失败就终止，不回退到某个历史版本。
- 官网 ZIP 地址当前重定向到可变 latest，不是版本固定镜像，因此不参与安装器回退。将来镜像必须提供同一目标版本；不能借镜像失败静默安装旧包。
- 现有安装版本无法确认，或高于目标版本时拒绝安装。暂存包 `hub/package.json` 必须精确等于目标版本。验证必需资源、Node 语法与依赖后才切换目录。
- 原安装移至 `%LOCALAPPDATA%\Programs\Codesk.backup-<安装ID>`；切换失败恢复原目录。只停止目标安装目录的托盘/内置 Node，不清理未知端口进程。
- 本次随机 `launchId` 从安装器传到托盘再传到 Node。只有本机状态返回匹配 `launchId` / 安装版本且托盘仍存活才报告成功；托盘自行核对子进程 PID。互斥锁/端口冲突明确报错，不把其他健康 Hub 认作新实例。

### 失败与人工恢复

1. **下载、版本或 staging 验证失败**：原安装未改变；确认发布资产/网络后重试，不手改目标版本绕过检查。
2. **目录切换失败**：安装器在目标目录不存在时自动将备份移回；若仍有锁文件，保留报错路径，人工检查，不覆盖或删除备份。
3. **文件已安装但启动核验失败**：不能视为升级成功。记录目标版本、launchId 与备份路径；先检查托盘冲突、18990 所属进程和本机状态。不因端口有响应就认定成功，不吊销设备或删除凭据来“修复”。
4. **确需恢复旧包**：人工确认并退出该安装的托盘/Node（不要停止其他源码或用户进程）；将当前 `Codesk` 目录改名为 `Codesk.failed-<时间>` 保留现场，再将本次 `Codesk.backup-<安装ID>` 改回 `Codesk`。从恢复目录启动 `CodeskHub.exe`，核验主机台与版本。恢复文件不等于回滚用户数据格式；跨数据格式版本先检查兼容性。
5. 安装器不会自动删除旧备份，也不会回滚用户目录中的 Codex 登录、Hub 状态或设备凭据。确认新版本稳定后，才人工决定是否删除备份。


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
