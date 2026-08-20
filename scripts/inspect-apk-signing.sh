#!/usr/bin/env bash
set -euo pipefail
APK="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb/apps/mobile/dist/codesk-1.0.2.apk"
GRADLE="$HOME/codesk-apk/mobile/android/app/build.gradle"
echo "=== signingConfig in gradle ==="
python3 - <<'PY'
from pathlib import Path
p = Path.home() / "codesk-apk/mobile/android/app/build.gradle"
text = p.read_text()
for key in ("signingConfig", "storeFile", "storePassword", "keyAlias", "debug", "release"):
    if key in text:
        pass
print("--- snippet ---")
keep = False
for i, line in enumerate(text.splitlines(), 1):
    if "signing" in line.lower() or "keystore" in line.lower() or "storeFile" in line or "keyAlias" in line:
        print(f"{i}:{line}")
PY
echo "=== keystore files ==="
find "$HOME/codesk-apk/mobile/android" -iname '*keystore*' -o -iname '*.jks' -o -iname '*.keystore' 2>/dev/null
echo "=== apksigner/keytool ==="
if command -v apksigner >/dev/null; then
  apksigner verify --print-certs "$APK" || true
elif [ -x "$HOME/Android/Sdk/build-tools/36.0.0/apksigner" ]; then
  "$HOME/Android/Sdk/build-tools/36.0.0/apksigner" verify --print-certs "$APK" || true
elif [ -x "$HOME/Android/Sdk/build-tools/35.0.0/apksigner" ]; then
  "$HOME/Android/Sdk/build-tools/35.0.0/apksigner" verify --print-certs "$APK" || true
fi
