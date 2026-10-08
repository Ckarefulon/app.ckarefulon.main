/**
 * 原生 HTTP：绕过 WebView 的跨域 / MIME 限制（Gitee raw 没有 CORS 头）
 */
import { CapacitorHttp } from '@capacitor/core';

const TEXT_EXT = /\.(html?|js|mjs|cjs|css|json|svg|txt|md|webmanifest|xml)(\?|$)/i;

export function wantsText(urlOrPath) {
  return TEXT_EXT.test(urlOrPath);
}

/**
 * @returns {Promise<{ok:boolean,status:number,data:any,contentType:string,etag:string,lastModified:string}>}
 */
export async function nativeGet(url, { forceText = null, timeoutMs = 30000 } = {}) {
  const asText = forceText == null ? wantsText(url) : forceText;
  const res = await CapacitorHttp.get({
    url,
    responseType: asText ? 'text' : 'blob',
    connectTimeout: Math.min(timeoutMs, 15000),
    readTimeout: timeoutMs,
    shouldEncodeUrlParams: false,
  });
  const h = res.headers || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (h[k] != null) return h[k];
      const lower = k.toLowerCase();
      if (h[lower] != null) return h[lower];
    }
    return '';
  };
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    data: res.data,
    contentType: pick('Content-Type', 'content-type'),
    etag: pick('ETag', 'etag'),
    lastModified: pick('Last-Modified', 'last-modified'),
  };
}

export default nativeGet;
