# 已归档：旧版 PWA 前端（2026-09-10）

以下两套旧 Web 前端已不再使用，归档于此：

- `archive/web` — 经典 Web 端（原 `apps/web`，独立 PWA）
- `archive/web-hub-public` — Hub 内置旧 PWA（原 `apps/web-hub/public`，"Codex 远程控制中心"）

**替代品**：`apps/mobile` 的 Expo Web 导出（`apps/mobile/dist-web`，电脑浏览器与 APK 同一套 UI）。
构建命令：`cd apps/mobile && npm run export:web`。

Hub 服务端静态目录解析（`apps/web-hub/server/index.js` 的 `resolvePublicDir`）现在只认
`apps/mobile/dist-web` 及打包场景的 `hub/public`（打包脚本会把 Expo 导出产物复制进去）。
