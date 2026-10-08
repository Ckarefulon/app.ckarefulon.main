/**
 * 构建壳运行时 JS（esbuild 打包 src/ → 单文件 IIFE）
 *   role=shell  → .build/shell/ckapp/ck-app.js   （进 APK）
 *   role=bundle → .build/bundle/ckapp/ck-app.js  （进 OTA 资源包，注入到站点每个页面）
 *
 * 用法：
 *   node scripts/build-web.mjs [--role=both|shell|bundle] [--version=1.0.x] [--commit=abc1234]
 */
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import {
  ROOT, ensureDir, rmrf, loadConfig, log, paths, writeJson,
  computeWebVersion, utcStamp, gitMeta,
} from './lib.mjs';
import { mirrorUrl } from './vendor-sync.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const cfg = loadConfig();
const role = argv.role || 'both';
const stamp = utcStamp();
const webVersion = argv.version || computeWebVersion(cfg, stamp);
const appMeta = gitMeta(ROOT);

const shared = {
  appId: cfg.appId,
  appName: cfg.appName,
  nativeVersion: cfg.versionName,
  nativeBuild: cfg.versionCode,
  builtAt: new Date().toISOString(),
  stamp,
  site: { baseUrl: cfg.site.baseUrl },
  ota: {
    enabled: cfg.ota.enabled,
    channel: cfg.ota.channel,
    publishDir: cfg.ota.publishDir || 'app-ota',
    manifestFile: cfg.ota.manifestFile || 'latest.json',
    assetNamePattern: cfg.ota.assetNamePattern || 'www-{version}.zip',
    mirrors: (cfg.ota.mirrors || []).filter((m) => m && m.base && m.enabled !== false && !/你的域名/.test(m.base)),
    originTimeoutMs: cfg.ota.originTimeoutMs || 8000,
    onlineFallbacks: cfg.ota.onlineFallbacks || [],
    checkOnLaunch: cfg.ota.checkOnLaunch !== false,
    checkOnResume: cfg.ota.checkOnResume !== false,
    checkIntervalMinutes: cfg.ota.checkIntervalMinutes ?? 60,
    applyMode: cfg.ota.applyMode || 'next',
    minNativeVersion: cfg.ota.minNativeVersion,
    apkUrls: cfg.ota.apkUrls || [],
    apkReleasesUrl: cfg.ota.apkReleasesUrl,
  },
  bluetooth: cfg.android?.bluetooth || {},
};

const roles = role === 'both' ? ['shell', 'bundle'] : [role];

/* ------------------------------ SW 元数据 ------------------------------ */
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const enabledMirrors = (cfg.ota.mirrors || [])
  .filter((m) => m && m.base && m.enabled !== false && !/你的域名/.test(m.base));
const corsMirrors = enabledMirrors.filter((m) => m.cors !== false);
// cors 标志必须带上：sw.js 的 fetchRemoteCors 靠它跳过没有 ACAO 头的源
// （Gitee raw 就是这种，只能走原生通道）。这里以前把标志丢了，
// 那段跳过逻辑等于不存在。
// html 标志：该源不发 .html（jsDelivr 对 .html 一律 301 给被墙的 raw）。
// HTML 请求跳过它 —— 每个文件省一整轮必失败的超时，也免去打爆 raw 的限流。
const toOrigin = (m) => ({
  name: m.name,
  base: trimSlash(m.base),
  cors: m.cors !== false,
  ignoreQuery: m.ignoreQuery !== false,
  html: m.html !== false,
});
// vendor 依赖的正确 Content-Type（vendor 文件只可能是脚本或样式表）
const VENDOR_CT_BY_EXT = {
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
const vendorCt = (u) => {
  const ext = (new URL(u).pathname.split('.').pop() || '').toLowerCase();
  return VENDOR_CT_BY_EXT[ext] || 'application/javascript; charset=utf-8';
};

/* ------------------------------ 全站文件清单（后台预缓存用） ------------------------------ */
const RUNTIME_EXT = /\.(html?|js|mjs|css|svg|png|jpe?g|gif|webp|ico|json|webmanifest|woff2?|ttf|otf|mp3|wav|ogg|mp4)$/i;
async function fetchAllPaths(cfg) {
  const repoPath = String(cfg.site.repo || '').replace(/\.git$/, '').split('/').slice(-2).join('/');
  const tryJson = async (url, pick) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'ck-build' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return pick(await r.json());
  };
  const sources = [
    {
      name: 'github-api',
      url: `https://api.github.com/repos/${repoPath}/git/trees/${cfg.site.branch || 'main'}?recursive=1`,
      pick: (d) => (d.tree || []).filter((t) => t.type === 'blob').map((t) => t.path),
    },
    {
      name: 'jsdelivr-api',
      url: `https://data.jsdelivr.com/v1/packages/gh/${repoPath}@${cfg.site.branch || 'main'}`,
      pick: (d) => {
        const out = [];
        const walk = (files, prefix) => {
          for (const f of files || []) {
            if (f.type === 'directory') walk(f.files, `${prefix}${f.name}/`);
            else out.push(`${prefix}${f.name}`);
          }
        };
        walk(d.files, '');
        return out;
      },
    },
    {
      // 国内构建时 api.github.com 和 data.jsdelivr.com 都不通，清单拿不到，
      // 后台预缓存就只剩首屏那 6 个核心文件（离线覆盖几乎为零）。
      // Gitee 的 trees 接口字段和 GitHub 一致，放在最后兜底，CI 上的行为不变。
      name: 'gitee-api',
      url: `https://gitee.com/api/v5/repos/${repoPath}/git/trees/${cfg.site.branch || 'main'}?recursive=1`,
      pick: (d) => (d.tree || []).filter((t) => t.type === 'blob').map((t) => t.path),
    },
  ];
  for (const s of sources) {
    try {
      const list = (await tryJson(s.url, s.pick))
        .map((p) => `/${String(p).replace(/^\/+/, '')}`)
        .filter((p) => !p.split('/').some((seg) => seg.startsWith('.')))
        .filter((p) => RUNTIME_EXT.test(p));
      if (list.length) {
        log.info(`全站清单（${s.name}）：${list.length} 个运行时文件`);
        return list.slice(0, 500);
      }
    } catch (e) {
      log.warn(`全站清单获取失败（${s.name}）：${String(e?.message || e).slice(0, 60)}`);
    }
  }
  log.warn('未取得全站清单：后台预缓存将仅覆盖首屏核心');
  return [];
}
const ALL_PATHS = await fetchAllPaths(cfg);

const SW_META = {
  cachePrefix: 'ck',
  originTimeoutMs: cfg.ota?.originTimeoutMs || 8000,
  // 取内容用的源（快的优先）。
  // 这里必须是**全部**启用源，不能只留 cors:true 的那几个：首屏下载走的是原生
  // HTTP（CapacitorHttp），不受 CORS 限制，需不需要 ACAO 头是 sw.js 自己判断的。
  // 只留 CORS 源会把国内唯一可用的 Gitee 排除掉，整条链只剩 jsDelivr，
  // 而 jsDelivr 在国内连不上 → 首启永远下载不到内容。
  origins: [...enabledMirrors].sort((a, b) => (a.fast ?? 9) - (b.fast ?? 9)).map(toOrigin),
  // 探测“有没有更新”用的源（新的优先），同样用全部启用源
  probeOrigins: [...enabledMirrors].sort((a, b) => (a.fresh ?? 9) - (b.fresh ?? 9)).map(toOrigin),
  // 无 CORS 头时的 no-cors 兜底：所有启用源都试一遍（只能救子资源）
  opaqueOrigins: enabledMirrors.map(toOrigin),
  core: [
    '/index.html',
    '/ui/colors_and_type.css',
    '/nav/nav.css',
    '/nav/nav.js',
    '/assets/services/core/site-scope.js',
    '/favicon.svg',
  ],
  allPaths: ALL_PATHS,
  // 每条 CDN 依赖带上国内镜像地址：直连不通时运行时要靠它兜底。
  // 没有它，国内机器上 vendor 必然下载失败——首屏能开，但页面里的库全是死的。
  // ct 一并算好：有的依赖路径没有扩展名（/npm/pkg/+esm），运行时按路径猜 MIME
  // 会猜成 octet-stream，<script type="module"> 就被浏览器拒载了。
  vendor: (cfg.bundle?.vendor?.assets || []).map((a) => ({
    url: a.url,
    mirror: a.mirror || mirrorUrl(a.url),
    ct: vendorCt(a.url),
  })),
  vendorHosts: ['jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh'],
  inject: {
    script: '/ckapp/ck-site.js',
    style: cfg.bundle?.inject?.style || '/ckapp/ck-app.css',
    marker: 'data-ck-runtime',
  },
};
// 壳运行时（bootstrap/updater）需要同一份源信息
shared.sw = SW_META;
writeJson(path.join(paths.build, 'sw-meta.json'), SW_META);

async function buildOne(r) {
  const outDir = path.join(paths.build, r, 'ckapp');
  rmrf(path.join(paths.build, r));
  ensureDir(outDir);

  const meta = {
    ...shared,
    role: r,
    version: r === 'shell' ? cfg.versionName : webVersion,
    commit: argv.commit || appMeta.commit,
    contentVersion: argv['content-version'] || null,
  };

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'ck-app.js')],
    outfile: path.join(outDir, 'ck-app.js'),
    bundle: true,
    format: 'iife',
    target: ['es2020', 'chrome90'],
    platform: 'browser',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      __CK_META__: JSON.stringify(meta),
      'process.env.NODE_ENV': '"production"',
    },
  });

  fs.copyFileSync(path.join(ROOT, 'src', 'ui', 'ck-app.css'), path.join(outDir, 'ck-app.css'));
  writeJson(path.join(outDir, 'ck-version.json'), meta);

  const js = fs.statSync(path.join(outDir, 'ck-app.js')).size;
  log.ok(`${r.padEnd(6)} → ${path.relative(ROOT, outDir)}  (ck-app.js ${(js / 1024).toFixed(1)} KB, v${meta.version})`);
}

log.step('构建壳运行时（esbuild）');
for (const r of roles) {
  await buildOne(r);
}

// sw.js：把仓库内容代理进 WebView 的核心（只进壳）
if (roles.includes('shell')) {
  // 站点角色运行时以 ck-site.js 之名放进壳资源：供 SW 注入到远程页面
  // （壳首页自己用 ck-app.js=壳角色；两者分离，杜绝启动循环）
  const bundleCk = path.join(paths.build, 'bundle', 'ckapp');
  const shellCk = path.join(paths.build, 'shell', 'ckapp');
  if (fs.existsSync(path.join(bundleCk, 'ck-app.js'))) {
    ensureDir(shellCk);
    fs.copyFileSync(path.join(bundleCk, 'ck-app.js'), path.join(shellCk, 'ck-site.js'));
    fs.copyFileSync(path.join(bundleCk, 'ck-version.json'), path.join(shellCk, 'ck-site-version.json'));
  }
  const swOut = path.join(paths.build, 'shell', 'root');
  ensureDir(swOut);
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'sw', 'sw.js')],
    outfile: path.join(swOut, 'sw.js'),
    bundle: true,
    format: 'iife',
    target: ['es2020', 'chrome90'],
    platform: 'browser',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    define: { __CK_SW_META__: JSON.stringify(SW_META) },
  });
  const swBytes = fs.statSync(path.join(swOut, 'sw.js')).size;
  log.ok(`sw     → ${path.relative(ROOT, swOut)}  (sw.js ${(swBytes / 1024).toFixed(1)} KB, 源：${SW_META.origins.map((o) => o.name).join(' → ')})`);
}
