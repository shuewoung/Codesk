# Codesk Expo 客户端

优先通过 Tailscale / WiFi 使用 Expo Web，也支持连 VPS 中继的 Android / iOS 客户端。业务消息仍是 Hub 的 WS，外层包 `fwd` 信封。

日常就开 Expo Web **`:18991`**。Hub `:18990` 若发现 18991 在跑，**本机**访问 `/` 会 302 过去；主机台「打开本地 Codex」也指向 18991。Cloudflare Tunnel / 别的电脑打开 `:18990` 不会跳到 `127.0.0.1`，只托管 Expo `dist-web`；旧 PWA 已归档，不再回退。

```bash
cd apps/mobile
npx expo start --web --port 18991 --host lan
# http://127.0.0.1:18991
```

打包 `scripts/pack-hub.ps1` 会先 `export:web`，安装包不依赖 Metro。

## 开发

```bash
cd apps/mobile
npm install
npx expo start
# Metro / Expo Go：http://localhost:18991
```

Cloudflare Tunnel 可以指到 `:18991`（实时 Expo Web）或 `:18990`（Hub 托管的 `dist-web`）。配对页只输家里码；请求走当前域名，由 Metro 转到本机 Hub `:18990`。Hub 必须同时在跑。不要把 Cloudflare 的 HTTP Host Header 改成 `127.0.0.1`。

浏览器打开开发态 Expo UI（Hub `:18990` 托管的是 Expo 静态导出）：

```bash
cd apps/mobile
npx expo start --web
# http://localhost:18991
```

配对页分两块：家里码 + 电脑地址；出门码或扫主机台右边的码。不要一个框两用。

用 Expo Go 扫终端里的二维码即可，不必先 EAS，也不要在仓库根目录生成 `android/` / `ios/`。

可选：本地预填中继地址

```bash
# Windows PowerShell
$env:EXPO_PUBLIC_RELAY_URL="https://example.invalid"
npx expo start
```

设置页也可以改连接地址。默认走官方入口。

## 配对

1. 电脑打开主机台：左家里、右出门
2. 同一 WiFi / Tailscale：扫左边直连二维码或打开电脑地址，输入固定 4 字符家里码
3. 出门：扫右边二维码，或手输出门码
4. 成功后凭证进 SecureStore（Web 使用本地存储），长期自动连接，直到退出撤销或主机台手动撤销设备

## EAS 打 Android APK（后置专项，不是 Web 使用前提）

```bash
cd apps/mobile
npx eas-cli@latest login
npx eas-cli@latest init --id b4237233-f824-49de-b3e1-e49904313ab4
npx eas-cli@latest build --platform android --profile preview
```

`preview` / `production` 都出 APK。极光 **AppKey** 写在 `app.json` 和 `android/app/build.gradle` 的 `JPUSH_APPKEY`（会打进包里）。Android 13+ 会在启动时要通知权限。**Master Secret 只放中继** `.env`，不要配到 EAS、不要写进用户 Hub。

## 打开发包

仍用 Expo Go 即可。若要独立安装包：

```bash
npx expo start
# 或以后再配 EAS：npx eas build --profile development
```

不要在仓库根目录执行 prebuild。需要原生目录时只允许出现在 `apps/mobile/` 内。

## 文件、产物与恢复操作

- 输入区附件入口区分“从当前设备上传”（当前手机/电脑）与“从宿主机选择”（运行 Hub 的电脑）。宿主机文件支持多选确认，不重复上传；卡片标注来源。上传任务绑定原会话，切换会话不会将结果加入新会话。
- 文件面板将本次产物、项目文件分开。只有有成功工具输出及文件存在证据的记录计为产物；没有可靠轮次边界时显示“会话已确认文件”，近期文档不自动认定为交付。图标统一显示文件类型。
- 原件下载上限 20 MiB，校验完整字节与 SHA-256；Office 原件与预览 PDF/HTML 分开。Web 交给浏览器保存，原生通过系统分享保存/打开。预览截断不影响原件下载的完整性要求。旧 Hub 不支持新下载协议时会明确超时/报错，需要更新 Hub。
- 文件选择/预览/下载受会话工作目录和上传目录授权限制，不支持任意浏览宿主机所有目录。符号链接越过授权目录会被拒绝。
- 断线和额度耗尽时仍可编辑本地草稿，但不能发送；恢复连接后不会自动发送。草稿按宿主机公开身份和会话隔离，不使用token作命名空间；旧草稿需明确认领到当前宿主机，认领后移除旧键。上传重试数据只在当前进程内保留，重启后未完成的上传需重新选择文件。
- 历史、搜索、刷新和文件读取有加载/错误/超时反馈；失败时使用对应重试入口。配对 HTTP 等待有上限，扫码权限永久拒绝时可打开系统设置。
- 设置中的退出先请求 LAN/Relay 凭据吊销；失败可重试或明确选择“仅本地退出”。仅本地退出不表示服务器授权已撤销，共享配对码也不因此失效。
- 最新答复回看与连接诊断是基础版本：不自动判断测试通过，不提供未测量的网络 RTT。常用/自定义提示词先填入输入框，确认后才发送。

实施清单、协议变更和实际验证范围见 [用户体验提升工作记录](../../docs/product/09-ux-improvements.md)。原生分享及相机功能需要含对应模块的新构建，不能以 Web 验收替代真机验收。

## 测试

```bash
npm ci --prefix apps/relay
npm ci --prefix apps/mobile
npm test --prefix apps/mobile
npm run typecheck --prefix apps/mobile
npm run export:web --prefix apps/mobile
```

导出会复制并校验 `apps/web-hub/assets` 中的主机台和必需图标，不包含旧 `app.js` / `sw.js`。

覆盖配对 URL 解析、会话/审批折叠、pair/revoke HTTP，以及连真实中继的 WSS/`fwd`/`hub_offline`/吊销。
