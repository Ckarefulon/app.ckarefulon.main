# 云端构建（Codespaces / GitHub Actions）

不装任何本地环境，在云端出 APK 并直接下载。两条路线：

| 路线 | 适合 | 产物怎么拿 | 签名 |
| --- | --- | --- | --- |
| **A. GitHub Actions**（`.github/workflows/android-apk.yml`） | 想「点一下就出包下载」 | Actions → 运行 → Release 附件直接下载 | 配了 Secrets = 正式签名；没配 = debug 签名 |
| **B. Codespaces + prebuild**（`.devcontainer/`） | 想改代码、调试、跑测试、反复出包 | 左侧文件树右键 `dist/*.apk` → Download | 配了个人密钥 = 正式签名；没配 = debug 签名 |

两条路都不需要本地装 JDK / Android SDK。日常改网页仍然什么都不用跑（走 OTA 热更新，见 README §4）。

---

## 1. 先看这个：签名密钥丢过，132 是重建出来的

> 当前状态（2026-11）：**128–131 那代的私钥已确认丢失** —— git 全历史、`release/Ckarefulon-app-kit.zip`、
> 各机器工作区都查过，都没有。已重建当前证书：**132 起**，SHA-256 `4b164aa5…`
> （见 `release/apk-verify.json` 与 HANDOFF 头部的「证书断代」表）。

这意味着：**装了 128~131 的用户拿到 132 的包无法覆盖安装**，必须先卸载重装。
（128 那次也是因为私钥泄露换的证书；这已经是本项目第二次换证书。）

⚠️ 这一次的私钥同样只存在于当前环境 —— **先备份再干活**：
`npm run keys:export -- --out=~/ck-signing-backup`，然后把两个文件转存到密码管理器
（keystore 与口令**分开**存放）。备份/恢复往返可验证：解回来 `keytool -list -v` 的指纹应不变。

### 1.1 重建密钥（只在确实找不回来时做）

在 Codespace 里（或在任何装了 JDK 21 的机器上）：

```bash
npm run keystore          # 生成 keys/Ckarefulon.keystore + keystore.properties
```

口令默认随机生成并写进 `keys/keystore.properties`。想自己定口令就先设环境变量：

```bash
CK_KEYSTORE_PASSWORD='你的口令' npm run keystore
```

然后**立刻做两件事**：

```bash
# ① 备份（丢了就只能再换一次证书，老用户再卸一次）
mkdir -p ~/ck-backup && cp keys/Ckarefulon.keystore keys/keystore.properties ~/ck-backup/

# ② 记下指纹，以后用它核对「这次签的包老用户能不能覆盖安装」
keytool -list -v -keystore keys/Ckarefulon.keystore \
  -storepass "$(sed -n 's/^storePassword=//p' keys/keystore.properties)" \
  | grep SHA256
```

把 `keystore.keystore` + 口令存进密码管理器（口令和密钥分开存）。**不要提交进仓库** —— `keys/*.keystore`、`keys/keystore.properties` 已在 `.gitignore` 里，别绕过它。

### 1.2 转成 base64（给 Codespaces 密钥 / Actions Secrets 用）

Windows PowerShell：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("keys\Ckarefulon.keystore")) | Out-File -Encoding ascii keys-b64.txt
```

Linux / macOS / Codespace：

```bash
base64 -w0 keys/Ckarefulon.keystore > keys-b64.txt    # macOS 用 base64 -i ... | tr -d '\n'
```

---

## 2. 路线 A：GitHub Actions（最省事）

工作流已在 `.github/workflows/android-apk.yml`。

**不配任何 Secrets 也能用**：手动触发 → 拿到 debug 签名的 APK（能装能测，不能用于正式发布，也无法覆盖安装老版本）。

配好 Secrets 就是正式签名包：

`仓库 → Settings → Secrets and variables → Actions → New repository secret`，加四个：

| Secret | 值 |
| --- | --- |
| `CK_KEYSTORE_B64` | 上面 `keys-b64.txt` 的内容（一整行） |
| `CK_KEYSTORE_PASSWORD` | `storePassword` |
| `CK_KEY_PASSWORD` | `keyPassword`（PKCS12 通常与 storePassword 相同） |
| `CK_KEY_ALIAS` | 可省略，默认 `Ckarefulon` |

> Actions 的**仓库级** Secret 是安全的：工作流能读，但任何人（包括能开 Codespace 的人）都读不出来，fork 也拿不到。

**出包**：`Actions → Build Android APK → Run workflow`（可填版本号 / versionCode / 是否发 Release）。
打 `v*` tag 也会自动触发。

**下载**：跑完在 `Releases` 里直接下载 APK 附件；或在该次运行页面底部 `Artifacts` 下载 zip。

工作流里 `npm run apk` 会依次跑完 utest → ptest → smoke → e2e → gradle，任一闸门失败就**不出包**（这是设计如此，见 README §6）。

---

## 3. 路线 B：Codespaces + prebuild

### 3.1 文件都在干什么

```
.devcontainer/
├── Dockerfile            JDK 21 + Android SDK（platform-tools / android-36 / build-tools 36.0.0）
│                         + headless Chrome 的系统依赖（E2E 闸门用）
├── devcontainer.json     镜像 + Node 22 / sshd 两个 feature + 生命周期命令 + 机器规格
├── update-content.sh     prebuild 阶段跑：npm ci + 预热 Gradle 发行版（幂等）
└── post-create.sh        创建 Codespace 时跑：恢复签名私钥（绝不进 prebuild 快照）
```

**为什么 `features` 里除了 Node 还有一条 `sshd`**：本仓库用自定义 `Dockerfile`
（`FROM mcr.microsoft.com/devcontainers/java:1-21-bookworm`），而基础镜像里**没有**
openssh-server。GitHub 文档的口径是「默认 dev container 镜像自带并自动启动 SSH 服务；
不是基于默认镜像创建的 Codespace 要在 `features` 里自己加
`ghcr.io/devcontainers/features/sshd:1`」。

这一条不是可选项：`gh codespace ssh`（以及任何把它当数据通道的客户端，比如 DSH 的
Codespace 工作区插件）是在容器**内部**拉起一个 SSH 服务、再经 dev tunnel 转发过来的，
容器里没有 sshd 就完全走不通 —— 表现是控制面（开关机、列 Codespace、看状态）一切正常，
但读写文件、跑命令一条都失败，`gh` 只会给一句
`error getting ssh server details: failed to start SSH server:`。

**改完必须删除并重建 Codespace**：feature 是在创建时烘进容器的，不会补装到已有实例上。

**关键点（决定了密钥放在哪一步）**：GitHub 文档明确，生成 prebuild 快照时只执行到
`updateContentCommand`，**不会运行 `postCreateCommand`**；而且 prebuild 期间拿不到用户级密钥。
所以：

- `updateContentCommand`（进快照）只装依赖，**不碰密钥**；
- `postCreateCommand`（不进快照）才恢复密钥。

本仓库是**公开仓库**，任何人都能开 Codespace。如果密钥进了快照，等于对所有人公开 ——
2026-09 已经因为私钥泄露被迫换过一次证书，这个坑不能再踩。

### 3.2 密钥放哪：三种 secret，只有两种能用

> 先搞清一件事：**「仓库 secret」有两种，安全模型完全不同。**
>
> | 位置 | 注入到哪 | 本仓库（public）安全吗 |
> | --- | --- | --- |
> | Settings → Secrets → **Actions** | 只有工作流能读 | ✅ **安全，推荐放这里** |
> | 头像 → Settings → **Codespaces** → Secrets（个人） | 只有**你自己**开的 Codespace | ✅ 安全 |
> | Settings → Secrets → **Codespaces**（仓库级） | 该仓库的**所有** Codespace | ❌ **等于公开** |
>
> 为什么第三种不行：仓库级 Codespaces secret 会注入到这个仓库创建的每一个 Codespace；
> 而 GitHub 文档写得很清楚 —— 公开仓库**任何有额度的用户都能开 Codespace**
> （"you can create a codespace for any public repository"）。
> 两者一叠加，陌生人开个 Codespace 就把私钥读走了。2026-09 那次泄露是同一类后果。

**推荐配置（两条都配，各管一段）**

```bash
npm run keys:export              # 打印需要备份哪些值（默认不显示 base64）
npm run keys:export -- --out=~/ck-signing-backup   # 同时落成可直接恢复的文件
```

① **Actions 仓库级 Secret**（出正式签名包的正路 —— 配好之后 CI 直接出正式签名包，
   本机与 Codespace 都不需要私钥）：
   仓库 → Settings → Secrets and variables → **Actions** → New repository secret

② **Codespaces 个人 Secret**（要在 Codespace 里手工出正式签名包时才需要）：
   右上角头像 → Settings → **Codespaces** → Secrets → New secret，
   Repository access 选这个仓库。

两处用的名字和值一样：

| 名称 | 值 |
| --- | --- |
| `CK_KEYSTORE_B64` | `npm run keys:export -- --show` 输出的那一整行 |
| `CK_KEYSTORE_PASSWORD` | `storePassword` |
| `CK_KEY_PASSWORD` | `keyPassword` |
| `CK_KEY_ALIAS` | 可省略，默认 `Ckarefulon` |

都没配也能用，只是出 debug 签名的包（`post-create.sh` 与 `npm run doctor` 都会提示），
且 `npm run verify` 会红一项「签名者为 Ckarefulon」。

### 3.3 开 prebuild

`仓库 → Settings → Code, planning and automation → Codespaces → Set up prebuild`

- **Branch**：`main`
- **触发**：`On configuration change` 更省 Actions 额度（只在 `.devcontainer/` 或 Dockerfile 变化时重建）；
  想让依赖跟着 `package-lock.json` 自动更新就选 `Every push`。
- 建好后等第一轮跑完（首次要下 JDK/SDK 层，约 5~10 分钟）。

之后新建 Codespace 就是秒开：SDK 和依赖已经在快照里。

### 3.4 出包并下载

在 Codespace 终端：

```bash
npm run build        # = android:sync + android:patch + apk（含全部质量闸门）
npm run verify       # 签名/包名/版本/权限校验
```

产物在 `dist/`：

```
dist/Ckarefulon-1.0.0-<versionCode>-release.apk   签名 APK
dist/Ckarefulon-latest-release.apk
dist/apk-info.json / dist/apk-verify.json
```

在左侧文件树里右键 APK → **Download** 即可拿到本地安装。

只想要包、不做质量闸门（快，但没跑测试）：`npm run android:sync && npm run apk:debug`。

### 3.5 新建 Codespace 后的第一次构建（实测清单）

**先跑自检**，它会逐项告诉你缺什么、怎么补（比直接跑完整流水线快得多，也不会
把环境问题伪装成"构建失败"）：

```bash
npm run doctor            # 人读；npm run doctor -- --quiet 只报问题；--offline 跳过联网检查
```

自检覆盖：Node/JDK 21/Android SDK 组件/node_modules/cordova 插件工程/发布签名
（含证书指纹是否还是 131 基线）/E2E 浏览器能否真的启动/各更新源连通性/release 基线
是否被 debug 签名污染/工作区有没有散落的私钥。退出码 0 = 可以出包，1 = 有阻塞项。

然后按下面走：

在新开的 Codespace 里从零跑通一次（2026-11 实测：2 核环境 4.9MB APK 约 2.5 分钟出包）：

```bash
# 1) E2E 闸门要真浏览器。镜像已装好系统依赖，只差二进制：
npx puppeteer browsers install chrome
#    装到 ~/.cache/puppeteer/chrome/<ver>/chrome-linux64/chrome
#    build-apk.mjs 会自动找到它，不用导 CHROME_BIN。
#    ⚠️ 只装二进制不够：缺 libglib 等系统库时启动直接报
#       chrome: error while loading shared libraries: libglib-2.0.so.0
#       依赖已进镜像（.devcontainer/Dockerfile），老实例可临时补：
#       sudo apt-get update && sudo apt-get install -y libglib2.0-0 libnss3 \
#         libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
#         libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 \
#         libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2

# 2) 出包（干净检出直接跑，不需要先手工 sync）
npm run apk
npm run verify
```

**干净检出可以直接 `npm run apk`**：`android/capacitor-cordova-android-plugins/` 是生成物、
不在仓库里，脚本发现它缺失会自动改跑 `cap sync` 补上（只跑 `cap copy` 补不出来，
gradle 会报 `Could not read script .../cordova.variables.gradle as it does not exist`）。

**没有 `keys/` 时 `npm run verify` 必然红一项**（`签名者为 Ckarefulon`），因为构建回落到
debug 签名（`CN=Android Debug`）——包能装能测，但不是发布签名。要真签名先把个人密钥
配好（§3.2），或在终端里临时生成一套（**会换证书**，见 §1）。

---

## 4. 什么时候才需要重打 APK

只有**原生层**变了才需要：加/换原生插件、改权限、改包名/图标/启动图、升级 Capacitor 或 Android SDK。

改网页、加页面、改样式、改 JS（含蓝牙逻辑）→ 直接 push，手机自动热更新（README §4）。

改了原生层就顺手 `npm run bump patch` 抬版本号。

---

## 5. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `bash: .devcontainer/xxx.sh: /bin/bash^M: bad interpreter` | 脚本被写成了 CRLF。`.gitattributes` 已钉 `*.sh text eol=lf`；若仍出现，检查本机 `core.autocrlf` 并重取文件 |
| `SDK location not found` | `ANDROID_HOME` 没生效。`devcontainer.json` 的 `containerEnv` 已设 `/opt/android-sdk`；本地构建则见 `docs/本地构建.md` |
| Gradle 报找不到 `:capacitor-cordova-android-plugins` | 干净检出后没跑 `cap sync`。该目录是生成物、不在仓库里，而 `android/settings.gradle` 会 `include` 它 —— 直接跑 `npm run build`（`build-apk.mjs` 会检测缺失并自动改跑 `cap sync`），或先手动 `npm run android:sync` |
| `Failed to install the following Android SDK packages` | 协议未接受。镜像里已 `sdkmanager --licenses`；手动补装：`sdkmanager --install "platforms;android-36" "build-tools;36.0.0"` |
| `Gradle build daemon disappeared unexpectedly` | 内存不足。`hostRequirements` 已要求 4 核 / 8GB；仍失败就 `./gradlew --stop` 后重试。脚本本身也会按总内存自动切低内存串行模式 |
| 每次 prebuild 都重装依赖 | `node_modules/.ck-lock-sha256` 是判断依据；若 `node_modules` 被清了（不在快照里）就会重装，属预期 |
| 构建镜像时 `apt-get update` 退出码 100 / `NO_PUBKEY 62D54FD4003F6525` | 基础镜像里烘着 `dl.yarnpkg.com` 的 apt 源和「当时」的 Yarn 签名公钥，Yarn 后来轮换了密钥 → 该源变成未签名 → `set -e` 中断构建。**2026-10 实际踩到**。`Dockerfile` 已在 `apt-get update` 前定向删除这个源（见那里的注释）。注意：别用 `apt-get install chromium` 绕，那会踩同一个坑 |
| e2e 闸门被跳过（日志出现「未检测到 chromium/chrome」） | 没装浏览器。Codespace 里 `npx puppeteer browsers install chrome` 即可（**别用 apt 装**，理由同上）；装好后 `build-apk.mjs` 会自动从 `~/.cache/puppeteer` 找到它，**不用导 `CHROME_BIN`**；CI 里工作流已显式安装 |
| Chrome 装好了但报 `error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file` | puppeteer 只下二进制、不装系统库。镜像已预装这组依赖（`Dockerfile` 里那一串 libglib/libnss/...）；**老 Codespace 实例**是旧镜像，按 §3.5 的 apt 命令临时补一次，或删掉重建实例拿新镜像 |
| `npm run verify` 红一项「签名者为 Ckarefulon」 | 没有 `keys/`，构建回落到 debug 签名（`CN=Android Debug`）。要真签名先配 §3.2 的个人密钥。**这不代表包坏了**（其余 14 项都过、能装能测） |
| 老用户装不上新 APK | **证书换了**（见 §1）。确认指纹是否还是 `dfda920e…`；不同则只能卸载重装 |
| prebuild 里出现了密钥 | 不可能，除非把恢复逻辑写进了 `updateContentCommand` 或 Dockerfile。密钥只允许出现在 `post-create.sh` |
| `gh codespace ssh` 报 `error getting ssh server details: failed to start SSH server:` | 容器里没有 sshd。见 §3.1：自定义 Dockerfile 的仓库必须在 `features` 里声明 `ghcr.io/devcontainers/features/sshd:1`，并且**删掉重建** Codespace（feature 不进已有实例）。判据：`command -v sshd` 有输出才是装上了 |
| 云端工作区能开能停，但读写文件/跑命令全失败 | 同上一条的另一种表现。控制面走 GitHub REST API，数据面走 `gh codespace ssh`，缺 sshd 时只有数据面全挂 |

---

## 6. 相关文档

- `docs/本地构建.md` — 本机构建与常见报错
- `docs/签名与发布.md` — keystore 管理、CI Secrets
- `docs/OTA更新机制.md` — 版本规则、清单字段、回滚
- `HANDOFF.md` §5 / §7 — 证书断代史、私钥泄露事故与处置
