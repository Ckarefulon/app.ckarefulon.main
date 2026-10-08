#!/usr/bin/env bash
# 在 prebuild 创建/更新时运行（有网；拿不到用户级密钥，也不需要）。
#
# 只做「跟 package-lock.json 有关、且结果值得烘进快照」的事：安装 npm 依赖。
# Android SDK 已经在镜像里，不用再装。
#
# 幂等：package-lock.json 的 sha256 与上次一致就跳过 npm ci，
# 这样每次 push 触发的 prebuild 更新不会白白重装几百 MB 依赖。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "[ck] 工作目录：$repo_root"
echo "[ck] node $(node -v 2>/dev/null || echo '(未安装)')"

lock_file="package-lock.json"
stamp_file="node_modules/.ck-lock-sha256"

if [ ! -f "$lock_file" ]; then
  echo "[ck] 找不到 $lock_file，跳过依赖安装" >&2
  exit 0
fi

want="$(sha256sum "$lock_file" | awk '{print $1}')"
have="$(cat "$stamp_file" 2>/dev/null || true)"

if [ -d node_modules ] && [ "$want" = "$have" ]; then
  echo "[ck] 依赖已与 $lock_file 一致，跳过 npm ci"
else
  echo "[ck] 安装 npm 依赖（npm ci）…"
  npm ci --no-audit --no-fund
  mkdir -p node_modules
  printf '%s\n' "$want" > "$stamp_file"
  echo "[ck] 依赖安装完成"
fi

# 预热 Gradle 发行版（约 200MB）：只下载 android/gradle/wrapper 指定的那个版本，
# 让用户第一次构建不用再等这一段。失败不影响使用，只警告。
if [ -f android/gradlew ]; then
  echo "[ck] 预热 Gradle 发行版…"
  (
    cd android
    chmod +x gradlew
    ./gradlew --version > /dev/null
  ) || echo "[ck] 警告：Gradle 预热失败（不影响后续构建，只是首次会慢）"
fi

echo "[ck] update-content 完成"
