# Codesk Hub

本目录是本机 Hub 服务及主机台资源。活跃产品 UI 在 `apps/mobile/`（Expo Web）；旧 PWA 已归档，不再托管。架构与启动见仓库根 `README.md` 和 `docs/`。

> **优先通过 Tailscale / WiFi 直连 Expo Web，也可使用中继长期二维码配对。APK 专项后置。**

版本以本目录 `package.json` 与本机 `/api/host/status` 返回值为准。
![Platform](https://img.shields.org/badge/platform-Windows%20%7C%20iOS%20%7C%20Android%20%7C%20iPadOS-orange.svg)
![License](https://img.shields.org/badge/license-MIT-green.svg)

---

## 核心特性

- Expo Web 单源：开发时使用 Metro，日常远程使用静态导出，不依赖旧 Service Worker。
- Hub 提供会话、文件、审批、Git 与终端协议；与 Codex Desktop 共用会话，不抢活跃 writer。
- 固定 4 字符家里码用于 WiFi / Tailscale；中继二维码与设备连接长期保留，手动撤销。

---

## 🛠️ 环境要求

- **操作系统**：Windows 10 / 11 (运行 Codex Desktop 的机器)
- **安装用户**：官网 Windows 包内置 Node 与生产依赖，无需系统 Node/npm
- **源码开发**：自行准备符合 Hub `package.json` 与 Expo 要求的 Node.js/npm；以下快速开始仅针对源码
- **依赖说明**：以 `package.json` / `package-lock.json` 为准；源码使用 `npm ci` 安装，终端需 `node-pty`

---

## 🚀 快速开始

### 1. 安装依赖
在仓库根目录下打开终端，执行：
```bash
npm ci --prefix apps/web-hub
npm ci --prefix apps/mobile
npm run export:web --prefix apps/mobile
```

### 2. 启动服务
#### 方式 A：标准命令行启动
```bash
cd apps/web-hub
node server/index.js
```
#### 方式 B：双击脚本启动 (后台守护模式)
双击仓库 `scripts/start-web-hub.cmd`。启动器生成 `CODESK_LAUNCH_ID`，检查本机状态的版本、launchId、instanceId 与新子进程 PID；不把已有健康实例当成本次成功。明确使用 `scripts/start-web-hub.ps1 -Restart` 重启时只停止本仓绝对入口进程，端口被未知实例占用时提示人工处理，不自动清端口。

### 3. 访问端口
服务默认绑定在端口 **`18990`**：
- **本机访问**：`http://localhost:18990`
- **局域网 WiFi 访问**：`http://<电脑局域网IP>:18990` (例如 `http://192.168.6.147:18990`)
- **Tailscale 组网访问**：`http://<Tailscale IP>:18990` (例如 `http://100.114.114.2:18990`)

---

## 手机与平板 Expo Web

1. 电脑和手机连接同一 tailnet（或同一 WiFi），保持 Hub 在线。
2. 本机打开 `http://127.0.0.1:18990/host`，扫描左侧直连二维码，或在手机浏览器打开对应地址。
3. 输入固定 4 字符家里码。无需 APK，也不要求安装旧 PWA；不承诺离线或无地址栏模式。
4. 使用中继时扫描右侧长期配对二维码；已连接设备可在主机台撤销。

---

## 📂 项目文件目录结构

**前端 UI 单源目录**：`apps/mobile/`

```text
apps/mobile/                 # Expo 客户端源码
apps/mobile/dist-web/        # export:web 生成，Hub / Relay 托管
apps/web-hub/server/         # Hub 后端
apps/web-hub/assets/         # 活跃 host.html 和必需图标
archive/web/                 # 旧 PWA，仅归档
archive/web-hub-public/      # 旧 PWA 副本，仅归档
```

`pack-hub.ps1` 使用唯一临时目录、按 lockfile 安装生产依赖；外部命令失败即终止，不复用旧导出。官网安装器解析一次目标稳定版本并使用固定 tag 下载，拒绝静默降级与包版本不符；先验证 staging，再切换目录。切换失败恢复旧目录，启动失败保留备份供人工回滚。托盘互斥锁冲突明确失败，默认中继遵循现有 `https://hub.codesk.icu:8787` 约定。完整恢复步骤见 [UPGRADING.md](../../docs/UPGRADING.md)。

---

## 🔒 许可协议

本项目基于 [Apache-2.0](../../LICENSE) 开源许可发布。
