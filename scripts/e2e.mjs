/**
 * 端到端测试（真浏览器）：只测一件事——能不能进首页（以及断网后还能不能进）
 *   1) 起静态服务模拟 Capacitor 本地服务器（http 源，服务 www/）
 *   2) headless Chromium 打开 → 壳启动 → SW 接管 → 真网预缓存 → document.write 落地站点首页
 *   3) 断网 reload → 仍应进入站点首页（离线缓存生效）
 * 用法：node scripts/e2e.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT, log, paths } from './lib.mjs';

const PORT = 8099;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(paths.www, p);
  if (!file.startsWith(paths.www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
log.info(`静态服务已启动：http://127.0.0.1:${PORT}/（模拟 Capacitor 本地服务器）`);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text().slice(0, 160)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e.message).slice(0, 160)}`));

const state = () => page.evaluate(() => ({
  boot: !!document.querySelector('.ck-boot'),
  err: document.querySelector('.ck-boot-err')?.classList.contains('ck-in') || false,
  errText: (document.querySelector('.ck-boot-err')?.textContent || '').slice(0, 200),
  site: !!document.querySelector('.dirTitle') || !!document.querySelector('[data-ck-runtime]'),
  // SW 是否把运行时注入进了站点文档（蓝牙桥/更新检查就靠它）
  injected: !!document.querySelector('[data-ck-runtime]'),
  // 注入的运行时是否真的跑起来了
  runtimeReady: typeof window.CkApp === 'object' && !!window.CkApp,
  stage: (document.querySelector('.ck-boot-stage')?.textContent || '').slice(0, 60),
  ctrl: !!navigator.serviceWorker?.controller,
  url: location.href,
  // SW 的离线兜底页一旦被服务出来，页面就是个点啥都没反应的死页（绝不能出现）
  offlineFallback: (document.body?.innerText || '').includes('当前离线'),
}));

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let s = null;
    try {
      s = await state();
    } catch (e) { /* 导航间隙 evaluate 会失败，等下一轮再取 */ }
    if (s && fn(s)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * 带重试的导航：上一页还在收尾时（阶段 2 刚恢复网络、页面内触发的 reload 还没提交），
 * 新的 goto 会被 Chrome 直接取消（net::ERR_ABORTED）。这不是产品问题，
 * 但会让整道闸门偶发失败、白白阻断出包 —— 连续三次都被取消才算真失败。
 */
async function gotoRetry(url, { tries = 3, ...opts } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await page.goto(url, opts);
    } catch (e) {
      const msg = String(e?.message || e);
      if (i >= tries || !/ERR_ABORTED/i.test(msg)) throw e;
      log.warn(`导航被浏览器取消（上一帧还在收尾），重试 ${i}/${tries - 1}：${msg.slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

let failed = false;
try {
  /* ---- 阶段 1：有网首启 → 必须进入站点首页 ---- */
  log.step('E2E 阶段 1：有网首启，等待进入站点首页…');
  await gotoRetry(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const entered = await waitFor((s) => s.site && !s.boot, 60000);
  const errState = await state();
  if (entered) {
    log.ok(`阶段 1 通过：已进入站点首页（ctrl=${errState.ctrl}，url=${errState.url}）`);
    // 运行时注入是蓝牙桥/更新检查的前提。以前只看响应头里的 Content-Type，
    // jsDelivr 把 .html 给成 text/plain 时注入整个被跳过 —— 这里必须真见着标记。
    if (!errState.injected || !errState.runtimeReady) {
      failed = true;
      log.err(`阶段 1 失败：站点文档里没有注入的运行时（injected=${errState.injected}，runtimeReady=${errState.runtimeReady}）`);
      log.err('  检查 sw.js 的 refreshIntoCache：HTML 判定必须按路径，不能按响应头里的 Content-Type');
    } else {
      log.ok('阶段 1 附加：SW 已把运行时注入进站点文档并成功执行');
    }
  } else {
    failed = true;
    log.err(`阶段 1 失败：60 秒内未进入站点首页`);
    log.err(`  状态：${JSON.stringify(errState)}`);
  }

  /* ---- 阶段 2：断网 reload → 仍应进入站点首页 ---- */
  if (!failed) {
    log.step('E2E 阶段 2：断网 reload，验证离线可进…');
    const client = await page.createCDPSession();
    await client.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    // 由页面内部触发 reload（避免 puppeteer 导航 Promise 在离线模拟下自阻塞），然后轮询等待
    await page.evaluate(() => setTimeout(() => location.reload(), 100)).catch(() => {});
    const t0 = Date.now();
    let offlineOk = null;
    while (Date.now() - t0 < 25000) {
      try {
        const s = await state();
        if (s.site && !s.boot) { offlineOk = s; break; }
      } catch (e) { /* 导航间隙 evaluate 会失败，重试 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (offlineOk) {
      log.ok('阶段 2 通过：断网后仍能进入站点首页（离线缓存生效）');
    } else {
      failed = true;
      const s2 = await state().catch(() => null);
      log.err('阶段 2 失败：断网后无法进入站点首页');
      log.err(`  状态：${JSON.stringify(s2)}`);
    }
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => {});
  }

  /* ---- 阶段 3：点首页的目录卡片 → 必须进真实站点页（绝不能是死页） ---- */
  // 复现过的回归：缓存键按"仓库路径"存（/Cube/index.html），而站点链接写的是
  // 目录（/Cube/），查询串里的 ?v= 也对不上 —— 结果每次点击都落到 SW 的兜底页
  // （没有运行时、点啥都没反应），退出重进还被它接管（WebView 恢复原路径）。
  if (!failed) {
    log.step('E2E 阶段 3：点首页目录卡片，验证能进真实站点页…');
    await gotoRetry(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const home = await waitFor((s) => s.site && !s.boot, 60000);
    if (!home) {
      failed = true;
      log.err(`阶段 3 失败：60 秒内未回到站点首页：${JSON.stringify(await state())}`);
    } else {
      // 记录 SW 发起的"原生桥"广播（点击后由旧文档接收，导航提交前它还活着）
      await page.evaluate(() => {
        window.__ckSwMsgs = [];
        navigator.serviceWorker.addEventListener('message', (ev) => {
          const d = ev.data || {};
          if (d.type === 'ck-fetch-native') window.__ckSwMsgs.push({ t: Date.now(), path: d.pathname });
        });
      }).catch(() => {});
      const t3 = Date.now();
      await page.evaluate(() => document.querySelector('.dirCard')?.click()).catch((e) => log.err(`点击失败：${String(e).slice(0, 120)}`));
      const after = await waitFor((s) => s.site && !s.boot && s.url !== home.url, 20000);
      let st = null;
      let swMsgs = [];
      try {
        st = await state();
        swMsgs = await page.evaluate(() => (window.__ckSwMsgs || []).slice(-5)).catch(() => []);
      } catch (e) { /* 导航间隙 */ }
      if (after && st && !st.offlineFallback) {
        log.ok(`阶段 3 通过：卡片导航进了真实站点页（url=${st.url}，${Date.now() - t3}ms）`);
      } else {
        failed = true;
        st = st || { url: '(导航中)', offlineFallback: null };
        log.err(`阶段 3 失败：点击目录卡片后没有进入真实站点页（url=${st.url}，offlineFallback=${st.offlineFallback}，${Date.now() - t3}ms）`);
        log.err(`  SW广播：${JSON.stringify(swMsgs)}`);
        log.err('  检查：① cacheKeyFor 目录 URL 要归一到 index.html；② SW 的原生通道桥有没有把请求广播给页面、页面有没有回 ck-fetch-native-done');
      }
    }
  }
} catch (e) {
  failed = true;
  log.err(`E2E 异常：${String(e?.message || e).slice(0, 300)}`);
}

if (failed) {
  log.err('---- 页面/ SW 日志（最后 25 条）----');
  for (const l of logs.slice(-25)) log.err('  ' + l);
  try {
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker?.getRegistration();
      const c = await caches?.open('ck-site-v1').then((x) => x.keys().then((k) => k.map((r) => new URL(r.url).pathname))).catch(() => []);
      return { active: reg?.active?.state, waiting: reg?.waiting?.state, ctrl: !!navigator.serviceWorker?.controller, cache: c?.slice(0, 12) };
    });
    log.err('  SW/缓存：' + JSON.stringify(info));
  } catch (e) { /* noop */ }
}

await browser.close().catch(() => {});
try { browser.process()?.kill('SIGKILL'); } catch (e) { /* noop */ }
server.close();
process.exit(failed ? 1 : 0);
