/**
 * 壳启动流程（SW 直连仓库模式）——全程零导航，结构上不可能产生启动循环
 *   1) 注册 /sw.js，确定性等待 SW 接管（ready → controller 轮询 → ck-claim）
 *   2) 原生多传输链预缓存首屏核心（各通道有超时 + 全局 deadline，绝不卡死）
 *   3) fetch('/')（经 SW 读缓存）取站点文档，document.write 原地落地
 *      —— 不做任何 location.replace/assign/reload，循环无从发生
 *   4) 失败则停在错误页：重试（原地重跑）/ 在线模式
 */

import { CkUI } from '../ui/ck-ui.js';
import { Network } from '@capacitor/network';
import { precacheCore } from '../net/precache.js';

const boot = CkUI.boot;

/** 等到 SW 真正接管当前文档；最多等 waitMs */
async function waitForController(reg, waitMs = 6000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const c = navigator.serviceWorker.controller;
    // 必须等到「本次注册的 SW 已接管」：APK 升级后旧 SW 可能还在控制页面，
    // 那时预缓存会按旧键位规则写缓存，新 SW 接管后目录页照样 miss
    if (c && !reg.installing && !reg.waiting) return c;
    reg.active?.postMessage?.({ type: 'ck-claim' });
    await new Promise((r) => setTimeout(r, 250));
  }
  return navigator.serviceWorker.controller || null;
}

/**
 * 取站点文档并原地落地；不导航。成功返回 true。
 *
 * 门槛必须是「带注入运行时的站点文档」（SW 入缓存前会给每个站点 HTML 注入
 * data-ck-runtime 标记）：以前只检查"不是壳文档"，于是 SW 的兜底页 —— 一段
 * 没有任何运行时、点啥都没反应的 HTML —— 也被当成站点写进来了，用户就停在
 * 死页上，退出重进还是它（WebView 恢复到上次浏览的路径，兜底页照样被服务
 * 出来）。加了标记校验后兜底页进不了页面，失败会如实报错并给出重试。
 */
const RUNTIME_MARKER = 'data-ck-runtime';

/**
 * 与 src/sw/sw.js 的 canonicalSitePath 完全一致（缓存键归一规则）——
 * 快通道要绕过 SW 直接读 CacheStorage，键算错了就永远 miss。改一处必须同步另一处。
 * （utest 有一致性回归检查）
 */
function canonicalSitePath(pathname) {
  let p = String(pathname || '/');
  p = p.split('?')[0];
  if (p === '' || p === '/') return '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (!last.includes('.')) p += '/index.html';
  return p;
}

/** 退出前所在的页面（WebView 重启时会带着原 URL）；没有就返回 null */
function getRestorePath() {
  try {
    return window.location.pathname && window.location.pathname !== '/' ? window.location.pathname : null;
  } catch (e) { return null; }
}

function writeDoc(html) {
  try { document.open(); } catch (e) { /* write 会自动开文档 */ }
  document.write(html);
  document.close();
}

/**
 * 静默快通道：不经 SW、不联网，直接从 CacheStorage 读"进站文档"。
 * 读到（带注入运行时标记、不是壳文档）返回正文，否则 null。
 * 这是"退出再进不闪缓存界面"的关键：缓存齐了就不该再出现任何
 * "正在安装离线服务 / 正在缓存首屏内容"的文案和进度条。
 */
async function readCachedEntryDoc(swMeta, restorePath) {
  try {
    if (typeof caches === 'undefined' || !caches?.open) return null;
    const cache = await caches.open(`${swMeta.cachePrefix || 'ck'}-site-v1`);
    const origin = window.location.origin;
    const targets = restorePath ? [canonicalSitePath(restorePath), '/index.html'] : ['/index.html'];
    for (const t of targets) {
      let hit = null;
      try { hit = await cache.match(origin + t); } catch (e) { /* noop */ }
      if (!hit || hit.type === 'opaque') continue;
      const text = await hit.text();
      if (text && text.includes(RUNTIME_MARKER) && !text.includes('ck-boot')) return text;
    }
    return null;
  } catch (e) { return null; }
}

/**
 * 首屏要缓存的东西（核心文件 + vendor 依赖）里，本地还缺哪些。
 * CacheStorage 页面上下文就能访问（同源），不必跟 SW 来回发消息；
 * 键名和 SW 写入的保持一致：站点路径按 origin 拼（核心清单本来就是规范的
 * 文件路径），vendor 用完整 CDN 地址。opaque 条目（无类型、内容未知）按缺处理。
 * 查不了（jsdom / 极旧 WebView）就返回"全缺"，照旧走预缓存，行为不变。
 */
async function listMissingCache(swMeta, paths) {
  try {
    if (typeof caches === 'undefined' || !caches?.open) return paths.slice();
    const cache = await caches.open(`${swMeta.cachePrefix || 'ck'}-site-v1`);
    const origin = window.location.origin;
    const missing = [];
    for (const p of paths) {
      let hit = null;
      try { hit = await cache.match(p.startsWith('http') ? p : origin + p); } catch (e) { /* noop */ }
      if (!hit || hit.type === 'opaque') missing.push(p);
    }
    return missing;
  } catch (e) {
    return paths.slice();
  }
}

async function enterViaWrite(worker) {
  // 优先恢复"退出前所在的页面"（WebView 会带着原 URL 重启），拿不到再回首页
  const restorePath = getRestorePath();
  const targets = restorePath ? [restorePath, '/'] : ['/'];
  for (const target of targets) {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(target, { cache: 'no-store' });
        if (r.ok) {
          const t = await r.text();
          if (t && t.includes(RUNTIME_MARKER) && !t.includes('ck-boot')) {
            writeDoc(t);
            return true;
          }
        }
      } catch (e) { /* 重试 */ }
      worker?.postMessage?.({ type: 'ck-claim' });
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

/**
 * 进站后后台静默预缓存全站其余文件（离线覆盖整站），**只补缺**。
 * HTML 排最前：页面间跳转全靠它。国内环境里 SW 自己的 CORS 通道拿不到 HTML
 * （jsDelivr 把 .html 全 301 给被墙的 raw），全靠原生链 —— 用户点一张还没
 * 预缓存到的卡片时，SW 现场回源必失败，会落回启动页（"首页按钮点不动"）。
 * 把 HTML 提前缓存掉，能把这个窗口从几分钟压到几秒。
 * 内容更新由更新检查按指纹触发全量刷新，这里不做全量重下。
 */
function startBackgroundPrecache(swm) {
  const isHtmlPath = (p) => /\.(html?)(\?|$)/i.test(p);
  const rest = (swm.allPaths || []).filter((p) => !(swm.core || []).includes(p));
  const htmlFirst = [...rest.filter(isHtmlPath), ...rest.filter((p) => !isHtmlPath(p))];
  listMissingCache(swm, htmlFirst).then((restMissing) => {
    if (!restMissing.length) return;
    precacheCore(swm, { paths: restMissing, includeVendor: false, deadlineMs: 300000, concurrency: 4 })
      .then((r) => console.log(`[ck] 后台全站预缓存 ${r.ok}/${r.total}`))
      .catch(() => null);
  }).catch(() => null);
}

export async function bootstrapShell(meta) {
  // 只在壳启动页里跑；站点页面误加载壳运行时也不会触发任何启动逻辑
  if (!document.querySelector('.ck-boot')) return { status: 'not-shell' };
  const swMeta = meta.sw || {};
  const fallbacks = [...(meta.ota?.onlineFallbacks || []), meta.site?.baseUrl].filter(Boolean);

  const failActions = (extra) => {
    const acts = [{ label: '重试', primary: true, onClick: () => run(true) }];
    for (const url of fallbacks) {
      const host = (() => { try { return new URL(url).hostname; } catch (e) { return url; } })();
      acts.push({
        label: `在线模式（${host}）`,
        onClick: () => { window.location.href = url.endsWith('/') ? url : `${url}/`; },
      });
    }
    if (extra) acts.push(extra);
    boot.actions(acts);
  };

  async function run(isRetry = false) {
    boot.clearError();
    boot.actions([]);

    // ---- 快通道准备（二进秒进，不闪"缓存界面"）----
    // 读缓存不依赖 SW，第一时间并行开始；重试按钮走慢通道（快通道刚失败过，别再试）
    const restorePath = getRestorePath();
    const fastDocP = isRetry ? Promise.resolve(null) : readCachedEntryDoc(swMeta, restorePath).catch(() => null);

    if (!('serviceWorker' in navigator)) {
      boot.stage('');
      boot.progress(1);
      boot.error('当前 WebView 版本过旧，不支持离线服务。', '请更新系统 WebView，或使用"在线模式"。');
      failActions();
      return { status: 'no-sw' };
    }

    // 静默注册（不更新任何文案）：热启动时注册本来就还在，controller 立等可取；
    // 版本升级后注册被原生层清掉，这里重装一次（秒级），期间启动页只有 logo
    let reg = null;
    let regError = null;
    try {
      reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      reg.update().catch(() => {});
    } catch (err) {
      regError = err;
    }
    if (reg) {
      try { await navigator.serviceWorker.ready; } catch (e) { /* noop */ }
    }
    const worker = reg ? await waitForController(reg) : (navigator.serviceWorker.controller || null);

    // ---- 快通道：入口文档已在缓存 + 首屏零缺失 → 直接落地，全程无文案 ----
    const fastDoc = await fastDocP;
    if (!isRetry && worker && fastDoc) {
      const corePaths = swMeta.core || [];
      const vendorUrls = (swMeta.vendor || []).map((v) => v.url);
      const missingFast = await listMissingCache(swMeta, [...corePaths, ...vendorUrls]);
      if (!missingFast.length) {
        boot.quiet(); // 收起阶段文案和进度条：一闪而过的只剩 logo，不再是"正在缓存…"
        writeDoc(fastDoc);
        window.__ckEntered = 1;
        const onlineFast = await Network.getStatus().then((s) => s.connected !== false).catch(() => true);
        if (onlineFast) startBackgroundPrecache(swMeta);
        return {
          status: 'ok', fast: true, online: onlineFast,
          ok: corePaths.length + vendorUrls.length, total: corePaths.length + vendorUrls.length,
        };
      }
    }

    // ---- 慢通道（首装 / 缓存不齐 / 重试）：照旧有阶段文案 ----
    boot.stage(isRetry ? '正在重试…' : '正在安装离线服务…');
    boot.progress(0.12, true);

    if (regError) {
      boot.progress(1);
      boot.error('离线服务注册失败。', String(regError?.message || regError));
      failActions();
      return { status: 'sw-register-failed', error: regError };
    }
    if (!worker) {
      boot.progress(1);
      boot.error('离线服务未能接管页面。', 'serviceWorker controller 为空（可能 WebView 限制）');
      failActions();
      return { status: 'sw-no-controller' };
    }

    // 离线就别再联网预缓存了：上次会话留下的缓存还在，直接进站，
    // 否则用户要干等预缓存超时（最长 40 秒）然后才看到错误页。
    // 在线也一样：先查本地缓存，齐了就直接进站 —— 以前只要在线就必跑一轮
    // 首屏预缓存，用户每次打开都要看着"正在缓存首屏内容 x/y"干等，
    // 其实缓存早就在了（升级后那次重建由原生层升级清理触发，属预期）。
    const online = await Network.getStatus().then((s) => s.connected !== false).catch(() => true);
    const corePaths = swMeta.core || [];
    const vendorUrls = (swMeta.vendor || []).map((v) => v.url);
    const totalAll = corePaths.length + vendorUrls.length;
    const missing = await listMissingCache(swMeta, [...corePaths, ...vendorUrls]);
    let result = {
      ok: totalAll - missing.length,
      total: totalAll,
      errors: [],
      okPaths: corePaths.filter((p) => !missing.includes(p)),
      partial: false,
    };
    if (missing.length && online) {
      const siteMissing = missing.filter((p) => !/^https?:/i.test(p));
      const vendorMissing = missing.filter((p) => /^https?:/i.test(p));
      result = await precacheCore(swMeta, {
        worker,
        paths: siteMissing,
        includeVendor: vendorMissing.length > 0,
        deadlineMs: 40000,
        onProgress: (ok, total) => boot.stage(`正在缓存首屏内容：${ok}/${total}`),
      });
    }

    boot.stage(online ? `首屏就绪（${result.ok}/${result.total}），正在进入站点…` : '离线：正在从本地缓存进入站点…');
    boot.progress(1);

    // 进站后后台静默预缓存全站其余文件（只补缺，HTML 排最前）
    if (online) startBackgroundPrecache(swMeta);

    // 原地落地站点文档（零导航）。不管预缓存结果如何都要试：
    // 缓存可能上次就建好了（离线可用），也可能本次只差个别文件
    const entered = await enterViaWrite(worker);
    if (entered) {
      // 通知壳运行时：站点已接管（返回键监听靠它静默，否则会双触发）
      window.__ckEntered = 1;
      return { status: 'ok', ...result, online };
    }

    boot.progress(1);
    if (online) {
      const missing = (swMeta.core || []).filter((p) => !(result.okPaths || []).includes(p)).slice(0, 2).join(', ');
      boot.error(
        '站点内容没拿到（离线服务已接管，但更新源都取不到站点首页）。',
        `核心缓存 ${result.ok}/${result.total}${missing ? `；未拿到：${missing}` : ''}；controller=${!!navigator.serviceWorker.controller}`,
      );
    } else {
      boot.error(
        '当前离线，且本地还没有站点缓存。请连接网络后点重试。',
        `首屏核心 ${(swMeta.core || []).length} 个文件都未缓存${result.errors?.length ? `；${result.errors.slice(0, 3).join(' | ')}` : ''}`,
      );
    }
    failActions();
    return { status: online ? 'enter-failed' : 'offline', ...result };
  }

  return run(false);
}

export default bootstrapShell;
