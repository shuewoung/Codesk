# Codesk Expo 客户端

出门连 VPS 中继的 Android / iOS 客户端。业务消息仍是 Hub 的 WS，外层包 `fwd` 信封。

## 开发

```bash
cd apps/mobile
npm install
npx expo start
```

浏览器打开当前 Expo UI（不是 Hub `:18990/` 旧 PWA）：

```bash
cd apps/mobile
npx expo start --web
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
2. 同一 WiFi：填左边家里码 + 常用局域网地址
3. 出门：扫右边二维码，或手输出门码
4. 成功后凭证进 SecureStore。退出才 `POST /api/relay/revoke`

## EAS 打 Android APK

```bash
cd apps/mobile
npx eas-cli@latest login
npx eas-cli@latest init --id b4237233-f824-49de-b3e1-e49904313ab4
npx eas-cli@latest build --platform android --profile preview
```

`preview` / `production` 都出 APK。极光 **AppKey** 写在 `app.json`（会打进包里）。**Master Secret 只放中继** `.env`，不要配到 EAS、不要写进用户 Hub。

## 打开发包

仍用 Expo Go 即可。若要独立安装包：

```bash
npx expo start
# 或以后再配 EAS：npx eas build --profile development
```

不要在仓库根目录执行 prebuild。需要原生目录时只允许出现在 `apps/mobile/` 内。

## 测试

```bash
cd apps/mobile
npm test
npm run typecheck
```

覆盖配对 URL 解析、会话/审批折叠、pair/revoke HTTP，以及连真实中继的 WSS/`fwd`/`hub_offline`/吊销。
