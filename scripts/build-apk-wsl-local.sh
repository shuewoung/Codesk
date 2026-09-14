#!/usr/bin/env bash
set -euo pipefail

SRC="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb/apps/mobile"
WORK="/tmp/codesk-apk/mobile"
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${HOME}/Android/Sdk"
export ANDROID_SDK_ROOT="${ANDROID_HOME}"
export GRADLE_USER_HOME="${HOME}/.gradle"
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

mkdir -p /tmp/codesk-apk
# 注意：排除模式必须锚定根目录（/dist），否则会误伤 node_modules/*/dist
rsync -a --delete \
  --exclude '/android/app/build' \
  --exclude '/android/build' \
  --exclude '/android/.gradle' \
  --exclude '/.expo' \
  --exclude '/dist' \
  --exclude '/dist-web' \
  "$SRC/" "/tmp/codesk-apk/mobile/"

cd "$WORK/android"
# WSL 单次构建：无守护进程 + 3G 堆（R8 收缩需要比默认更大的堆）
sed -i '/^org.gradle.jvmargs=/d' gradle.properties
grep -q 'org.gradle.jvmargs=' gradle.properties || printf 'org.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m\n' >> gradle.properties
grep -q 'org.gradle.daemon=false' gradle.properties || printf 'org.gradle.daemon=false\n' >> gradle.properties
chmod +x gradlew

echo "=== building ==="
./gradlew :app:assembleRelease --no-daemon --stacktrace -q || ./gradlew :app:assembleRelease --no-daemon --stacktrace

APK="$(find "$WORK/android/app/build/outputs" -name '*.apk' | head -n 1)"
test -n "$APK"
echo "=== APK: $APK ==="
ls -lh "$APK"
mkdir -p "$SRC/dist"
cp -f "$APK" "$SRC/dist/codesk-1.0.12.apk"
ls -lh "$SRC/dist/"
