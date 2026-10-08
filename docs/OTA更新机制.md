# OTA / 内容更新机制

> **v2 说明（当前默认）**：内容更新已改为 **Service Worker 直连仓库**——
> App 直接读取你 repo 里的网页文件并缓存，push 即生效，**不需要 zip、清单或任何发布步骤**。
> 本文下面的 zip / `app-ota/` / 清单流程为**可选 legacy 通道**（脚本仍保留：`npm run ota:bundle` / `ota:publish`），
> 仅当你想改用"整包替换"模式时才需要。


## 1. 版本规则

| 版本 | 形态 | 例子 | 说明 |
| --- | --- | --- | --- |
| 原生版本 `versionName` / `versionCode` | APK | `1.0.0` / `100` | 只有重新构建 APK 才变 |
| 资源包版本 | OTA zip | `1.0.202609171614` | `主.次.时间戳(UTC yyyymmddHHmm)`，单调递增、合法 semver |
| 内容版本 `contentVersion` | 展示用 | `13.2.1823` | 从站点 `Cube/Formula/Changelog.md` 自动解析 |

比较规则：按数字段逐段比较。资源包版本 > 当前运行版本 ⇒ 有更新。

## 1.5 更新源 URL 到底是个啥

`https://gitee.com/Ckarefulon/Ckarefulon.github.io/raw/main/app-ota/latest.json`
不是网页，而是**仓库里一个文件的原始内容地址**（raw = 取文件本身，main = 分支）：

- `latest.json`：更新清单（版本号、zip 地址、sha256、最低原生版本）；
- 同目录的 `www-<版本>.zip`：站点资源包本体。

App 只用 HTTP GET 读这两个文件，不打开任何网页；**不需要开通 Gitee Pages**，公开仓库的 raw 接口默认可用。仓库里还没有 `app-ota/` 时访问是 404，推送后即生效。

**本仓库的 Gitee 是 GitHub 的镜像**，所以日常只需要 push GitHub：
Actions 打资源包 → 提交 `app-ota/` 回 GitHub → Gitee 镜像同步 → 手机从 Gitee raw 高速下载。
不需要 Gitee 令牌、不需要单独推送。注意镜像同步可能有几分钟延迟（个别镜像方式需在 Gitee 仓库页手动点“同步”），同步前手机读到的仍是旧清单，不会出错。

## 2. 更新源（镜像）

`app.config.json → ota.mirrors`，按顺序尝试，**第一个成功的会被记住**（localStorage `ck.ota.preferredMirror`），下次优先：

```json
"mirrors": [
  { "name": "Gitee",        "base": "https://gitee.com/Ckarefulon/Ckarefulon.github.io/raw/main", "enabled": true },
  { "name": "GitHub Pages", "base": "https://ckarefulon.github.io", "enabled": false },
  { "name": "jsDelivr",     "base": "https://fastly.jsdelivr.net/gh/Ckarefulon/Ckarefulon.github.io@main", "enabled": false }
]
```

- 清单地址 = `<base>/app-ota/latest.json`；zip 地址优先用清单里的 `relativeUrl` 拼当前镜像，下载失败自动换下一个镜像。
- 清单与 zip 都走**原生 HTTP**（CapacitorHttp / Capgo 下载器），不受 WebView 跨域限制，能正常跟随 Gitee 的 302 跳转。
- Gitee raw 的缓存只有 60 秒，发布后 1 分钟内全网可见；jsDelivr 有最长 12 小时缓存，所以只建议做兜底。

## 3. 清单字段（latest.json）

```jsonc
{
  "channel": "production",
  "version": "1.0.202609171614",        // 资源包版本
  "url": "https://gitee.../www-1.0.202609171614.zip",
  "relativeUrl": "app-ota/www-1.0.202609171614.zip",
  "mirrors": [ { "name": "Gitee", "manifest": "...", "url": "..." } ],
  "bytes": 1415832,
  "sha256": "04ef217a...",              // zip 校验和
  "contentVersion": "13.2.1823",
  "commit": "94bba75",
  "files": 162,
  "minNativeVersion": "1.0.0",          // 低于此原生版本 → 提示下载新 APK
  "minNativeCode": 100,
  "notes": "",
  "apkUrl": "https://gitee.com/.../releases",
  "publishedAt": "2026-09-17T16:14:59Z"
}
```

## 4. 客户端流程

```
App 启动（壳 或 资源包页面）
  ├─ notifyAppReady()                    告知插件“当前包加载成功”（失败才会回滚）
  ├─ 1.5s 后静默 check()
  │    ├─ 读清单（多镜像）
  │    ├─ 版本比较
  │    │    ├─ 原生过旧      → 浮标“需要更新安装包”→ 打开 apkUrl
  │    │    ├─ 已是最新      → 无提示
  │    │    └─ 有新版        → 下载（进度浮标/启动页进度条）
  │    │         └─ CapacitorUpdater.next(id)  → 下次后台/重启时激活
  │    │              └─ toast“新版本已下载… [立即重启]”
  ├─ 回前台 / 每 60 分钟 / 网络恢复 → 再次 check()
  └─ 新包激活后加载失败 → 插件自动回滚到上一个可用包 / 内置壳
```

激活策略 `ota.applyMode`：
- `next`（默认）：下载后不中断当前使用，下次启动或后台切换时生效；
- `set`：下载完立即重载（会打断当前页面）。

`keepUrlPathAfterReload: true` 已开启：重载后保留用户当前所在页面路径。

## 5. 发布流程

```bash
npm run ota:bundle                     # → dist/ota/{latest.json, www-*.zip}
npm run ota:publish -- --push          # 复制到站点仓库 app-ota/，提交并推送 gitee
```

或直接 push 网页改动，由 `Publish OTA Bundle` 工作流自动完成（提交信息带 `[skip ci]`，且 `paths-ignore: app-ota/**`，不会自我触发循环）。

仓库里只保留最近 3 个 zip（`ota.keepReleases`），避免 git 历史膨胀。

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| 一直停在启动页“下载资源” | 检查网络；点“重试”；或“临时在线模式”先用网页版 |
| 更新后页面异常 | `CkApp.update.reset()`（关于面板→重置资源）重新下载 |
| 提示“需要更新安装包” | 清单里 `minNativeVersion/minNativeCode` 高于本机 APK → 装新 APK |
| 想强制立刻检查 | 控制台 `CkApp.update.check()`；或 `CkApp.showAbout()` 面板 |
| 看当前生效版本 | `CkApp.update.info()`（bundleId / version / 内容版本 / 构建时间 / 提交） |
