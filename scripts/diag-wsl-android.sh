#!/usr/bin/env bash
set -u
echo "=== java ==="
java -version 2>&1
echo "=== env ==="
printf 'ANDROID_HOME=%s\n' "${ANDROID_HOME-}"
printf 'ANDROID_SDK_ROOT=%s\n' "${ANDROID_SDK_ROOT-}"
echo "=== sdk dirs ==="
ls -d /usr/lib/android-sdk /opt/android-sdk "$HOME/Android/Sdk" /mnt/d/Android/Sdk 2>/dev/null || true
echo "=== windows sdk ==="
ls /mnt/d/Android/Sdk 2>/dev/null | head || true
echo "=== daemon tail ==="
tail -50 "$HOME/.gradle/daemon/8.14.3/daemon-5075.out.log" 2>/dev/null || true
echo "=== docker images ==="
docker images
echo "=== leftover ==="
ls -d /tmp/shuwang/eas-build-local-nodejs/*/build/apps/mobile/android 2>/dev/null || true
echo "=== gradle home ==="
ls -la "$HOME/.gradle" | head
