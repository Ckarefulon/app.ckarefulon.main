#!/usr/bin/env bash
# 只在「创建 Codespace」时运行一次。
#
# 关键前提（GitHub 文档）：prebuild 阶段只执行到 updateContentCommand，
# 生成快照时不会运行 postCreateCommand。所以放在这里的签名私钥
# 绝不会被烘进 prebuild 快照 —— 本仓库是公开仓库，任何人都能开 Codespace，
# 密钥一旦进快照就等于公开（2026-09 已经因为私钥泄露被迫换过一次证书）。
#
# 私钥来源：Codespaces 的「个人」密钥（Settings → Codespaces → Secrets）。
# 仓库是公开的 → 仓库级密钥对所有能开 Codespace 的人可见，绝不能用。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "[ck] 环境自检"
echo "  node      : $(node -v 2>/dev/null || echo '缺失')"
echo "  java      : $(java -version 2>&1 | head -n 1)"
echo "  ANDROID_HOME: ${ANDROID_HOME:-/opt/android-sdk}"
if "${ANDROID_HOME:-/opt/android-sdk}/cmdline-tools/latest/bin/sdkmanager" --version > /dev/null 2>&1; then
  echo "  sdkmanager: OK"
else
  echo "  sdkmanager: 不可用（Android 构建会失败，见 docs/Codespaces云端构建.md）" >&2
fi

# ------------------------------------------------------------------ 签名私钥

keys_dir="$repo_root/keys"
mkdir -p "$keys_dir"

if [ -n "${CK_KEYSTORE_B64:-}" ] && [ -z "${CK_KEYSTORE_PASSWORD:-}" ]; then
  echo "[ck] 错误：设置了 CK_KEYSTORE_B64，但缺少 CK_KEYSTORE_PASSWORD" >&2
  exit 1
fi

if [ -n "${CK_KEYSTORE_B64:-}" ]; then
  keystore="$keys_dir/Ckarefulon.keystore"
  printf '%s\n' "$CK_KEYSTORE_B64" | base64 -d > "$keystore"

  {
    echo "storeFile=../keys/Ckarefulon.keystore"
    echo "storePassword=${CK_KEYSTORE_PASSWORD}"
    echo "keyAlias=${CK_KEY_ALIAS:-Ckarefulon}"
    echo "keyPassword=${CK_KEY_PASSWORD:-${CK_KEYSTORE_PASSWORD}}"
    echo "storeType=PKCS12"
  } > "$keys_dir/keystore.properties"
  chmod 600 "$keys_dir/keystore.properties" "$keystore"

  echo "[ck] 已从 Codespaces 密钥恢复发布签名"

  # 指纹对比：换过证书的话，老用户装不上（必须卸载重装），这里明确提示。
  baseline='dfda920ed20b06ef1d00b32c7c1f9e6fbccac1eb32ddad3c0d5220e7ac10c59e'
  fp="$(keytool -list -v -keystore "$keystore" \
          -storepass "$CK_KEYSTORE_PASSWORD" -alias "${CK_KEY_ALIAS:-Ckarefulon}" 2>/dev/null \
        | sed -n 's/^[[:space:]]*SHA256: //p' | head -n 1 | tr -d ':' | tr 'A-Z' 'a-z')"
  echo "  证书 SHA-256: ${fp:-（读取失败）}"
  if [ -n "$fp" ] && [ "$fp" != "$baseline" ]; then
    echo "[ck] 注意：该证书与 131 版基线（$baseline）不一致 ——" >&2
    echo "      用它会签出「老用户装不上」的包，已装 128~131 的人必须卸载重装。" >&2
  fi
else
  echo "[ck] 未配置 CK_KEYSTORE_B64：release 包会回退 debug 签名（仅测试用）"
  echo "     要构建正式签名包，见 docs/Codespaces云端构建.md"
fi

echo
echo "[ck] post-create 完成。构建：npm run build"
