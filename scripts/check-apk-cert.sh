#!/usr/bin/env bash
APK="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb/apps/mobile/dist/codesk-1.0.3.apk"
"$HOME/Android/Sdk/build-tools/35.0.0/apksigner" verify --print-certs "$APK"
