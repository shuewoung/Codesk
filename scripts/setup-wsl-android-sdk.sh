#!/usr/bin/env bash
set -euo pipefail
SDK_ROOT="${HOME}/Android/Sdk"
TOOLS_ZIP="${HOME}/commandlinetools-linux.zip"
mkdir -p "${SDK_ROOT}/cmdline-tools"
if [ ! -x "${SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -L --retry 5 -o "${TOOLS_ZIP}" \
    "https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-linux-11076708_latest.zip" \
    || curl -L --retry 5 -o "${TOOLS_ZIP}" \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  rm -rf "${SDK_ROOT}/cmdline-tools/latest" "${SDK_ROOT}/cmdline-tools/cmdline-tools"
  unzip -q "${TOOLS_ZIP}" -d "${SDK_ROOT}/cmdline-tools"
  mv "${SDK_ROOT}/cmdline-tools/cmdline-tools" "${SDK_ROOT}/cmdline-tools/latest"
fi
export ANDROID_HOME="${SDK_ROOT}"
export ANDROID_SDK_ROOT="${SDK_ROOT}"
export PATH="${SDK_ROOT}/cmdline-tools/latest/bin:${SDK_ROOT}/platform-tools:${PATH}"
yes | sdkmanager --licenses >/tmp/sdk-licenses.log || true
sdkmanager --install \
  "platform-tools" \
  "platforms;android-35" \
  "platforms;android-36" \
  "build-tools;35.0.0" \
  "build-tools;36.0.0"
echo "ANDROID_HOME=${ANDROID_HOME}"
sdkmanager --list_installed
