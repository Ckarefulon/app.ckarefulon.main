/**
 * 内容更新器（SW 直连仓库模式）
 *   · check()：原生 HTTP 探测 /index.html（probe 源优先），ETag/Last-Modified（或正文哈希）变化即有更新
 *   · 有更新：弹「正在下载更新」→ 后台下载全站 → 下完弹确认刷新框
 *     全程不阻拦页面：页面早就打开了，用户不刷新就继续用旧版
 *   · 离线：继续读本地缓存
 *   · 只在站点页面（bundle 角色）进站后才 init()，壳启动流程绝不等更新检查
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { CkUI } from '../ui/ck-ui.js';
import { nativeGet } from '../net/native-http.js';
import { precacheCore } from '../net/precache.js';
import { fetchFileList, fileListSources, readCachedFileList, writeCachedFileList } from './filelist.js';

const ETAG_KEY = 'ck.remote.etag.index';
/**
 * 断点续传进度：{tag, done:[已入缓存的站点路径/vendor URL]}。
 * 以前下载被任何事打断（用户切页、退出 app、5 分钟 deadline 到点、网络抖动）
 * 都只能整站从头重下 —— 明明一半文件已经在缓存里。现在按"目标指纹"记录
 * 已下载清单：恢复时只补缺；远端又出了更新（tag 变了）才作废旧进度重下。
 */
const PROG_KEY = 'ck.update.progress';
/** 半截下载后的自动重试间隔：不能只等每小时定期检查/网络事件（用户看到的就是"停了没下文"） */
const RETRY_DELAY_MS = 60000;
/** `serviceWorker.ready` 在没有活动注册时永远不 resolve（不是 reject），必须自己有超时 */
const SW_READY_TIMEOUT_MS = 8000;
/**
 * 单次检查的硬上限：任何一步挂住（SW 消息不回、网络状态查询不返回…）都不许让
 * state.checking 永久为 true —— 那等于把更新功能彻底锁死，只能重启 app。
 * 下载本身有 5 分钟 deadline，这里留足余量。
 */
const CHECK_WATCHDOG_MS = 10 * 60 * 1000;

function loadProgress() {
  try {
    const v = JSON.parse(localStorage.getItem(PROG_KEY) || 'null');
    return v && typeof v === 'object' && typeof v.tag === 'string' && Array.isArray(v.done) ? v : null;
  } catch (e) { return null; }
}
function saveProgress(tag, done) {
  try { localStorage.setItem(PROG_KEY, JSON.stringify({ tag, done })); } catch (e) { /* 配额满：丢进度只是多下点，不影响正确性 */ }
}
function clearProgress() {
  try { localStorage.removeItem(PROG_KEY); } catch (e) { /* noop */ }
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function parseVersion(v) {
  const parts = String(v || '0').replace(/^v/i, '').split(/[.\-+]/)
    .map((p) => parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function cmpVersion(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 内容指纹：Gitee raw 这类源不给 ETag/Last-Modified，以前只能退回"内容长度"，
 * 内容变了但长度恰好没变就会被当成"没更新"。这里对取回来的正文做一次轻量哈希。
 */
export function contentTag(text) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function createUpdater(meta) {
  const ota = meta.ota || {};
  const state = { checking: false, lastCheckAt: 0, lastError: null, listeners: new Set() };
  let retryTimer = null;
  /**
   * 半截下载后的自动重试（60s）。以前 partial 之后只能等：每小时定期检查 /
   * app 回前台 / 网络事件 —— 用户前台挂着 app 什么都不会发生，表现就是
   * "更一半自动停了"。定时器全局只有一个，check 正在跑时到点也不会并发。
   */
  function scheduleRetry(delayMs = RETRY_DELAY_MS) {
    if (retryTimer) return;
    try {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        check({ silent: true, force: true });
      }, delayMs);
    } catch (e) { /* noop */ }
  }
  const emit = (event, data) => {
    for (const fn of [...state.listeners]) {
      try { fn(event, data); } catch (e) { console.error('[ck-update] listener error', e); }
    }
  };

  /**
   * 取"当前站点真实有哪文件"。
   *   · 缓存 TTL 内 → 直接用（连一个请求都不发）
   *   · 过期 → 拉 tree 接口；tag 没变说明站点没动过，把缓存续期，省下重新解析
   *   · 全失败 → 返回空 paths，调用方回退到构建时烘死的 allPaths
   * 注意：只有"确认有更新"之后才会调到这里，没更新时零额外流量。
   */
  async function resolveSitePaths(tag) {
    const cached = readCachedFileList();
    if (cached && cached.fresh && cached.tag === tag) return { paths: cached.paths, source: 'cache' };
    try {
      const got = await fetchFileList(fileListSources(meta.site || {}, meta.site?.branch || 'main'));
      if (got && got.paths.length) {
        writeCachedFileList(tag, got.paths);
        console.info(`[ck-update] 站点清单已更新：${got.paths.length} 个文件（源：${got.source}）`);
        return { paths: got.paths, source: got.source };
      }
      // 接口全挂了：有旧缓存就用旧的（比烘死的那份新），否则交给调用方回退
      if (cached && cached.paths?.length) return { paths: cached.paths, source: 'stale-cache' };
      console.warn('[ck-update] 拿不到站点清单，回退到构建时的清单（新文件可能要等下次）');
      return { paths: [], source: 'fallback' };
    } catch (e) {
      if (cached && cached.paths?.length) return { paths: cached.paths, source: 'stale-cache' };
      return { paths: [], source: 'fallback' };
    }
  }

  /** 上次清单里有、这次清单里没有的站点路径（vendor 是 CDN 地址，不参与） */
  function diffGone(currentPaths) {
    const prevList = readCachedFileList();
    // 没有上一份清单可比时，用构建时烘死的那份当基线 —— 它正好代表了
    // "装机时站点有哪些文件"，删掉的文件就是从这里多出来的那些。
    const baseline = (prevList && prevList.paths?.length) ? prevList.paths : (meta.sw?.allPaths || []);
    if (!baseline.length) return [];
    const now = new Set(currentPaths);
    return baseline.filter((p) => !now.has(p));
  }

  /** 让 SW 把已消失的文件从 CacheStorage 删掉（失败无所谓，只是缓存多留一会儿） */
  function dropGone(worker, paths) {
    try {
      worker?.postMessage?.({ type: 'ck-cache-drop', paths });
    } catch (e) { /* noop */ }
  }

  const hasSW = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  async function sw() {
    if (!hasSW()) return null;
    try {
      // `serviceWorker.ready` 在没有活动注册时**永远不会 resolve**（不是 reject）。
      // 以前这里直接 await：一旦 SW 注册失败（sw.js 404 / 安装期报错），
      // check() 就永久挂住、state.checking 永远 true → 之后所有更新检查都返回 busy，
      // 用户看到的就是"卡住之后再也不能更新"。加超时，拿不到就当没有 SW。
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((r) => setTimeout(() => r(null), SW_READY_TIMEOUT_MS)),
      ]);
      if (!reg) return null;
      return navigator.serviceWorker.controller || reg.active || null;
    } catch (e) { return null; }
  }

  function ask(worker, requestType, responseType, timeoutMs = 25000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve(null);
      }, timeoutMs);
      const handler = (ev) => {
        if (ev.data?.type === responseType) {
          navigator.serviceWorker.removeEventListener('message', handler);
          clearTimeout(timer);
          resolve(ev.data);
        }
      };
      navigator.serviceWorker.addEventListener('message', handler);
      worker.postMessage({ type: requestType });
    });
  }

  async function check(options = {}) {
    const { silent = true, force = false } = options;
    if (ota.enabled === false) return { status: 'disabled' };
    if (state.checking) return { status: 'busy' };
    const intervalMs = (ota.checkIntervalMinutes ?? 60) * 60 * 1000;
    // 有半截没下完的更新时不受节流限制：切页/回前台都应立刻续传，
    // 而不是等下一个整点检查（用户视角就是"停了再也没动静"）
    const resumePending = !!loadProgress();
    if (!force && !resumePending && Date.now() - state.lastCheckAt < intervalMs) return { status: 'throttled' };

    state.checking = true;
    const checkStartedAt = Date.now();
    let watchdog = null;
    try {
      watchdog = setTimeout(() => {
        if (state.checking && Date.now() - checkStartedAt >= CHECK_WATCHDOG_MS) {
          state.checking = false;
          console.warn('[ck-update] 单次检查超过硬上限仍未结束，强制解锁（避免更新功能被永久锁死）');
        }
      }, CHECK_WATCHDOG_MS + 1000);
    } catch (e) { /* noop */ }
    emit('checking');
    try {
      const net = await Network.getStatus().catch(() => ({ connected: true }));
      if (!net.connected) {
        state.lastCheckAt = Date.now();
        if (!silent) CkUI.toast('当前离线：继续使用本地缓存', { type: 'warn' });
        return { status: 'offline' };
      }

      // 原生 HTTP 探测（不依赖 SW/WebView 的 fetch 实现）
      // 用 probeOrigins（按"最新"排序），它才是为探测准备的源；老配置里没有这个
      // 字段时退回 origins。以前只试第一个源，第一个不通整个更新检查就失败——
      // 必须顺着源链往下试。
      const probeOrigins = (meta.sw?.probeOrigins?.length ? meta.sw.probeOrigins : meta.sw?.origins) || [];
      let res = null;
      let probeError = null;
      const isNative = Capacitor.isNativePlatform();
      for (const o of probeOrigins) {
        if (!o?.base) continue;
        // 浏览器页面（非原生）受 CORS 约束，没有 ACAO 头的源必然失败 ——
        // 照旧去试只会刷一屏 "blocked by CORS policy"，白等一轮超时。
        // 原生（CapacitorHttp）不受限，照旧按 fresh 顺序全试。
        if (!isNative && o.cors === false) continue;
        try {
          const r = await nativeGet(`${o.base}/index.html`, { forceText: true, timeoutMs: 20000 });
          if (r.ok) { res = r; break; }
          probeError = `HTTP ${r.status}`;
        } catch (e) {
          probeError = String(e?.message || e);
        }
      }
      state.lastCheckAt = Date.now();
      if (!res) throw new Error(`探测失败 ${probeError || '（无可用更新源）'}`);

      const tag = res.etag || res.lastModified || contentTag(res.data);
      const prev = (() => { try { return localStorage.getItem(ETAG_KEY); } catch (e) { return null; } })();

      if (!prev) {
        try { localStorage.setItem(ETAG_KEY, tag); } catch (e) { /* noop */ }
        clearProgress(); // 指纹都还没有，残留的半截进度必然是旧版本的，作废
        emit('upToDate', { first: true });
        if (!silent) CkUI.toast('已是最新版本', { type: 'ok' });
        return { status: 'up-to-date', first: true };
      }
      if (prev === tag) {
        clearProgress(); // 已是最新：残留的进度记录没意义，顺手清掉（免得永远绕过节流）
        emit('upToDate', {});
        if (!silent) CkUI.toast('已是最新版本', { type: 'ok' });
        return { status: 'up-to-date' };
      }

      // 有更新：**页面这时候已经打开了，这里的一切都不许阻拦它**。
      // 顺序固定为「发现更新 → 弹"正在下载更新" → 后台下完 → 弹确认刷新的框」。
      // 用户不点刷新就继续用旧版（内容其实已经在缓存里，下次导航自然是新版）。
      // 指纹只在下载全量成功后才写 —— 以前是立即写，下载一旦失败（网络抖一下），
      // 下次检查就判"已是最新"，用户永远看不到新版，只能手动重置缓存。
      const worker = await sw();
      const allPaths = meta.sw?.allPaths || [];
      emit('updated', { tag });
      if (!worker) {
        // 没有 SW 接管时下载无处可存（会把失败当成功），直接跳过，
        // 等下次检查再试 —— 指纹也不写，保证有网时能重试
        return { status: 'updated', tag, deferred: true };
      }

      // ---- 站点清单：以**运行时**拿到的真实清单为准 ----
      // allPaths 是打 APK 时烘死的，站点一新增/改名/删文件它就不准了。
      // 这里优先用 tree 接口的实时清单（有 TTL 缓存，没真更新时根本不会请求到这一步），
      // 全失败才退回烘死的那份，保证离线/接口全挂时行为不变。
      //
      // 为什么不每次检查都拉：tree 接口是几 KB~一百多 KB 的额外请求，
      // 而"有没有更新"用 index.html 的 ETag 一个请求就够了。只在确认有更新后
      // 才去核实清单，没更新时零额外流量。
      const listed = await resolveSitePaths(tag);
      const sitePaths = listed.paths.length ? listed.paths : allPaths;
      const vendorAll = sitePaths.length ? (meta.sw?.vendor || []) : [];
      // 清单里已经没有的旧路径：内容已经从站点消失，缓存里的那份是死数据，
      // 交给 SW 删掉（不删的话缓存只增不减，而且用户可能看到已下线的旧页面）
      const gone = listed.paths.length ? diffGone(sitePaths) : [];
      if (gone.length) {
        console.info('[ck-update] 这些路径已从站点消失，清理本地缓存', gone.slice(0, 10).join(', '), gone.length > 10 ? `…共 ${gone.length} 个` : '');
        void dropGone(worker, gone);
      }
      let prog = loadProgress();
      if (!prog || prog.tag !== tag) prog = { tag, done: [] };
      const doneSet = new Set(prog.done);
      const doneOffset = doneSet.size;
      const pendingPaths = sitePaths.filter((p) => !doneSet.has(p));
      const pendingVendor = vendorAll.filter((v) => !doneSet.has(v.url));

      let flushTimer = null;
      const persist = () => saveProgress(prog.tag, [...doneSet]);
      const markDone = (key) => {
        if (!key || doneSet.has(key)) return;
        doneSet.add(key);
        // 节流落盘：几百个文件每个都同步写 localStorage 会明显拖慢下载
        if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; persist(); }, 1000);
      };
      const flushNow = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        persist();
      };
      // 用户中途切页/退出（页面卸载）也把进度落盘 —— 下次进来接着下
      const persistOnUnload = () => persist();
      try { window.addEventListener('pagehide', persistOnUnload); } catch (e) { /* noop */ }

      const note = CkUI.toast('正在下载更新…', { type: 'info', timeout: 0 });
      let lastNote = '';
      const nothingPending = pendingPaths.length + pendingVendor.length === 0;
      let result = null;
      try {
        result = nothingPending
          ? { ok: 0, total: 0, errors: [] } // 上次其实已下完（写指纹前被打断）：直接进确认流程
          : await precacheCore(meta.sw || {}, {
            worker,
            paths: pendingPaths,
            vendor: pendingVendor,
            deadlineMs: 300000,
            onPathDone: markDone,
            onProgress: (ok, total) => {
              const text = `正在下载更新 ${doneOffset + ok}/${doneOffset + total}`;
              if (text !== lastNote) {
                lastNote = text;
                try { note?.update?.(text); } catch (e) { /* noop */ }
              }
            },
          });
      } catch (e) {
        console.warn('[ck-update] 下载更新失败', e);
        result = null;
      } finally {
        try { window.removeEventListener('pagehide', persistOnUnload); } catch (e) { /* noop */ }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      }
      try { note?.close?.(); } catch (e) { /* noop */ }

      // 判定"下完了"：成功的 + 源上已不存在的 = 全部。missing 是**永久性**的
      // （全源 404/410），不这样算的话，站点删掉一个文件就能让指纹永远写不进去。
      const settledAll = !!result && (result.ok + (result.missing || 0) === result.total);
      // 兜底：一个都真没下到（整站 404 / 源配错）不能算成功，否则会把空内容
      // 当成"已是最新"写进指纹，之后再也不更新。
      const gotSomething = !!result && (result.total > 0 ? result.ok > 0 : doneOffset > 0);
      const complete = settledAll && gotSomething;

      // 源上已经不存在的文件（站点改名/删除，而 allPaths 是构建时烘死的）：
      // 不管这次是不是全部下完，都先记进已下载清单 —— 否则每轮重试都会重新去
      // 打这批 404 地址，永远卡在同一格（"更一半自动停了"就是这么来的）。
      for (const m of result?.missingPaths || []) markDone(m);
      if (result?.missingPaths?.length) {
        console.info('[ck-update] 源上已不存在的文件（已跳过）', result.missingPaths);
      }

      if (!complete) {
        // 只下了一半：进度已落盘（下次检查/重进 app 从断点继续，不从头下），
        // 指纹保持旧值；并安排一次自动重试 —— 不能只等每小时定期检查，
        // 否则用户看到的就是"更一半自动停了，没有下文"
        persist();
        emit('downloadFailed', { tag, result });
        if (!silent) CkUI.toast('更新没下载完，稍后会自动重试', { type: 'warn' });
        scheduleRetry();
        return { status: 'updated', tag, partial: true, result, resumed: doneOffset };
      }

      clearProgress();
      try { localStorage.setItem(ETAG_KEY, tag); } catch (e) { /* noop */ }
      emit('downloaded', { tag });
      // 内容已经落地、指纹已经写好，更新这件事到此结束。下面只是问用户要不要刷新：
      // 等他点按钮的这段时间**不能再算"正在检查"** —— 以前 check() 一直 await 这个框，
      // 用户不点（或框没弹出来）state.checking 就永远 true，之后所有检查全部 busy，
      // 表现就是"更新功能从此没有任何反应，只能重启 app"。
      state.checking = false;
      const doRefresh = await CkUI.confirm({
        title: '更新已下载完成',
        message: '新版内容已经下载到本地，刷新页面就能看到。现在刷新吗？',
        okLabel: '立即刷新',
        cancelLabel: '稍后再说',
      });
      if (doRefresh) window.location.reload();
      return { status: 'updated', tag, downloaded: true, refreshed: !!doRefresh };
    } catch (err) {
      state.lastError = err;
      state.lastCheckAt = Date.now();
      emit('error', err);
      console.warn('[ck-update] 检查更新失败：', err);
      if (!silent) CkUI.toast(`检查更新失败：${String(err?.message || err)}`, { type: 'error' });
      return { status: 'error', error: err };
    } finally {
      if (watchdog) { try { clearTimeout(watchdog); } catch (e) { /* noop */ } }
      state.checking = false;
    }
  }

  async function applyNow() { window.location.reload(); return true; }

  async function resetToShell() {
    const ok = await CkUI.confirm({
      title: '重置本地内容',
      message: '将清空已缓存的站点内容并回到启动壳，重新下载首屏。用于修复页面异常。',
      okLabel: '重置', cancelLabel: '取消', danger: true,
    });
    if (!ok) return false;
    try {
      const keys = await caches.keys();
      for (const k of keys) if (k.startsWith('ck-')) await caches.delete(k);
    } catch (e) { /* noop */ }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
    } catch (e) { /* noop */ }
    window.location.reload();
    return true;
  }

  async function info() {
    let runtime = null;
    try {
      const r = await fetch('/ckapp/ck-version.json', { cache: 'no-store' });
      runtime = r.ok ? await res(r) : null;
    } catch (e) { runtime = null; }
    async function res(r) { return r.json(); }
    let stats = null;
    const worker = await sw();
    if (worker) stats = await ask(worker, 'ck-cache-stats', 'ck-cache-stats-done', 8000);
    return {
      mode: 'sw-repo-direct',
      source: (meta.sw?.origins || []).map((o) => o.name).join(' → ') || '-',
      bundleVersion: runtime?.version || meta.version,
      native: meta.nativeVersion,
      runtime: runtime || meta,
      contentVersion: runtime?.contentVersion || null,
      cacheEntries: stats?.entries ?? null,
      cacheBytes: stats?.bytes ?? null,
      isShell: meta.role === 'shell',
    };
  }

  function init() {
    if (ota.checkOnLaunch !== false) setTimeout(() => check({ silent: true }), 2500);
    if (hasSW()) {
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data?.type === 'ck-content-refreshed' && !state.checking) emit('refreshed', ev.data);
      });
    }
    if (ota.checkOnResume !== false) {
      App.addListener('appStateChange', ({ isActive }) => { if (isActive) check({ silent: true }); }).catch(() => {});
    }
    const every = Math.max((ota.checkIntervalMinutes ?? 60) * 60 * 1000, 5 * 60 * 1000);
    setInterval(() => check({ silent: true, force: true }), every);
    Network.addListener('networkStatusChange', ({ connected }) => {
      if (connected) check({ silent: true, force: true });
    }).catch(() => {});
  }

  return {
    meta, state, init, check, applyNow, resetToShell, info,
    on: (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
    cmpVersion, parseVersion,
    platform: Capacitor.getPlatform(),
  };
}

export default createUpdater;
