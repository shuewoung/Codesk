# Codesk Hub

本目录是仓库产品 UI。架构与启动见仓库根 `README.md` 和 `docs/`。

> **专为移动端（手机、平板）与远程 Web 打造的高性能、真原生 PWA 体验的 Codex Desktop 远程控制与会话管理中心。**

![Version](https://img.shields.org/badge/version-v3.7.0-blue.svg)
![Platform](https://img.shields.org/badge/platform-Windows%20%7C%20iOS%20%7C%20Android%20%7C%20iPadOS-orange.svg)
![License](https://img.shields.org/badge/license-MIT-green.svg)

---

## ✨ 核心特性

- 📱 **真原生 PWA App 模式**：符合 PWA 最高规格标准，内置 `sw.js` (Service Worker) 预缓存 App Shell。添加到主屏幕后**完全消除地址栏与 Tab 页**，极致模拟 iOS/Android 原生 App 体验。
- 🎨 **黑金 OpenAI 视觉设计系统**：高度还原 OpenAI 暖金视觉与 Codex 官方设计语言，支持自适应像素级圆环 Token 用量仪表盘与呼吸灯运行状态指示（`🟢 运行中`）。
- ⚡ **微秒级双重内存缓存 (Dual Memory Engine)**：
  - 前端 `clientThreadCache` 内存池，切换 Session 耗时 **< 5ms**；
  - 前端 `markdownCache` 编译缓存，已渲染过的 Markdown 文本 **0ms 秒开**；
  - 服务端尾部倒序 Chunk 解析，即便遇到 **50MB** 的特大日志文件，读取耗时依然锁定在 **< 3ms**。
- 🚀 **保底呈现最新 20~30 条完整对话**：首次打开即刻保证呈现最新的 250~300 条底层记录，确保至少展现 20~30 条完整 User 用户指令与 Assistant 回复卡片。
- 🔄 **1 分钟后台无感静默刷新**：后台每隔 60 秒静默更新会话状态与账号限额卡片，零白屏、零闪烁、零滚动条跳动。
- 📐 **移动端自适应抽屉与视口锁**：针对 iOS/Android 虚拟键盘与屏幕凹槽（Safe Area Insets）进行了深度像素级适配，右侧项目文件树抽屉支持触控滑动展开/收起。

---

## 🛠️ 环境要求

- **操作系统**：Windows 10 / 11 (运行 Codex Desktop 的机器)
- **Node.js 运行时**：Node.js v18.0.0 或更高版本
- **依赖说明**：仅包含唯一的超轻量依赖 `ws` (WebSocket)

---

## 🚀 快速开始

### 1. 安装依赖
在项目根目录下打开终端，执行：
```bash
npm install
```

### 2. 启动服务
#### 方式 A：标准命令行启动
```bash
node server/index.js
```
#### 方式 B：双击脚本启动 (后台守护模式)
双击运行 `start-remote-hub.cmd` 即可启动服务并开启自动端口占用清理与守护。

### 3. 访问端口
服务默认绑定在端口 **`18990`**：
- **本机访问**：`http://localhost:18990`
- **局域网 WiFi 访问**：`http://<电脑局域网IP>:18990` (例如 `http://192.168.6.147:18990`)
- **Tailscale 组网访问**：`http://<Tailscale IP>:18990` (例如 `http://100.114.114.2:18990`)

---

## 📱 手机与平板 PWA 无地址栏安装指南

为了获得**彻底消除浏览器地址栏与 Tab 栏**的真原生手机 App 体验，请按照以下步骤安装：

### iOS / iPadOS (Safari)
1. 在 Safari 浏览器中打开 `http://<您的IP>:18990`；
2. 点击底部/顶部的 **“分享” 按钮 (⬆️)**；
3. 向下滚动并选择 **“添加到主屏幕”**；
4. 返回桌面，点击全新的 **Codex Remote** 黄色 OpenAI 图标即可全屏无缝使用！

### Android (Chrome / Edge)
1. 在 Chrome 浏览器中打开 `http://<您的IP>:18990`；
2. 点击右上角 **“菜单” 按钮 (⋮)**；
3. 选择 **“安装应用”** 或 **“添加到主屏幕”**；
4. 即可在桌面生成独立全屏应用窗口。

---

## 📂 项目文件目录结构

**前端 UI 单源目录（只维护这一个）**：`apps/web/`

```text
apps/
├── web/                       # ← 浏览器/PWA 多端一致版唯一维护目录
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── ...
└── web-hub/
    ├── server/
    │   └── index.js           # 后端（会自动优先加载 ../web 作为静态资源）
    └── public/                # 过渡期副本（可删）
```

---

## 🔒 许可协议

本项目基于 [MIT License](LICENSE) 开源许可发布。
