#!/usr/bin/env bash
set -euo pipefail
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${HOME}/Android/Sdk"
export ANDROID_SDK_ROOT="${ANDROID_HOME}"
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
unset GRADLE_OPTS || true
export JAVA_TOOL_OPTIONS="-XX:MaxMetaspaceSize=384m -XX:+HeapDumpOnOutOfMemoryError -Xms256m -Xmx512m -Dfile.encoding=UTF-8"
export GRADLE_USER_HOME="${HOME}/.gradle"
cd /tmp/codesk-apk/mobile/android
sed -i '/^org.gradle.jvmargs=/d' gradle.properties
grep -q 'org.gradle.daemon=false' gradle.properties || printf '\norg.gradle.daemon=false\n' >> gradle.properties
echo "=== gradle.properties ==="
cat gradle.properties
chmod +x gradlew
./gradlew :app:assembleRelease --no-daemon --stacktrace
find . -name '*.apk' -print
