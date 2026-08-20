# Codesk

进了 ICU，还要遥控 Codex。

电脑上的 Codex，手机上接着干。同一份 session，发、停、审批，无缝流转。不是云端 Codex，不是多人共用一个账号。

官网：https://codesk.icu

## 用之前

- Windows 电脑已登录 Codex Desktop 或 VS Code Codex
- 本机已装 Node.js 18+

## 本机打开

```powershell
irm https://codesk.icu/install.ps1 | iex
```

装到托盘（不是 CLI）。双击图标打开主机台。开发也可 `scripts\start-web-hub.cmd`。

主机台左边是**家里码**（同一 WiFi），右边是**出门码**（一次性，走中继）。不是同一个码。

浏览器打开 http://127.0.0.1:18990 。同一 WiFi 下手机也可打开 `http://<电脑局域网IP>:18990`。

## 出门接着干

1. 电脑主机台看右边出门码 / 二维码
2. 手机扫右边的码，或手输出门码
3. 和桌面 / VS Code 看同一份对话：发、停、审批

电脑休眠或 Hub 没开，就不能干活。没有离线队列。

## 它做什么

- 读本机 `~/.codex`，列表与桌面同源
- 桌面开着时，写入走同一把锁，不抢会话
- 空闲会话由 Hub 自己接着跑
- 一人一机，凭据留在本机

## 安全

能打开这个 Hub，就等于能操作你已登录的 Codex。只给自己的设备。不要提交 `auth.json`、`codex-web-state/`、`vendor/`。
