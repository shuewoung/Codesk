#!/usr/bin/env bash
echo "=== docker ==="
docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Command}}'
echo "=== java/gradle ==="
ps -ef | grep -E 'gradle|java|docker' | grep -v grep || true
echo "=== workdir ==="
ls -ld /tmp/codesk-apk/mobile/android 2>/dev/null || echo missing
echo "=== apk ==="
find /tmp/codesk-apk /mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb/apps/mobile/dist -name '*.apk' 2>/dev/null || true
echo "=== last gradle log ==="
ls -lt /tmp/codesk-apk/mobile/android/app/build 2>/dev/null | head
