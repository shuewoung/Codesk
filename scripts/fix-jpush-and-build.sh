#!/usr/bin/env bash
set -euo pipefail
GRADLE="$HOME/codesk-apk/mobile/android/app/build.gradle"
python3 - <<'PY'
from pathlib import Path
p = Path.home() / "codesk-apk/mobile/android/app/build.gradle"
text = p.read_text()
line = '        manifestPlaceholders += [JPUSH_APPKEY: "364b4be1280291e3543d9bb8", JPUSH_CHANNEL: "developer-default"]'
if "JPUSH_APPKEY" not in text:
    text = text.replace("defaultConfig {", "defaultConfig {\n" + line, 1)
    p.write_text(text)
    print("patched")
else:
    print("already patched")
PY
export ANDROID_HOME="${HOME}/Android/Sdk"
export GRADLE_USER_HOME="${HOME}/.gradle"
NODE_BIN="$(command -v node)"
docker rm -f codesk-apk-build >/dev/null 2>&1 || true
docker run -d --name codesk-apk-build \
  -v "${HOME}/codesk-apk/mobile:/project" \
  -v "${ANDROID_HOME}:/opt/android-sdk" \
  -v "${GRADLE_USER_HOME}:/root/.gradle" \
  -v "${NODE_BIN}:/usr/local/bin/node:ro" \
  -e ANDROID_HOME=/opt/android-sdk \
  -e ANDROID_SDK_ROOT=/opt/android-sdk \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e LANG=C.UTF-8 \
  -w /project/android \
  eclipse-temurin:17-jdk \
  ./gradlew :app:assembleRelease --no-daemon --stacktrace
echo "container started"
docker logs -f codesk-apk-build
status="$(docker inspect -f '{{.State.ExitCode}}' codesk-apk-build)"
test "${status}" = "0"
SRC="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb"
OUT="${SRC}/apps/mobile/dist"
mkdir -p "${OUT}"
APK="$(find "${HOME}/codesk-apk/mobile/android" -name '*.apk' | head -n 1)"
test -n "${APK}"
cp -f "${APK}" "${OUT}/codesk-1.0.2.apk"
ls -lh "${OUT}/codesk-1.0.2.apk"
echo "APK ${OUT}/codesk-1.0.2.apk"
