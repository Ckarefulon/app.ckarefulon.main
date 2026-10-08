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

RUN set -eux; \
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
    yes | sdkmanager --licenses > /dev/null; \
    sdkmanager --install "platform-tools" "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}"; \
    rm -rf "${ANDROID_SDK_ROOT}/.temp"; \
    chmod -R a+rX "${ANDROID_SDK_ROOT}"; \
    if id vscode > /dev/null 2>&1; then chown -R vscode:vscode "${ANDROID_SDK_ROOT}"; fi
