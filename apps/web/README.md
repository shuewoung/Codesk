# Browser / PWA 客户端（多端一致版单源目录）

**这就是你要维护的唯一前端目录。**

- 位置：`apps/web/`
- 内容：index.html + app.js + style.css + manifest + sw + icons + host.html 等
- 任何浏览器直接打开都能用（桌面浏览器 + 手机浏览器 + PWA）

## 如何启动

```powershell
# 方式1
scripts\start-web-hub.cmd

# 方式2
cd apps\web-hub
node server/index.js
```

然后浏览器访问：
- 本机：http://127.0.0.1:18990
- 局域网：http://你的电脑IP:18990

## 维护规则（只动这一个目录）

以后所有 UI 改动（聊天界面、样式、PWA 配置、主机台 host.html）**只在 `apps/web/` 下改**。

server 会自动优先使用 `apps/web/`（见 server/index.js resolvePublicDir）。

旧的 `apps/web-hub/public/` 目前是副本，过渡期可保留，之后可删或做构建时拷贝。

## 桌面浏览器 vs 移动 PWA

- 同一个代码
- 桌面浏览器会自然用较宽布局（已有部分响应式）
- 手机上「添加到主屏幕」就是无地址栏 PWA

这样你就真正只维护一端了。
