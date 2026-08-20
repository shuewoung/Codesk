#!/usr/bin/env bash
set -euo pipefail
WORK="${HOME}/codesk-apk/mobile"
SRC="/mnt/d/00_智能工作区/01_项目工作区/20260816-CodexWeb"
OUT="${SRC}/apps/mobile/dist"
ANDROID_HOME="${HOME}/Android/Sdk"
GRADLE_USER_HOME="${HOME}/.gradle"
NODE_BIN="$(command -v node)"
cd "${WORK}/android"
if grep -q '^org.gradle.jvmargs=' gradle.properties; then
  sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8/' gradle.properties
else
  printf '\norg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8\n' >> gradle.properties
fi
docker rm -f codesk-apk-build >/dev/null 2>&1 || true
docker run -d --name codesk-apk-build \
  -v "${WORK}:/project" \
  -v "${ANDROID_HOME}:/opt/android-sdk" \
  -v "${GRADLE_USER_HOME}:/root/.gradle" \
  -v "${NODE_BIN}:/usr/local/bin/node:ro" \
  -e ANDROID_HOME=/opt/android-sdk \
  -e ANDROID_SDK_ROOT=/opt/android-sdk \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e LANG=C.UTF-8 \
  -e JAVA_TOOL_OPTIONS="-Xmx2048m" \
  -w /project/android \
  eclipse-temurin:17-jdk \
  ./gradlew :app:assembleRelease --no-daemon --stacktrace
echo "container started"
docker logs -f codesk-apk-build
status="$(docker inspect -f '{{.State.ExitCode}}' codesk-apk-build)"
test "${status}" = "0"
mkdir -p "${OUT}"
APK="$(find "${WORK}/android" -name '*.apk' | head -n 1)"
test -n "${APK}"
cp -f "${APK}" "${OUT}/codesk-1.0.4.apk"
ls -lh "${OUT}/codesk-1.0.4.apk"
echo "APK ${OUT}/codesk-1.0.4.apk"
