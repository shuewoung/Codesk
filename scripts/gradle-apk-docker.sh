#!/usr/bin/env bash
set -euo pipefail
WORK="/tmp/codesk-apk/mobile"
ANDROID_HOME="${HOME}/Android/Sdk"
GRADLE_USER_HOME="${HOME}/.gradle"
SRC="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb"
OUT="${SRC}/apps/mobile/dist"
NODE_BIN="$(command -v node)"
mkdir -p "${OUT}"
test -d "${WORK}/android"
test -x "${NODE_BIN}"
docker run --rm \
  -v "${WORK}:/project" \
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
APK="$(find "${WORK}/android" -name '*.apk' | head -n 1)"
test -n "${APK}"
cp -f "${APK}" "${OUT}/codesk-1.0.2.apk"
ls -lh "${OUT}/codesk-1.0.2.apk"
echo "APK ${OUT}/codesk-1.0.2.apk"
