# Codesk 测试与诊断

所有本地验证脚本统一放在 `tests/` 下，按被测层分组：

- `browser/`：原版 Web UI、移动端和项目/会话渲染验证；
- `app-server/`：真实 `codex.exe app-server` 与共享 catalog 的只读探针；
- `hub/`：本机口令、命令面板、只读 Git、Hub 出站中继；
- `ipc/`：`codex-ipc` Host Router / follower 探针；
- `asar/`：桌面 `app.asar` 的只读提取和逆向诊断。

CI 从干净依赖运行 Hub、Relay、Mobile 测试和 Expo Web 导出（Mobile 的 relay-client 测试会跨目录导入 Relay）：

```bash
npm ci --prefix apps/relay
npm ci --prefix apps/web-hub
npm ci --prefix apps/mobile
npm test --prefix apps/relay
npm test --prefix apps/web-hub
npm test --prefix apps/mobile
npm run typecheck --prefix apps/mobile
npm run lint --prefix apps/mobile
npm run export:web --prefix apps/mobile
```

导出验证 Expo 入口脚本、活跃主机台与必需图标，并拒绝旧 `app.js` / `sw.js`。`tests/browser/` 的历史 PWA 探针不代表当前 Expo 验收；不要为了运行旧探针恢复归档 PWA。

下列诊断可能访问本机服务或 Codex 用户目录，并非上述隔离单测。默认从仓库根目录运行，例如：

```powershell
node tests/hub/run.mjs
node tests/app-server/session-count.mjs
node tests/browser/verify-codexweb.mjs
```

脚本会优先使用 `CODEX_HOME`；未设置时使用当前 Windows 用户的 `~/.codex`。测试产物统一写入 `tests/artifacts/`，不会再写入 `D:\tmp` 或覆盖仓库根目录截图。

涉及真实 app-server 的脚本只读查询会话和 catalog，不创建会话、不发送 turn、不修改会话内容。

## 体验提升隔离验收

新增纯测试已接入 Mobile/Hub 的 `npm test`：请求 ID/连接身份、草稿附件保存竞态、完整原件下载及 SHA-256、文件权限/产物轮次、实际 HTTP/WS handler 回包契约。

```bash
node --test tests/mobile/ux-fixture.test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/windows/launch-safety.test.ps1
node tests/mobile/ux-fixture.mjs --port 19992
```

Windows 脚本只做 PowerShell 解析、纯函数断言、C# 临时编译及反射，不执行安装升级、不停止 Hub。它不能代替真实安装/恢复验收。

GUI 夹具入口是 `http://ux-fixture.localhost:19992`，家里码 `2468`。使用正常页面登录，服务当前 `apps/mobile/dist-web`；两个虚拟会话、项目、附件和下载内容只在内存。严格 CSP 禁止请求真实 Hub/中继，禁止将此夹具作为真实服务部署。普通 `127.0.0.1` 页面可能触发客户端固定 Hub 端口发现，所以夹具先重定向到专用 `.localhost` 域名。控制端点仅用于环境准备，正式黑盒验收不得以注入替代交互。

验收至少覆盖：配对与错误反馈、两种附件入口、宿主机多选、上传时切会话、产物/候选分区、预览重试、下载校验失败、断线草稿、搜索乱序、键盘焦点。相机和系统分享另做 Android/iOS 原生验收；工具不支持文件选择器时标记受限，不用程序注入假装上传成功。

本轮记录与已查看截图见 [体验提升工作记录](../docs/product/09-ux-improvements.md)。截图和日志保存在 `tests/artifacts/ux-20260911/`（按既有规则忽略版本控制），文档中的结论保留在源码树。

## 跨端工作台隔离回归与 GUI 准备

范围与验收矩阵见 [跨端工作台实施与验收](../docs/product/11-cross-device-workbench.md)。以下命令从仓库根目录运行，依赖安装沿用上文的 `npm ci`：

```bash
npm test --prefix apps/mobile
npm test --prefix apps/web-hub
npm test --prefix apps/relay
npm run typecheck --prefix apps/mobile
npm run lint --prefix apps/mobile
node --test tests/mobile/ux-fixture.test.mjs
```

- Mobile 的 `npm test` 已包含 session reliability、composer draft / draft sync、pending commands、thread UI 等回归。
- Hub 的 `npm test` 已包含 `workbench.test.mjs`、`writer-handoff.test.mjs`、`config-application.test.mjs` 与 `relay-security.test.mjs`；Relay 的 `npm test` 已包含 `test/security.test.mjs`。
- `node --test tests/mobile/ux-fixture.test.mjs` 是隔离夹具服务自身的回归，不等同于生产 Hub handler 或 GUI 验收。真实 workbench handler 的集成用例在 `apps/web-hub/server/workbench.test.mjs`：临时目录保存测试状态，临时 loopback WebSocket 调用生产 `createWorkbench` handler，发送由计数并返回模拟成功的 `send` stub 替代，不启动真实 Hub、IPC 或模型。这也不代表真实 Desktop 写锁交接已实测。

### 独立导出并启动夹具

本轮本地 GUI 准备不要运行上文 CI 的 `npm run export:web`，也不要覆盖正在使用的 `apps/mobile/dist-web`。直接调用 `apps/mobile/node_modules/expo/bin/cli export --platform web --output-dir <绝对隔离目录>`，工作目录必须是 `apps/mobile`。例如在仓库根目录的 PowerShell 中运行：

```powershell
$repo = (Get-Location).Path
$dist = Join-Path ([System.IO.Path]::GetTempPath()) ("codesk-cross-device-web-" + [guid]::NewGuid().ToString('N'))
Push-Location (Join-Path $repo 'apps/mobile')
try {
    node ./node_modules/expo/bin/cli export --platform web --output-dir "$dist"
    if ($LASTEXITCODE -ne 0) { throw '隔离 Expo Web 导出失败；不要启动夹具' }
} finally {
    Pop-Location
}
node (Join-Path $repo 'tests/mobile/ux-fixture.mjs') --port 19993 --dist "$dist"
```

这里直接导出 Expo Web，不替代 `export:web` 对正式部署资源的验证。`--dist` 必须指向本次隔离导出；省略时夹具会默认读取真实 `apps/mobile/dist-web`。启动日志中的 `dist` 和 `origin` 应与本次准备一致。

夹具只绑定 `127.0.0.1`，GUI 使用 `http://ux-fixture.localhost:19993`，在正常配对页面输入虚拟家里码 `2468`。数字 loopback 入口会重定向；专用域名避免客户端固定 Hub 端口发现，CSP 限制连接到夹具自身，不能连接真实 Hub / Relay。会话、草稿、队列、执行状态及模型回复均为模拟数据，不读取真实用户会话、不调用模型、不执行真实命令，不能作为真实服务部署。

准备期可使用日志提供的 `setupBase` / `controlToken` 调用 `/__fixture/state`、`/__fixture/control`、`/__fixture/reset`；这些接口要求 `x-fixture-control` 请求头且拒绝带浏览器 `Origin` 的请求。控制接口仅用于准备断线、延迟、失败、执行状态等场景。正式 GUI 验收必须通过正常页面交互，不用控制接口、脚本注入或改源码代替登录、发送、排队、草稿冲突处理及交回桌面等操作。

上述内容仅说明已接入的回归入口和隔离准备方法，不记录最终通过数字，也不宣称已完成最终 GUI、Android/iOS 真机或真实 Desktop 跨端实测。
