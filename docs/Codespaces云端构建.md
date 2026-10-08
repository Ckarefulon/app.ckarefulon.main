# 云端构建（Codespaces / GitHub Actions）

不装任何本地环境，在云端出 APK 并直接下载。两条路线：

| 路线 | 适合 | 产物怎么拿 | 签名 |
| --- | --- | --- | --- |
| **A. GitHub Actions**（`.github/workflows/android-apk.yml`） | 想「点一下就出包下载」 | Actions → 运行 → Release 附件直接下载 | 配了 Secrets = 正式签名；没配 = debug 签名 |
| **B. Codespaces + prebuild**（`.devcontainer/`） | 想改代码、调试、跑测试、反复出包 | 左侧文件树右键 `dist/*.apk` → Download | 配了个人密钥 = 正式签名；没配 = debug 签名 |

两条路都不需要本地装 JDK / Android SDK。日常改网页仍然什么都不用跑（走 OTA 热更新，见 README §4）。

---

## 1. 先看这个：签名密钥丢了

> 当前状态：`keys/Ckarefulon.keystore` 与 `keys/keystore.properties` **本机已不存在**，
> git 历史与 `release/Ckarefulon-app-kit.zip` 里也没有（app-kit 里只有一份占位 README）。
> 131 版基线证书是 `dfda920e…`（见 `release/apk-verify.json`）。

这意味着：**重新生成的密钥 = 换了一张证书**。
按 HANDOFF §5 的证书断代，装了 **128~131** 的用户拿到新证书的包**无法覆盖安装**，必须先卸载重装。
（128 那次就是因为私钥泄露换过证书；换证书这件事在这个项目里已经发生过一次。）

所以重建密钥前先接受这个后果，或者先把密钥找回来（旧手机备份、密码管理器、换机器前的旧目录都值得翻一遍）。

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
├── devcontainer.json     镜像 + Node 22 feature + 生命周期命令 + 机器规格
├── update-content.sh     prebuild 阶段跑：npm ci + 预热 Gradle 发行版（幂等）
└── post-create.sh        创建 Codespace 时跑：恢复签名私钥（绝不进 prebuild 快照）
```

**关键点（决定了密钥放在哪一步）**：GitHub 文档明确，生成 prebuild 快照时只执行到
`updateContentCommand`，**不会运行 `postCreateCommand`**；而且 prebuild 期间拿不到用户级密钥。
所以：

- `updateContentCommand`（进快照）只装依赖，**不碰密钥**；
- `postCreateCommand`（不进快照）才恢复密钥。

本仓库是**公开仓库**，任何人都能开 Codespace。如果密钥进了快照，等于对所有人公开 ——
2026-09 已经因为私钥泄露被迫换过一次证书，这个坑不能再踩。

### 3.2 配个人密钥（不要用仓库级！）

Codespaces 的**仓库级** Secret 对所有能开 Codespace 的人可见 —— 公开仓库上等于公开。
必须用**个人**密钥：

`右上角头像 → Settings → Codespaces → Secrets → New secret`，Repository access 选这个仓库。

| 名称 | 值 |
| --- | --- |
| `CK_KEYSTORE_B64` | `keys-b64.txt` 内容 |
| `CK_KEYSTORE_PASSWORD` | `storePassword` |
| `CK_KEY_PASSWORD` | `keyPassword` |
| `CK_KEY_ALIAS` | 可省略，默认 `Ckarefulon` |

没配也能用，只是出 debug 签名的包（`post-create.sh` 会提示）。

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
| Gradle 报找不到 `:capacitor-cordova-android-plugins` | 干净检出后没跑 `cap sync`。该目录是生成物、不在仓库里，而 `android/settings.gradle` 会 `include` 它 —— 先跑 `npm run android:sync`（工作流里已有这一步） |
| `Failed to install the following Android SDK packages` | 协议未接受。镜像里已 `sdkmanager --licenses`；手动补装：`sdkmanager --install "platforms;android-36" "build-tools;36.0.0"` |
| `Gradle build daemon disappeared unexpectedly` | 内存不足。`hostRequirements` 已要求 4 核 / 8GB；仍失败就 `./gradlew --stop` 后重试。脚本本身也会按总内存自动切低内存串行模式 |
| 每次 prebuild 都重装依赖 | `node_modules/.ck-lock-sha256` 是判断依据；若 `node_modules` 被清了（不在快照里）就会重装，属预期 |
| e2e 闸门被跳过（日志出现「未检测到 chromium/chrome」） | 本地没装浏览器。Codespace 里可 `sudo apt-get install -y chromium` 后设 `CHROME_BIN`；CI 里工作流已显式安装 |
| 老用户装不上新 APK | **证书换了**（见 §1）。确认指纹是否还是 `dfda920e…`；不同则只能卸载重装 |
| prebuild 里出现了密钥 | 不可能，除非把恢复逻辑写进了 `updateContentCommand` 或 Dockerfile。密钥只允许出现在 `post-create.sh` |

---

## 6. 相关文档

- `docs/本地构建.md` — 本机构建与常见报错
- `docs/签名与发布.md` — keystore 管理、CI Secrets
- `docs/OTA更新机制.md` — 版本规则、清单字段、回滚
- `HANDOFF.md` §5 / §7 — 证书断代史、私钥泄露事故与处置
