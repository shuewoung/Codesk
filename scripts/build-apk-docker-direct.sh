#!/usr/bin/env bash
# 需要以 root 运行：容器内构建会向 /tmp/codesk-apk 写 root 属主文件，
# 混合属主会让后续 rsync --delete 失败。
set -euo pipefail

SRC="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb/apps/mobile"
WORK="/tmp/codesk-apk/mobile"
# root 下 $HOME 是 /root，必须写死真实用户路径，否则 docker 会挂载空目录
ANDROID_HOME="/home/shuwang/Android/Sdk"
GRADLE_USER_HOME="/home/shuwang/.gradle"
NODE_BIN="$(command -v node)"
OUT="${SRC}/dist"

[ "$(id -u)" = 0 ] || { echo "must run as root (sudo)"; exit 1; }
test -d "${SRC}" && test -x "${NODE_BIN}"

echo "=== rsync (anchored excludes; /dist won't hurt node_modules) ==="
mkdir -p /tmp/codesk-apk
rsync -a --delete \
  --exclude '/android/app/build' \
  --exclude '/android/build' \
  --exclude '/android/.gradle' \
  --exclude '/.expo' \
  --exclude '/dist' \
  --exclude '/dist-web' \
  "${SRC}/" "${WORK}/"
test -f "${WORK}/node_modules/sucrase/dist/index.js"
echo "sucrase ok"

cd "${WORK}/android"
sed -i '/^org.gradle.jvmargs=/d' gradle.properties
grep -q 'org.gradle.jvmargs=' gradle.properties || printf 'org.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m\n' >> gradle.properties
grep -q 'org.gradle.daemon=false' gradle.properties || printf 'org.gradle.daemon=false\n' >> gradle.properties

echo "=== docker build ==="
docker run --rm \
  -v "${WORK}:/project" \
  -v "${ANDROID_HOME}:/opt/android-sdk" \
  -v "${GRADLE_USER_HOME}:/root/.gradle" \
  -v "${NODE_BIN}:/usr/local/bin/node:ro" \
  -e ANDROID_HOME=/opt/android-sdk \
  -e ANDROID_SDK_ROOT=/opt/android-sdk \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e NODE_ENV=production \
  -e LANG=C.UTF-8 \
  -w /project/android \
  eclipse-temurin:17-jdk \
  ./gradlew :app:assembleRelease --no-daemon --stacktrace

APK="$(find "${WORK}/android/app/build/outputs" -name '*.apk' | head -n 1)"
test -n "${APK}"
echo "=== APK: ${APK} ==="
ls -lh "${APK}"
mkdir -p "${OUT}"
cp -f "${APK}" "${OUT}/codesk-1.0.11.apk"
ls -lh "${OUT}/codesk-1.0.11.apk"
echo "BUILD-SCRIPT-DONE"
