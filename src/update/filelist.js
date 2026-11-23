/**
 * 站点文件清单（**运行时**从仓库 tree 接口取，不再构建时烘死）
 *
 * 为什么要有它：`allPaths` 是打 APK 时从仓库 tree 拉下来、编成字面量写进
 * `ck-app.js` 的，装机后永远不变。于是站点只要**新增/改名/删除**文件，老 APK 就瞎了：
 *   · 删除/改名 → 老路径全源 404 → 更新永远差一格（2026-11 实际踩过）
 *   · 新增    → 更新根本不会去下，只有在线打开过那个页面才顺手缓存
 *   · 超过构建时的 500 条上限 → 尾巴静默丢弃
 *
 * 现在改成每次检查更新时核实一遍真实清单（tree 接口，1 个请求），并把它缓存起来：
 *   · 缓存 TTL 内不重复请求（默认 10 分钟）
 *   · **只在确实有更新时**才去核实（没更新什么都不发）
 *   · 三个源按顺序兜底，主源先上；全失败就退回构建时那份（离线可用的底线）
 */
import { CapacitorHttp } from '@capacitor/core';

const KEY = 'ck.remote.filelist';
const SCHEMA = 2;
/** 清单缓存的默认有效期：10 分钟内多次检查只打一次 tree 接口 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 只收运行时会用到的文件类型（和 scripts/build-web.mjs 的 RUNTIME_EXT 保持一致） */
const RUNTIME_EXT = /\.(html?|js|mjs|css|svg|png|jpe?g|gif|webp|ico|json|webmanifest|woff2?|ttf|otf|mp3|wav|ogg|mp4)$/i;

/** 点号开头的目录/文件一律不进缓存（.git / .github / .http / supabase/.temp …） */
const hasDotSegment = (p) => p.split('/').some((s) => s.startsWith('.'));

export function readCachedFileList(now = Date.now()) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!v || v.schema !== SCHEMA || typeof v.tag !== 'string' || !Array.isArray(v.paths)) return null;
    const age = now - (Number(v.at) || 0);
    return { ...v, age, fresh: age >= 0 && age < (Number(v.ttl) || DEFAULT_TTL_MS) };
  } catch (e) { return null; }
}

export function writeCachedFileList(tag, paths, ttl = DEFAULT_TTL_MS) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ schema: SCHEMA, tag, paths, at: Date.now(), ttl }));
    return true;
  } catch (e) { return false; /* 配额满：只是下次要重取，不影响正确性 */ }
}

export function clearCachedFileList() {
  try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
}

const toPaths = (list) => list
  .map((p) => `/${String(p).replace(/^\/+/, '')}`)
  .filter((p) => !hasDotSegment(p))
  .filter((p) => RUNTIME_EXT.test(p));

const githubPick = (d) => (d.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
const jsdelivrPick = (d) => {
  const out = [];
  const walk = (files, prefix) => {
    for (const f of files || []) {
      if (f.type === 'directory') walk(f.files, `${prefix}${f.name}/`);
      else out.push(`${prefix}${f.name}`);
    }
  };
  walk(d.files, '');
  return out;
};
const giteePick = (d) => (d.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);

/**
 * 清单源链。顺序按「国内手机实际可达性 + 响应速度」排：
 *   Gitee  → 国内直连快，国内网络唯一稳定的（站点主镜像就在这里）
 *   jsDelivr → 有 CDN，国外/机场网络可用
 *   GitHub → 国内常被墙，只做最后兜底
 * 每个源都带自己的 pick 函数，字段结构不同（jsDelivr 是嵌套 files）。
 */
export function fileListSources(site = {}, branch = 'main') {
  const repoPath = String(site.repo || site.repoFallback || '')
    .replace(/\.git$/, '')
    .split('/').slice(-2).join('/');
  const fallbackPath = String(site.repoFallback || '')
    .replace(/\.git$/, '')
    .split('/').slice(-2).join('/');
  const out = [];
  if (repoPath) {
    out.push({
      name: 'Gitee',
      url: `https://gitee.com/api/v5/repos/${repoPath}/git/trees/${branch}?recursive=1`,
      pick: giteePick,
    });
  }
  if (fallbackPath) {
    out.push({
      name: 'jsDelivr',
      url: `https://data.jsdelivr.com/v1/packages/gh/${fallbackPath}@${branch}`,
      pick: jsdelivrPick,
    });
    out.push({
      name: 'GitHub',
      url: `https://api.github.com/repos/${fallbackPath}/git/trees/${branch}?recursive=1`,
      pick: githubPick,
    });
  }
  return out;
}

/**
 * 取当前真实的全站清单。
 * @returns {Promise<{paths:string[], source:string, at:number}|null>} 全部源都失败时返回 null
 */
export async function fetchFileList(sources, { timeoutMs = 8000 } = {}) {
  for (const s of sources) {
    try {
      const r = await CapacitorHttp.get({
        url: s.url,
        responseType: 'json', // CapacitorHttp 对 application/json 直接给已解析对象
        connectTimeout: Math.min(timeoutMs, 8000),
        readTimeout: timeoutMs,
        shouldEncodeUrlParams: false,
        headers: { Accept: 'application/json', 'User-Agent': 'ckapp' },
      });
      if (r.status < 200 || r.status >= 300 || r.data == null) continue;
      // 响应头是 application/json 时原生给的是对象；个别源会退回字符串
      const body = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      const paths = toPaths(s.pick(body) || []);
      if (paths.length) return { paths, source: s.name, at: Date.now() };
    } catch (e) { /* 换下一个源 */ }
  }
  return null;
}

/** 纯函数版：给已有清单数组套同样的过滤规则（测试用，也方便别处复用） */
export function normalizeFileList(list) {
  return toPaths(Array.isArray(list) ? list : []);
}

export default { fetchFileList, fileListSources, readCachedFileList, writeCachedFileList, clearCachedFileList, normalizeFileList, DEFAULT_TTL_MS };
