#!/usr/bin/env bash
set -u
echo "=== workdir ==="
ls -la /tmp/codesk-apk/mobile/android 2>/dev/null | head
echo "=== gradle.properties ==="
cat /tmp/codesk-apk/mobile/android/gradle.properties 2>/dev/null
echo "=== gradle wrapper ==="
ls /tmp/codesk-apk/mobile/android/gradle/wrapper 2>/dev/null
echo "=== locales ==="
locale
locale -a | head
