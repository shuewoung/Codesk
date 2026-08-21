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
- **版本检查**：在 `SettingsScreen.tsx` 中直接通过原生 `fetch('https://codesk.icu/version.json')` 检查版本，当 `versionCode > 110` 时原生弹窗引导下载。
- **软键盘视口自适应**：在 Android 与 Web 环境下依赖系统原生缩放，严禁手动叠加固定像素 `paddingBottom`（避免产生双重叠加抬高）；iOS 仅在扣除 Safe Area 后按差值进行微调。
- **Diff 节点就地展开**：`flattenItems` 中的 diff 节点必须透传 `patch` 字段，支持在对话流中直接展开行内代码差异。

### 3. Web 控制台与 Mobile 端对齐规范 (`apps/web-hub` & `apps/mobile`)
- **对齐规范（人右 AI 左）**：
  - 用户指令（`.message-card.role-user`）：靠右对齐（`align-self: flex-end; margin-left: auto;`）；
  - 助手消息（`.assistant-flow-block`）与中间态微节点：靠左对齐（`align-self: flex-start; text-align: left;`）。
- **长指令折叠阈值（5行折叠与双向展开）**：用户 Prompt 超过 5 行时默认仅展示 5 行，底部提供轻量「展开全文 ˅ / 收起 ˄」按钮，支持反复就地展开与折叠收起。
- **子智能体数据提纯与低饱和度呈现**：
  - 拦截并提纯内部子智能体回调（`{"agent_path": ...}`），提取有效结果直接归入 AI 正文流；
  - 移除刺眼的高饱和度 Emoji，统一采用低饱和度灰色细线框 SVG 图标（`stroke: #64748b; stroke-width: 1.6`）；
  - 智能体状态文字采用中性灰色（`#64748b` 与 `#94a3b8`），以纯文本微节点自然融入。
- **命令行 `exec` 极简单行化与连续多命令聚合折叠**：
  - 自动脱掉外部 `tools.exec_command({cmd: "..."})` 样板包装，提取核心 Shell/PowerShell 首行；
  - 移除所有外层大框与多余背景（Zero Boxes），单条命令只占 20px 浅灰色单行（`🔲 exec xxx ▾`）；
  - 连续执行多条命令时，自动聚合折叠为总览胶囊（`🔲 终端执行了 N 条命令 ▾`），点击可展开查看全部子命令及输出；
  - 中间态微节点默认应用 `opacity: 0.88`，鼠标悬停平滑恢复 100%。
- **右侧工作区面板双 Tab 整合**：
  - 顶部 Tab 标签精简为 `📁 文件` 与 `🌿 Git & 终端` 两个核心分页；
  - 「🤖 子智能体」与「📊 用量统计」下沉至文件树下方，与文件卡片统一采用单层白底圆角卡片；
  - 账号限额与上下文 Token 剩余量新增三级健康色（>35% 科技蓝、15%~35% 预警橙黄、<15% 告急红）。
- **Expo Mobile 端的完全同步 (`apps/mobile`)**：
  - `history.ts` 接入 `extractActualCommand`，同步支持子智能体回调提纯、技能名称去重与 `wait_agent` 噪音过滤；
  - `CommandGroupView` 统一呈现 `🔲 终端执行了 N 条命令 ▾`，保持 Web 与 Native 体验一致；
  - **底部紧邻输入框弹层（Bottom Popover）**：模型选择、推理强度与权限模式（「帮我批准」）彻底取消屏幕居中遮罩跳转，与 `/` 命令弹层、`+` 菜单完全统一，紧密附着在输入框上方浮动弹出，随选随走；
  - **行内链接与代码纯加粗化（Zero Box & Pure Bold）**：彻底移除正文中行内代码与文件/技能引用的灰色背景框、外边框与生硬蓝色，统一以原生文本颜色的纯加粗（`font-weight: 700; color: inherit;`）自然融入正文流；
  - **移动端用户气泡标准中性灰底色与原生文本渲染**：气泡底色统一采用系统标准灰色（`colors.user`，亮色 `#f4f4f4`，暗色 `#2f2f2f`），移除淡蓝色，采用纯净原生 Text 渲染，彻底避免 Markdown 引擎冗余解析；
  - **大屏（Pad / PC / Web）居中沉浸阅读容器**：大屏环境下对话流与输入框自动约束在 `maxWidth: 880px` 居中容器内，两侧自然留白，告别全屏拉伸浪费；
  - **双击极速折叠/展开（Double-Tap/Click to Fold）**：针对长用户 Prompt 及超长助手输出，双击气泡任意位置即可立即就地折叠（收拢至约 200px 高度）或重新展开，无需必须滑动寻找按钮，解决长文本刷不完的问题；
  - **项目与目录线框灰度化（Neutral Wireframe Folder Icons）**：全面移除耀眼的彩色 Emoji 文件夹（`📁`/`📂`），移动端与 Web 端统一采用低饱和度灰色细线框文件夹图标（`FolderOutlineIcon` 与 SVG `stroke: #64748b`），视觉素雅安静，不再抢夺注意力；
  - **连接状态极简纯粹化**：左上角连接状态文本精简为 `直连` 与 `中继`，保留清晰的状态圆点；设置 `flexShrink: 0` 保证连接状态在任何小屏幕与抽屉宽度下永不截断（不再出现 `直...`）；
  - **顶栏操作按钮舒朗布局**：精简顶栏拥挤按钮组，移除冗余的「刷新」纯文本按钮（列表本身已支持下拉刷新 `Pull-to-refresh`），右侧仅保留 `[＋ 对话]`、`[＋ 项目]` 与 `[⋯]` 菜单，释放充足横向间距，告别拥挤堆叠；
  - **列表排版密度对齐 PWA 黄金比例**：告别过度微缩的超紧凑模式（避免过小字号和过度挤压内边距），完全对齐 PWA 版本的经典间距与字体比例：文件夹与会话行高统一约为 `34px`（`paddingVertical: 7px`，字号 `14.5px`），分组小标题保持 `12.5px` 浅灰，层级缩进 `34px`，保持清晰易读的同时维持优雅的紧凑感；
  - **左侧会话与文件夹状态感知（Multi-State Badges）**：
    - **会话项状态**：运行中会话显示绿点与「运行中」徽章（`badge-working`）；等待批准显示橙点与「需批准」徽章（`badge-waiting`）；刚结束的任务（1分钟内）显示清晰低饱和的薄荷蓝绿调「✓ 刚刚」徽章（`badge-finished`，颜色 `#0d9488` / 背景 `rgba(13, 148, 136, 0.12)`）；
    - **文件夹状态三级联动**：项目文件夹外层实时统计内部状态：运行中优先显示（如 `🟢 1`），其次显示等待批准（如 `✋ 1`），若有子会话刚结束且无运行中任务，则同步显示刚刚完成计数（如 `✓ 1`），无论文件夹是否折叠，都能对全局进度一目了然；
    - **文件夹纯净排版（去底色卡片）**：彻底移除文件夹条目的灰底气泡卡片（`colors.shell`），采用与会话列表一致的扁平纯色背景；移除左侧多余的箭头（`▸`/`▾`），统一由灰色细线框文件夹图标直接承载视觉与展开状态，整行排版更加清爽紧凑；
  - **右侧工作区文件树对齐官方规范（Official IDE File Tree & Dedicated Icons）**：
    - **极简目录树排版**：彻底移除目录项笨重的大白底气泡卡片与冗余的“文件夹”文字，统一对齐官方 VSCode / Codex 树状风格（`› 目录名` / `⌄ 目录名`），层级缩进利落紧凑；
    - **常用文件专有图标体系**：
      - `README.md` / `*.md` ➔ 专用文档徽标 `ℹ`（蓝色）；
      - `.gitignore` / Git 配置文件 ➔ Git 菱形 `◆`（橙红色）；
      - `package.json` / `package-lock.json` ➔ Node 六角形 `⬢`（红色）；
      - `LICENSE` ➔ 天平 `⚖`（金色）；
      - 图片（`.png`, `.jpg`, `.svg` 等）➔ 图像 `🖼`（紫色）；
      - 代码文件（`.ts`, `.tsx`, `.js`, `.py`, `.rs`, `.go` 等）➔ 专用微徽章与语言图标（`TS`, `JS`, `{}`, `🐍`, `🦀`, `⚡`）；
      - 纯单行省略（`numberOfLines={1}`），长文件名不再错误折行；
  - **文件多引擎专业渲染（Multi-Engine File Viewers）**：
    - **Markdown 文档引擎**：完整支持 GitHub Flavored Markdown，包含一级/二级标题、粗体、代码块、表格与链接渲染；
    - **HTML 双模引擎**：支持「🌐 网页实时预览」与「💻 源码高亮」一键切换，实时沙箱 iframe 渲染真实网页排版；
    - **代码与脚本高亮引擎（JS / TS / JSON / Python / Shell / CSS 等）**：
      - 行号侧槽（Gutter Line Numbers），清晰展示代码行数；
      - 语法关键字（Keywords）、字符串（Strings）、注释（Comments）、数值与符号颜色分词；
      - JSON 自动格式化（Pretty-print）与长代码横向平滑滚动；
      - 顶部栏一键复制全文操作（带反馈提示）；
    - **图片原生渲染**：支持 base64 与 URL 图像缩放预览；
  - **PWA 界面精简与多端统一**：
    - **顶栏精简**：右上角保留「主机台」文字入口，彻底移除多余的二维码配对小框框图标（`#btn-show-pair-qr`）；
    - **左侧项目文件夹排版**：移除 PWA 左侧项目文件夹头部多余的小箭头（`▸`），与移动端保持统一的极简线框文件夹图标排版。
