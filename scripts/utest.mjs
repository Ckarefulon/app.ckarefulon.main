/**
 * 离线单元检查（不联网、不需要浏览器）：
 *   1) sw.js 出站 MIME 归一化 + opaque 处理 + 目录页识别 + 回源超时
 *   2) vendor 直连不通时改走国内镜像，缓存键仍是原始 CDN 地址
 *   3) 原生传输通道（CapacitorHttp）的返回值还原：二进制不是 base64 文本、JSON 不是 "[object Object]"
 *
 * 为什么要有它：Gitee raw 把 .html/.css/.js 一律当 text/plain 返回，而 Gitee 现在是
 * 首屏下载链的第一个源——这条路径是主路径。e2e 能覆盖它但依赖真浏览器，跑得慢；
 * 这里用 vm 直接把 sw.js 拉起来测，改 sw.js 后几秒内就能发现回归。
 * 依赖 .build/sw-meta.json（先跑 npm run bundle:js），缺失时跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { ROOT, log, paths, readJson } from './lib.mjs';

const metaPath = path.join(paths.build, 'sw-meta.json');
if (!fs.existsSync(metaPath)) {
  log.warn('utest：缺少 .build/sw-meta.json（先跑 npm run bundle:js），跳过');
  process.exit(0);
}
const META = readJson(metaPath);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; log.ok(name); }
  else { fail++; log.warn(`✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
};

/* ============================ 1) sw.js ============================ */

const swSrc = path.join(ROOT, 'src', 'sw', 'sw.js');
let code = fs.readFileSync(swSrc, 'utf8');
if (!code.includes('const META = __CK_SW_META__;')) {
  log.die('utest：sw.js 里的 META 注入点不见了，测试需要同步更新');
}
code = code.replace('const META = __CK_SW_META__;', 'const META = globalThis.__META;');
code += '\nglobalThis.__t = { normalizeResponse, contentTypeFor, looksLikeListing, fetchVendor, fetchRemoteCors, refreshIntoCache, canonicalSitePath, cacheKeyFor, handleSiteRequest, offlineResponse };\n';

/* 缓存桩：只记录 put 进来的键 */
const putKeys = [];
const cacheStub = { match: async () => null, put: async (req) => { putKeys.push(typeof req === 'string' ? req : req.url); } };

/* 网络桩：直连一律失败，只有国内镜像能通 —— 模拟国内网络环境 */
const netCalls = [];
const netStub = async (url) => {
  netCalls.push(url);
  if (url.includes('jsd.onmicrosoft.cn')) {
    return new Response('/*镜像内容*/', { headers: { 'Content-Type': 'application/javascript' } });
  }
  throw new Error('net-blocked');
};

/** 拉起一份 sw.js 实例；meta 可覆盖（如把超时改小，免得测试干等 8 秒）；
 *  overrides 可替换 self 上的成员（如 clients.matchAll 返回"有页面在线"） */
function bootSw(meta, net = netStub, overrides = {}) {
  const listeners = {};
  const self = {
    location: { origin: 'http://localhost' },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    ...overrides,
  };
  const c = vm.createContext({
    self, __META: meta, caches: { open: async () => cacheStub }, console, URL, Response, Request, Headers,
    ArrayBuffer, TextEncoder, TextDecoder, setTimeout, clearTimeout, AbortController, fetch: net,
  });
  new vm.Script(code).runInContext(c);
  c.__t.__listeners = listeners; // 测试里用它模拟页面给 SW 发消息
  return c.__t;
}

const ctx = { __t: bootSw(META) };
const { normalizeResponse, contentTypeFor, looksLikeListing, fetchVendor, fetchRemoteCors, canonicalSitePath, cacheKeyFor } = ctx.__t;

log.step('utest 1/3：sw.js 出站处理');

// 1.1 Gitee 的 text/plain 出站必须按扩展名纠正，且内容不能丢
const plain = () => new Response('<x>内容</x>', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
for (const [p, want] of [
  ['/index.html', 'text/html'],
  ['/Cube/index.html', 'text/html'],
  ['/nav/nav.css', 'text/css'],
  ['/nav/nav.js', 'javascript'],
  ['/assets/services/core/site-scope.js', 'javascript'],
  ['/favicon.svg', 'svg'],
]) {
  const out = await normalizeResponse(plain(), p);
  const ct = out.headers.get('content-type') || '';
  check(`${p} 纠正为 ${want}`, ct.includes(want), `实际 ${ct}`);
  check(`${p} 内容没丢`, (await out.text()) === '<x>内容</x>');
}

// 1.2 MIME 本来就对的不动它
for (const [p, ct] of [['/index.html', 'text/html; charset=utf-8'], ['/a.png', 'image/png'], ['/a.woff2', 'font/woff2']]) {
  const res = new Response('x', { headers: { 'Content-Type': ct } });
  check(`${p} (${ct}) 原样返回`, (await normalizeResponse(res, p)) === res);
}

// 1.3 opaque 响应不能被重建（重建 = 0 字节，等于把内容弄丢）
const opaque = { type: 'opaque', status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0), clone() { return this; } };
const outOpaque = await normalizeResponse(opaque, '/nav/nav.js');
check('opaque 原样返回，没有被清空', outOpaque === opaque);

// 1.4 兜底样式表的 contentTypeFor
for (const [p, want] of [['/x.css', 'text/css'], ['/x.js', 'application/javascript'], ['/x.html', 'text/html'], ['/x.md', 'text/plain']]) {
  check(`contentTypeFor(${p}) → ${want}`, contentTypeFor(p).startsWith(want), `实际 ${contentTypeFor(p)}`);
}

// 1.5 目录/列表页不能被当成站点内容缓存。
//     判定必须只认列表页自己的硬特征：以前只要正文开头出现 "jsdelivr"
//     （站点页面引用 CDN 脚本太常见）就把真页面当列表页拒掉 ——
//     22 个站点页面里有 12 个被误杀，永远进不了缓存。
const JSDELIVR_LISTING = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="description" content="Ckarefulon/Ckarefulon.github.io CDN by jsDelivr - A free, fast, and reliable Open Source CDN">
<title>Ckarefulon/Ckarefulon.github.io CDN by jsDelivr - A free, fast, and reliable Open Source CDN</title></head>
<body><div class="container"><div class="header"><h1>Ckarefulon/Ckarefulon.github.io CDN files</h1></div></div></body></html>`;
check('jsDelivr 目录列表页被拒', looksLikeListing(JSDELIVR_LISTING) === true);
check('jsDelivr 目录列表页（h1 CDN files）被拒', looksLikeListing('<html><body><h1>repo CDN files</h1></body></html>') === true);
check('截断页面被拒（无任何真实标记）', looksLikeListing('半个页面') === true);
check('站点自身的 404 页通过（虽小但真实）', looksLikeListing('<p>404<p>\n') === false);
// 站点页面在 <head> 里引用 CDN 脚本，正文前 2000 字里就有 jsdelivr 字样 —— 必须照常通过
const realSitePage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<title>Ckarefulon</title></head><body><main><h1>站点内容</h1></main></body></html>`;
check('引用 CDN 脚本的真站点页面不能被拒', looksLikeListing(realSitePage) === false);
check('空响应被拒', looksLikeListing('') === true);

// 1.6 vendor 直连不通 → 走国内镜像；缓存键必须仍是原始 CDN 地址
const vendorEntry = (META.vendor || []).find((v) => v.mirror);
if (!vendorEntry) {
  log.warn('utest：sw-meta 里没有任何带 mirror 的 vendor 条目，跳过镜像兜底检查');
} else {
  netCalls.length = 0;
  putKeys.length = 0;
  const res = await fetchVendor(new Request(vendorEntry.url));
  check('直连不通时镜像兜底拿到了内容', res != null && (await res.text()) === '/*镜像内容*/');
  check('先试了原始 CDN 地址', netCalls[0] === vendorEntry.url, netCalls[0]);
  check('直连失败后改试镜像', netCalls.includes(vendorEntry.mirror), netCalls.join(' | '));
  check('缓存键是原始 CDN 地址（页面里的 <script> 才能拦到）', putKeys[0] === vendorEntry.url, String(putKeys[0]));
}

// 1.7 没有镜像的地址行为不变
netCalls.length = 0;
check('没有镜像时拿不到就返回 null', (await fetchVendor(new Request('https://example.com/a.js'))) === null);
check('没有镜像时只试原始地址', netCalls.every((u) => u === 'https://example.com/a.js'), netCalls.join(' | '));

// 1.8 回源的重定向判定：CDN 跳到 raw 主机是**正常路径**，不能当成目录列表页拒掉
{
  const okRes = (url) => ({ ok: true, status: 200, url, headers: new Headers({ 'Content-Type': 'text/html' }) });
  const CDN = 'https://fastly.jsdelivr.net/gh/Ckarefulon/Ckarefulon.github.io@main/nav/nav.css';
  const RAW = 'https://raw.githubusercontent.com/Ckarefulon/Ckarefulon.github.io/main/nav/nav.css';
  const LISTING = 'https://fastly.jsdelivr.net/gh/Ckarefulon/Ckarefulon.github.io@main/';
  const metaCors = { ...META, origins: [{ name: 'jsDelivr', base: 'https://fastly.jsdelivr.net/gh/Ckarefulon/Ckarefulon.github.io@main', cors: true, ignoreQuery: true }] };

  const t1 = bootSw(metaCors, async (u) => okRes(u === CDN ? RAW : u));
  check('CDN → raw 主机的重定向被接受（同名文件）', (await t1.fetchRemoteCors('/nav/nav.css', '')) != null);

  const t2 = bootSw(metaCors, async (u) => okRes(u === CDN ? LISTING : u));
  check('跳到目录列表页被拒（文件名变了）', (await t2.fetchRemoteCors('/nav/nav.css', '')) === null);

  // 1.9 opaque 兜底必须带超时：拿不到响应也拿不到错误时会一直挂着，
  //     而这条路径是**导航请求**在走 —— 挂住 = 启动页永远停在"正在进入站点…"。
  // 永不回包、但会响应 abort 的 fetch —— 真实 fetch 就是这样：挂住的请求只能靠 signal 掐断
  const hang = (url, opts) => new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const metaHang = {
    ...META, originTimeoutMs: 300,
    origins: [{ name: 'dead', base: 'https://dead.example', cors: true, ignoreQuery: true }],
    opaqueOrigins: [{ name: 'hang', base: 'https://hang.example', ignoreQuery: true }],
  };
  const t3 = bootSw(metaHang, hang);
  const t0 = Date.now();
  const r3 = await Promise.race([
    t3.refreshIntoCache(cacheStub, new Request('http://localhost/index.html')),
    new Promise((r) => setTimeout(() => r('HUNG'), 5000)),
  ]);
  const cost = Date.now() - t0;
  check('拿不到响应时回源不会无限挂起', r3 === null, String(r3));
  check('在超时窗口内返回', cost < 4000, `${cost}ms`);
}

// 1.10 回源入缓存：HTML 不能靠响应头里的 Content-Type 判断。
//     jsDelivr 把 .html 给成 text/plain —— 以前这样判断的结果是：运行时注入整个被跳过
//     （页面没有蓝牙桥/更新检查），根路径还会被出站重建成 application/octet-stream。
{
  const HTML = '<!doctype html><html><head><title>站点</title></head><body><main>hi</main></body></html>';
  const JS = 'console.log(1)';
  const store = new Map();
  const puts = [];
  const cache2 = {
    match: async (req) => store.get(String(req.url || req)) || null,
    put: async (req, res) => {
      const u = String(req.url || req);
      store.set(u, res.clone());
      puts.push({ key: u, ct: res.headers.get('content-type'), type: res.type });
    },
  };
  // 模拟 jsDelivr：一切内容一律 text/plain
  const plainSource = async (u) => {
    const res = new Response(u.includes('index.html') ? HTML : JS, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    Object.defineProperty(res, 'url', { value: u });
    return res;
  };
  const t = bootSw({ ...META, originTimeoutMs: 200 }, plainSource);
  const put = async (req) => {
    puts.length = 0;
    const r = await t.refreshIntoCache(cache2, new Request(`http://localhost${req}`));
    const entry = puts.find((p) => p.key.endsWith(req.replace(/\/$/, '') || '/index.html')) || puts[puts.length - 1];
    return { r, entry };
  };

  // 根路径：必须按 text/html 入缓存，且带注入
  const root = await put('/');
  check('根路径入缓存为 text/html（不是 octet-stream）', root.entry?.ct?.includes('text/html'), String(root.entry?.ct));
  check('根路径注入了运行时', root.r ? (await root.r.clone().text()).includes('ck-site.js') : false);
  const rootOut = await normalizeResponse(root.r, '/index.html');
  check('根路径出站为 text/html（不是 application/octet-stream）', (rootOut.headers.get('content-type') || '').includes('text/html'), rootOut.headers.get('content-type'));

  // 子页面 / 目录路径同样要注入
  for (const p of ['/Cube/index.html', '/Cube/']) {
    const r = await put(p);
    check(`${p} 注入了运行时`, r.r ? (await r.r.clone().text()).includes('ck-site.js') : false);
    check(`${p} 入缓存为 text/html`, r.entry?.ct?.includes('text/html'), String(r.entry?.ct));
  }

  // 非文本（.js）从 text/plain 源来 → 出站按扩展名纠正
  const rjs = await put('/nav/nav.js');
  const jsOut = await normalizeResponse(rjs.r, '/nav/nav.js');
  check('text/plain 的 .js 出站纠正为 javascript', (jsOut.headers.get('content-type') || '').includes('javascript'), jsOut.headers.get('content-type'));
}

// 1.11 opaque 兜底只能临时顶一下，绝不能写入缓存，也不能给 HTML 用。
//     opaque 读不到 body/头：Content-Type 是空的（CSS 没类型浏览器会直接拒用）、
//     内容长度未知。写进缓存等于把"加载失败"固化下来，好内容再也不会被换上。
//     HTML 走 opaque 更是毫无意义（读不到正文、注入不了运行时）。
{
  const HTML = '<!doctype html><html><head><title>站点</title></head><body><main>hi</main></body></html>';
  const mkOpaqueEnv = ({ seeded } = {}) => {
    const store = new Map();
    const puts = [];
    const cache3 = {
      match: async (req) => store.get(String(req.url || req)) || null,
      put: async (req, res) => { store.set(String(req.url || req), res.clone()); puts.push(String(req.url || req)); },
    };
    const net = async (u, opts) => {
      if (String(u).startsWith('https://dead')) throw new Error('net-blocked');
      if (opts?.mode === 'no-cors') return { type: 'opaque', status: 0, ok: false, headers: new Headers(), clone() { return this; } };
      throw new Error('unexpected cors fetch');
    };
    const t = bootSw({
      ...META,
      originTimeoutMs: 200,
      origins: [{ name: 'dead', base: 'https://dead.example', cors: true, ignoreQuery: true }],
      opaqueOrigins: [{ name: 'opq', base: 'https://opq.example', ignoreQuery: true }],
    }, net);
    if (seeded) for (const [k, v] of Object.entries(seeded)) store.set(k, v);
    return { t, puts, cache3 };
  };

  // A 已有好内容 → opaque 不能覆盖
  {
    const { t, puts, cache3 } = await mkOpaqueEnv({
      seeded: { 'http://localhost/index.html': new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) },
    });
    const r = await t.refreshIntoCache(cache3, new Request('http://localhost/index.html'));
    const body = await store_get(cache3, 'http://localhost/index.html');
    check('已有好内容不被 opaque 顶掉（不写缓存，内容原样）', r === null && puts.length === 0 && body === HTML, `返回 ${r?.type}，写缓存 ${puts.length}`);
  }
  // B HTML 没有 opaque 通道可用（存了只会锁死）
  {
    const { t, puts, cache3 } = await mkOpaqueEnv({});
    const r = await t.refreshIntoCache(cache3, new Request('http://localhost/other.html'));
    check('HTML 不走 opaque 通道（存了也没用）', r === null && puts.length === 0, `返回 ${r?.type}，写缓存 ${puts.length}`);
  }
  // C 子资源（css）只有 opaque 能拿到时 → 只能临时顶一下，不入缓存
  {
    const { t, puts, cache3 } = await mkOpaqueEnv({});
    const r = await t.refreshIntoCache(cache3, new Request('http://localhost/ui/colors_and_type.css'));
    check('子资源 opaque 兜底临时可用但绝不入缓存', r?.type === 'opaque' && puts.length === 0, `返回 ${r?.type}，写缓存 ${puts.length}`);
  }
}

// 1.12 缓存键归一：站点链接写的是目录和带版本号的查询串，预缓存存的是
//     index.html 和无查询的路径 —— 以前两者对不上，真机上（SW 自己的 CORS
//     通道到不了任何源时）所有目录导航都 miss、所有 ?v= 子资源都 miss。
for (const [inUrl, wantPath] of [
  ['http://localhost/', '/index.html'],
  ['http://localhost/index.html', '/index.html'],
  ['http://localhost/Cube/', '/Cube/index.html'],
  ['http://localhost/Cube', '/Cube/index.html'],
  ['http://localhost/nav/nav.js?v=11', '/nav/nav.js'],
  ['http://localhost/Cube/Analyzer/', '/Cube/Analyzer/index.html'],
  ['http://localhost/favicon.svg?v=7', '/favicon.svg'],
]) {
  const key = cacheKeyFor(new Request(inUrl));
  check(`缓存键 ${inUrl} → ${wantPath}`, new URL(key.url).pathname === wantPath, new URL(key.url).pathname);
  check(`缓存键 ${inUrl} 不带查询串`, !new URL(key.url).search, new URL(key.url).search);
}
check('canonicalSitePath 保留文件路径', canonicalSitePath('/nav/nav.js') === '/nav/nav.js');
check('canonicalSitePath 去掉查询串', canonicalSitePath('/nav/nav.js?v=11') === '/nav/nav.js');

// 1.13 拿不到站点内容时的导航兜底：回壳启动页（带 .ck-boot，壳运行时会在
//     里面重新走启动/预缓存流程），绝不能给一段没有运行时的死页 ——
//     那才是"退出再进只剩空白页"的根源。子资源请求照旧按网络错误处理。
{
  const SHELL_DOC = '<!doctype html><html><head><title>Ckarefulon</title></head><body><div class="ck-boot"></div></body></html>';
  const net = async (u, opts) => {
    if (String(u).startsWith('https://dead') || String(u).includes('opq.example')) throw new Error('net-blocked');
    return new Response(SHELL_DOC, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  const t = bootSw({
    ...META,
    originTimeoutMs: 200,
    bridgeTimeoutMs: 250,
    origins: [{ name: 'dead', base: 'https://dead.example', cors: true, ignoreQuery: true }],
    opaqueOrigins: [{ name: 'opq', base: 'https://opq.example', ignoreQuery: true }],
  }, net);
  // Node 的 Request 不接受 mode:'navigate'，直接在实例上补一个（影子属性）
  const navReq = new Request('http://localhost/Cube/');
  Object.defineProperty(navReq, 'mode', { value: 'navigate' });
  const navRes = await t.handleSiteRequest(navReq);
  check('导航兜底回壳启动页（可恢复）', !!navRes && navRes.headers.get('content-type')?.includes('text/html'), String(navRes?.headers?.get('content-type')));
  check('兜底文档带 .ck-boot（壳运行时能重新启动）', (await navRes.clone().text()).includes('ck-boot'));
  const subRes = await t.handleSiteRequest(new Request('http://localhost/Cube/missing.js'));
  check('子资源兜底按网络错误处理（不回壳文档）', subRes?.type === 'error', String(subRes?.type));
  const deadNet = async () => { throw new Error('all-dead'); };
  const t2 = bootSw({ ...META, originTimeoutMs: 100, bridgeTimeoutMs: 250 }, deadNet);
  const navReq2 = new Request('http://localhost/Cube/');
  Object.defineProperty(navReq2, 'mode', { value: 'navigate' });
  const fallback = await t2.handleSiteRequest(navReq2);
  check('连壳文档都拿不到时退回离线提示页', !!fallback && (await fallback.clone().text()).includes('当前离线'), String(fallback));
}

// 1.14 页面原生通道桥：HTML miss 时 SW 广播 ck-fetch-native，请页面用原生链代取。
//     国内环境里 SW 自己的 CORS 通道拿不到站点 HTML（jsDelivr 把 .html 全部 301 给
//     被墙的 raw.githubusercontent.com，Gitee/Netlify 没有 ACAO）—— 没有这条桥，
//     点一个还没被后台预缓存到的页面，只能落回启动页再弹回首页（"首页按钮点不动"）。
{
  const PAGE_HTML = '<!doctype html><html><head><title>Cube</title></head><body><div class="dirTitle">Cube</div></body></html>';
  const ORIGINS = [{ name: 'dead', base: 'https://dead.example', cors: true, ignoreQuery: true }];
  const mkNet = () => async () => { throw new Error('net-blocked'); };

  // a) 页面代取成功：注入运行时 + 按归一路径入缓存 + 直接服务
  putKeys.length = 0;
  const sent = [];
  const t = bootSw({
    ...META, originTimeoutMs: 200, bridgeTimeoutMs: 500, origins: ORIGINS, opaqueOrigins: [],
  }, mkNet(), { clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m) => sent.push(m) }] } });
  const navReq = new Request('http://localhost/Cube/?v=11');
  Object.defineProperty(navReq, 'mode', { value: 'navigate' });
  const p = t.handleSiteRequest(navReq);
  await new Promise((r) => setTimeout(r, 80));
  const ask = sent.find((m) => m.type === 'ck-fetch-native');
  check('HTML miss 时向页面广播原生取数请求（路径已归一）', !!ask && ask.pathname === '/Cube/index.html', JSON.stringify(sent));
  t.__listeners.message({ data: { type: 'ck-fetch-native-done', requestId: ask?.requestId, ok: true, body: PAGE_HTML, ct: 'text/html; charset=utf-8' } });
  const res = await p;
  check('桥回的内容已注入运行时标记', (await res.clone().text()).includes('data-ck-runtime'), String(res?.status));
  check('桥回的内容带正确 Content-Type', res.headers.get('content-type')?.includes('text/html'), res.headers.get('content-type'));
  check('桥回的内容已按归一路径入缓存', putKeys.includes('http://localhost/Cube/index.html'), JSON.stringify(putKeys));

  // b) 页面回复失败 → 照旧落回导航兜底（壳文档），不能死等
  const sent2 = [];
  const t2 = bootSw({
    ...META, originTimeoutMs: 200, bridgeTimeoutMs: 400, origins: ORIGINS, opaqueOrigins: [],
  }, mkNet(), { clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m) => sent2.push(m) }] } });
  const navReq2 = new Request('http://localhost/Cube/');
  Object.defineProperty(navReq2, 'mode', { value: 'navigate' });
  const p2 = t2.handleSiteRequest(navReq2);
  await new Promise((r) => setTimeout(r, 80));
  const ask2 = sent2.find((m) => m.type === 'ck-fetch-native');
  t2.__listeners.message({ data: { type: 'ck-fetch-native-done', requestId: ask2?.requestId, ok: false } });
  const res2 = await p2;
  check('页面代取失败时落回导航兜底（不死等）', !!res2 && res2.headers.get('content-type')?.includes('text/html'), String(res2));

  // c) 页面不回复（超时）→ 同样兜底；非 HTML 的 miss 不发桥请求
  const sent3 = [];
  const t3 = bootSw({
    ...META, originTimeoutMs: 200, bridgeTimeoutMs: 250, origins: ORIGINS, opaqueOrigins: [],
  }, mkNet(), { clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m) => sent3.push(m) }] } });
  const navReq3 = new Request('http://localhost/Cube/');
  Object.defineProperty(navReq3, 'mode', { value: 'navigate' });
  const res3 = await t3.handleSiteRequest(navReq3); // 不回复，等桥超时
  check('页面不回复（超时）也落回导航兜底', !!res3 && res3.headers.get('content-type')?.includes('text/html'), String(res3));
  await t3.handleSiteRequest(new Request('http://localhost/Cube/missing.js'));
  check('非 HTML 的 miss 不发桥请求', !sent3.some((m) => m.pathname === '/Cube/missing.js'), JSON.stringify(sent3));
}

// 1.15 不发 .html 的源（jsDelivr 对 .html 一律 301 给被墙的 raw）：HTML 请求
//     必须跳过它直接试下一个源；非 HTML 照旧按顺序走快的源。
//     不跳过的话，每个 HTML 都要白等一整轮超时，点卡片要干等十几秒。
{
  let calls = [];
  const net = async (u) => {
    calls.push(String(u));
    return new Response('ok', { headers: { 'Content-Type': /index\.html/.test(String(u)) ? 'text/html' : 'text/css' } });
  };
  const t = bootSw({
    ...META,
    originTimeoutMs: 200,
    origins: [
      { name: 'j', base: 'https://j.example', cors: true, ignoreQuery: true, html: false },
      { name: 'g', base: 'https://g.example', cors: true, ignoreQuery: true },
    ],
    opaqueOrigins: [],
  }, net);
  await t.fetchRemoteCors('/Cube/index.html', '');
  check('HTML 跳过不发 .html 的源', calls.every((u) => !u.startsWith('https://j.example')), JSON.stringify(calls));
  check('HTML 落到下一个可用源', calls.some((u) => u.startsWith('https://g.example')), JSON.stringify(calls));
  calls = [];
  await t.fetchRemoteCors('/nav/nav.css', '');
  check('非 HTML 照旧先试快的源', calls[0]?.startsWith('https://j.example'), JSON.stringify(calls));
}

/** 从缓存桩里把存进去的响应读回来（put 存的是 clone） */
async function store_get(cache, key) {
  const res = await cache.match(key);
  return res ? res.clone().text() : null;
}

/* ========================= 2) precache.js ========================= */

log.step('utest 2/3：precache 的 vendor 下载链');

// 页面侧两条通道都堵上，只留"原生 HTTP"能通到镜像 —— 复现国内环境
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('fetch-blocked'); };
globalThis.XMLHttpRequest = class { open() {} send() { throw new Error('xhr-blocked'); } };

const { precacheCore } = await import(new URL('../src/net/precache.js', import.meta.url).href);
const CDN = vendorEntry ? vendorEntry.url : 'https://unpkg.com/lucide@1.8.0/dist/umd/lucide.min.js';
const MIRROR = vendorEntry ? vendorEntry.mirror : null;

// 原生通道桩：只有镜像地址能返回内容（Node 里 Capacitor.isNativePlatform() 为 false，
// 走不到这条路，所以这里直接把 download 的失败/成功面收敛到 fetch 桩上）
globalThis.fetch = async (url) => {
  netCalls.push(url);
  if (MIRROR && url === MIRROR) return new Response('/*镜像内容*/', { headers: { 'Content-Type': 'application/javascript' } });
  throw new Error('net-blocked');
};

const posted = [];
const recv = new Set();
const worker = {
  postMessage: (m) => { posted.push(m); setTimeout(() => { for (const l of recv) l({ data: { type: 'ck-cache-put-done', pathname: m.pathname, key: m.key } }); }, 0); },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { serviceWorker: { controller: worker, addEventListener: (t, h) => recv.add(h), removeEventListener: (t, h) => recv.delete(h) } },
});

if (!MIRROR) {
  log.warn('utest：没有带 mirror 的 vendor 条目，跳过 precache 镜像检查');
} else {
  netCalls.length = 0;
  posted.length = 0;
  const r = await precacheCore(
    { origins: [], core: [], vendor: [{ url: CDN, mirror: MIRROR }] },
    { worker, concurrency: 1 },
  );
  check('vendor 经镜像下载成功', r.ok === r.total, `${r.ok}/${r.total} ${JSON.stringify(r.errors)}`);
  check('precache 试过国内镜像', netCalls.includes(MIRROR), netCalls.join(' | '));
  const vput = posted.find((m) => m.key);
  check('precache 入缓存的键是原始 CDN 地址', vput?.key === CDN, JSON.stringify(vput));
  check('precache 入缓存的内容来自镜像', vput?.body === '/*镜像内容*/', String(vput?.body));

  // 老配置（没有 mirror 字段）行为不变：失败要如实报出，不能瞎试别的地址
  netCalls.length = 0;
  const r2 = await precacheCore({ origins: [], core: [], vendor: [{ url: CDN }] }, { worker, concurrency: 1 });
  check('没有 mirror 字段时下载失败被如实报出', r2.ok === 0 && r2.total === 1, `${r2.ok}/${r2.total}`);
  check('没有 mirror 字段时不会去试镜像', !netCalls.includes(MIRROR), netCalls.join(' | '));
}

// 2.3 无 ACAO 头的源只在"受 CORS 约束的环境"里跳过。
//     Node 里没有 CORS，Gitee 这类源必须照试——ptest 就是靠它验证国内下载链的，
//     误跳过会让国内机器上 ptest 直接判定失败、阻断出包。
{
  const giteeMeta = { origins: [{ name: 'Gitee', base: 'https://gitee.example/raw', cors: false }], core: ['/nav/nav.js'], vendor: [] };
  const hit = (u) => ({ body: 'x', ct: 'application/javascript', url: u });

  netCalls.length = 0;
  globalThis.fetch = async (url) => { netCalls.push(url); return new Response('x', { headers: { 'Content-Type': 'application/javascript' } }); };
  const rNode = await precacheCore(giteeMeta, { worker, concurrency: 1 });
  check('Node（无 CORS 约束）会试无 ACAO 的源', netCalls.some((u) => u.startsWith('https://gitee.example/raw')), netCalls.join(' | '));
  check('Node 上该源能下载成功', rNode.ok === 1, `${rNode.ok}/${rNode.total}`);

  netCalls.length = 0;
  globalThis.window = { document: {} }; // 伪装成浏览器页面 → 受 CORS 约束
  const rPage = await precacheCore(giteeMeta, { worker, concurrency: 1 });
  check('浏览器页面里跳过无 ACAO 的源（省两轮必失败的等待）', netCalls.length === 0, netCalls.join(' | '));
  check('跳过之后如实报失败，不假装成功', rPage.ok === 0, `${rPage.ok}/${rPage.total}`);
  delete globalThis.window;
}

globalThis.fetch = origFetch;

/* ===================== 3) 原生传输通道的返回值还原 ===================== */
// CapacitorHttp 的 blob/arraybuffer 通道给的是 base64 字符串、json 给的是已解析对象，
// 直接塞进 Response 就是坏文件（图片变成一段 base64 文本 / JSON 变成 "[object Object]"）。
// 它是真机上的首选传输通道，这条路径错了 = 所有非文本资源缓存全坏。
log.step('utest 3/3：原生通道返回值还原');

const { normalizeNativeBody } = await import(new URL('../src/net/precache.js', import.meta.url).href);

{
  // 真实 PNG 文件头
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const b64 = Buffer.from(pngBytes).toString('base64');

  const blob = normalizeNativeBody(b64, false, 'image/png');
  check('base64 二进制被还原成 Blob', blob instanceof Blob, String(blob?.constructor?.name));
  check('Blob 带上了正确的 MIME', blob?.type === 'image/png', String(blob?.type));
  const back = new Uint8Array(await blob.arrayBuffer());
  check('字节与原始文件一致（不是一段 base64 文本）',
    back.length === pngBytes.length && back.every((b, i) => b === pngBytes[i]),
    `len=${back.length} head=${[...back.slice(0, 4)].join(',')}`);

  check('文本通道原样返回字符串', normalizeNativeBody('<html>ok</html>', true, 'text/html') === '<html>ok</html>');
  check('被解析成对象的 JSON 还原成 JSON 文本',
    normalizeNativeBody({ a: 1 }, true, 'application/json') === '{"a":1}',
    String(normalizeNativeBody({ a: 1 }, true, 'application/json')));
  check('本来就是 Blob 的二进制原样返回',
    (() => { const b = new Blob([pngBytes]); return normalizeNativeBody(b, false, 'image/png') === b; })());
}

/* ============ 4) bootstrap 的 canonicalSitePath 必须与 sw.js 完全一致 ============ */
// 启动快通道绕过 SW 直接读 CacheStorage（二进秒进、不闪"缓存界面"），
// 缓存键归一规则两边各有一份 —— 算得不一样就永远 miss，快通道静默失效。
{
  const bootSrc = fs.readFileSync(path.join(ROOT, 'src', 'update', 'bootstrap.js'), 'utf8');
  const m = bootSrc.match(/function canonicalSitePath\(pathname\) \{[\s\S]*?\n\}/);
  check('bootstrap.js 里有 canonicalSitePath（改 sw.js 的归一规则必须同步它）', !!m);
  if (m) {
    // eslint-disable-next-line no-new-func
    const bootstrapCanonical = new Function(`${m[0]}; return canonicalSitePath;`)();
    const samples = ['/', '', '/Cube/', '/Cube', '/index.html', '/nav/nav.js?v=11', '/a/b/', '/dir/name/x', '/x.HTML'];
    const mismatch = samples.filter((s) => bootstrapCanonical(s) !== canonicalSitePath(s));
    check('bootstrap/sw 两份 canonicalSitePath 结果一致（快通道直读缓存的键位）',
      mismatch.length === 0,
      `不一致：${mismatch.map((s) => `${s}→${bootstrapCanonical(s)}≠${canonicalSitePath(s)}`).join(' | ')}`);
  }
}

/* ============ 5) 蓝牙桥就绪判定：BleClient.isEnabled() 的返回形态 ============ */
// 126 真机回执事故：`@capacitor-community/bluetooth-le` 8.x 的公开 `BleClient`
// 已经把原生层的 `{ value }` 拆成**裸布尔**，polyfill 仍在读 `.value`（恒 undefined
// → 恒 false）→ 蓝牙一直开着也走「蓝牙未开启」→「打开蓝牙」→ 8 秒后抛
// 「蓝牙未就绪」。这里把原生插件换成桩，直接跑 ensureReady()，把这个形态钉死：
// 裸布尔和 `{ value }` 两种都必须认。
{
  const BLE_STUB = `
    const S = globalThis.__BLE__;
    export const ScanMode = { LOW_POWER: 0, BALANCED: 1, LOW_LATENCY: 2 };
    export const BleClient = {
      initialize: (o) => S.initialize(o),
      isEnabled: () => S.isEnabled(),
      isLocationEnabled: () => S.isLocationEnabled(),
      requestEnable: () => S.requestEnable(),
      openAppSettings: () => S.openAppSettings(),
      openLocationSettings: () => S.openLocationSettings(),
      getServices: () => Promise.resolve([]),
      getBondedDevices: () => S.getBondedDevices(),
      requestLEScan: (o, cb) => S.requestLEScan(o, cb),
      stopLEScan: () => S.stopLEScan(),
    };
  `;
  const UI_STUB = `
    const calls = () => (globalThis.__UI_CALLS__ ||= []);
    export const CkUI = {
      confirm: async (o) => { calls().push('confirm:' + (o?.title || '')); return true; },
      toast: (m) => { calls().push('toast:' + m); },
      devicePicker: (opts) => {
        if (!globalThis.__UI_PICKER__) throw new Error('devicePicker 不该在就绪判定里被调用');
        return globalThis.__UI_PICKER__(opts);
      },
    };
  `;

  let n = 0;
  async function loadPolyfill(ble) {
    globalThis.__BLE__ = ble;
    globalThis.__UI_CALLS__ = [];
    const out = await esbuild.build({
      stdin: {
        contents: `import { CkBle } from ${JSON.stringify(path.join(ROOT, 'src/ble/web-bluetooth-polyfill.js'))};\n`
          + `export const ensureReady = CkBle.ensureReady;\n`
          + `export const installWebBluetoothPolyfill = CkBle.installWebBluetoothPolyfill;`,
        resolveDir: ROOT,
        loader: 'js',
      },
      bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent',
      plugins: [{
        name: 'ble-stub',
        setup(b) {
          b.onResolve({ filter: /@capacitor-community\/bluetooth-le/ }, () => ({ path: 'ble', namespace: 'stub' }));
          b.onResolve({ filter: /ck-ui\.js$/ }, () => ({ path: 'ui', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
            contents: a.path === 'ble' ? BLE_STUB : UI_STUB, loader: 'js',
          }));
        },
      }],
    });
    const file = path.join(paths.build, `ble-test-${n++}.mjs`);
    fs.writeFileSync(file, out.outputFiles[0].text);
    return import(`${pathToFileURL(file).href}?v=${n}`);
  }

  /** 造一个原生 BLE 桩；enabled 可为布尔 / {value} / 返回序列（模拟开关过渡期） */
  const makeBle = ({ enabled = true, location = true, bonded = [] } = {}) => {
    const seq = Array.isArray(enabled) ? [...enabled] : null;
    const state = { initialize: 0, isEnabled: 0, requestEnable: 0, lescan: 0, stopLescan: 0 };
    const value = () => (seq ? (seq.length > 1 ? seq.shift() : seq[0]) : enabled);
    return {
      state,
      initialize: async (o) => { state.initialize++; state.neverForLocation = o?.androidNeverForLocation; },
      isEnabled: async () => { state.isEnabled++; return value(); },
      isLocationEnabled: async () => location,
      requestEnable: async () => { state.requestEnable++; },
      openAppSettings: async () => {},
      openLocationSettings: async () => {},
      getBondedDevices: async () => bonded,
      requestLEScan: async () => { state.lescan++; },
      stopLEScan: async () => { state.stopLescan++; },
    };
  };

  // ① 8.x 形态：裸布尔 true —— 126 就是死在这里
  {
    const ble = makeBle({ enabled: true });
    const mod = await loadPolyfill(ble);
    let err = null;
    await mod.ensureReady().catch((e) => { err = e; });
    check('ensureReady：isEnabled 返回裸布尔 true → 直接就绪，不弹任何框',
      !err && ble.state.initialize === 1 && globalThis.__UI_CALLS__.length === 0,
      err ? `抛错：${err.message}` : `弹框：${globalThis.__UI_CALLS__.join(' | ')}`);
    check('ensureReady：initialize 传 androidNeverForLocation=true（与 manifest 三处一致）',
      ble.state.neverForLocation === true);
  }

  // ② 旧形态：{ value: true } —— 兼容回退，不能因为修 ① 就把它弄坏
  {
    const ble = makeBle({ enabled: { value: true }, location: { value: true } });
    const mod = await loadPolyfill(ble);
    let err = null;
    await mod.ensureReady().catch((e) => { err = e; });
    check('ensureReady：isEnabled 返回 {value:true}（旧形态）仍然就绪',
      !err && globalThis.__UI_CALLS__.length === 0,
      err ? `抛错：${err.message}` : `弹框：${globalThis.__UI_CALLS__.join(' | ')}`);
  }

  // ③ 开关「正在打开」过渡期：前两次读到 false，之后 true → 轮询等到就绪，不该弹框
  {
    const ble = makeBle({ enabled: [false, false, true] });
    const mod = await loadPolyfill(ble);
    let err = null;
    await mod.ensureReady().catch((e) => { err = e; });
    check('ensureReady：开关过渡期（先 false 后 true）→ 轮询等待，不误报未开启',
      !err && ble.state.isEnabled >= 3 && globalThis.__UI_CALLS__.length === 0,
      err ? `抛错：${err.message}` : `弹框：${globalThis.__UI_CALLS__.join(' | ')}`);
  }

  // ④ 蓝牙确实没开：弹「打开蓝牙」→ 仍读不到 → 抛中文「蓝牙未就绪」
  //    用假时钟把两个轮询窗口瞬间走完（否则这一步要真等 9.5 秒）
  {
    const ble = makeBle({ enabled: false });
    const mod = await loadPolyfill(ble);
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    let clock = 0;
    Date.now = () => clock;
    globalThis.setTimeout = (fn, ms) => { clock += ms || 0; queueMicrotask(fn); return 0; };
    let err = null;
    try {
      await mod.ensureReady().catch((e) => { err = e; });
    } finally {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
    }
    const calls = globalThis.__UI_CALLS__.join(' | ');
    check('ensureReady：蓝牙真没开 → 弹「蓝牙未开启」→ requestEnable → 抛「蓝牙未就绪」',
      !!err && /蓝牙未就绪/.test(err.message) && ble.state.requestEnable === 1 &&
        /confirm:蓝牙未开启/.test(calls),
      err ? `弹框：${calls} / 抛错：${err.message}` : `没抛错，弹框：${calls}`);
  }

  // ⑤ getAvailability 只表达「适配器是否存在」：开关关着（isEnabled=false）也要 true，
  //    否则站点的 chkAvail() 直接报「当前浏览器不可用 Web Bluetooth」
  {
    const ble = makeBle({ enabled: false });
    const mod = await loadPolyfill(ble);
    mod.installWebBluetoothPolyfill();
    check('getAvailability：蓝牙开关关着也返回 true（适配器存在 ≠ 不可用）',
      (await navigator.bluetooth.getAvailability()) === true);
    check('installWebBluetoothPolyfill：navigator.bluetooth 已挂上 __ckPolyfill 标记',
      navigator.bluetooth.__ckPolyfill === true);
  }

  /* ---- 6) 设备选择器的「已配对设备」兜底 ---- */
  // 又是同一个坑：原生插件层 `BluetoothLe.getBondedDevices()` 返回 `{ devices }`，
  // 公开的 `BleClient` 包装层已经把 `.devices` 拆掉、直接给裸数组。旧代码写的是
  // `const { devices } = await BleClient.getBondedDevices()` → 恒 undefined →
  // 这段兜底从上线起就没生效过；它又被 catch 吞掉，所以只表现为「搜不到设备」。
  /** 选择器桩：记录 push 进来的条目，用户「点了列表里的第一条」 */
  const makePicker = (pushed) => ({
    push: (d) => { pushed.push(d); },
    setScanning: () => {},
    setNotice: () => {},
    cancel: () => {},
    get result() { return Promise.resolve(pushed.find((p) => p.bonded) || pushed[0]); },
  });

  /** 走真实入口：装 polyfill → navigator.bluetooth.requestDevice()。
   *  异常也捕获成返回值 —— 回归时给一条干净的 ✗，而不是让整个 utest 崩掉。 */
  const run = async (bonded) => {
    const pushed = [];
    globalThis.__UI_PICKER__ = () => makePicker(pushed);
    const ble = makeBle({ enabled: true, bonded });
    let device = null;
    let err = null;
    try {
      const mod = await loadPolyfill(ble);
      mod.installWebBluetoothPolyfill();
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'GAN' }],
        optionalServices: ['0000fff0-0000-1000-8000-00805f9b34fb'],
      });
    } catch (e) {
      err = e;
    } finally {
      globalThis.__UI_PICKER__ = null;
    }
    return { pushed, device, ble, err };
  };

  // ① 8.x 形态：裸数组 —— 旧代码正是死在这里
  {
    const { pushed, device, ble, err } = await run([{ deviceId: 'AA:BB:CC:DD:EE:FF', name: 'GAN 356 i3' }]);
    check('选择器：已配对设备（裸数组形态）会出现在候选列表里',
      pushed.some((p) => p.deviceId === 'AA:BB:CC:DD:EE:FF' && p.bonded === true),
      err ? `抛错：${err.message}` : `pushed=${JSON.stringify(pushed)}`);
    check('选择器：选中已配对设备后能正常返回 device（后面 connect 才有戏）',
      device?.deviceId === 'AA:BB:CC:DD:EE:FF', err ? `抛错：${err.message}` : String(device?.deviceId));
    check('选择器：广播侧也在扫（兜底不该顶掉正常扫描）', ble.state.lescan === 1);
  }

  // ② 旧形态 { devices: [...] } 也必须认（同 readFlag 的策略：两种都吃）
  {
    const { pushed, err } = await run({ devices: [{ deviceId: '11:22:33:44:55:66', name: 'GAN 12' }] });
    check('选择器：已配对设备（{devices} 旧形态）仍然认',
      pushed.some((p) => p.deviceId === '11:22:33:44:55:66'),
      err ? `抛错：${err.message}` : `pushed=${JSON.stringify(pushed)}`);
  }

  // ③ 过滤器必须仍然生效：不匹配 namePrefix 的已配对设备不能混进来
  {
    const { pushed, err } = await run([
      { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'GAN 356 i3' },
      { deviceId: 'DE:AD:BE:EF:00:01', name: '小米手环' },
    ]);
    check('选择器：不匹配 namePrefix 的已配对设备被过滤掉',
      pushed.length === 1 && pushed[0].deviceId === 'AA:BB:CC:DD:EE:FF',
      err ? `抛错：${err.message}` : `pushed=${JSON.stringify(pushed)}`);
  }

  // ④ 没有任何已配对设备时不能炸（部分机型 getBondedDevices 直接抛）
  {
    const pushed = [];
    globalThis.__UI_PICKER__ = () => makePicker(pushed);
    try {
      const ble = makeBle({ enabled: true });
      ble.getBondedDevices = async () => { throw new Error('not supported'); };
      const mod = await loadPolyfill(ble);
      mod.installWebBluetoothPolyfill();
      let err = null;
      await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'GAN' }],
        optionalServices: [],
      }).catch((e) => { err = e; });
      check('选择器：getBondedDevices 抛错时静默忽略（用户点了取消/无设备）',
        pushed.length === 0, `err=${err?.message} pushed=${JSON.stringify(pushed)}`);
    } finally {
      globalThis.__UI_PICKER__ = null;
    }
  }
}

/* ============ 7) 跨域 fetch 的原生兜底通道 ============ */
// 真机回执：同一个域名，手机浏览器能开、App 里的网页报「主机不可达」。
// 兜底一旦写错，会污染**所有**跨域请求（正常的也被换条通道重打一遍、或把
// 响应体解坏），所以「什么时候兜、什么时候不兜、兜回来怎么还原」逐条钉死。
{
  const CORE_STUB = `
    export const Capacitor = {
      isNativePlatform: () => globalThis.__NATIVE__.native !== false,
      getPlatform: () => 'android',
    };
    export const CapacitorHttp = {
      request: (o) => globalThis.__NATIVE__.request(o),
      get: (o) => globalThis.__NATIVE__.request(Object.assign({}, o, { method: 'GET' })),
    };
  `;

  let n = 0;
  async function loadFallback() {
    const out = await esbuild.build({
      stdin: {
        contents: `export { installFetchFallback, decodeNativeBody, netDiag, clearNetDiag, blockedHosts } from `
          + `${JSON.stringify(path.join(ROOT, 'src/net/fetch-fallback.js'))};`,
        resolveDir: ROOT,
        loader: 'js',
      },
      bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent',
      plugins: [{
        name: 'core-stub',
        setup(b) {
          b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: 'core', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: CORE_STUB, loader: 'js' }));
        },
      }],
    });
    const file = path.join(paths.build, `netfallback-test-${n++}.mjs`);
    fs.writeFileSync(file, out.outputFiles[0].text);
    return import(`${pathToFileURL(file).href}?v=${n}`);
  }

  const realFetch = globalThis.fetch;
  const makeLs = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
    };
  };
  const setOnline = (v) => {
    try { Object.defineProperty(globalThis, 'navigator', { value: { onLine: v }, configurable: true, writable: true }); }
    catch (e) { try { globalThis.navigator.onLine = v; } catch (e2) { /* noop */ } }
  };
  /** 网页通道桩：记录调用，再交给用例给的行为 */
  const webFetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    globalThis.__WEB__.calls.push(url);
    return globalThis.__WEB__.impl(url, init);
  };
  /** 原生桩：2xx + 非 JSON 时给 base64（与 CapacitorHttp 的真实行为一致） */
  const okNative = (body = 'native-body', ct = 'text/plain') => ({
    status: 200, headers: { 'content-type': ct }, data: Buffer.from(body).toString('base64'), url: '',
  });

  function resetGlobals(web, native) {
    globalThis.__WEB__ = { calls: [], impl: web };
    globalThis.__NATIVE__ = {
      calls: [], last: null, native: true,
      request: (o) => { globalThis.__NATIVE__.calls.push(o.url); globalThis.__NATIVE__.last = o; return native(o); },
    };
    globalThis.__TOASTS__ = [];
    globalThis.window = globalThis;
    globalThis.location = { href: 'http://localhost/', origin: 'http://localhost' };
    globalThis.localStorage = makeLs();
    globalThis.CkApp = { ui: { toast: (m) => { globalThis.__TOASTS__.push(m); } } };
    setOnline(true);
    globalThis.fetch = webFetch;
  }

  // ① 网页通道通：原样返回，绝不能多打一次原生
  {
    resetGlobals(async () => new Response('web-ok', { status: 200 }), async () => { throw new Error('不该调用原生'); });
    const mod = await loadFallback();
    check('兜底：在原生壳里装上', mod.installFetchFallback() === true);
    const r = await globalThis.fetch('https://api.example.com/x');
    check('兜底：网页通道通时原样返回', (await r.text()) === 'web-ok');
    check('兜底：网页通道通时不打第二枪', globalThis.__NATIVE__.calls.length === 0, JSON.stringify(globalThis.__NATIVE__.calls));
    check('兜底：成功路径不写诊断记录', mod.netDiag().length === 0, JSON.stringify(mod.netDiag()));
  }

  // ② 网页通道抛错 + 原生通：救回来
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => okNative('救回来了'));
    const mod = await loadFallback();
    mod.installFetchFallback();
    const r = await globalThis.fetch('https://api.example.com/x', { mode: 'no-cors' });
    check('兜底：网页通道抛错时改走系统通道并拿回内容', (await r.text()) === '救回来了');
    check('兜底：诊断里标了「已救回」', mod.netDiag()[0]?.healed === true, JSON.stringify(mod.netDiag()[0]));
    check('兜底：救回来时不弹提示（用户无感）', globalThis.__TOASTS__.length === 0, JSON.stringify(globalThis.__TOASTS__));
  }

  // ③ 两条都不通：抛**原来的**错 + 点名主机
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => { throw new Error('native also dead'); });
    const mod = await loadFallback();
    mod.installFetchFallback();
    let err = null;
    await globalThis.fetch('https://sekbhrzxblaxvgspyjxa.supabase.co/?speed_ping=1', { mode: 'no-cors' }).catch((e) => { err = e; });
    check('兜底：两条都不通时抛出原来的错（调用方语义不变）', err?.message === 'Failed to fetch', String(err && err.message));
    const d = mod.netDiag()[0] || {};
    check('兜底：两条通道各自的结果都记进诊断', d.healed === false && /^fail:/.test(d.native || ''), JSON.stringify(d));
    check('兜底：两条都不通时点名主机（产品侧才说得清是哪台到不了）',
      globalThis.__TOASTS__.some((m) => m.includes('sekbhrzxblaxvgspyjxa.supabase.co')), JSON.stringify(globalThis.__TOASTS__));
  }

  // ④ 有响应（含 4xx/5xx）就不是「通道不通」，一律原样返回
  {
    resetGlobals(async () => new Response('boom', { status: 500 }), async () => { throw new Error('不该调用原生'); });
    const mod = await loadFallback();
    mod.installFetchFallback();
    const r = await globalThis.fetch('https://api.example.com/x');
    check('兜底：500 是「有响应」，原样返回、不打第二枪',
      r.status === 500 && globalThis.__NATIVE__.calls.length === 0, `status=${r.status}`);
  }

  // ⑤ 不该兜底的三种：离线 / 主动取消 / 同源
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => okNative());
    setOnline(false);
    const mod = await loadFallback();
    mod.installFetchFallback();
    await globalThis.fetch('https://api.example.com/x').catch(() => {});
    check('兜底：离线时不打第二枪（否则每次失败都要多等一轮超时）',
      globalThis.__NATIVE__.calls.length === 0 && mod.netDiag().length === 0, JSON.stringify(globalThis.__NATIVE__.calls));
  }
  {
    resetGlobals(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, async () => okNative());
    const mod = await loadFallback();
    mod.installFetchFallback();
    await globalThis.fetch('https://api.example.com/x').catch(() => {});
    check('兜底：主动取消（AbortError）不兜底', globalThis.__NATIVE__.calls.length === 0, JSON.stringify(globalThis.__NATIVE__.calls));
  }
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => okNative());
    const mod = await loadFallback();
    mod.installFetchFallback();
    await globalThis.fetch('http://localhost/nav/nav.js').catch(() => {});
    check('兜底：同源不兜底（同源失败归离线服务的多源链管）',
      globalThis.__NATIVE__.calls.length === 0, JSON.stringify(globalThis.__NATIVE__.calls));
  }

  // ⑥ 原生返回值 → Response 的还原（历史事故点，三种形态都要对）
  {
    const mod = await loadFallback();
    const bin = mod.decodeNativeBody(Buffer.from('二进制').toString('base64'), 'image/png', true);
    check('还原：2xx 非 JSON → base64 解回真字节', bin.body instanceof Blob, typeof bin.body);
    check('还原：解出来的内容和原文一致',
      Buffer.from(await bin.body.arrayBuffer()).toString('utf8') === '二进制');
    const js = mod.decodeNativeBody({ a: 1 }, 'application/json', true);
    check('还原：JSON 被原生解析成对象时重新序列化（否则是 [object Object]）',
      typeof js.body === 'string' && JSON.parse(js.body).a === 1, String(js.body));
    const bad = mod.decodeNativeBody('<html>502</html>', 'text/html', false);
    check('还原：非 2xx 时原生给的是原文，不能再当 base64 解', bad.body === '<html>502</html>', String(bad.body));
  }

  // ⑦ 请求体重放：能重放的带过去，不能重放的（FormData / 流）直接放弃兜底
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); },
      async () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true }, url: '' }));
    const mod = await loadFallback();
    mod.installFetchFallback();
    const r = await globalThis.fetch('https://api.example.com/rest/v1/x', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    });
    check('兜底：POST 的请求体原样重放', globalThis.__NATIVE__.last?.data === '{"a":1}', String(globalThis.__NATIVE__.last?.data));
    check('兜底：方法与请求头一并带过去',
      globalThis.__NATIVE__.last?.method === 'POST' && globalThis.__NATIVE__.last?.headers?.['content-type'] === 'application/json',
      JSON.stringify(globalThis.__NATIVE__.last?.headers));
    check('兜底：JSON 响应合成后仍能 .json()', (await r.json()).ok === true);
  }
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => okNative());
    const mod = await loadFallback();
    mod.installFetchFallback();
    await globalThis.fetch('https://api.example.com/upload', { method: 'POST', body: new FormData() }).catch(() => {});
    check('兜底：不可重放的请求体（FormData）直接放弃兜底',
      globalThis.__NATIVE__.calls.length === 0, JSON.stringify(globalThis.__NATIVE__.calls));
  }

  // ⑧ 失败冷却：这个域名就是到不了时，不能每次请求都再等一轮原生超时
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => { throw new Error('native dead'); });
    const mod = await loadFallback();
    mod.installFetchFallback();
    await globalThis.fetch('https://blocked.example.com/a').catch(() => {});
    const afterFirst = globalThis.__NATIVE__.calls.length;
    await globalThis.fetch('https://blocked.example.com/b').catch(() => {});
    check('冷却：同一主机两条都不通后，后续请求不再等第二轮超时',
      afterFirst === 1 && globalThis.__NATIVE__.calls.length === 1,
      `第一次后=${afterFirst} 两次共=${globalThis.__NATIVE__.calls.length}`);
    check('冷却：被冷却的主机进了名单', !!mod.blockedHosts()['blocked.example.com'], JSON.stringify(mod.blockedHosts()));
    check('冷却：不再重复记诊断（第二次在冷却处就拦下了）', mod.netDiag().length === 1, String(mod.netDiag().length));

    await globalThis.fetch('https://other.example.com/a').catch(() => {});
    check('冷却：只影响那台主机，别的主机照常兜底',
      globalThis.__NATIVE__.calls.length === 2, JSON.stringify(globalThis.__NATIVE__.calls));
  }

  // ⑨ 冷却会过期：网络恢复后不能被永久放弃
  {
    resetGlobals(async () => { throw new TypeError('Failed to fetch'); }, async () => { throw new Error('native dead'); });
    const mod = await loadFallback();
    mod.installFetchFallback();
    await globalThis.fetch('https://cooldown.example.com/a').catch(() => {});
    const m = JSON.parse(globalThis.localStorage.getItem('ck.net.blocked'));
    m['cooldown.example.com'] = Date.now() - 1;
    globalThis.localStorage.setItem('ck.net.blocked', JSON.stringify(m));
    await globalThis.fetch('https://cooldown.example.com/a').catch(() => {});
    check('冷却：到期后重新尝试（不会被永久放弃）',
      globalThis.__NATIVE__.calls.length === 2, JSON.stringify(globalThis.__NATIVE__.calls));
  }

  globalThis.fetch = realFetch;
}

log.info(`utest：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
