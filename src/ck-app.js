/**
 * Ckarefulon App Runtime —— 入口
 * ---------------------------------------------------------------------------
 * 同一份代码构建两次（esbuild define 注入 __CK_META__）：
 *   role = 'shell'  → 打进 APK 的启动壳，负责首次下载 / 激活 OTA 资源包
 *   role = 'bundle' → 注入到站点每个 HTML 里，负责 BLE 原生桥 + 后台检查更新
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { installWebBluetoothPolyfill, CkBle } from './ble/web-bluetooth-polyfill.js';
import { createUpdater, humanSize } from './update/updater.js';
import { bootstrapShell } from './update/bootstrap.js';
import { CkUI } from './ui/ck-ui.js';
import { fetchSitePath } from './net/precache.js';
import { installFetchFallback, netDiag, clearNetDiag, probeHosts, blockedHosts as netBlockedHosts } from './net/fetch-fallback.js';

const META = typeof __CK_META__ !== 'undefined' ? __CK_META__ : { role: 'bundle', ota: {} };
const isNative = Capacitor.isNativePlatform();
const isAndroid = Capacitor.getPlatform() === 'android';

/* --------------------------- 跨域兜底通道（越早越好） --------------------------- */

/**
 * 必须在**站点自己的脚本执行之前**装上：站点里有些库（比如 supabase-js）
 * 可能在加载时就把 fetch 存进内部变量，装晚了它就不会走兜底。
 * 本文件是被注入到 <head> 的普通脚本，模块顶层就在解析期同步执行 ——
 * 站点那些 defer 的脚本一定在这之后。所以这里直接调用，不要挪进 main()。
 */
installFetchFallback();

/* ------------------------------ 标记 ------------------------------ */

function markRuntime() {
  const root = document.documentElement;
  if (!root) return;
  root.classList.add('ck-native');
  root.dataset.ckRole = META.role || 'bundle';
  root.dataset.ckPlatform = Capacitor.getPlatform();
  if (META.version) root.dataset.ckVersion = META.version;
}

/* ------------------------------ 状态栏 ------------------------------ */

function syncStatusBar() {
  if (!isAndroid) return;
  const apply = () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark }).catch(() => {});
    StatusBar.setBackgroundColor({ color: theme === 'light' ? '#f7f7fb' : '#161328' }).catch(() => {});
  };
  apply();
  try {
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) { /* noop */ }
}

/* ------------------------------ 返回键 ------------------------------ */

function bindBackButton() {
  if (!isAndroid) return;
  App.addListener('backButton', ({ canGoBack }) => {
    // 站点接管后（document.write 落地站点文档，window 没换），壳这份监听还活着。
    // ck-site.js 会再注册一份返回键监听 —— 壳这边必须静默，否则按返回键
    // 会"既把应用退到后台、又触发一次返回上一页"。
    if (META.role === 'shell') {
      if (window.__ckEntered) return;
      App.minimizeApp().catch(() => App.exitApp());
      return;
    }
    const atHome = /^\/(index\.html?)?$/.test(window.location.pathname);
    if (canGoBack && !atHome) {
      window.history.back();
    } else if (!atHome) {
      window.location.href = '/';
    } else {
      App.exitApp().catch(() => {});
    }
  }).catch(() => {});
}

/* ------------------------------ 对外 API ------------------------------ */

function exposeApi(api) {
  const existing = window.CkApp || {};
  window.CkApp = Object.assign(existing, api);
  window.dispatchEvent(new CustomEvent('ckapp:ready', { detail: window.CkApp }));
}

/* ------------------------------ 原生取数桥 ------------------------------ */

/**
 * SW 的"原生通道桥"：站点 HTML 在国内只能靠原生 HTTP 拿（jsDelivr 把 .html
 * 全部 301 给被墙的 raw.githubusercontent.com，Gitee/Netlify 又没有 CORS 头），
 * 所以 SW 在 HTML 缓存 miss 时会广播 ck-fetch-native，请页面用原生链代取。
 * 壳角色（启动页）和站点角色（每个页面）都装上 —— 退出重进恢复原路径时，
 * 是壳页面在替 SW 取；点进一个还没预缓存到的页面时，是上一个站点页面在替它取。
 */
function installNativeFetchBridge() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const d = event?.data || {};
    if (d.type !== 'ck-fetch-native') return;
    const reply = (r) => {
      try {
        navigator.serviceWorker.controller?.postMessage({
          type: 'ck-fetch-native-done', requestId: d.requestId, ok: !!r, body: r?.body || '', ct: r?.ct || '',
        });
      } catch (e) { /* noop */ }
    };
    const pathname = String(d.pathname || '');
    // 只服务本站路径：必须以 / 开头（不能是协议相对路径），也不能有目录穿越
    if (!d.requestId || !/^\/(?!\/)[^?#]*$/.test(pathname) || pathname.includes('..')) {
      reply(null);
      return;
    }
    fetchSitePath(META.sw, pathname).then(reply).catch(() => reply(null));
  });
}

/* ------------------------------ 启动 ------------------------------ */

async function main() {
  window.__ckBootStarted = 1;
  if (window.__ckWatch) clearTimeout(window.__ckWatch);
  markRuntime();
  CkUI.mount();

  if (isNative) {
    installWebBluetoothPolyfill();
  }
  syncStatusBar();
  bindBackButton();
  installNativeFetchBridge();

  const updater = createUpdater(META);

  const api = {
    meta: META,
    isNative,
    platform: Capacitor.getPlatform(),
    ui: CkUI,
    bluetooth: CkBle,
    /**
     * 跨域网络：网页通道失败会自动切系统通道（见 net/fetch-fallback.js）。
     * diag() 看最近 20 条失败记录（两条通道各自的结果都在里面），
     * probe(urls) 现场逐条比一次两条通道 —— 排查「这台设备能不能到这个域名」用它。
     */
    net: {
      diag: netDiag,
      clearDiag: clearNetDiag,
      probe: (urls) => probeHosts(urls),
      blocked: netBlockedHosts,
    },
    update: {
      check: (opts) => updater.check(Object.assign({ silent: false }, opts)),
      checkSilent: () => updater.check({ silent: true }),
      applyNow: () => updater.applyNow(),
      reset: () => updater.resetToShell(),
      info: () => updater.info(),
      state: updater.state,
      on: updater.on,
      native: META.nativeVersion,
    },
    /** 手动弹出一个“关于 / 更新”面板，站点里可以自行接入（例如 nav 的菜单项） */
    async showAbout() {
      const info = await updater.info();
      const s = CkUI.sheet({ title: '关于 Ckarefulon App', subtitle: META.appName || 'Ckarefulon' });
      const rows = [
        ['客户端版本', `${info.native || META.nativeVersion}（build ${META.nativeBuild || '?'}）`],
        ['内容版本', info.contentVersion || '—'],
        ['运行模式', 'Service Worker 直连仓库（本地缓存离线可用）'],
        ['本地缓存', info.cacheEntries != null ? `${info.cacheEntries} 个文件 / ${humanSize(info.cacheBytes)}` : '统计中…'],
        ['构建时间', info.runtime?.builtAt || META.builtAt || '—'],
        ['提交', info.runtime?.commit || META.commit || '—'],
        ['运行环境', `${Capacitor.getPlatform()} · ${isNative ? '原生壳' : '浏览器'}`],
        ['蓝牙', isNative ? '原生 BLE 桥（已启用）' : (navigator.bluetooth ? 'Web Bluetooth' : '不可用')],
      ];
      const box = CkUI.el('div');
      box.style.padding = '16px 18px';
      box.style.fontSize = '13px';
      box.style.lineHeight = '1.6';
      for (const [k, v] of rows) {
        const row = CkUI.el('div');
        row.style.display = 'flex';
        row.style.gap = '12px';
        row.style.padding = '7px 0';
        row.style.borderBottom = '1px solid rgba(127,127,150,.12)';
        const key = CkUI.el('span', '', k);
        key.style.flex = 'none';
        key.style.width = '86px';
        key.style.color = 'var(--ck-muted)';
        const val = CkUI.el('span', '', String(v));
        val.style.flex = '1';
        val.style.wordBreak = 'break-all';
        row.append(key, val);
        box.appendChild(row);
      }
      s.body.appendChild(box);
      s.foot.appendChild(CkUI.el('div', 'ck-spacer'));
      const check = CkUI.el('button', 'ck-primary', '检查更新');
      check.addEventListener('click', async () => {
        check.disabled = true;
        check.textContent = '检查中…';
        const r = await updater.check({ silent: false, force: true });
        check.disabled = false;
        check.textContent = '检查更新';
        if (r.status === 'up-to-date') CkUI.hideBadge();
      });
      const reset = CkUI.el('button', '', '重置资源');
      reset.addEventListener('click', () => updater.resetToShell());
      s.foot.append(reset, check);
    },
  };

  exposeApi(api);

  if (META.role === 'shell') {
    SplashScreen.hide().catch(() => {});
    try {
      await bootstrapShell(META);
    } catch (err) {
      console.error('[ck-shell] bootstrap error', err);
      CkUI.boot.error('启动失败', String(err?.message || err));
      CkUI.boot.actions([{ label: '重试', primary: true, onClick: () => window.location.reload() }]);
    }
    return;
  }

  // 站点页面（由 SW 注入本运行时）：后台检查内容更新
  updater.init();
  SplashScreen.hide().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { main(); }, { once: true });
} else {
  main();
}
