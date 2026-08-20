#!/usr/bin/env bash
APP="$HOME/codesk-apk/mobile/android/app"
echo "=== manifest placeholders ==="
rg -n "JPUSH|manifestPlaceholders" "$APP/build.gradle" "$APP/src/main/AndroidManifest.xml" || true
echo "=== manifest jpush ==="
rg -n -C2 "JPUSH" "$APP/src/main/AndroidManifest.xml" || true
echo "=== gradle defaultConfig ==="
rg -n -C8 "defaultConfig" "$APP/build.gradle" | head -80
