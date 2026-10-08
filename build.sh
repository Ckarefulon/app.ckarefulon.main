#!/usr/bin/env bash
# Ckarefulon 安卓壳 一键构建（Linux / macOS）
#   ./build.sh            构建 release APK
#   ./build.sh debug      构建 debug APK
#   ./build.sh bundle     只构建 OTA 资源包
#   ./build.sh all        APK + OTA 资源包
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-release}"

echo "== 环境检查 =="
command -v node >/dev/null || { echo "缺少 Node.js（需要 22+）"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node 版本过低（当前 $(node -v)，需要 22+）"; exit 1; }
echo "node $(node -v)"

if [ -z "${JAVA_HOME:-}" ]; then
  for guess in /usr/lib/jvm/java-21-openjdk-amd64 /usr/lib/jvm/java-21-openjdk /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home /opt/jdk21; do
    [ -x "$guess/bin/java" ] && export JAVA_HOME="$guess" && break
  done
fi
[ -n "${JAVA_HOME:-}" ] || { echo "缺少 JDK 21：请安装并设置 JAVA_HOME"; exit 1; }
export PATH="$JAVA_HOME/bin:$PATH"
echo "java $(java -version 2>&1 | head -1)"

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for guess in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" /opt/android-sdk /usr/local/android-sdk; do
    [ -d "$guess" ] && export ANDROID_HOME="$guess" && break
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "缺少 Android SDK：请安装 Android Studio 并设置 ANDROID_HOME"; exit 1; }
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
echo "sdk  $ANDROID_HOME"

echo "== 依赖 =="
[ -d node_modules ] || npm install --no-audit --no-fund

case "$MODE" in
  bundle)
    npm run ota:bundle
    ;;
  debug)
    npm run android:sync && npm run android:patch && npm run apk:debug && npm run verify
    ;;
  all)
    npm run android:sync && npm run android:patch && npm run apk && npm run verify && npm run ota:bundle
    ;;
  *)
    npm run android:sync && npm run android:patch && npm run apk && npm run verify
    ;;
esac

echo
echo "完成。产物在 dist/ 目录："
ls -lh dist/*.apk dist/ota/*.zip 2>/dev/null || true
