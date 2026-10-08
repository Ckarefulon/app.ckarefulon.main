# Ckarefulon 安卓壳 —— Codespaces / devcontainer 基础镜像
#
# 只负责「装工具链」这一件不随源码变化的事，所以放进镜像层：
#   · JDK 21 —— android/app/capacitor.build.gradle 用 VERSION_21
#   · Android SDK：platform-tools + platforms;android-36 + build-tools;36.0.0
#     （与 android/variables.gradle 的 compileSdk/targetSdk 36 对齐，见 docs/本地构建.md）
#
# 好处：prebuild 快照里已经装好 SDK，创建 Codespace 时不用再下载约 1.5GB。
# 这里不装 Node —— Node 22 由 devcontainer.json 的 node feature 提供。

FROM mcr.microsoft.com/devcontainers/java:1-21-bookworm

# cmdline-tools 固定到具体版本并校验 sha256：
# 用 "latest" 会在上游更新后静默换包，构建环境就不可复现了。
# 升级时把版本号与 sha256 一起换掉（sha256 见
# https://dl.google.com/android/repository/repository2-3.xml）。
ARG ANDROID_CMDLINE_TOOLS_BUILD=16111833
ARG ANDROID_CMDLINE_TOOLS_SHA256=0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8

# 与 android/variables.gradle 保持一致
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}

# 先删掉基础镜像里烘着的 dl.yarnpkg.com 源，再 apt-get update。
#
# 原因：镜像里带的是「构建镜像当时」的 Yarn 签名公钥，Yarn 之后轮换了密钥，
# 于是 apt-get update 报 NO_PUBKEY 62D54FD4003F6525 并以 100 退出，
# 在 set -e 下直接中断整个构建（2026-10 实际踩到，Codespace 创建失败）。
#
# 不选「刷新密钥」是因为有鸡生蛋问题：装 gnupg 得先 apt-get update，而它正是坏的那一步。
# 本项目用 npm，不需要从 apt 装 yarn；yarn 由 node feature 经 corepack/npm 提供，
# 且它只在 yarn.list 仍存在时才会重配该源（devcontainers/features 的 node/install.sh），
# 所以删掉后不会被加回来。
#
# 注意：注释必须写在 RUN 之外 —— Dockerfile 的多行 RUN 续行里不支持 # 注释。
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/yarn.list; \
    sed -i '/dl\.yarnpkg\.com/d' /etc/apt/sources.list 2>/dev/null || true; \
    grep -rlZ 'dl\.yarnpkg\.com' /etc/apt/sources.list.d 2>/dev/null | xargs -0 -r rm -f; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl unzip ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    tools_zip=/tmp/android-commandline-tools.zip; \
    curl --fail --location --retry 3 --retry-delay 2 \
        "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_BUILD}_latest.zip" \
        --output "${tools_zip}"; \
    echo "${ANDROID_CMDLINE_TOOLS_SHA256}  ${tools_zip}" | sha256sum --check --strict; \
    mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools"; \
    unzip -q "${tools_zip}" -d /tmp/android-cmdline-tools; \
    mv /tmp/android-cmdline-tools/cmdline-tools "${ANDROID_SDK_ROOT}/cmdline-tools/latest"; \
    rm -rf /tmp/android-cmdline-tools "${tools_zip}"; \
    yes | sdkmanager --licenses > /dev/null 2>&1 || true; \
    sdkmanager --install "platform-tools" "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}"; \
    rm -rf "${ANDROID_SDK_ROOT}/.temp"; \
    chmod -R a+rX "${ANDROID_SDK_ROOT}"; \
    if id vscode > /dev/null 2>&1; then chown -R vscode:vscode "${ANDROID_SDK_ROOT}"; fi
