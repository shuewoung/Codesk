# 交接文档：修复 Web 端项目内会话不显示（VSCode/桌面创建的线程）

> 给执行模型的指令：严格按本文档执行。所有 bundle 编辑**必须写成 .cjs 脚本文件运行**，
> 禁止在 bash 双引号里内联 node -e（反引号/引号转义坑已踩过三次）。每步改完先 `node --check` 再重启。

## 背景（30 秒版）

架构：原版 Codex webview（浏览器）+ 真·主进程 bundle 跑在 Node（codex-web 方案，位于 `codex-web-upstream/`）。
服务器：`cd codex-web-upstream && CODEX_CLI_PATH="<repo>/codex-bin/codex.exe" node src/server/main.js --port 8214`（后台跑，日志重定向 server.log）。

**Bug**：web UI 里，已有本地项目展开后没有会话；web 自己新建的会话能显示；VSCode 扩展/桌面创建的会话全不显示。

## 已验证事实（不要重查）

1. app-server 层无问题：手动 spawn `codex-bin/codex.exe app-server`，initialize 后 `thread/list`（带或不带 `useStateDbOnly:true, sourceKinds:[], sortKey:"updated_at", archived:false`）都返回全部会话（脚本 `../probe-appserver.mjs`）。
2. 共享 sqlite（`~/.codex/sqlite/codex-dev.db` 表 `local_thread_catalog`）数据完整，线程 cwd 与项目 rootPaths 精确匹配。
3. 渲染端曾向主进程发 `thread/list`（mcp-request 桥），app-server 响应正常——丢失发生在**主进程 catalog 同步层**。
4. `isThreadVisible` 预热过滤无关（未跟踪线程恒可见）。
5. 同步器链路（26.707 bundle `scratch/asar/.vite/build/main-d9AlrLRg.js`）：
   - 工厂：`P=n.Vr(), F=P==null?null:(e,t)=>new n.i(P,e,t)`；若 `P==null` 则 `threadCatalogSyncManager=null`（**零日志，与现状吻合**）
   - 运行门控：`requestRun(e,t){if(this.disposed||!this.foreground)return ...}`；foreground 由 appEvent background 事件置 false（已打补丁移除 background 分支，**单独无效**）
6. 服务器日志 grep "catalog" 结果为 0 条（同步器从未活动或静默为 null）。

## 当前文件状态（重要）

`scratch/asar/.vite/build/main-d9AlrLRg.js` = pristine + 两个修改（语法已过 node --check）：
- foreground 补丁（appEvent.subscribe 移除 background 分支）
- SyncDebug 打桩（**分号形式**）：`P=n.Vr();console.warn("[SyncDebug] catalogStore=",P==null?"NULL":"OK");F=...`
- 服务器进程已 kill，**待重启**。

pristine 备份：如丢失，从 `scratch/ChatGPT.app/Contents/Resources/app.asar` 全量重解。

**打桩铁律**：该位置只能用分号语句形式替换（把逗号链改成 `P=n.Vr();...;F=...;I=...;`），
任何「在逗号链中插入内容」的形式都会产生莫名 SyntaxError（原因未明，勿再调查）。

## 执行步骤

### 第 1 步：重启服务器，读打桩输出
后台启动（命令见上），等 20s，`grep SyncDebug codex-web-upstream/server.log`。

### 第 2 步：按结果分支

**分支 A：`catalogStore=NULL`**（n.Vr() 返回 null）
→ 工厂在 `scratch/asar/.vite/build/src-Ct4P_yu5.js` 里（搜 `better-sqlite3 is only bundled with the Electron app`，`wO()` 函数 `require('better-sqlite3')` 失败即抛错、上层 catch 返回 null）。
排查：在 `codex-web-upstream` 下 `node -e 'require("better-sqlite3");console.log("ok")'` 验证可解析；
若可解析但仍 null，在工厂外层 catch 处打桩（分号形式）打印真实异常。
可能修法：在 `src/server/module.ts` 的 `installModuleAliasHook` 里给 `better-sqlite3` 加解析（返回 `createRequire(codex-web-upstream/package.json)` 的解析结果），重新 `npm run build:server`。

**分支 B：`catalogStore=OK`**（同步器存在但没跑）
→ 继续打桩（都加分号形式、改完 node --check）：
1. `$4` 类（同步协调器）的 `requestRun` 开头：打印入参和 foreground/syncEnabled。
2. manager 的 `attachHost`（搜 `attachHost(\`local\``）后打印是否被调。
3. 渲染端 population lease：主进程 `setPopulationEnabled`（AppHost 的 localThreadCatalog RPC 目标）是否被渲染端调用——若没被调，问题在渲染端侧栏初始化（查 webview assets 里 `setPopulationEnabled` 的调用条件）。
4. 根据打桩结果修复（大概率是某个 electron 依赖的 API 在 shim 里缺失导致链路断，参照 `src/server/electron/index.ts` 补 stub）。

### 第 3 步：修复后
1. 撤销所有打桩（保留 foreground 补丁，或若确认无效也撤销）。
2. 重生成补丁文件（diff pristine vs 修改后，头部改 `--- a/... +++ b/...` 格式），更新 `codex-web-upstream/patches/` + `scripts/prepare_asar` + 主仓库根目录存档。
3. 验证：Playwright 脚本模式——打开 http://127.0.0.1:8214，等 20s，点击侧栏已有项目，检查正文含该项目下已知会话标题。
4. 手机视口 + 项目顺序回归（项目顺序补丁 `webview-project-order-static.patch` 已生效，勿破坏）。
5. 更新 README 故障章节，git 提交（主仓库，`codex-web-upstream/` 已 gitignore）。

## 环境坑清单

- 杀服务器：`powershell Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 按 CommandLine 含 `src/server/main.js` 过滤 Stop-Process。
- Playwright 已装在主仓库 `node_modules`（脚本从主仓库根目录跑）。
- 浏览器端可能有 SW/缓存，验证用全新 Playwright context；用户浏览器需 Ctrl+Shift+R。
- bash 中路径含中文，引号用双引号包整路径。
- server.log 里 grep "catalog" 可能命中巨型单行 dump（错误栈带源码），加 `| head -c 500` 防刷屏。
