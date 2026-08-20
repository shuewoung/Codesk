# 窗口同步（2026-08-19）

其他窗口先读本文，再动代码。协议仍以 [04-protocol.md](04-protocol.md) 为准。

## 产品壳

- 以后只维护 **Expo**（`apps/mobile`）。旧 PWA（`apps/web-hub/public/`）不删、不搬进 RN。
- 开发 Web：`cd apps/mobile && npx expo start --web` → `http://localhost:8081`（这是 Expo UI，不是 Hub `:18990` 旧 PWA）。
- 出门客户端要装 **新 APK**。已上架/已安装的包仍是旧提交：会提示 `http://`、没有家里探测、Android 上 `no PRNG`。

## 两套码（禁止混用）

| | 家里码 | 出门码 |
|---|---|---|
| 在哪看 | 主机台 **左边** | 主机台 **右边** |
| 干什么 | 同一 WiFi 登录 Hub | `POST /api/relay/pair` |
| 寿命 | 常驻 | 一次性 |
| App | 「连接家里」 | 「连接出门」/扫右边二维码 |

一个输入框两用已经废止。手输出门码必须同时有 `hk`（扫码带 `hk=`）；只输 6 位出门码 E2E 不完整。

## 中继

- 客户端入口：`https://hub.codesk.icu:8787`（Let’s Encrypt，**端口仍是 8787**，不用 443）。
- `http://hub.codesk.icu:8787` 已关。Hub 出站也走 HTTPS；不要再把 hostname 改成公网 IP（证书对不上）。
- 没备案：80/443 不能做 HTTP-01。续期用 DNS-01（Cloudflare TXT `_acme-challenge.hub`）。
- **不要**用 Cloudflare Worker 包一层转 `wss`（长连接不稳）。**不要**橙云反代当主路径。
- 中继新增：`hubE2ePub` 随 pair 返回；转发 `e2e_hello` / `e2e_welcome` / `fwd.enc`；`GET /api/relay/devices`、`POST /api/relay/kick`；失败才计 pair 限流。
- 中继 CORS：localhost / 127.0.0.1 / 私网 Origin（给 Expo Web）。

现网机器以 [OPS.md](../OPS.md) 为准，不要往已退役的旧机发版。

## Hub（已改，窗口 2 勿回滚）

- `GET /api/discover` 未登录：`{ ok, hub, port, hubId }`，禁止回密码/配对码/密钥。
- 私网 Origin CORS + `OPTIONS`。
- WS 认 query `?token=`（浏览器不能自定义头）。
- 默认中继 URL：`https://hub.codesk.icu:8787`。

## Expo（窗口 4）

- Web 依赖：`react-dom` / `react-native-web` / `@expo/metro-runtime`（SDK 54）。
- 存储：SecureStore，Web 不行就 `localStorage`。
- Web 隐藏相机扫码；Web / Expo Go 推送 no-op。正式 APK 会 `register_push`。
- 家里：HTTP 探测 `GET /api/discover`（不扫 1–254）。顺序：当前页 `:18990` → 上次 `lanUrl` → `127.0.0.1`/`localhost`（仅 Web）→ 页面 hostname:18990 → 同网段 `.1`/`.2`。
- 出门默认 `https://hub.codesk.icu:8787`。`normalizeRelayUrl` 会把旧 `http://hub.codesk.icu…` 改成 https。
- Android `tweetnacl` 必须先 `expo-crypto` `setPRNG`，否则握手报 `no PRNG`。
- 极光只做推送，**不是安装量统计**。AppKey 可在 APK；Master Secret 只在中继。Hub 只转发 `push_register` / `push_send`，不调极光 REST。

## 「电脑已连接、手机还在转」

主机台出现 `dev_xxxx` = 中继 **WS 已登记**。  
手机「正在连中继」= **E2E 还没拿到 `contentKey`**（`e2e_hello` / `e2e_welcome`）。

常见原因：

1. **旧 APK（9f05d66）不会发 `e2e_hello`。** Hub 已强制密文。中继显示设备在线，手机永远「正在连中继」。必须装 **1.0.1+**（含 E2E + `expo-crypto`）。
2. 中继审计：`pair_success` 后 1 秒内若出现 `disconnected_hub`，是 Hub 处理 `e2e_hello` 抛错被踢下线。Hub `relay-client` 必须包 try/catch，不能把整条出站 WS 打掉。
2. 旧包 `no PRNG`：Android 上 tweetnacl 没随机数，密钥生不成。
3. **手机 `b64uDecode` 把 `=` 当成 -1**，私钥最后几字节解坏。Hub 欢迎包是对的，手机永远 `握手失败`。1.0.2 已修。
3. 装新包后仍卡：退出，再扫右边出门码。

局域网直连不走这套握手。

## 不要做

改中继业务协议名、删 `public/app.js`、真 PTY、抄 Happy E2E/sync、提交密钥、把公网 IP 写进对外文档、用 Worker 包 `wss`。

---

## 窗口同步（2026-08-20：分发体系、软键盘适配与代码块复制）

### 1. 官网分发与版本检测体系 (`apps/www`)
- **Windows 一键安装口令**：统一使用 `irm https://codesk.icu/install.ps1 | iex`，脚本位于 `apps/www/public/install.ps1`，自动检测 Node 环境并静默放行防火墙 18990 端口。
- **APK 直链下载**：官网直链提供 `https://codesk.icu/codesk-latest.apk`，国内网络环境下秒级下载，无需依赖 GitHub Releases。
- **静态版本检测源**：`https://codesk.icu/version.json` 包含 `versionCode`、`version`、`changelog` 与 `downloadUrl`，零服务端代码、零额外服务器成本。

### 2. 移动端 App 交互规范 (`apps/mobile`)
- **版本检查**：在 `SettingsScreen.tsx` 中直接通过原生 `fetch('https://codesk.icu/version.json')` 检查版本，当 `versionCode > 106` 时原生弹窗引导下载。
- **软键盘视口自适应**：在 Android 与 Web 环境下依赖系统原生缩放，严禁手动叠加固定像素 `paddingBottom`（避免产生双重叠加抬高）；iOS 仅在扣除 Safe Area 后按差值进行微调。
- **Diff 节点就地展开**：`flattenItems` 中的 diff 节点必须透传 `patch` 字段，支持在对话流中直接展开行内代码差异。

### 3. Web 控制台交互规范 (`apps/web-hub`)
- **代码块一键复制**：`renderMarkdown` 中所有 `<pre><code>` 自动包装为 `.code-block-wrapper`，自带 `.btn-copy-code` 复制按钮与点击反馈。
- **右侧工作区分页**：右侧卡片统一采用 Tab 选项卡分页（`文件`、`Git & 终端`、`智能体`、`用量`），杜绝嵌套滚动条。
