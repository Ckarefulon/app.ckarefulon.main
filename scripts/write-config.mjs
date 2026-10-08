/**
 * 由 app.config.json 生成 capacitor.config.json（单一数据源，避免两处不同步）
 * 用法：node scripts/write-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, writeJson, log, paths, ROOT } from './lib.mjs';

const cfg = loadConfig();
const android = cfg.android || {};

const allowNavigation = [];
const pushHost = (u) => {
  try {
    const h = new URL(u).hostname;
    if (!allowNavigation.includes(h)) allowNavigation.push(h);
  } catch (e) { /* noop */ }
};
pushHost(cfg.site.baseUrl);
for (const m of cfg.ota?.mirrors || []) pushHost(m.base);
for (const u of cfg.ota?.onlineFallbacks || []) pushHost(u);

const out = {
  appId: cfg.appId,
  appName: cfg.appName,
  webDir: cfg.shell?.webDir || 'www',
  server: {
    androidScheme: cfg.android?.webScheme || 'https',
    cleartext: (cfg.android?.webScheme || 'https') === 'http',
    allowNavigation,
  },
  android: {
    allowMixedContent: false,
    // captureInput=true 会把 WebView 的输入连接换成 BaseInputConnection（假实现）：
    // 中文输入法的组合输入/上屏会出各种怪象（打进来的字不显示、候选词丢字）。
    // 这本是给"硬件键盘/特殊设备"兜底的开关，软键盘场景必须关。
    captureInput: false,
    backgroundColor: android.backgroundColor || '#161328',
  },
  plugins: {
    SplashScreen: {
      launchShowDelay: 200,
      launchAutoHide: true,
      backgroundColor: android.backgroundColor || '#161328',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: android.backgroundColor || '#161328',
    },
    CapacitorUpdater: {
      // 关闭 Capgo 云：完全走我们自己的 GitHub Pages 清单
      autoUpdate: false,
      statsUrl: '',
      autoDeleteFailed: true,
      autoDeletePrevious: true,
      resetWhenUpdate: true,
      directUpdate: false,
      appReadyTimeout: 15000,
      responseTimeout: 30,
      periodCheckDelay: 0,
      // 热更新重载后保留当前页面路径（多页站点体验关键）
      keepUrlPathAfterReload: true,
      disableJSLogging: false,
      shakeMenu: false,
    },
    BluetoothLe: {
      displayStrings: {
        scanning: '正在搜索设备…',
        cancel: '取消',
        availableDevices: '可用设备',
        noDeviceFound: '未发现设备',
      },
    },
  },
};

const file = path.join(ROOT, 'capacitor.config.json');
writeJson(file, out);
log.ok(`已生成 ${path.relative(ROOT, file)}（appId=${out.appId}，webDir=${out.webDir}）`);

// 顺手确保 webDir 存在，否则 `cap add/sync` 会报错
fs.mkdirSync(path.join(ROOT, out.webDir), { recursive: true });
