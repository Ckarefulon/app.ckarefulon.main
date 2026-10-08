# 交接说明（HANDOFF）

> 目标仓库：https://gitlink.org.cn/Careful_S/transit（2026-10 由 `tmp` 改名；旧地址平台会自动重定向，但文档一律写新名）
> 状态基线：APK `release/Ckarefulon-1.0.0-131-release.apk`（versionCode 131，签名 CN=Ckarefulon，v2+v3）
> 130 = 129 + 跨域「网页通道不通自动改走系统通道」；131 = 130 + 失败主机冷却（见 §5「跨域『主机不可达』」条）。
> **装 131，不要装 130**：130 里凡是连不上的主机，每次请求都要多等一轮原生超时才报错。
> ⚠️ **128 换了签名证书**（旧证书私钥泄露，见 §5）：证书 SHA-256 由 `9d2a2dfa…` 变为 `dfda920e…`。
> **124–127 的用户装 128 必须先卸载**（123 及更早同样）。旧证书已作废，勿再用于任何新包。
> 125 的 E2E 验证结论（有网首启进首页 ✅、断网 reload ✅、点目录卡片进真实站点页 ✅、
> 热启动快通道秒进 ✅）对 126–129 仍然成立（这几版只改蓝牙就绪判定、选择器兜底、文案与签名）

## 1. 这是什么

把静态站点 https://github.com/Ckarefulon/Ckarefulon.github.io（Gitee 同库镜像）打包成安卓 App 的
**壳工程（Capacitor 8）**。APK 内不含站点内容（壳仅 ~90KB 网页资源），站点内容通过
**Service Worker 直连仓库镜像源**拉取并缓存（离线可用、push 后自动更新，无需任何发布步骤）。

## 2. 关键架构（务必先读）

- `shell/index.html`：启动壳（深色启动页 + 看门狗）。
- `src/ck-app.js`：入口，esbuild 打两份：
  - `www/ckapp/ck-app.js`（role=shell）：启动流程 `src/update/bootstrap.js`
  - `www/ckapp/ck-site.js`（role=bundle）：注入到站点每个 HTML（蓝牙桥 + 更新检查）
- `src/sw/sw.js`：Service Worker（构建时注入 `__CK_SW_META__`）：
  - 同源请求：CacheStorage 命中秒开（SWR 后台刷新）；未命中回源
  - 回源顺序（`app.config.json → ota.mirrors`）：Gitee raw(仅原生通道,cors:false) → jsDelivr(cors) → Netlify(仅原生通道,cors:false)
  - **MIME 归一化**：jsDelivr 把 .html 当 text/plain+nosniff，出站前按扩展名纠正（`contentTypeFor`，历史事故点，勿删）
  - 合成响应必须带 `Access-Control-Allow-Origin: *`（跨源 cors 请求依赖）
  - 失败兜底 `siteFallback()`：**绝不回壳文档**（会造成启动循环），导航给离线页
- `src/update/bootstrap.js`：启动**全程零导航**（杜绝循环）。两条通道：
  - **快通道（123 新增，二进秒进）**：静默注册 SW 的同时直接读 CacheStorage 里的入口文档
    （`canonicalSitePath` 归一键，带运行时标记才认）；controller 在位且缓存齐全 →
    `boot.quiet()` 收起所有文案/进度条 → `document.write` 落地，**零网络请求、不闪启动文案**。
    缺文件才转慢通道或落地后静默补齐
  - **慢通道（首装/缓存缺失）**：注册 SW → 等 controller（`ck-claim`）→ 原生多传输链预缓存首屏
    （`src/net/precache.js`：CapacitorHttp → fetch → XHR，各带超时 + 全局 deadline）
    → `fetch('/')` 经 SW 取站点文档 → `document.write` 原地落地；
    后台并发池(4)预缓存全站（清单构建时嵌入 `SW_META.allPaths`）
- `src/ble/web-bluetooth-polyfill.js`：Web Bluetooth → `@capacitor-community/bluetooth-le` 原生桥
  （站点魔方代码零修改；requestDevice 自绘选择器、watchAdvertisements 用扫描模拟、manufacturerData Map）
- `src/update/updater.js`：更新检查 = 原生 HTTP 取 `<base>/index.html` 的 ETag/Last-Modified 对比
  localStorage；有变化 → 后台整站重新预缓存（**断点续传**：进度存 `ck.update.progress`，
  中断后只补未下完的文件；部分失败 60s 自动重试）→ 全量下完才提示刷新

## 3. 构建 / 测试闸门（`npm run apk` 串联，任一失败不出包）

1. `scripts/patch-android.mjs`：版本号/签名/权限/MainActivity（升级清旧 SW 目录）/lint 关闭
2. `scripts/utest.mjs`：离线单元检查（vm 拉起 sw.js + 真跑 precache），不联网不要浏览器，几秒出结果
   - 覆盖：**蓝牙桥就绪判定（`BleClient.isEnabled()` 裸布尔 vs `{value}` 两种形态、
     开关过渡期轮询、真没开时的引导链路、`getAvailability` 的适配器语义）** /
     出站 MIME 归一化 / opaque 透传 / 目录页识别 / **vendor 直连不通时走国内镜像且缓存键仍是原始 CDN 地址** /
     **HTML 请求跳过 `html:false` 的源（jsDelivr 不发 .html）** / **页面原生通道桥（miss → 广播 ck-fetch-native → 页面代取 → 注入入缓存服务；页面不回则照旧兜底）**
   - 依赖 `.build/sw-meta.json`（先跑 `npm run bundle:js`），缺失时跳过
3. `scripts/ptest.mjs`：真网下载首屏 11 文件 + 入缓存回执链路（离线自动跳过）
4. `scripts/smoke.mjs`：jsdom 三阶段（壳运行时 / 站点运行时 / 进入路径 document.write 无循环）
   - 注意 jsdom 无 `window.Response`、无 `AbortSignal.timeout`、不实现运行期 `document.write`：桩里已处理
5. `scripts/e2e.mjs`：**真浏览器**（chromium + puppeteer-core）三阶段：有网进首页 / 断网 reload 进首页 /
   点首页目录卡片进真实站点页（不许落到启动页/死页）
   - 静态服务模拟 Capacitor 本地服务器（http://127.0.0.1:8099，http 源）
   - 断网用 CDP `Network.emulateNetworkConditions`；reload 由页面内触发 + 轮询（puppeteer 导航 Promise 在离线模拟下会自阻塞）
   - 没有 chromium 时**跳过**（仅警告）；`CHROME_BIN` 可指定路径
6. gradle 分阶段（1GB 内存沙箱适配）：Kotlin → 资源 → dex → 打包；每阶段失败自动清场重试一次
7. `scripts/make-app-kit.mjs`：重打 `release/Ckarefulon-app-kit.zip`（换机器重建源码包，
   要提交进仓库）——**已并入 `npm run apk` 末尾**，改完源码出一次包它就跟着刷新；
   失败只警告，不拖累 APK

环境注意（沙箱 1GB RAM）：
- gradle 参数见 `scripts/build-apk.mjs` stages（小堆+大 metaspace+SerialGC+in-process Kotlin）
- 构建前/失败后清理 java/aapt2/chromium 残留进程（内存抖动主因）
- 工具链：JDK21、Node22、Android SDK 36（platform-tools/build-tools 36）

## 4. 配置单一源

`app.config.json`：appId/appName/versionCode、mirrors（cors 标志决定通道）、core/allPaths 清单来源、
onlineFallbacks（在线模式按钮）、签名信息。`scripts/write-config.mjs` 由此生成 capacitor.config.json。

## 5. 已知历史事故点（改代码时别踩）

- sw.js 曾漏写 `contentTypeFor` → 全链路抛异常（jsdom 测不出，E2E 才能抓到）→ **sw.js 的任何改动必须跑 e2e**
- 启动流程曾含 `location.replace('/')` 回退 → SW 未接管时落回壳 → 启动循环 → 现已零导航
- jsDelivr `.html` = text/plain+nosniff；Netlify/Gitee 无 ACAO（只能原生通道）
- **国内可用性（2026-09 修）**：`SW_META.origins`/`probeOrigins` 曾只取 `cors:true` 的源 → 整条链只剩
  jsDelivr → 国内连不上 → 首启永远下载不到内容。**取内容的源必须是全部启用源**（首屏走原生 HTTP，
  不受 CORS 限制，需不需要 ACAO 由 sw.js 自己判断）；`toOrigin()` 曾丢掉 `cors` 标志，使 sw.js 的
  `cors === false` 跳过逻辑成为死代码——两处都别再改回去
- vendor（页面引用的 CDN 库）国内直连不通：构建时给每条 `SW_META.vendor` 算好 `mirror`
  （规则在 `scripts/vendor-sync.mjs` 的 `MIRROR_HOSTS`，cdnjs 这类没通用镜像的在 `app.config.json` 里写 `mirror`），
  运行时由 `precache.js` / `sw.js` 兜底。**缓存键必须始终是原始 CDN 地址**，否则页面里
  `<script src="https://cdn...">` 的请求拦不到
- **E2E 曾随机卡在"正在进入站点…"（2026-09 修）**，两个病根，都在 sw.js：
  1. `fetchRemoteCors` 的重定向判定曾比**整条路径**。`fastly.jsdelivr.net/gh/<repo>@main/<p>` 会 301 到
     `raw.githubusercontent.com/<repo>/main/<p>`，前缀本来就不同 → 这条**唯一的 CORS 通道**被误杀 →
     站点内容一个源都拿不到，只剩 no-cors 的 opaque 响应（HTML 没法注入）。现改为只比文件名。
  2. `refreshIntoCache` 的 opaque（no-cors）兜底循环曾**没有超时**。no-cors 请求拿不到响应也拿不到错误时
     会一直挂着，而这条路径是**导航请求**在走 → 启动页永远停在"正在进入站点…"。现已补 AbortController。
  → 改 sw.js 里的任何 `fetch` 都要带超时；这条只跑 e2e 才看得出，utest 里已补两个回归检查
- **无 ACAO 头的源该不该跳过，取决于"环境受不受 CORS 约束"，不是"是不是原生"**：
  原生（CapacitorHttp）不受限；浏览器页面受限；**Node（ptest）没有 CORS 这回事**。
  误按"非原生就跳过"会让国内机器上 ptest 一个源都试不了 → 直接判失败 → 阻断出包。
  判定见 `src/net/precache.js` 的 `corsBound`
- **CapacitorHttp 的返回值不能直接当响应体（2026-09 修）**：`responseType: 'blob'` 给的是
  **base64 字符串**（原生与 web 实现都是），直接塞进 `Response` 会把 `Author.png` 这类二进制存成
  一段 base64 文本；响应头是 `application/json` 时它一律返回**已解析的对象**，塞进 `Response`
  变成 `"[object Object]"`。它是真机上的**首选**传输通道，走错 = 非文本资源缓存全坏。
  还原逻辑见 `src/net/precache.js` 的 `normalizeNativeBody`（utest 3/3 有回归检查）。
  注意 ptest 跑在 Node 里、`isNativePlatform()` 为 false，**这条路径 ptest 覆盖不到**
- 覆盖安装保留 WebView 数据：MainActivity **只在版本变化时**删 SW 的 `Database`/`ScriptCache`
  防旧 SW 残留（123 起，见 §5“SW 注册只在版本变化时清”）
- **升版本号后 `npm run verify` 会挑到旧包、报假失败（2026-09 修）**：`dist/` 里历史版本的包不会被清掉
  （115 和 117 并存），原逻辑按文件名排序取第一个带 `release` 的 → 挑到**旧的那份**，再拿新版本号
  去比旧包 → 报"versionCode 不匹配"，看着像打包失败，其实包是对的。现改为先认当前配置算出来的
  确切文件名（`Ckarefulon-<versionName>-<versionCode>-release.apk`），认不到才退回 mtime 最新的并出警告
- **设备选择器点 ✕ / 点遮罩 / Esc 关闭后 `requestDevice()` 永远挂着（2026-09 修，最重）**：
  `devicePicker` 靠 patch `s.close` + 一个没人派发的 `ck-close` 事件来 reject，而 ✕ / 遮罩 / Esc
  走的是 sheet 内部的 `close`，两条路都收不到 → 站点的连接流程卡死在转圈。
  改法：`onClose` 统一收口（内部 `settled` 防重复），picker 的 close/cancel 也走同一处。
  smoke 第 4 阶段有回归检查
- **`CkUI.confirm()` 永远返回 false（2026-09 修，第二最重）**：`sheet.close()` 会先触发 `onClose`
  再返回，而 confirm 把 `resolve(false)` 挂在 `onClose` 上、把 `resolve(true)` 放在按钮回调里 →
  点"确定"时 false 先生效，true 被 Promise 丢弃。后果：`CkApp.update.reset()`（重置资源）点了没反应，
  BLE 权限/蓝牙开关弹窗里的"去授权 / 打开蓝牙"按钮也全都不起作用。
  改法：confirm 内部先抢答（`finish(true)` 先 resolve 再 close）。smoke 第 4 阶段有回归检查
- **HTML 回源判定看响应头而不是看路径（2026-09 修，国内必踩）**：jsDelivr 把 .html 给成
  `text/plain` → `refreshIntoCache` 的 HTML 分支整个被跳过：① 不注入运行时（页面没有蓝牙桥、
  没有更新检查）；② 缓存里存成 text/plain，根路径出站还被重建成 `application/octet-stream`。
  改法：按**实际请求的路径**判（目录路径取 `<path>index.html`），`effectivePathname()` 同时
  服务出站 MIME 归一化。utest 1.10 有回归检查
- **opaque 兜底会顶掉已缓存的好内容（2026-09 修，国内必踩）**：SWR 后台刷新在 jsDelivr 不通时
  走 no-cors 通道拿到 opaque 响应，直接 `cache.put` → 把构建时注入过运行时的好 HTML 顶掉
  → 页面"显示源码"。改法：① HTML 一律不走 opaque 通道；② 已有非 opaque 内容时不覆盖。
  utest 1.11 有回归检查（A/B/C/D 四种场景）
- **返回键双触发（2026-09 修）**：`document.write` 不换 window，壳的 `backButton` 监听在进站后
  仍然活着，而 ck-site.js 会再注册一份 → 按返回键"既退到后台又返回上一页"。
  改法：`bootstrapShell` 进站成功后置 `window.__ckEntered`，壳监听看到它就静默
- **`getAvailability()` 会弹权限框（2026-09 修）**：以前先 `ensureReady()` → `BleClient.initialize()`，
  应用一启动就弹"附近的设备"授权框。`isEnabled()` 在原生侧只读蓝牙适配器、不需要 initialize，
  直接用它；没蓝牙适配器时才如实返回 false
- **更新指纹写早了（2026-09 修）**：发现新版本后立刻写入 localStorage 指纹，后台刷新如果失败，
  下次检查就判"已是最新"→ 用户永远看不到新版（只能手动重置缓存）。改为刷新**全量成功**才写；
  只成功一半时指纹保持旧值，下次检查会重试
- **更新探测只试一个源（2026-09 修）**：`probeOrigins[0]` 不通整个检查就报错。现顺着源链往下试，
  并在源不给 ETag/Last-Modified 时用正文哈希（`contentTag`）代替"内容长度"做指纹
- **vendor 依赖没有扩展名时 MIME 猜成 octet-stream（2026-09 修）**：`/npm/ts-fsrs/+esm` 这类路径
  按 `<script type="module">` 的 MIME 规则会被浏览器直接拒载。构建时把每条 vendor 依赖的
  Content-Type 算好（`SW_META.vendor[].ct`），precache / sw.js 都用它
- **E2E 闸门被静默跳过（2026-09 修）**：`build-apk.mjs` 只认 `/usr/bin/chromium` 等三个路径，
  机器装的是 chrome-headless-shell 时整道闸门静默跳过（日志只有一行警告）。
  现会探测 `CHROME_BIN`、常见路径和 `/opt/chrome`（chrome-headless-shell）
- **E2E 之前测不出"运行时有没有注入"**：`state().site` 用的是 `||`，站点自己有 `.dirTitle` 就算过。
  现额外断言 `[data-ck-runtime]` 存在 **且** `window.CkApp` 已就绪（真的跑起来了）
- **`verify-apk` 的 minSdk 永远是 null（2026-09 修）**：aapt2 输出的是 `minSdkVersion`，
  正则抓的是 `sdkVersion`。纯信息展示问题，但排查时会被误导
- `verify-apk` 里有一段 `aapt2 dump resources` 只为了算 `.length` 然后丢掉，白跑一次子进程 —— 已删
- **jsDelivr 对一切 `.html` 都是 301 → raw.githubusercontent.com（2026-09 修，本次事故根子）**：
  连根目录的 `/index.html` 也一样。国内 raw 不通 → SW 自己的 CORS 通道**永远拿不到站点 HTML**，
  点一个还没被预缓存到的卡片就落回启动页再弹回首页（"首页按钮点不动"），退出重进恢复到那个
  路径又是它。修法两层：① mirrors 给 jsDelivr 加 **`html:false`**（HTML 请求跳过该源，
  `fetchRemoteCors` / `precache` 两条取数链都认这个标志），每个文件省一整轮必失败的超时；
  ② 源链补 **GitHub Pages**（`ckarefulon.github.io`，实测带 ACAO 且给真 `text/html`）——
  浏览器上下文里唯一的 HTML 源。别把 GitHub Pages 排在 Gitee 前面：原生通道不受 CORS 限制，
  `fast` 顺序仍以 Gitee 为先
- **HTML 缓存 miss 时靠 SW 现场回源永远拿不到（2026-09 修）**：加了**页面原生通道桥** ——
  sw.js 在 HTML miss 时广播 `ck-fetch-native`（pathname 已归一），页面侧
  （`ck-app.js` 的 `installNativeFetchBridge`，壳/站点两个角色都装）用
  `precache.js` 新导出的 `fetchSitePath()` 按源链代取（原生 CapacitorHttp → Gitee 优先），
  回 `ck-fetch-native-done`；SW 注入运行时、按归一键入缓存、直接服务。页面不回（无客户端 /
  15s 超时）就照旧落回导航兜底。回源与桥**并行**（`firstNonNull`，谁先到用谁），
  离线（`navigator.onLine === false`）直接跳过两条通道走兜底
- **后台预缓存 HTML 排最前（2026-09 修）**：bootstrap 的后台池把 `.html` 放第一批，
  把"点早了 miss"的窗口从几分钟压到几秒
- **GitHub raw 连发会被限流（2026-09 观察）**：E2E 里后台预缓存 + 现场回源同时压 raw，
  请求会挂到超时 —— 曾表现为"E2E 阶段 3 随机失败"。`html:false` 跳过 + 原生桥之后不再依赖它
- **updater 的浏览器上下文要跳过无 ACAO 的源（2026-09 修）**：原生（CapacitorHttp）不受限照旧
  全试；非原生照旧试 Gitee 只会刷一屏 "blocked by CORS policy" 还白等超时
- **utest 的 `bootSw` 多了第三个参数 `overrides`**（可替换 `self` 上的成员，比如让
  `clients.matchAll` 返回一个"在线页面"来测原生桥），并会把事件监听器挂在
  `t.__listeners` 上供测试派发消息；`META.bridgeTimeoutMs` 可把桥超时改小
- **导航被压在状态栏底下（2026-09 修，真机回执 119）**：targetSdk 36 起系统强制
  edge-to-edge，WebView 顶到屏幕最上沿，站点导航被状态栏盖住。修法：MainActivity 里
  `applySystemBarInsets()` 把系统栏/刘海 insets 换成 WebView 的外边距，insets 在这里
  消费掉（CSS 的 env(safe-area-*) 不会再叠加）。**键盘刻意没吃 ime insets**（仍走
  manifest 的 adjustResize，避免双重避让）——真机若还出现"键盘盖住输入框"，
  下一步就是把 ime insets 也算进来
- **文本输入怪象（2026-09 修，真机回执 119）**：capacitor 配置里 `captureInput: true`
  把 WebView 的输入连接换成 BaseInputConnection（假实现），中文输入法的组合输入 /
  上屏会出各种怪象。改回 `false`（write-config.mjs）——这开关本是给硬件键盘兜底的
- **每次打开都要重新缓存一遍首屏（2026-09 修，真机回执 119）**：以前只要在线就必跑
  一轮首屏预缓存，进站后还必跑一轮全站后台预缓存。现在先查本地缓存（页面上下文直接
  `caches.match`，键名与 SW 写入的保持一致；opaque 条目按缺处理；查不了就照旧全量
  预缓存），**只补缺**。升级后首次启动的重建由原生层升级清理触发，属预期。
  smoke 新增 3c 回归（缓存齐了直接进站、零预缓存消息）
- **改 MainActivity 模板时把 `import java.io.File;` 挤掉过（2026-09 教训）**：
  patch-android.mjs 里这份模板是整体重写的，动它之前先核对 import 完整性，
  编译错误只在 gradle 阶段暴露（前面所有 JS 闸门都测不到）
- **改完 src/ 只重打原生层 → 修好的东西根本没进包（2026-09 修，120 翻车的根子）**：
  `npm run apk` 以前不含网页资源同步 —— android 资源目录里的 ck-app.js / 壳配置还是
  上一轮的，120 的"缓存跳过、输入开关、页面原生桥"全都没生效，真正进包的只有
  MainActivity 的 insets。修法两层：① build-apk.mjs 现在自己在打包前跑
  write-config → build-web → sync-shell → `cap copy android`（copy 是纯本地复制，
  不用 sync 以免联网更新插件），`npm run apk` 从此自包含；
  ② verify-apk 把包内的 capacitor.config.json（android 段）与当前配置稳定对比、
  并把包内 index.html/sw.js/ck-app.js/ck-site.js 与 www/ 逐字节对比，
  任何一处是旧版就拒收
- **insets 兜底（2026-09 加）**：MainActivity 新增 onResume 里显式读
  `getRootWindowInsets` 补一次边距 —— 个别机型 insets 不派发到 WebView 时，
  监听器收不到、边距设置不上。两条机制设同一个值，幂等不叠加
- **离线缓存被原生层每次启动清空（2026-09 修，“每次打开都要缓存”的真凶）**：
  `purgeServiceWorkerRegistrations()` 删的是整个 `app_webview/*/Service Worker` 目录，
  而 Chromium 把 CacheStorage 存在它的**子目录** `Service Worker/CacheStorage` 里 →
  每次冷启动离线缓存全没 → 网页侧“先查缓存、只补缺”永远查到全缺（120/121 的
  缓存跳过逻辑本身是对的，是被原生层清了），断网冷启动直接进不去。
  改法：只删 `Database` 与 `ScriptCache`（旧 SW 注册照样清干净，壳会立刻重新注册），
  CacheStorage 与 Local Storage 一律保留。升级清理同理：只清 `Default/Cache`、
  `Default/Code Cache`，**不清站点离线缓存**（产品要求“先保证正常打开，即使不是最新版”）
- **更新流程改成“打开优先”（2026-09，产品要求）**：顺序固定为
  进站 → 后台检查 → 发现更新弹「正在下载更新 x/y」→ 下完弹确认刷新框（立即刷新 / 稍后再说）。
  壳启动流程绝不等更新检查（`updater.init()` 只在站点角色跑）；只下了一半时
  **不弹框、不写指纹**（下次检查重试）；指纹只在全量成功后写。
  以前是“发现更新就立刻弹‘已刷新，点刷新’”——其实那时还没下完。smoke 第 5 阶段有回归检查
- **jsdom 里 XHR 会真的联网（2026-09 教训）**：`download()` 的第三条通道是 XHR，
  测试里只桩 `fetch` 不够 —— jsdom 的 XMLHttpRequest 会发真实请求，
  慢到让整道闸门超时（表现为 smoke 卡死、一行输出都没有）。桩环境要把 XHR 一起桩掉
- **`CkUI.toast()` 的句柄加了 `update(text)`**：下载进度用它原地改文案，
  不要反复弹新 toast（会叠一屏）
- **更新下载中断后从头再来（2026-09 修，真机回执 122，“更一半自动停了又从头”）**：
  三个病根都在 updater：① 每次 check 都全量重下 `allPaths`，没有任何进度持久化 ——
  页面跳转杀掉注入运行时 / 退出 app / 300s deadline / 网络抖动，任何一种中断都丢全部进度；
  ② 部分失败后**没有任何重试**，要等下一个整点 interval 或网络事件（用户感知“停了没下文”）；
  ③ 60 分钟节流把恢复也挡住了。修法：进度按指纹 tag 存 `ck.update.progress`
  （`{tag, done:[keys]}`，每文件成功后写、1s 节流持久化、pagehide 兜底 flush），
  续传只下缺的；部分失败 60s 自动静默重试；有未完成进度时节流直接放行。
  指纹仍只在**全量成功**后写（原有语义不变）。smoke 第 5 阶段有断点续传回归检查
- **二进闪一下缓存/启动界面（2026-09 修，真机回执 122）**：两个病根：
  ① MainActivity **每次冷启动**都清 SW 注册 → 每次启动都重装一遍 SW → 启动页每次都闪
  “正在安装离线服务…”；② 缓存明明齐全，bootstrap 仍要走完注册→等 controller→查缓存
  的全流程并显示阶段文案。修法见下两条
- **SW 注册只在版本变化时清（2026-09 改，取代“每次冷启动清注册”）**：
  `resetWebRuntimeIfUpgraded()` 的清理条件改为 `last != 0 && last != now`，
  purge（Database/ScriptCache + Default/Cache + Code Cache）只在**覆盖安装**时执行。
  版本没变就保留注册：热启动 controller 立等可取，壳能静默秒进。
  当初“每次冷启动清”是防旧 SW 拦死文档请求——那个场景只发生在升级时，日常启动清是白清。
  ⚠️ 老规矩不变：**绝不能删整个 “Service Worker” 目录**（CacheStorage 在里面）
- **bootstrap 里有一份 `canonicalSitePath` 副本（2026-09 加，快通道直读缓存的键位）**：
  快通道绕过 SW 直接 `caches.match`，必须自己算出与 sw.js **完全一致**的归一键。
  函数体是从 sw.js 原样复制的，**改一处必须同步另一处**——utest 3/3 有一致性回归检查
  （对 9 组样本逐一对比两份实现的结果），漏改会被闸门拦下
- **快通道落地前必须验运行时标记（2026-09 加）**：`readCachedEntryDoc` 只认
  `data-ck-runtime` 在位且**不含** `ck-boot` 的文档（opaque 响应跳过）——
  否则可能把壳文档/半成品写进页面，退回启动循环老路。smoke 3d 有回归检查
  （零请求、零 ck-cache-put、无阶段文案、落地文档正确）
- **已授权「附近的设备」仍提示没有权限（2026-09 修，真机回执 123，Android 12+）**：
  两个病根：① `neverForLocation` 三处全是 false（config / manifest / polyfill），
  Android 12+ 上插件会**额外索要定位权限**，而 manifest 把定位限制在 maxSdk 30，
  12+ 根本没声明 → 授权必失败 → initialize 抛 permission 错；
  ② polyfill 的 `ensureReady` 失败后把 rejected Promise 留在 `RUNTIME.initializing`，
  用户去设置里授权回来后**同一页面生命周期内永远命中缓存的失败**，怎么点都是没权限。
  修法：三处统一改 true/`neverForLocation`（见 docs/蓝牙BLE.md §3 的一致性警告）；
  catch 里顺手把 `RUNTIME.initializing` 提前置 null（末尾 try/await/catch 本来也会重置，
  属双保险，不是独立病根）
- **「当前浏览器不可用 Web Bluetooth」误报（2026-09 修，真机回执 124，125 修复）**：
  站点的 `giikerutil.chkAvail()`（Cube/assets/base/compat.js）在 `getAvailability()`
  返回 false 时 reject 这句文案。而 polyfill 的 getAvailability 之前把
  `isEnabled()` 的**开关状态**当成了可用性：只要 initialize 成功过一次（适配器已拿到），
  蓝牙开关没开 → value=false → 站点误报「浏览器不可用」，且 chkAvail 拦在 requestDevice
  之前，用户永远见不到壳里「蓝牙未开启 → 打开蓝牙」的引导框。
  修法：getAvailability 只表达「适配器是否存在」，开关暂时关闭也返回 true；
  未开启的友好引导统一由 ensureReady 负责；无适配器设备（initialize 报
  BLE is not supported/available）在 ensureReady 里 toast 明确提示
- **蓝牙已开仍报「Bluetooth is not available.」（2026-09 修，真机回执 125，126 修复）**：
  ① 蓝牙开关拨开后适配器有 1~3 秒「正在打开」过渡期，`requestEnable()` resolve
  ≠ 已就绪——旧代码只**单次**复读 isEnabled，false 就直接抛英文错，把"马上就好"
  误判成"不可用"；② initialize 若因开关翻转瞬间读到 null 适配器被拒
  （BLE is not available.），旧代码一次判死。修法：所有"开关状态"读取一律
  `waitEnabled()` 轮询（首查 1.5s、requestEnable 后最长 8s，400ms 间隔）；
  initialize 被拒 /not supported|not available/ 时 800ms 后重试一次；
  报错全部改中文并带原生原因码（`蓝牙初始化失败（<native msg>）`），
  再出问题时用户回执自带诊断信息
- **签名私钥被公开发布（2026-09 发现并处置）**：`release/Ckarefulon-app-kit.zip` 里带着
  `keys/Ckarefulon.keystore`，而这个包被提交到了 gitlink 仓库；该仓库**可匿名克隆**
  （`git ls-remote https://gitlink.org.cn/Careful_S/transit.git` 不带任何凭据就能列出分支，
  对照：换成不存在的仓库名会立刻索要用户名）。等于把「Ckarefulon 应用的签名身份」公开了——
  任何人都能签出被系统当成「正规升级」的假安装包。
  处置：① 重签证书（旧 `9d2a2dfa…` 作废，新 `dfda920e…`，见头部基线），
  ② app-kit 改为 `npm run kit`（`scripts/make-app-kit.mjs`）生成，**硬闸门**：
  扫到任何 `*.keystore/*.jks/*.p12/*.pem` 直接报错不出包，`keys/` 整目录不进包、
  只留一份说明；③ 旧 zip 仍留在 git 历史里，但证书已作废，不再具备签名效力。
  教训：`.gitignore` 早就写了「不要提交签名私钥」，但**手工打包时没人拦**——
  凡是要提交的产物，都得由脚本生成并自带闸门。
  ④ 历史也已重写清干净（`git filter-branch` 把该 zip 从所有提交里剔除，再回填
  不含私钥的新包）：**master 的提交哈希全变了**（重写前 `28d6013` → 现在 `39375d2` 起），
  旧分支 `fix/china-and-boot` 已删除（它只是旧 master 的一个祖先提交，无独有内容）。
  验证方式：新克隆后遍历所有分支的所有 blob、逐个拆 zip 找 `*.keystore`，命中 0。
  ⚠️ 重写前的整仓备份留在构建机的 `/workspace/backup-ckarefulon-before-purge.bundle`
  （**只在本机，未上传**），确认无碍后可删。
  ⚠️ 其它机器上的旧克隆会与远端冲突，用 `git fetch origin && git reset --hard origin/master`
  或直接重新克隆。
- **蓝牙「一直开着」仍报「蓝牙未就绪」（2026-09 修，真机回执 126，127 修复）**：
  126 把「开关状态」的读取改成 `waitEnabled()` 轮询，方向对，但**读错了字段**——
  `@capacitor-community/bluetooth-le` 的原生插件层 `BluetoothLe.isEnabled()` 返回
  `{ value: boolean }`，而**公开的 `BleClient` 包装层（8.x）在 JS 侧就把 `.value`
  拆掉了、直接返回裸布尔**。旧代码一律 `st.value` → 恒 `undefined` → 恒 falsy →
  轮询必然超时：蓝牙开着也先弹「蓝牙未开启」、点「打开蓝牙」后仍等不到，
  最后抛「蓝牙未就绪：请确认手机蓝牙已打开…」（用户回执：蓝牙就没关过）。
  修法：加 `readFlag()` 统一取值，**裸布尔与 `{ value }` 两种形态都认**
  （`isLocationEnabled()` 同一个坑，一并修掉——否则每次连接都会误弹「需要开启位置服务」）。
  `scripts/utest.mjs` 加了 5 组离线回归（裸布尔 / `{value}` / 开关过渡期 / 真没开 /
  `getAvailability`），改这块必须让它们过
- **「已配对设备」兜底从未生效（2026-09 查同类问题时发现，129 修复）**：
  同一类坑的第二个落点。palette 里的 `getBondedDevices()` 与 `isEnabled()` 同构——
  原生层 `BluetoothLe.getBondedDevices()` 返回 `{ devices }`，公开 `BleClient` 层
  已经在 JS 侧把 `.devices` 拆成**裸数组**；而选择器写的是
  `const { devices } = await BleClient.getBondedDevices()` → 恒 `undefined` →
  循环体一次都没跑过。它又被 `catch {}` 吞掉，所以没有任何报错，**唯一症状是
  「魔方就在手边、也配对过，却搜不到设备」**——广播没扫到时本该由它兜底。
  修法：`Array.isArray(res) ? res : res?.devices || []`（两种形态都认）。
  `utest` 加了 4 组回归（裸数组 / `{devices}` / 过滤器仍生效 / 桩抛错不炸），
  旧写法下精确复现「列表空 → requestDevice 抛 TypeError」。
  **教训升级**：这不是单点 bug，是这个插件的通用陷阱——
  *凡是取 `BleClient.*` 的返回值，必须按 **包装层**（`bleClient.d.ts`）的形状取，
  不能照抄原生层（definitions.d.ts）的类型*。以后再接新方法，先去
  `node_modules/@capacitor-community/bluetooth-le/dist/esm/bleClient.d.ts` 核对
- **跨域「主机不可达」：网页通道不通时自动改走系统通道（2026-09 加，130）**：
  真机回执「同一个域名，手机浏览器能打开，App 里的网页报主机不可达」。应用这一侧
  **没有任何拦截面**（已逐段核对）：离线服务只处理同源页面与几条 CDN 依赖、
  页面没有内容安全策略、没有任何地方改写 fetch、Android 侧也没有按域名的网络限制 ——
  失败发生在 **WebView 自己的网络栈** 里。它和系统原生 HTTP 不是一套东西
  （域名解析、协议协商如 HTTP/3、TLS 指纹、UA 都可能不同），
  所以「浏览器能开、App 打不开」和「网页通道不通、原生通道却通」都很常见。
  新增 `src/net/fetch-fallback.js`：**跨域请求在网页通道抛错时，用原生 HTTP 重试一次**。
  通了就静默返回（用户无感，坏掉的页面被救回来）；两条都不通才如实抛**原来的错**，
  并点名主机（toast）+ 记一条诊断。
  ⚠️ 几条不能动的约束：
  · 安装点在 `ck-app.js` 的**模块顶层**，不能挪进 `main()` —— 站点有些库在加载时就把
    fetch 存进内部变量，装晚了它根本不走兜底
  · 只兜「网页通道抛错」：**有响应（含 4xx/5xx）一律原样返回**，绝不改语义
  · 离线（`navigator.onLine === false`）/ 主动取消（AbortError）/ **同源**
    （同源失败归离线服务的多源链管，用原生去打 `http://localhost/` 只会打到真本机端口）/
    不可重放的请求体（FormData、流、二进制）一律**不兜**
  · 还原原生返回值必须**同时看状态码和 Content-Type**：2xx 且非 JSON 才是 base64
    （要解成真字节），JSON 一律被原生解析成对象（要重新序列化，否则是 `[object Object]`），
    非 2xx 给的是**原文**（不能再当 base64 解）—— 只看其中一个就会把内容解坏
  · utest 7 有 22 组回归（含「网页通了不打第二枪」「500 不兜」「AbortError 不兜」），改这块必须让它们过
  · **失败主机冷却（131 加）**：一个主机被判「两条都不通」后，**10 分钟内不再为它重打原生**。
    没有这层的话，在「这个域名就是到不了」的网络里，每一次跨域请求都要先等网页通道失败、
    再等一轮原生超时（8~20s）才报错 —— 云端同步这类会重试的代码会一次比一次卡，
    用户感知是「整个功能卡死」。冷却状态存 `ck.net.blocked`，`online` 事件（切网/关飞行模式）
    会清空它，到期自动重新尝试；只影响那台主机，别的主机照常兜底。utest 7 有 5 组回归。
  排查入口（App 内控制台）：`CkApp.net.diag()` 看最近 20 条失败（两条通道各自的原因都在里面）、
  `CkApp.net.probe(['https://…'])` 现场逐条比两条通道、`CkApp.net.blocked()` 看当前被判
  「在这个网络下到不了」的主机（含剩余冷却秒数）。
- **`release/Ckarefulon-app-kit.zip` 会悄悄过期（2026-10 发现并修）**：它是「换机器重建」用的
  源码包，同样提交进仓库，但出包流程里没人重打它 —— 出到 131 时包里装的还是 **129 的源码**
  （缺 `src/net/fetch-fallback.js`，也就是 130/131 的跨域兜底），拿它换机器重建只会得到旧版本。
  现在 `npm run apk` 末尾会自动重打（§3 第 7 步），手动刷新是 `npm run kit`。
  核对版本：`unzip -p release/Ckarefulon-app-kit.zip app-android/app.config.json | grep versionCode`

## 6. 待验证

- **131 尚未收到用户真机回执**（130 已作废，别装）。这一版专门查两件事
  （用户回执：手机浏览器能打开自己的 supabase 域名，App 里的测速却报「主机不可达」）：
  ① **测速页那一行是不是好了**——网页通道失败会自动改走系统通道，通了那一行就会显示「完成」，
     说明系统通道能到、应用已经把它救回来了；
  ② 若**仍报不可达**，屏幕上会多一条「xxx 连不上（已试过备用连接方式）」——那就说明
     **这台设备的两条通道都到不了那个域名**（不是应用拦的：应用这一侧逐段核对过没有拦截面）。
     此时把这条提示原文记下来即可，下一步是给原生通道加加密 DNS（DoH）解析。
  ③ 顺带确认没伤到别的：站点正常打开、云端同步/登录照旧、断网冷启动照旧能进。

- **129 尚未收到用户真机回执**。128 与 129 都没回执，**建议直接测 129**（同证书，
  可覆盖 128）。129 修「已配对设备兜底从未生效」（见 §5 同名条目），
  128 修蓝牙就绪判定 + 换签名证书。**重点验**：
  ① 蓝牙一直开着直接点连接 → 直接进设备搜索，全程不该出现任何「蓝牙未开启 / 未就绪 /
  不可用」提示；② **魔方已配对过（系统蓝牙里有它）时点连接 → 就算广播没扫到，
  选择器列表里也应该有它**（这是 129 的修复点）；③ 若仍失败，把整句错误记下
- 127 真机回执：未收到（这一版就是修 126 的蓝牙 bug，随后因换证书直接进了 128）
- 126 真机回执：蓝牙没关过仍提示「蓝牙未就绪…」（→ 127 修）
- 125 真机回执：手机已开蓝牙仍提示「蓝牙 is not available」（→ 126 修）
- 老检查点仍要有效：蓝牙关着 → 弹「蓝牙未开启」→ 点「打开蓝牙」→ 开启后**自动等到
  就绪**并继续搜索；权限授权（Android 12+ 只给「附近的设备」）；退出再进秒进；
  更新断点续传；首页二进不闪缓存界面
- 122 真机回执：更新更一半停了又从头 + 二进闪缓存界面（→ 123 修，见 §5 两条记录）
- 121 真机回执：进入首页每次都要缓存（→ 122 修，见 §5 离线缓存被清空那条）
- 119 真机回执：首页跳转/空白页已好转；残留三个问题（状态栏重叠、重复缓存、输入 bug）
- **证书断代（务必记住）**：120–122 / 123 / **124–127** / **128 起** 是四张不同证书。
  只有同一段内能覆盖安装；跨段（含 127 → 128）**必须先卸载**。
  换构建环境时先把本机 `keys/` 带过去——丢失就等于再断一次代，keystore 已经这样丢过两次
- 仓库已瘦身（2026-09）：历史压成单提交，只保留当前源码 + release 最新几版；
  旧历史里的 base.apk(279M)/AI_CFOP(102M) 等已清除，勿再往仓库塞无关大文件
- 仓库「只剩当前源码」收尾（2026-10）：仓库里另一个分支（早先的 AI 小工具，`main`）也换成了
  当前源码 —— 现在 **`master` 和 `main` 指向同一个提交**，点哪个分支看到的都是当前源码。
  换机器时如果哪台机器上还留着老克隆，用 `git fetch origin && git reset --hard origin/master` 对齐。
  它原来的内容（旧 `main` 的提交 `630823a`）已经不在任何分支上，真需要时按这个哈希捞回；
  另有一个「屏幕旋转控制」的分支没动（体积很小，与本项目无关）

## 7. 不要上传的东西

`keys/Ckarefulon.keystore`、`keys/keystore.properties`（签名私钥，**仅本地保管，任何远程仓库都不行**）。

⚠️ 2026-09 实际踩过：私钥被裹进 `release/Ckarefulon-app-kit.zip` 传了上去，
而那个仓库可匿名克隆 —— 最终只能换证书收场（见 §5）。
所以：**凡是会进远程仓库的产物，一律用脚本生成**。
app-kit 走 `npm run kit`（`scripts/make-app-kit.mjs`），它扫到私钥文件会直接报错停手；
发行包也不要手工打 zip。
