/**
 * Ckarefulon 壳 · Service Worker（构建时注入 __CK_SW_META__）
 * ---------------------------------------------------------------------------
 * 内容源：**jsDelivr**（= 你 repo 内容的 CDN 直发，带 CORS 头）。
 *   · 导航/资源：stale-while-revalidate —— 有缓存秒开（离线可用），后台静默回源刷新
 *   · 回源拿到的 HTML 注入 /ckapp/ck-app.js（蓝牙原生桥 + 更新提示）
 *   · 首启由壳发消息 ck-precache 预缓存首屏核心 + vendor 脚本
 *   · 无任何发布步骤：repo 里有什么，App 就能拿到什么
 */

const META = __CK_SW_META__;
const CACHE = `${META.cachePrefix}-site-v1`;

/* ------------------------------ MIME 归一化 ------------------------------ */
const MIME_BY_EXT = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8', mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
};
function contentTypeFor(pathname, hinted) {
  const ext = (String(pathname).split('.').pop() || '').toLowerCase().split('?')[0];
  return MIME_BY_EXT[ext] || (hinted && hinted !== 'text/plain' ? hinted : 'application/octet-stream');
}

/**
 * 把站点请求路径归一成"仓库里的真实文件路径"：
 *   · `/`            → /index.html（根页就是 index.html）
 *   · `/Cube/`、`/Cube` → /Cube/index.html（站点链接写的是目录，预缓存存的是 index.html）
 *   · 去掉查询串     → 站点用 ?v=11 当版本号，同一路径必须命中同一条缓存
 *
 * 以前只归一了 `/`：真机上（SW 自己的 CORS 通道到不了任何源时）预缓存存好的
 * `/Cube/index.html` 对 `/Cube/` 这个请求就是 miss —— 点首页每一张卡片都落到
 * 兜底页；`/nav/nav.js?v=11` 也 miss，只能靠 no-cors 的 opaque 兜底（无类型、
 * 不可靠）。这两类 miss 是"首页点不动/二进空白"的直接原因。
 */
function canonicalSitePath(pathname) {
  let p = String(pathname || '/');
  p = p.split('?')[0];
  if (p === '' || p === '/') return '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (!last.includes('.')) p += '/index.html'; // 没扩展名的末段按目录处理
  return p;
}

/* ------------------------------ 回源 ------------------------------ */

/** 取路径的文件名部分（末段），用于判断重定向是不是"换了个文件" */
function baseName(pathname) {
  const s = String(pathname || '');
  return s.slice(s.lastIndexOf('/') + 1);
}

async function fetchRemoteCors(pathname, search, origins = META.origins) {
  const perOriginTimeout = META.originTimeoutMs || 8000;
  const isHtml = HTML_RE.test(pathname);
  for (const o of origins) {
    if (o.cors === false) continue; // 无 CORS 头的源（如 Gitee raw）只供原生通道使用
    // 不发 .html 的源（jsDelivr 对 .html 一律 301 给被墙的 raw）：HTML 请求跳过，
    // 不然每个文件都白等一整轮超时，还会把 raw 打到限流
    if (o.html === false && isHtml) continue;
    const q = o.ignoreQuery ? '' : search;
    const urls = pathname.endsWith('/')
      ? [`${o.base}${pathname}index.html${q}`, `${o.base}${pathname}${q}`]
      : [`${o.base}${pathname}${q}`];
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perOriginTimeout);
      try {
        const res = await fetch(url, {
          mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: controller.signal,
        });
        // 目录列表页的兜底拦截：只比文件名，不比整条路径。
        // fastly.jsdelivr.net/gh/<repo>@main/<path> 会 301 到 raw.githubusercontent.com/<repo>/main/<path>，
        // 路径前缀本来就不同——比整条路径会把这条**唯一的 CORS 通道**误杀，
        // 结果站点内容一个源都拿不到，只剩 no-cors 的 opaque 响应（HTML 没法注入）。
        // res.url 为空（理论上真实 fetch 不会，但防御一下）：当成本同名处理
        if (res.ok && res.url && baseName(new URL(res.url).pathname) !== baseName(new URL(url).pathname)) continue;
        if (res.ok) return res;
      } catch (e) { /* 超时/失败 → 换下一个源 */ }
      finally { clearTimeout(timer); }
    }
  }
  return null;
}

/**
 * 识别 CDN 的目录/文件列表页（jsDelivr 等），绝不能当站点内容缓存。
 * 只认**列表页自己的硬特征**：jsDelivr 的包浏览页标题/页脚是
 * "…CDN by jsDelivr - A free, fast, and reliable Open Source CDN"、正文是
 * "<h1>…CDN files</h1>"。以前只要正文开头出现 "jsdelivr"（站点页面引用
 * CDN 脚本太常见，22 个站点页面里有 12 个命中）就把真页面当列表页拒掉，
 * 那些页面永远进不了缓存。
 */
function looksLikeListing(text) {
  if (!text) return true;
  if (!/<(html|head|body|div|main|section|p)\b/i.test(text)) return true; // 没真实标记：截断/错误页
  const head = text.slice(0, 4000);
  if (/CDN by jsDelivr - A free, fast, and reliable/i.test(head)) return true;
  if (/<h1>[^<]*CDN files<\/h1>/i.test(head)) return true;
  if (/Files?\s*(?:and|&)\s*Directories|Directory listing for|<title>\s*Index of /i.test(head)) return true;
  return false;
}

const HTML_RE = /\.(html?)(\?|$)/i;

/**
 * MIME 归一化：jsDelivr 等源会把 .html 当 text/plain+nosniff 返回，
 * 直接渲染就是"显示源码"。出站前按扩展名强制纠正 Content-Type。
 * @param {string} pathname 归一后的路径（站点请求要先过 canonicalSitePath：
 *   否则 /Cube/ 这类目录 URL 会被判成"无扩展名"，重建成 octet-stream）
 * @param {string} hint 已知的正确类型（vendor 依赖在构建时算好），无扩展名的路径靠它
 */
async function normalizeResponse(res, pathname, hint) {
  // opaque 响应（no-cors 兜底拿到的）读不到 header 也读不到 body，
  // 下面按扩展名重建会得到一个 0 字节的响应，等于把内容弄丢。
  // 这正是国内 jsDelivr 不通、只能靠 no-cors 兜底时最需要它工作的时候。
  if (res.type === 'opaque') return res;
  const path = pathname;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const want = contentTypeFor(path, hint);
  const ok =
    ct &&
    !ct.startsWith('text/plain') &&
    !ct.startsWith('application/octet-stream') &&
    (!HTML_RE.test(path) || ct.includes('text/html')) &&
    (!/\.(js|mjs)$/.test(path) || ct.includes('javascript') || ct.includes('ecmascript')) &&
    (!/\.css$/.test(path) || ct.includes('text/css')) &&
    (!/\.svg$/.test(path) || ct.includes('svg'));
  if (ok) return res;
  const buf = await res.arrayBuffer();
  return new Response(buf, {
    status: res.status,
    headers: { 'Content-Type': want, 'Access-Control-Allow-Origin': '*' },
  });
}

function injectHtml(text) {
  if (!text || text.includes(META.inject.marker)) return text;
  const script = `<script src="${META.inject.script}" ${META.inject.marker}></script>`;
  const style = `<link rel="stylesheet" href="${META.inject.style}" ${META.inject.marker}>`;
  if (/<head[^>]*>/i.test(text)) {
    return text
      .replace(/<head[^>]*>/i, (m) => `${m}\n\t${script}`)
      .replace(/<\/head>/i, `\t${style}\n</head>`);
  }
  if (/<html[^>]*>/i.test(text)) return text.replace(/<html[^>]*>/i, (m) => `${m}<head>${script}${style}</head>`);
  return text;
}

/** 站点请求的缓存键：和预缓存写入用的路径走同一套归一规则 */
function cacheKeyFor(req) {
  const url = new URL(req.url);
  url.pathname = canonicalSitePath(url.pathname);
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

function offlineResponse() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#161328;color:#eceef6;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;padding:32px}
button{margin-top:18px;padding:11px 22px;border:0;border-radius:12px;background:linear-gradient(120deg,#a99cf0,#24f0ea);color:#10101c;font-weight:700;font-size:15px}</style></head>
<body><div><h2 style="margin:0 0 10px">当前离线，且本地还没有缓存</h2>
<p style="opacity:.7;font-size:14px;line-height:1.7">连接网络后点重试，即可下载站点内容并永久离线使用。</p>
<button onclick="location.href='/'">重试</button></div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * 导航兜底：拿不到站点内容时，回壳启动页（带 .ck-boot + ck-app.js），
 * 壳运行时会在里面重新走一遍启动/预缓存流程 —— 有网就能恢复进站。
 * 以前这里给的是一段没有运行时的"离线提示页"：一旦被服务出来（比如退出
 * 再进时 WebView 恢复到上次浏览的路径），壳永远不会启动，用户就卡在一个
 * 点啥都没反应、退出重进还是空白的死页上。
 * 注意：SW 自己发起的 fetch 不会再进本 SW 的 fetch 事件，所以这里拿到的
 * 一定是原生本地服务器上的壳文档。
 */
async function shellDocResponse() {
  try {
    const res = await fetch(`${self.location.origin}/`, { cache: 'no-store', credentials: 'omit' });
    if (res.ok) {
      const text = await res.text();
      if (text && text.includes('ck-boot')) {
        return new Response(text, { status: 200, headers: { 'Content-Type': MIME_BY_EXT.html } });
      }
    }
  } catch (e) { /* 连壳文档都拿不到：只能给离线提示页 */ }
  return offlineResponse();
}

/* ---------------------- 页面原生通道桥 ---------------------- */

/**
 * 页面原生通道桥：国内环境里，SW 自己的 CORS 通道**拿不到站点 HTML**——
 *   · jsDelivr 对一切 .html 都 301 到 raw.githubusercontent.com（国内不通）；
 *   · Gitee / Netlify 没有 ACAO 头，SW 是浏览器上下文，碰不了。
 * 真正可靠的通道只有页面里的原生 HTTP（CapacitorHttp → Gitee）。
 * 所以 HTML 请求 miss 时广播给页面，请它用原生链代取，SW 注入运行时、
 * 入缓存、再服务 —— 用户点一个还没预缓存到的页面，不用再等后台池跑完。
 * 页面不响应（无客户端 / 超时）就照旧落回导航兜底，行为不变。
 */
const pendingNative = new Map();
let requestIdSeq = 0;

function requestNativeHtml(pathname) {
  return new Promise((resolve) => {
    const requestId = `nf${++requestIdSeq}`;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingNative.delete(requestId);
      resolve(r);
    };
    const timer = setTimeout(() => done(null), META.bridgeTimeoutMs || 15000);
    pendingNative.set(requestId, done);
    broadcast({ type: 'ck-fetch-native', requestId, pathname });
  });
}

async function bridgePageHtml(cache, req, pathname) {
  const r = await requestNativeHtml(pathname);
  if (!r || typeof r.body !== 'string') return null;
  if (!/<(html|head|body|div|main|section|p)\b/i.test(r.body)) return null; // 残缺/错误页：当失败处理
  const text = injectHtml(r.body);
  const res = new Response(text, { status: 200, headers: { 'Content-Type': MIME_BY_EXT.html } });
  try { await cache.put(cacheKeyFor(req), res.clone()); } catch (e) { /* 配额 */ }
  return res;
}

/** 并行多个取数通道，谁先给出非空结果就用谁；全空（或全失败）返回 null */
async function firstNonNull(ps) {
  const pending = new Set(ps);
  while (pending.size) {
    const r = await Promise.race([...pending].map((p) => p.then((v) => ({ p, v })).catch(() => ({ p, v: null }))));
    pending.delete(r.p);
    if (r.v) return r.v;
  }
  return null;
}

/* ------------------------------ 缓存读写 ------------------------------ */

async function refreshIntoCache(cache, req, { allowOpaque = true, origins } = {}) {
  const url = new URL(req.url);
  // 目录路径实际取的是 <path>index.html，HTML 判定要跟它走：
  // 以前只看响应头里的 Content-Type，而 jsDelivr 把 .html 给成 text/plain →
  // 运行时注入被整个跳过（页面没有蓝牙桥/更新检查），缓存里还存着错误的类型。
  const effPath = canonicalSitePath(url.pathname);
  const isHtml = HTML_RE.test(effPath);
  const key = cacheKeyFor(req);

  let res = await fetchRemoteCors(url.pathname, url.search, origins);
  let opaque = false;
  if (!res && allowOpaque && !isHtml) {
    // 每条都要带超时：no-cors 请求拿不到响应也拿不到错误时会一直挂着，
    // 而这条路径可能是导航请求在走——挂住 = 启动页永远停在"正在进入站点…"。
    // HTML 走 no-cors 毫无意义（body 读不了、注入不了、类型还不对），直接不试。
    const perOriginTimeout = META.originTimeoutMs || 8000;
    for (const o of META.opaqueOrigins || []) {
      const q = o.ignoreQuery ? '' : url.search;
      const u = url.pathname.endsWith('/') ? `${o.base}${url.pathname}index.html${q}` : `${o.base}${url.pathname}${q}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perOriginTimeout);
      try {
        const r = await fetch(u, { mode: 'no-cors', credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: controller.signal });
        if (r.type === 'opaque' || r.ok) { res = r; opaque = true; break; }
      } catch (e) { /* 超时/失败 → 换下一个源 */ }
      finally { clearTimeout(timer); }
    }
  }
  if (!res) return null;

  let final = res;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!opaque && (isHtml || ct.includes('text/html'))) {
    const text = await res.text();
    if (looksLikeListing(text)) return null; // 列表页/残缺页：视为失败，换源或离线兜底
    final = new Response(injectHtml(text), { status: res.status, headers: { 'Content-Type': MIME_BY_EXT.html } });
  }
  // opaque（no-cors 兜底）读不到 body 也读不到头：Content-Type 是空的、
  // 内容长度未知。写进缓存会把"样式/脚本加载失败"固化下来（CSS 没有类型
  // 会被浏览器直接拒用），而且把好内容顶掉之后离线就再也回不去了。
  // 同源请求只允许临时用它顶一下，绝不入缓存 —— 缓存里只存预缓存/回源
  // 拿到的、带正确类型且注入过运行时的内容。
  if (opaque) return final;
  try { await cache.put(key, final.clone()); } catch (e) { /* 配额 */ }
  return final;
}

function broadcast(msg) {
  self.clients.matchAll({ includeUncontrolled: true }).then((list) => {
    for (const c of list) { try { c.postMessage(msg); } catch (e) { /* noop */ } }
  });
}

async function handleSiteRequest(req) {
  const cache = await caches.open(CACHE);
  const pathname = canonicalSitePath(new URL(req.url).pathname);
  const hit = await cache.match(cacheKeyFor(req));
  // 旧版本写进去的 opaque 条目不可用（无类型、内容未知）：当作 miss 处理，
  // 回源拿到好内容时会把它覆盖掉
  if (hit && hit.type !== 'opaque') {
    refreshIntoCache(cache, req).then((res) => {
      if (res) broadcast({ type: 'ck-content-refreshed', url: req.url });
    }).catch(() => null);
    return normalizeResponse(hit, pathname);
  }
  // miss：回源（CORS 通道）和"请页面用原生通道代取"同时进行，谁先拿到用谁。
  // 明明离线还去发请求只会白等一轮超时，直接走兜底。
  const offline = self.navigator?.onLine === false;
  const fresh = offline ? null : await firstNonNull([
    refreshIntoCache(cache, req).catch(() => null),
    HTML_RE.test(pathname) ? bridgePageHtml(cache, req, pathname) : Promise.resolve(null),
  ]);
  if (fresh) return normalizeResponse(fresh, pathname);
  if (req.mode === 'navigate') return shellDocResponse();
  return Response.error();
}

/** 站点请求兜底：导航回壳启动页（可恢复），子资源按网络错误处理 */
function siteFallback(req, err) {
  console.error('[ck-sw] handleSiteRequest 失败：', String(err?.message || err), req.url);
  return req.mode === 'navigate' ? shellDocResponse() : Response.error();
}

async function handleVendorRequest(req) {
  const cache = await caches.open(CACHE);
  const pathname = new URL(req.url).pathname;
  const hint = VENDOR_CT.get(req.url);
  const hit = await cache.match(req);
  if (hit) {
    fetchVendor(req).catch(() => null);
    return normalizeResponse(hit, pathname, hint);
  }
  const res = await fetchVendor(req);
  if (res) return normalizeResponse(res, pathname, hint);
  return Response.error();
}

// 原始 CDN 地址 → 国内镜像地址。缓存键始终是原始地址，镜像只是取内容的通道。
const VENDOR_MIRROR = new Map(
  (META.vendor || []).filter((v) => v.mirror).map((v) => [v.url, v.mirror]),
);
// 没有单独配镜像的 CDN 地址（站点页面里引用的、预缓存清单之外的）也要能兜底：
// jsDelivr / unpkg 的路径规则完全一致，换主机就是镜像。只有 cdnjs / esm.sh
// 没有通用镜像（需要的话在 app.config.json 里单独写 mirror）。
const MIRROR_RULES = [
  ['https://cdn.jsdelivr.net/', 'https://jsd.onmicrosoft.cn/'],
  ['https://fastly.jsdelivr.net/', 'https://jsd.onmicrosoft.cn/'],
  ['https://unpkg.com/', 'https://jsd.onmicrosoft.cn/npm/'],
];
const mirrorFor = (url) => {
  const configured = VENDOR_MIRROR.get(url);
  if (configured) return configured;
  for (const [from, to] of MIRROR_RULES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return null;
};
// vendor 依赖的正确类型（构建时按真实内容算好）。缓存键是原始 CDN 地址，
// 有的路径没有扩展名（如 jsDelivr 的 /npm/pkg/+esm），按路径猜 MIME 会猜成
// octet-stream → <script type="module"> 直接被浏览器拒载。
const VENDOR_CT = new Map(
  (META.vendor || []).map((v) => [v.url, v.ct || 'application/javascript; charset=utf-8']),
);

async function fetchVendor(req) {
  const cache = await caches.open(CACHE);
  const mirror = mirrorFor(req.url);
  for (const url of [req.url, mirror].filter(Boolean)) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (res.ok) { try { await cache.put(req, res.clone()); } catch (e) { /* noop */ } return res; }
    } catch (e) { /* noop */ }
    try {
      const res = await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' });
      if (res.type === 'opaque') { try { await cache.put(req, res.clone()); } catch (e) { /* noop */ } return res; }
    } catch (e) { /* noop */ }
  }
  return null;
}

/* ------------------------------ 事件 ------------------------------ */

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    for (const k of keys) if (k.startsWith(META.cachePrefix) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 壳运行时资产交给原生本地服务器
  if (url.origin === self.location.origin && (url.pathname.startsWith('/ckapp/') || url.pathname === '/sw.js')) return;

  // CDN 依赖：缓存优先
  if (META.vendorHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    event.respondWith(handleVendorRequest(req));
    return;
  }

  // 本站导航与资源（失败时绝不回壳文档——那会造成启动循环；只给离线页并记录原因）
  if (url.origin === self.location.origin) {
    event.respondWith(handleSiteRequest(req).catch((err) => siteFallback(req, err)));
  }
});

/* ------------------------------ 与页面通信 ------------------------------ */

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const reply = (msg) => { try { event.source?.postMessage(msg); } catch (e) { /* noop */ } };

  // 页面用原生通道代取的结果（HTML 导航 miss 时发起）
  if (data.type === 'ck-fetch-native-done') {
    const done = pendingNative.get(data.requestId);
    if (done) {
      pendingNative.delete(data.requestId);
      done(data.ok && typeof data.body === 'string' ? { body: data.body, ct: data.ct } : null);
    }
    return;
  }

  if (data.type === 'ck-precache') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const jobs = [
        ...(META.core || []).map((p) => refreshIntoCache(cache, new Request(self.location.origin + p), { allowOpaque: false })),
        ...(META.vendor || []).map((v) => fetchVendor(new Request(v.url))),
      ];
      const labels = [...(META.core || []), ...(META.vendor || []).map((v) => v.url)];
      const results = await Promise.allSettled(jobs);
      const ok = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      // 失败原因分两种：rejected（抛异常）和 fulfilled 但拿到空值。
      // 以前只挑 fulfilled 的再看 r.reason，而 reason 只存在于 rejected 上，
      // 结果诊断信息永远是 'empty'，真机排障时看不到任何有用线索。
      const errors = results
        .map((r, i) => ({ r, label: labels[i] }))
        .filter(({ r }) => r.status === 'rejected' || !r.value)
        .slice(0, 3)
        .map(({ r, label }) => `${label}: ${r.status === 'rejected' ? String(r.reason?.message || r.reason) : '空响应'}`);
      const msg = { type: 'ck-precache-done', ok, total: jobs.length, errors };
      reply(msg);
      broadcast(msg);
    })());
  }

  if (data.type === 'ck-revalidate') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const key = cacheKeyFor(new Request(self.location.origin + '/index.html'));
      const before = await cache.match(key);
      const beforeTag = before?.headers?.get?.('etag') || before?.headers?.get?.('last-modified') || null;
      const res = await refreshIntoCache(cache, new Request(self.location.origin + '/index.html'), {
        allowOpaque: false,
        origins: META.probeOrigins || META.origins,
      });
      const afterTag = res?.headers?.get?.('etag') || res?.headers?.get?.('last-modified') || null;
      const changed = !!res && beforeTag !== afterTag;
      reply({ type: 'ck-revalidate-done', changed });
      if (changed) broadcast({ type: 'ck-content-refreshed', url: '/index.html' });
    })());
  }

  // 页面把下载好的内容塞进缓存（首屏预缓存 / vendor），并回执确认
  if (data.type === 'ck-cache-put') {
    event.waitUntil((async () => {
      const keyName = data.pathname || data.key;
      try {
        const cache = await caches.open(CACHE);
        // vendor 的键是原始 CDN 地址（可能没有扩展名，如 /npm/pkg/+esm），
        // 不能套目录归一 —— 否则会被误判成 HTML，脚本类型被改成 text/html，
        // <script type="module"> 直接被浏览器拒载
        const pathForType = data.key
          ? new URL(data.key).pathname
          : canonicalSitePath(data.pathname || '/');
        const vendorCt = data.vendorCt || (data.key ? VENDOR_CT.get(data.key) : null);
        let ct = data.contentType || '';
        // 源给的不是可用类型（text/plain / octet-stream / 空）就按路径推：
        // Gitee raw 对一切文本都给 text/plain，不能原样入缓存
        if (!ct || /octet-stream|text\/plain/i.test(ct)) ct = contentTypeFor(pathForType, vendorCt);
        if (HTML_RE.test(pathForType)) ct = MIME_BY_EXT.html; // jsDelivr 等源给 text/plain，必须纠正
        let body = data.body;
        if (ct.startsWith('text/html')) body = injectHtml(typeof body === 'string' ? body : await body.text());
        const key = data.key ? new Request(data.key) : cacheKeyFor(new Request(self.location.origin + (data.pathname || '/')));
        await cache.put(key, new Response(body, { status: 200, headers: { 'Content-Type': ct } }));
        reply({ type: 'ck-cache-put-done', pathname: keyName });
      } catch (e) {
        reply({ type: 'ck-cache-put-failed', pathname: keyName, error: String(e?.message || e) });
      }
    })());
  }

  if (data.type === 'ck-claim') {
    event.waitUntil(self.clients.claim());
  }

  if (data.type === 'ck-clear-cache') {
    event.waitUntil(caches.delete(CACHE).then(() => reply({ type: 'ck-cache-cleared' })));
  }

  if (data.type === 'ck-cache-stats') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const keys = await cache.keys();
      let bytes = 0;
      for (const k of keys) {
        try {
          const r = await cache.match(k);
          const b = await r?.clone()?.blob();
          bytes += b?.size || 0;
        } catch (e) { /* noop */ }
      }
      reply({ type: 'ck-cache-stats-done', entries: keys.length, bytes });
    })());
  }
});
