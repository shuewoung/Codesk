#!/usr/bin/env bash
set -euo pipefail
ZIP=/tmp/gradle-dl/gradle-8.14.3-bin.zip
mkdir -p /tmp/gradle-dl
if [ ! -s "$ZIP" ]; then
  curl -L --retry 5 -o "$ZIP" https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip
fi
DEST="$HOME/.gradle/wrapper/dists/gradle-8.14.3-bin/cv11ve7ro1n3o1j4so8xd9n66"
mkdir -p "$DEST"
rm -f "$DEST"/*.part "$DEST"/*.lck
cp "$ZIP" "$DEST/gradle-8.14.3-bin.zip"
ls -lh "$DEST"
