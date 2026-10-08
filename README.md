# Ckarefulon · Android 壳工程

把 <https://github.com/Ckarefulon/Ckarefulon.github.io>（Gitee 同库镜像）打包成安卓 App 的完整方案：

| 需求 | 实现方式 |
| --- | --- |
| 打包成 APK | **Capacitor 8** 原生壳（WebView + 6 个原生插件），包名 `app.ckarefulon.main` |
| 自动更新 | **Service Worker 直连仓库**：网页内容直接从你的 repo 拉取并缓存，push 之后 App 自动拿到新版，**零发布步骤、不用重装 APK** |
| 离线使用 | 首启缓存落盘（Cache Storage），之后完全离线；CDN 依赖（supabase-js / jszip / tailwind / lucide / ts-fsrs）也一并缓存 |
| 内容源 | **jsDelivr（国内快）→ Netlify（自建镜像）** 自动回落；任一可用即可；全不可用时启动页提供"在线模式（Netlify）"按钮 |
| 签名 | PKCS12 keystore，别名 / 证书主体均为 **Ckarefulon**（v1+v2+v3 签名） |
| 蓝牙 | **Web Bluetooth → 原生 BLE 桥**：站点里的 GAN / Giiker / Moyu / GoCube / QiYi 魔方代码一行不改即可在 App 里连蓝牙 |
| APK 体积 | **≈ 4.9 MB**（壳只有 88 KB 网页资源，站点内容不进 APK） |

---

## 1. 架构

```
┌─────────────────────────── 手机上的 App ───────────────────────────┐
│  APK 壳（≈4.9MB）= WebView + 启动页 + 原生插件（BLE 桥 / 更新 UI）   │
│    └─ Service Worker（/sw.js）                                     │
│         ├─ 有缓存 → 秒开（离线可用），后台静默回源刷新                │
│         ├─ 无缓存 → 回源拉取 → 注入蓝牙桥脚本 → 缓存 → 展示          │
│         └─ 回源顺序：jsDelivr(快) → Netlify(回落)；每源 8s 超时切换   │
└───────────────────────────────▲────────────────────────────────────┘
                                │ 普通 HTTPS：读的就是你 repo 里的文件
        ┌───────────────────────┴──────────────────────┐
        │  你的仓库 main 分支（网页内容原样存放，无需加工）│
        └──────────────────────────────────────────────┘
```

**首次启动**：联网缓存首屏（约 1 MB）→ 进入站点。
**之后**：完全离线可用；你 push 新内容后，App 在后台静默刷新缓存，提示"刷新"即见新版。
**不需要** `app-ota/`、zip、清单或任何发布动作（旧 zip OTA 通道仍保留在脚本中，作为可选 legacy）。
**兼容性**：本地服务使用 `http://localhost`（localhost 属信任源，SW/离线不受影响），以兼容个别对 https 本地服务实现有缺陷的 WebView；覆盖升级时原生层会自动清理旧 ServiceWorker 注册，避免残留拦截。

> **什么时候才需要重新构建 APK？**
> 只有「原生层」变化时才需要：加/换原生插件、改权限、改包名/图标/启动图、升级 Capacitor 或 Android SDK。
> 改网页、加页面、改样式、改 JS（包括蓝牙逻辑）→ 推仓库即可，手机自动热更新。

---

## 2. 目录结构

```
app-android/                     ← 把本目录放进站点仓库根目录（名字固定为 app-android）
├── app.config.json              ★ 唯一配置源：包名/版本/签名/更新源/打包规则
├── capacitor.config.json        由 scripts/write-config.mjs 生成，勿手改
├── shell/                       APK 内置的启动壳页面
├── src/                         壳运行时源码（esbuild → ck-app.js，进 APK 与资源包各一份）
│   ├── ble/web-bluetooth-polyfill.js   Web Bluetooth → 原生 BLE 桥
│   ├── update/{updater,bootstrap}.js   OTA 检查/下载/激活/回滚
│   └── ui/ck-ui.js                     设备选择器 / Toast / 更新浮标
├── scripts/
│   ├── build-web.mjs            esbuild 打包运行时（shell / bundle 两种角色）
│   ├── sync-shell.mjs           生成 www/（只含壳）
│   ├── make-bundle.mjs          ★ 构建 OTA 资源包（复制+离线化+注入+zip+清单）
│   ├── publish-ota.mjs          ★ 发布到站点仓库 app-ota/ 并推送
│   ├── patch-android.mjs        定制 Android 工程（权限/签名/版本/图标引用）
│   ├── build-apk.mjs / verify-apk.mjs   构建 + 13 项校验
│   ├── make-keystore.mjs        生成 Ckarefulon 签名
│   ├── make-assets.mjs          站点 favicon.svg → 各密度图标/启动图
│   └── bump.mjs                 版本号管理
├── android/                     Capacitor 生成的原生工程（已定制，随仓库提交）
├── keys/                        签名（已被 .gitignore 忽略，务必自行备份！）
├── .devcontainer/               云端构建：Codespaces / prebuild 配置
├── .github/workflows/           CI：Build Android APK
├── build.sh / build.ps1         本地一键构建（Linux·mac / Windows）
└── docs/                        详细文档
```

---

## 3. 快速开始

### 3.1 本地构建（Windows）

```powershell
# 前置：Node 22+、JDK 21、Android SDK（装 Android Studio 即可）
git clone https://gitee.com/Ckarefulon/Ckarefulon.github.io.git
cd Ckarefulon.github.io\app-android
.\build.ps1                 # 构建 release APK + 校验
.\build.ps1 -Mode all       # APK + OTA 资源包
```

产物：`dist\Ckarefulon-<版本>-<versionCode>-release.apk`

### 3.2 本地构建（macOS / Linux）

```bash
./build.sh          # 或 ./build.sh all
```

### 3.3 不装任何环境：云端构建

两条路线，都不需要本地装 JDK / Android SDK，产物都能直接下载 —— 详见 **`docs/Codespaces云端构建.md`**：

- **GitHub Actions**（`.github/workflows/android-apk.yml`）：**Actions → Build Android APK → Run workflow**（或打 `v*` tag 自动触发），构建签名 APK 并发到 Release，在 Release 附件里直接下载。
  在仓库 Secrets 里配置 `CK_KEYSTORE_B64`（keystore 的 base64）、`CK_KEYSTORE_PASSWORD`、`CK_KEY_PASSWORD`（见 `docs/签名与发布.md`）。没配也能跑，但产物是临时签名，仅测试用。
- **Codespaces + prebuild**（`.devcontainer/`）：秒开一个装好 JDK 21 + Android SDK 的云端开发环境，跑 `npm run build` 后在文件树里右键 APK → Download。
  签名私钥用 **Codespaces 个人密钥**恢复（**不要用仓库级密钥** —— 本仓库是公开仓库，仓库级密钥对任何能开 Codespace 的人可见）。

- **改网页不需要任何工作流**：App 直接从 jsDelivr/Netlify 读取仓库内容，push 即生效。

> ⚠️ 签名密钥当前**已丢失**（本地、git 历史、app-kit 包里都没有）。重建 = 换证书，
> 装了 128~131 的用户必须卸载重装。动手前先读 `docs/Codespaces云端构建.md` §1。

### 3.4 安装到手机

```bash
adb install -r release/Ckarefulon-latest-release.apk
```
或把 APK 传到手机直接安装（需允许“安装未知应用”）。

---

## 4. 日常更新流程（改网页）

```
改网页 → git push（GitHub；Gitee 镜像自动跟随）→ 结束。
```

手机下次打开或回前台时，Service Worker 会在后台回源刷新缓存；
若内容有变化，App 内会出现提示，点"刷新"即见新版（下次冷启动则直接是新版）。
**没有任何额外发布步骤**，也不需要动 APK。

---

## 5. 离线行为说明

- 首次启动必须联网一次（下载资源包，约 1.4 MB）。
- 之后完全离线可用，包括所有页面与本地化的 CDN 脚本。
- 依赖网络的在线功能（Supabase 云端同步等）离线时自然不可用，页面本身照常打开。
- 离线时检查更新会得到“当前离线”提示，不影响使用。

---

## 6. 质量闸门（出包前自动运行）

| 闸门 | 命令 | 作用 | 失败后果 |
| --- | --- | --- | --- |
| 真网功能测试 | `npm run ptest` | 真下载全部首屏核心 + vendor（多传输链），并验证"下载→入缓存回执"链路 | **阻断出包**（离线环境自动跳过） |
| 冒烟测试 | `npm run smoke` | 在 jsdom 里真实执行壳运行时（壳角色 + 站点角色），任何 ReferenceError/TypeError/启动失败即失败 | **阻断出包** |
| APK 校验 | `npm run verify` | apksigner + aapt2：签名/包名/版本/权限/壳内容共 14 项 | 仅报告 |

`npm run apk` 会依次执行 ptest → smoke → gradle → 复制产物；任一闸门失败即停止。

---

## 7. 命令速查

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 壳同步 + Android 定制 + 构建签名 APK |
| `npm run verify` | 校验 APK（签名/包名/版本/权限/壳内容，13 项） |
| `npm run ota:bundle` | 构建 OTA 资源包 → `dist/ota/` |
| `npm run ota:publish -- --push` | 发布资源包到站点仓库并推送（默认推 gitee） |
| `npm run bump patch` | 版本号 +1（改原生层时用） |
| `npm run kit` | 打「换机器重建」源码包 → `release/Ckarefulon-app-kit.zip`（**不含签名私钥**） |
| `npm run keystore` | 重新生成签名（**慎用**：换了签名老用户无法覆盖安装） |
| `npm run icons` | 重新生成图标/启动图 |

更多细节见 `docs/`：

- `docs/Codespaces云端构建.md` — 云端出包（Actions / Codespaces + prebuild）、密钥重建与备份
- `docs/OTA更新机制.md` — 版本规则、清单字段、回滚、多镜像、故障排查
- `docs/蓝牙BLE.md` — Web Bluetooth 桥接 API 对照、权限、调试
- `docs/签名与发布.md` — keystore 管理、CI Secrets、Gitee 令牌
- `docs/本地构建.md` — 环境要求与常见报错

