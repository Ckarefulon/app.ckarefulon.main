/**
 * 跨域 fetch 的原生兜底通道
 * ---------------------------------------------------------------------------
 * 背景（真机回执）：同一个域名，手机浏览器能打开，App 里的网页却报「主机不可达」。
 * 这条链路应用没有拦：离线服务只处理自己的页面和几个 CDN 依赖，页面没有内容安全
 * 策略，也没有任何地方改写 fetch —— 失败发生在 **WebView 自己的网络栈** 里。
 *
 * WebView 的网络栈和系统（原生 HTTP）不是同一套：域名解析、协议协商（HTTP/3）、
 * TLS 指纹、User-Agent 都可能不同。任何一环在特定网络下出问题，就会表现为
 * 「浏览器能开、App 打不开」或者「网页通道不通、原生通道却是通的」。
 *
 * 所以这里只做一件事：**跨域请求在网页通道抛错时，用系统通道重试一次**。
 *   · 原生通了 → 静默返回原生结果，坏掉的页面被救回来（用户无感）
 *   · 两条都不通 → 如实抛错，并把主机名记下来，产品侧可以明确告诉用户
 *     「是这台设备到不了这个域名」，而不是含糊的「失败」
 *
 * ⚠️ 只处理「网页通道抛错」这一种情况：
 *   · 有响应（含 4xx/5xx）一律原样返回，绝不改语义
 *   · 离线（navigator.onLine === false）、主动取消（AbortError）、
 *     请求体不可重放（FormData / 流 / 二进制）一律不兜底，直接把原错抛出去
 * 宁可少救几个，也不要把「正常失败」变成「换个姿势再失败一次」。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

const DIAG_KEY = 'ck.net.diag';
const DIAG_MAX = 20;
/** 这几类方法没有请求体，重放最安全 */
const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** 这些响应头不能带进合成响应：长度/编码对不上，或本来就不该由脚本设 */
const DROP_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'set-cookie2',
]);
/** 一次会话里最多弹几条「连不上」的提示，避免刷屏 */
const TOAST_LIMIT = 3;
/** 某个主机两条通道都不通之后的冷却时长：这期间不再为它重打原生 */
const BLOCK_KEY = 'ck.net.blocked';
const BLOCK_MS = 10 * 60 * 1000;

let origFetch = null;
let installed = false;
const toasted = new Set();

const short = (e, n = 60) => String((e && e.message) || e).slice(0, n);

/* ------------------------------ 失败主机冷却 ------------------------------ */

/**
 * 两条通道都不通的主机要记下来别再试。否则在「这个域名就是到不了」的网络里，
 * 每一次跨域请求都要先等网页通道失败、**再等一轮原生超时**才报错 ——
 * 云端同步这类会重试的代码就会一次比一次卡（用户感知是「整个功能卡死」）。
 * 冷却只针对「两条都不通」的主机；网页通道单独失败（原生能救）永远照兜。
 * 网络恢复（online 事件）或冷却到期后自动重新尝试。
 */
function loadBlocked() {
  try { return JSON.parse(localStorage.getItem(BLOCK_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function saveBlocked(map) {
  try {
    const now = Date.now();
    const live = {};
    for (const [h, until] of Object.entries(map)) if (until > now) live[h] = until;
    localStorage.setItem(BLOCK_KEY, JSON.stringify(live));
  } catch (e) { /* noop */ }
}
function isBlocked(host) {
  const until = loadBlocked()[host];
  return !!until && until > Date.now();
}
function markBlocked(host) {
  const map = loadBlocked();
  if (!map[host]) {
    map[host] = Date.now() + BLOCK_MS;
    saveBlocked(map);
  }
}
function clearBlocked() {
  try { localStorage.removeItem(BLOCK_KEY); } catch (e) { /* noop */ }
}
/** 当前被判「在这个网络下到不了」的主机（排查用：`CkApp.net.blocked()`） */
export function blockedHosts() {
  const now = Date.now();
  const out = {};
  for (const [h, until] of Object.entries(loadBlocked())) if (until > now) out[h] = until - now;
  return out;
}

/* ------------------------------ 诊断记录 ------------------------------ */

function record(entry) {
  try {
    const list = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]');
    list.unshift(entry);
    localStorage.setItem(DIAG_KEY, JSON.stringify(list.slice(0, DIAG_MAX)));
  } catch (e) { /* 隐私模式 / 配额满：诊断不该影响主流程 */ }
}

/** 读最近若干条跨域失败记录（排查用：`CkApp.net.diag()`） */
export function netDiag() {
  try { return JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch (e) { return []; }
}
export function clearNetDiag() {
  try { localStorage.removeItem(DIAG_KEY); } catch (e) { /* noop */ }
}

/* ------------------------------ 原生结果 → Response ------------------------------ */

function base64ToBlob(b64, ct) {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: ct || 'application/octet-stream' });
}

/**
 * 把 CapacitorHttp 的返回值还原成能塞进 Response 的东西。
 * ⚠️ 这套行为很反直觉（历史事故点），原生与 web 实现一致：
 *   · responseType 请求 'blob' 时，**任何 2xx 响应**都返回 base64 字符串
 *   · 但只要响应头是 application/json，就无条件改返回**已解析的对象**
 *   · 请求失败（非 2xx）时 responseType 被忽略，返回的是**原始文本**，不是 base64
 * 所以必须同时看 `ok` 和 Content-Type，只看其中一个都会把内容搞坏：
 * 把文本当 base64 解 → 空 Blob；把对象直接塞 Response → 字面量 "[object Object]"。
 */
export function decodeNativeBody(data, ct, ok) {
  const isJson = /application\/json/i.test(ct || '');
  if (typeof data !== 'string') {
    // 原生已经把 JSON 解析成对象了
    return { body: JSON.stringify(data), ct: ct || 'application/json' };
  }
  if (ok && !isJson) return { body: base64ToBlob(data, ct), ct: ct || 'application/octet-stream' };
  return { body: data, ct: ct || 'text/plain' };
}

function buildResponse(native) {
  const raw = native.headers || {};
  const headers = new Headers();
  let ct = '';
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).toLowerCase();
    if (DROP_HEADERS.has(key)) continue;
    if (key === 'content-type') ct = String(v);
    if (v == null) continue;
    try { headers.set(key, String(v)); } catch (e) { /* 非法头名直接丢 */ }
  }
  const status = Number(native.status) || 200;
  const ok = status >= 200 && status < 300;
  const { body, ct: finalCt } = decodeNativeBody(native.data, ct, ok);
  if (finalCt && !headers.has('content-type')) headers.set('content-type', finalCt);
  // 这几个状态码按规范不允许带响应体
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : body, { status, statusText: '', headers });
}

/* ------------------------------ 请求重放信息 ------------------------------ */

const TEXTUAL = /json|text\/|javascript|xml|x-www-form-urlencoded/i;

/**
 * 抽出「重试时需要的东西」。拿不到就返回 null（= 不兜底）。
 * ⚠️ Request 带 body 时必须**在原始 fetch 之前** clone：fetch 一消费，
 * 请求体就作废了，回头再 clone 只会抛错。
 */
function planReplay(input, init) {
  let url = '';
  let method = 'GET';
  let headers = null;
  let data;          // 字符串请求体（只有可重放的才留）
  let bodyKind = 'none';
  let clone = null;

  const fromInit = init || {};

  if (typeof Request !== 'undefined' && input instanceof Request) {
    url = input.url;
    method = (fromInit.method || input.method || 'GET').toUpperCase();
    headers = new Headers(fromInit.headers || input.headers);
    if (!BODYLESS.has(method)) {
      const ct = headers.get('content-type') || '';
      // 只重放文本类请求体；FormData / 流 / 二进制重放风险太大，直接放弃兜底
      if (TEXTUAL.test(ct)) {
        try { clone = input.clone(); } catch (e) { return null; }
        bodyKind = 'request';
      } else {
        return null;
      }
    }
  } else {
    url = String(input && input.url ? input.url : input || '');
    method = (fromInit.method || 'GET').toUpperCase();
    headers = new Headers(fromInit.headers || {});
    const b = fromInit.body;
    if (b == null || BODYLESS.has(method)) {
      bodyKind = 'none';
    } else if (typeof b === 'string') {
      data = b;
      bodyKind = 'string';
    } else if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) {
      data = b.toString();
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
      bodyKind = 'string';
    } else {
      return null; // Blob / ArrayBuffer / FormData / 流：不重放
    }
  }

  let scheme = '';
  try { scheme = new URL(url, location.href).protocol; } catch (e) { return null; }
  if (scheme !== 'http:' && scheme !== 'https:') return null;

  let sameOrigin = true;
  try { sameOrigin = new URL(url, location.href).origin === location.origin; } catch (e) { /* 保持 true */ }

  return { url, method, headers, data, bodyKind, clone, sameOrigin };
}

async function nativeRequest(plan, { connectTimeout = 8000, readTimeout = 20000 } = {}) {
  let data = plan.data;
  if (plan.bodyKind === 'request' && plan.clone) data = await plan.clone.text();
  const headers = {};
  for (const [k, v] of plan.headers.entries()) headers[k] = v;
  return CapacitorHttp.request({
    url: plan.url,
    method: plan.method,
    headers,
    data,
    // 一律要 base64 通道：文本 / 二进制都能准确还原，见 decodeNativeBody 的说明
    responseType: 'blob',
    connectTimeout,
    readTimeout,
    shouldEncodeUrlParams: false,
  });
}

/* ------------------------------ 对外：单次探测 ------------------------------ */

function hostOf(url) {
  try { return new URL(url, location.href).host; } catch (e) { return String(url).slice(0, 60); }
}

/** 两条通道都不通时给用户一句**能照做**的话，而不是干巴巴的「失败」 */
function notifyUnreachable(host) {
  if (toasted.size >= TOAST_LIMIT || toasted.has(host)) return;
  toasted.add(host);
  try {
    const ui = window.CkApp && window.CkApp.ui;
    if (ui && ui.toast) ui.toast(`连不上 ${host}（两种连接方式都试过了）。若开着代理或加速器，把本应用也加进它的应用列表再试`);
  } catch (e) { /* UI 没起来就算了 */ }
}

/**
 * 逐条探测「网页通道 / 系统通道」哪条通。
 * 给产品侧做网络自检用（`await CkApp.net.probe(['https://x/'])`）。
 * @returns {Promise<Array<{url:string, web:string, native:string}>>}
 */
export async function probeHosts(urls) {
  const out = [];
  const webChannel = origFetch || (typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null);
  for (const url of urls) {
    const row = { url, web: '', native: '' };
    try {
      if (!webChannel) throw new Error('no-fetch');
      const r = await webChannel(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
      // no-cors 拿到的是 opaque 响应，status 恒 0；能返回就说明这条通道通了
      row.web = `ok:${r.status || 0}`;
    } catch (e) { row.web = `fail:${e && e.name ? e.name : short(e)}`; }
    try {
      const r = await CapacitorHttp.get({
        url, responseType: 'text', connectTimeout: 8000, readTimeout: 12000, shouldEncodeUrlParams: false,
      });
      row.native = `ok:${r.status}`;
    } catch (e) { row.native = `fail:${short(e)}`; }
    out.push(row);
  }
  return out;
}

/* ------------------------------ 安装 ------------------------------ */

/**
 * 装上兜底通道。只在原生壳里生效；浏览器里什么都不做（浏览器没有这套双通道问题，
 * 也不该让 E2E / 本地预览的行为和应用不一致）。
 */
export function installFetchFallback() {
  if (installed) return false;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false;
  if (!Capacitor.isNativePlatform()) return false;
  installed = true;

  // 网络恢复（切 Wi-Fi / 开关飞行模式）就把冷却清掉，重新给每条通道机会
  try { window.addEventListener('online', clearBlocked); } catch (e) { /* noop */ }

  origFetch = window.fetch.bind(window);
  window.fetch = function ckFetch(input, init) {
    let plan = null;
    try { plan = planReplay(input, init); } catch (e) { plan = null; }

    const p = origFetch(input, init);
    // 同源请求不兜底：它的失败由离线服务（多源链 + 原生桥）负责，
    // 用原生 HTTP 去打 http://localhost/ 只会打到真正的本机端口，反而更糟
    if (!plan || plan.sameOrigin) return p;

    return p.catch(async (err) => {
      // 只兜「网络层真的没通」：主动取消 / 离线 / 页面卸载，都不该再打一次
      const name = err && err.name;
      if (name === 'AbortError') throw err;
      const signal = (init && init.signal) || (input && input.signal);
      if (signal && signal.aborted) throw err;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw err;

      const host = hostOf(plan.url);
      // 这个主机刚被判过「两条都不通」：别再等一轮原生超时，直接如实报错
      if (isBlocked(host)) throw err;

      let native = null;
      let nativeErr = null;
      try {
        native = await nativeRequest(plan);
      } catch (e) {
        nativeErr = e;
      }
      record({
        at: Date.now(),
        url: plan.url,
        method: plan.method,
        web: short(err),
        native: native ? `ok:${native.status}` : `fail:${short(nativeErr)}`,
        healed: !!native,
      });

      if (native) {
        console.warn(`[ck-net] 网页通道失败，已切系统通道：${plan.method} ${plan.url}（${short(err)}）`);
        return buildResponse(native);
      }
      console.warn(`[ck-net] 两条通道都不通：${plan.method} ${plan.url}（网页：${short(err)} / 系统：${short(nativeErr)}）`);
      markBlocked(host);
      notifyUnreachable(host);
      throw err;
    });
  };
  return true;
}

export default installFetchFallback;
