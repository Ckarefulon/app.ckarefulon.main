/**
 * 首屏预缓存 / 核心刷新：多传输链下载 → 交给 SW 入缓存（并等待确认）
 *   传输链：原生 CapacitorHttp → 页面 fetch(cors) → 页面 XHR(cors)
 *   源链  ：swMeta.origins（jsDelivr → Netlify）
 * 任何组合成功即算成功；全部失败时带回逐条错误，供启动页显示定位。
 */
import { CapacitorHttp, Capacitor } from '@capacitor/core';

const MIME_BY_EXT = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8', mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};
export function mimeFor(pathname) {
  const ext = (String(pathname).split('.').pop() || '').toLowerCase().split('?')[0];
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
export function wantsText(pathname) {
  return /\.(html?|js|mjs|cjs|css|json|svg|txt|md|webmanifest|xml)(\?|$)/i.test(pathname);
}
const msg = (e) => String(e?.message || e).slice(0, 40);
/** 源给的类型能不能直接用（text/plain / octet-stream / 空都要按路径重推） */
const usableCt = (ct) => !!ct && !/octet-stream|text\/plain/i.test(ct);

function xhrGet(url, wantText, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs;
      xhr.responseType = wantText ? 'text' : 'blob';
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response != null) resolve(xhr.response);
        else reject(new Error(`xhr:${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('xhr:error'));
      xhr.ontimeout = () => reject(new Error('xhr:timeout'));
      xhr.send();
    } catch (e) { reject(e); }
  });
}

/** base64 → Blob（CapacitorHttp 的二进制通道返回的就是 base64） */
function base64ToBlob(b64, contentType) {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: contentType || 'application/octet-stream' });
}

/**
 * CapacitorHttp 的返回值不能直接当响应体用（原生与 web 实现都是这套行为）：
 *   · responseType=blob/arraybuffer 返回的是 **base64 字符串**，直接塞进
 *     Response 会把图片/字体原样存成一段 base64 文本 —— 缓存里的文件是坏的，
 *     而且它是首选传输通道，真机上必然走到
 *   · 响应头是 application/json 时它一律返回**已解析的对象**，
 *     直接塞进 Response 会变成 "[object Object]"
 * 这里按"我们要的是不是文本"把返回值还原成真正的字节 / 文本。
 */
export function normalizeNativeBody(data, wantText, ct) {
  if (wantText) return typeof data === 'string' ? data : JSON.stringify(data);
  if (typeof data !== 'string') return data; // 已经是 Blob/ArrayBuffer
  return base64ToBlob(data, ct);
}

async function download(url, wantText) {
  const tries = [];
  if (Capacitor.isNativePlatform()) {
    try {
      const r = await CapacitorHttp.get({
        url,
        responseType: wantText ? 'text' : 'blob',
        connectTimeout: 5000,
        readTimeout: 10000,
        shouldEncodeUrlParams: false,
      });
      if (r.status >= 200 && r.status < 300 && r.data != null) {
        const h = r.headers || {};
        const ct = h['Content-Type'] || h['content-type'] || '';
        return { body: normalizeNativeBody(r.data, wantText, ct), ct };
      }
      tries.push(`native:${r.status}`);
    } catch (e) { tries.push(`native:${msg(e)}`); }
  }
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (r.ok) return { body: wantText ? await r.text() : await r.blob(), ct: r.headers.get('content-type') || '' };
    tries.push(`fetch:${r.status}`);
  } catch (e) { tries.push(`fetch:${msg(e)}`); }
  try {
    const body = await xhrGet(url, wantText, 10000);
    return { body, ct: '' };
  } catch (e) { tries.push(msg(e)); }
  throw new Error(tries.join('/') || 'unknown');
}

function confirmPut(worker, payload, key, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!worker || typeof navigator === 'undefined' || !navigator.serviceWorker) { resolve(true); return; }
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const handler = (ev) => {
      const d = ev.data || {};
      if (d.type === 'ck-cache-put-done' && (d.pathname === key || d.key === key)) { cleanup(); resolve(true); }
      if (d.type === 'ck-cache-put-failed' && (d.pathname === key || d.key === key)) { cleanup(); resolve(false); }
    };
    const cleanup = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('message', handler); };
    navigator.serviceWorker.addEventListener('message', handler);
    worker.postMessage({ type: 'ck-cache-put', ...payload });
  });
}

/**
 * @param {object} swMeta 构建时注入的源信息 {origins, core, vendor}
 * @param {object} opts {worker, paths, includeVendor, vendor, onProgress, onPathDone}
 *   · vendor：显式指定要下载的 vendor 依赖列表（断点续传时只补缺的那部分）
 *   · onPathDone(key)：每个文件成功入缓存后立刻回调（站点路径 / vendor 完整 URL），
 *     更新器靠它把"已下载清单"落盘 —— 下载被打断（切页/退出/超时）后能续传，
 *     而不是整站从头重下
 * @returns {Promise<{ok:number,total:number,errors:string[],okPaths:string[]}>}
 */
export async function precacheCore(swMeta, opts = {}) {
  const worker = opts.worker !== undefined ? opts.worker : (navigator.serviceWorker?.controller || null);
  const origins = swMeta?.origins || [];
  const paths = opts.paths || swMeta?.core || [];
  const vendor = opts.includeVendor === false
    ? []
    : (Array.isArray(opts.vendor) ? opts.vendor : (swMeta?.vendor || []));
  const errors = [];
  const okPaths = [];
  const total = paths.length + vendor.length;
  // 当前环境受不受 CORS 约束？
  //   原生（Android WebView）：CapacitorHttp 走原生栈，不受限
  //   浏览器页面（真机 WebView / E2E / jsdom）：受限，没有 ACAO 头的源必然失败
  //   Node（ptest）：**没有 CORS 这回事**，Gitee 这类源照样能直连——
  //     国内机器上 ptest 就是靠这条来验证真实下载链的，别把它一起跳过了
  const corsBound = !Capacitor.isNativePlatform()
    && typeof window !== 'undefined' && !!window.document;
  const HTML_RE = /\.(html?)(\?|$)/i;

  const jobs = [
    ...paths.map((p) => async () => {
      const wantText = wantsText(p);
      const isHtml = HTML_RE.test(p);
      for (const o of origins) {
        // 没有 ACAO 头的源（Gitee raw 就是）在受 CORS 约束的环境里必然被拦，
        // 跳过可以省下每文件两轮超时——sw.js 里是同一套规则。
        if (corsBound && o.cors === false) continue;
        // 不发 .html 的源（jsDelivr 对 .html 一律 301 给被墙的 raw）：跳过，
        // 不然 HTML 全靠它就永远下不到，还会把 raw 打到限流
        if (o.html === false && isHtml) continue;
        const url = `${o.base}${p}`;
        try {
          const { body, ct } = await download(url, wantText);
          const putOk = await confirmPut(worker, { pathname: p, body, contentType: usableCt(ct) ? ct : mimeFor(p) }, p);
          if (putOk) { okPaths.push(p); if (typeof opts.onPathDone === 'function') opts.onPathDone(p); return true; }
          errors.push(`${p}:put-failed`);
        } catch (e) {
          errors.push(`${p}:${msg(e)}`);
        }
      }
      return false;
    }),
    ...vendor.map((v) => async () => {
      // 直连 CDN 在国内基本不通，镜像站兜底；缓存键始终用原始 CDN 地址，
      // 这样页面里 <script src="https://cdn..."> 的请求才能被 SW 拦到。
      const key = v.url;
      const wantText = wantsText(new URL(key).pathname);
      for (const url of [key, v.mirror].filter(Boolean)) {
        try {
          const { body, ct } = await download(url, wantText);
          // 路径猜不出的（如 /npm/pkg/+esm）只能靠构建时算好的类型；
          // 猜成 octet-stream 的话 <script type="module"> 会被浏览器直接拒载
          const putOk = await confirmPut(worker, {
            key,
            body,
            contentType: usableCt(ct) ? ct : (v.ct || mimeFor(new URL(key).pathname)),
            vendorCt: v.ct,
          }, key);
          if (putOk) { okPaths.push(key); if (typeof opts.onPathDone === 'function') opts.onPathDone(key); return true; }
          errors.push(`vendor:put-failed`);
        } catch (e) {
          errors.push(`vendor:${msg(e)}`);
        }
      }
      return false;
    }),
  ];

  // 并发池：避免上百个请求同时砸向 SW/缓存
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  let cursor = 0;
  let settledOk = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        if (await job()) settledOk++;
      } catch (e) { /* noop */ }
      if (typeof opts.onProgress === 'function') opts.onProgress(settledOk, total);
    }
  });

  const deadline = opts.deadlineMs ?? 45000;
  const finished = await Promise.race([
    Promise.all(workers).then(() => true),
    new Promise((r) => setTimeout(() => r(false), deadline)),
  ]);
  if (!finished) errors.push(`deadline:${deadline}ms`);
  if (typeof opts.onProgress === 'function') opts.onProgress(settledOk, total);
  return { ok: settledOk, total, errors: errors.slice(0, 6), okPaths, partial: !finished };
}

/**
 * 按源链取一个站点路径（SW 的"原生桥"用：HTML 导航 miss 时，SW 会广播给页面，
 * 请页面用原生链代取，取回来交给 SW 注入运行时并入缓存）。
 * 受 CORS 约束的环境（浏览器页面 / E2E）照旧跳过没有 ACAO 的源；原生环境不跳。
 * @returns {Promise<{body:string|Blob, ct:string}|null>} 全部源都失败时返回 null
 */
export async function fetchSitePath(swMeta, pathname) {
  const wantText = wantsText(pathname);
  const isHtml = /\.(html?)(\?|$)/i.test(pathname);
  const corsBound = !Capacitor.isNativePlatform()
    && typeof window !== 'undefined' && !!window.document;
  for (const o of swMeta?.origins || []) {
    if (corsBound && o.cors === false) continue;
    // 不发 .html 的源（jsDelivr 对 .html 一律 301 给被墙的 raw）：跳过
    if (o.html === false && isHtml) continue;
    try {
      const { body, ct } = await download(`${o.base}${pathname}`, wantText);
      return { body, ct };
    } catch (e) { /* 换下一个源 */ }
  }
  return null;
}

export default precacheCore;
