/**
 * 把站点页面里引用的 CDN 脚本下载到本地缓存，供 OTA 资源包离线使用
 *   缓存目录：.cache/vendor/
 * 用法：node scripts/vendor-sync.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ensureDir, loadConfig, log, paths, download } from './lib.mjs';

const FORCE = process.argv.includes('--force');
export const VENDOR_DIR = path.join(paths.cache, 'vendor');

/**
 * 国内镜像：jsDelivr / unpkg 的镜像站，路径规则和 jsDelivr 完全一致，
 * 国内直连可用。只在直连失败时兜底，通外网的环境行为不变。
 */
const MIRROR_HOSTS = [
  ['https://cdn.jsdelivr.net/', 'https://jsd.onmicrosoft.cn/'],
  ['https://fastly.jsdelivr.net/', 'https://jsd.onmicrosoft.cn/'],
  ['https://unpkg.com/', 'https://jsd.onmicrosoft.cn/npm/'],
];
export function mirrorUrl(url) {
  for (const [from, to] of MIRROR_HOSTS) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return null; // cdnjs / esm.sh 没有通用镜像，需要在 app.config.json 里单独写 mirror
}

/** 下载单个资源（带缓存），返回 {file, bytes, fromCache} */
export async function fetchVendorAsset(url, fileName, { depth = 0, mirror } = {}) {
  const file = path.join(VENDOR_DIR, fileName);
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { file, bytes: fs.statSync(file).size, fromCache: true, url };
  }
  let bytes;
  try {
    bytes = await download(url, file, { timeoutMs: 90000 });
  } catch (err) {
    const alt = mirror || mirrorUrl(url);
    if (!alt) throw err;
    log.warn(`直连失败（${String(err.message || err).slice(0, 60)}），改用国内镜像：${alt}`);
    bytes = await download(alt, file, { timeoutMs: 90000 });
  }
  log.info(`下载 ${url} → vendor/${fileName} (${(bytes / 1024).toFixed(1)} KB)`);
  return { file, bytes, fromCache: false, url };
}

/** 扫描已下载的 JS 里还引用了哪些 CDN 资源（esm 包常见），一并本地化 */
export async function fetchNested(file, depth = 0, seen = new Set()) {
  if (depth > 3) return [];
  const text = fs.readFileSync(file, 'utf8');
  const re = /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh)\/[^\s"'`)<>,;]+/g;
  const urls = [...new Set(text.match(re) || [])].filter((u) => !seen.has(u));
  const results = [];
  for (const url of urls) {
    seen.add(url);
    const name = vendorFileName(url);
    if (fs.existsSync(path.join(VENDOR_DIR, name)) && !FORCE) {
      results.push({ url, file: path.join(VENDOR_DIR, name), nested: [] });
      continue;
    }
    try {
      const r = await fetchVendorAsset(url, name);
      const nested = /\.(m?js)$/.test(name) ? await fetchNested(r.file, depth + 1, seen) : [];
      results.push({ url, file: r.file, nested });
    } catch (err) {
      log.warn(`嵌套依赖下载失败（不影响主流程）：${url} → ${err.message}`);
    }
  }
  return results;
}

/** URL → 本地文件名（可读、稳定） */
export function vendorFileName(url) {
  const u = new URL(url);
  let name = u.pathname
    .replace(/^\/+/, '')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9._@+-]/g, '_');
  if (name.endsWith('+esm') || !/\.(js|mjs|css)$/.test(name)) name += '.js';
  return name.slice(0, 120);
}

export async function syncVendor(cfg = loadConfig()) {
  const vendor = cfg.bundle?.vendor;
  if (!vendor?.enabled) {
    log.info('vendor 本地化已关闭');
    return { map: new Map(), dir: VENDOR_DIR };
  }
  ensureDir(VENDOR_DIR);
  log.step('本地化 CDN 依赖（离线可用）');

  const map = new Map(); // 原始 URL → vendor 文件名
  const seen = new Set();

  for (const asset of vendor.assets || []) {
    try {
      const r = await fetchVendorAsset(asset.url, asset.file, { mirror: asset.mirror });
      map.set(asset.url, asset.file);
      seen.add(asset.url);
      if (/\.js$/.test(asset.file)) {
        const nested = await fetchNested(r.file, 0, seen);
        for (const n of nested) map.set(n.url, path.basename(n.file));
      }
    } catch (err) {
      log.warn(`CDN 资源下载失败：${asset.url} → ${err.message}（离线时该资源不可用）`);
    }
  }

  log.ok(`vendor 就绪：${map.size} 个资源，缓存于 ${path.relative(ROOT, VENDOR_DIR)}`);
  return { map, dir: VENDOR_DIR };
}

if (process.argv[1] && process.argv[1].endsWith('vendor-sync.mjs')) {
  syncVendor().catch((err) => log.die(err.stack || err.message));
}
