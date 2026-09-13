# Codesk

进了 ICU，还要遥控 Codex。

电脑上的 Codex，手机上接着干。同一份 session，发、停、审批，无缝流转。不是云端 Codex，不是多人共用一个账号。

官网：https://codesk.icu

## 用之前

- Windows 电脑已登录 Codex Desktop 或 VS Code Codex
- 使用官网 Windows 安装包无需系统 Node.js：包内自带运行时与生产依赖
- 仅源码开发需要自行安装 Node.js / npm（版本以各应用 `package.json` 与 Expo 要求为准）

## 本机打开

```powershell
irm https://codesk.icu/install.ps1 | iex
```

装到托盘（不是 CLI）。双击图标打开主机台。安装器先锁定目标发布版本、验证暂存包并拒绝降级，再保留旧目录备份；只有本次启动实例与版本核验通过才报告成功。升级与恢复见 [docs/UPGRADING.md](docs/UPGRADING.md)。开发也可 `scripts\start-web-hub.cmd`。

主机台左边是固定 **4 字符家里码**（WiFi / Tailscale 直连），右边是长期**出门配对码**（走中继）。两者不混用，连接保留到手动撤销。

浏览器打开 http://127.0.0.1:18990 。同一 WiFi 下手机也可打开 `http://<电脑局域网IP>:18990`。

## 出门接着干

1. 优先让电脑与手机连接同一 Tailscale 网络，在主机台扫描直连二维码，或打开 `http://<电脑 Tailscale IP>:18990`
2. 输入固定 4 字符家里码，使用 Expo Web；也可扫主机台右边的中继配对二维码
3. 和桌面 / VS Code 看同一份对话：发、停、审批。无需定时重扫；设备可在主机台手动撤销

活跃前端是 `apps/mobile` 的 Expo Web；旧 PWA 已归档到 `archive/`，不再托管。源码运行前执行 `npm ci --prefix apps/mobile`、`npm run export:web --prefix apps/mobile`，Hub 托管 `dist-web`；APK 构建与推送验收后置。

电脑休眠或 Hub 没开，就不能干活。没有离线队列。

## 它做什么

- 读本机 `~/.codex`，列表与桌面同源
- 桌面开着时，写入走同一把锁，不抢会话
- 空闲会话由 Hub 自己接着跑
- 一人一机，凭据留在本机

## 实现与验证

历史时间线、生成图片访问边界、子智能体、Git 差异及产物筛选的行为与测试记录见 [类型化历史与文件体验](docs/product/10-typed-history-and-files.md)。

## 安全

能打开这个 Hub，就等于能操作你已登录的 Codex。只给自己的设备。不要提交 `auth.json`、`codex-web-state/`、`vendor/`。
