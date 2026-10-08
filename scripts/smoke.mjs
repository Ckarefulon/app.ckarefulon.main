/**
 * 壳运行时冒烟测试：在 jsdom 里真实执行 www/ckapp/ck-app.js（壳角色），
 * 任何 ReferenceError / TypeError 等脚本错误都会让本脚本失败 → 阻断出包。
 * 用法：node scripts/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT, log, paths } from './lib.mjs';

const shellHtmlPath = path.join(paths.www, 'index.html');
const bundlePath = path.join(paths.www, 'ckapp', 'ck-app.js');
if (!fs.existsSync(shellHtmlPath) || !fs.existsSync(bundlePath)) {
  log.die('www/ 尚未生成，请先执行：npm run android:sync（或 node scripts/build-web.mjs && node scripts/sync-shell.mjs）');
}

const dom = new JSDOM(fs.readFileSync(shellHtmlPath, 'utf8'), {
  url: 'https://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

/* ---- 最小运行环境：假的 ServiceWorker / 断网的 fetch ---- */
const workerStub = { postMessage() {} };
Object.defineProperty(window.navigator, 'serviceWorker', {
  configurable: true,
  value: {
    controller: workerStub,
    ready: Promise.resolve({ active: workerStub }),
    register: async () => ({ active: workerStub, update: async () => {} }),
    addEventListener() {},
    removeEventListener() {},
    getRegistration: async () => ({ unregister: async () => {} }),
  },
});
window.fetch = async () => { throw new Error('smoke-offline-stub'); };

/* ---- 捕获所有未处理错误 ---- */
const scriptErrors = [];
window.addEventListener('error', (e) => scriptErrors.push(String(e.message || e)));

const code = fs.readFileSync(bundlePath, 'utf8');
try {
  window.eval(code);
} catch (err) {
  scriptErrors.push(String(err?.message || err));
}

await new Promise((r) => setTimeout(r, 800));

const bootErr = window.document.querySelector('.ck-boot-err')?.textContent || '';
const stage = window.document.querySelector('.ck-boot-stage')?.textContent || '';
const combined = `${bootErr} ${stage} ${scriptErrors.join(' ')}`;

const fatal = combined.match(/(ReferenceError|TypeError|SyntaxError)[^\n]{0,80}|[\w$]+ is not defined|Cannot read properties[^\n]{0,60}|启动失败/g);
if (fatal) {
  log.err(`冒烟测试失败：${fatal.slice(0, 3).join(' | ')}`);
  log.err(`启动页文案：${(bootErr || stage).slice(0, 160)}`);
  process.exit(1);
}

log.ok(`冒烟测试通过：壳运行时无脚本错误（当前文案：${(stage || bootErr).slice(0, 60) || '空'}）`);

/* ---- 第二阶段：站点角色运行时（ck-site.js，注入到远程页面的那份） ---- */
const siteBundle = path.join(paths.www, 'ckapp', 'ck-site.js');
if (fs.existsSync(siteBundle)) {
  const dom2 = new JSDOM('<!doctype html><html><head></head><body><main>site</main></body></html>', {
    url: 'https://localhost/Cube/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom2.window.fetch = async () => { throw new Error('smoke-offline-stub'); };
  const errs2 = [];
  dom2.window.addEventListener('error', (e) => errs2.push(String(e.message || e)));
  try {
    dom2.window.eval(fs.readFileSync(siteBundle, 'utf8'));
  } catch (err) {
    errs2.push(String(err?.message || err));
  }
  await new Promise((r) => setTimeout(r, 800));
  const fatal2 = errs2.join(' ').match(/ReferenceError|TypeError|SyntaxError|is not defined|Cannot read properties/);
  if (fatal2) {
    log.err(`冒烟测试（站点角色）失败：${fatal2[0]} | ${errs2.slice(0, 2).join(' | ')}`);
    process.exit(1);
  }
  log.ok('冒烟测试通过：站点角色运行时（ck-site.js）无脚本错误');
} else {
  log.warn('未找到 www/ckapp/ck-site.js，跳过站点角色冒烟');
}

/* ---- 第三阶段：进入路径（下载成功 → document.write 落地，不应回壳/循环） ---- */
{
  const dom3 = new JSDOM(fs.readFileSync(shellHtmlPath, 'utf8'), {
    url: 'https://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w3 = dom3.window;
  // SW 入缓存前会给站点 HTML 注入运行时（带 data-ck-runtime 标记）——
  // 壳侧的落地门槛就是它：没有标记的文档（壳文档/离线兜底页）绝不能写进来
  const siteHtml = '<!doctype html><html><head><script src="/ckapp/ck-site.js" data-ck-runtime></script></head><body><main>site-content</main></body></html>';
  const listeners3 = new Set();
  const worker3 = {
    postMessage(msg) {
      setImmediate(() => {
        const d = { data: { type: 'ck-cache-put-done', pathname: msg.pathname || msg.key } };
        for (const l of [...listeners3]) l(d);
      });
    },
  };
  Object.defineProperty(w3.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: worker3,
      ready: Promise.resolve({ active: worker3 }),
      register: async () => ({ active: worker3, update: async () => {} }),
      addEventListener: (t, h) => listeners3.add(h),
      removeEventListener: (t, h) => listeners3.delete(h),
      getRegistration: async () => ({ unregister: async () => {} }),
    },
  });
  w3.fetch = async (url) => {
    const u = String(url);
    // 注意：jsdom 没有 window.Response，用 Node 的 Response 构造响应体
    if (u === '/' || u === 'https://localhost/') return new Response(siteHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response(u.endsWith('.css') ? 'body{}' : 'void 0;', { status: 200, headers: { 'Content-Type': u.endsWith('.css') ? 'text/css' : 'application/javascript' } });
  };
  if (typeof w3.AbortSignal?.timeout !== 'function') w3.AbortSignal = AbortSignal;
  const errs3 = [];
  w3.addEventListener('error', (e) => errs3.push(String(e.message || e)));
  // jsdom 不实现运行期 document.write：用间谍断言"进入路径"确实落地了站点文档
  let writtenSite = false;
  const origWrite = w3.document.write ? w3.document.write.bind(w3.document) : null;
  w3.document.write = (t) => { if (String(t).includes('site-content')) writtenSite = true; return origWrite ? origWrite(t) : undefined; };
  try { w3.eval(fs.readFileSync(bundlePath, 'utf8')); } catch (e) { errs3.push(String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, 2500));
  const doc3 = w3.document;
  const entered = writtenSite || (!!doc3.querySelector('main') && !doc3.querySelector('.ck-boot'));
  const fatal3 = errs3.join(' ').match(/ReferenceError|TypeError|SyntaxError|is not defined|Cannot read properties/);
  if (fatal3) {
    log.err(`冒烟测试（进入路径）失败：${fatal3[0]} | ${errs3.slice(0, 2).join(' | ')}`);
    process.exit(1);
  }
  if (!entered) {
    log.err(`冒烟测试（进入路径）失败：未能落地站点文档（仍在壳/启动页）`);
    log.err(`  body 片段：${(doc3.body?.innerHTML || '').slice(0, 140).replace(/\s+/g, ' ')}`);
    log.err(`  错误：${errs3.slice(0, 3).join(' | ') || '无'}`);
    process.exit(1);
  }
  log.ok('冒烟测试通过：进入路径正常（document.write 落地站点文档，无循环）');

  // 3b) 没有运行时标记的文档（壳文档 / SW 离线兜底页）绝不能被当成站点落地：
  //     否则用户会停在一个点啥都没反应的死页上，退出重进还是它
  const dom3b = new JSDOM(fs.readFileSync(shellHtmlPath, 'utf8'), {
    url: 'https://localhost/Cube/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w3b = dom3b.window;
  const listeners3b = new Set();
  const worker3b = { postMessage() {} };
  Object.defineProperty(w3b.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: worker3b,
      ready: Promise.resolve({ active: worker3b }),
      register: async () => ({ active: worker3b, update: async () => {} }),
      addEventListener: (t, h) => listeners3b.add(h),
      removeEventListener: (t, h) => listeners3b.delete(h),
      getRegistration: async () => ({ unregister: async () => {} }),
    },
  });
  // 模拟 SW 的两种坏响应：兜底页（没有运行时标记）和壳文档（带 .ck-boot）。
  // 顺手把网络置为离线：跳过 40 秒的预缓存等待，直接走"进站"分支
  Object.defineProperty(w3b.navigator, 'onLine', { configurable: true, value: false });
  w3b.fetch = async (url) => {
    const u = String(url);
    const shellLike = '<!doctype html><html><head><title>Ckarefulon</title></head><body><div class="ck-boot"></div></body></html>';
    return new Response(u.includes('ck-boot') || true ? shellLike : shellLike, { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  if (typeof w3b.AbortSignal?.timeout !== 'function') w3b.AbortSignal = AbortSignal;
  let wrote3b = false;
  const orig3b = w3b.document.write ? w3b.document.write.bind(w3b.document) : null;
  w3b.document.write = (t) => { wrote3b = true; return orig3b ? orig3b(t) : undefined; };
  try { w3b.eval(fs.readFileSync(bundlePath, 'utf8')); } catch (e) { /* 壳报错属预期 */ }
  await new Promise((r) => setTimeout(r, 6000));
  const err3b = w3b.document.querySelector('.ck-boot-err')?.textContent || '';
  if (wrote3b) {
    log.err('冒烟测试（落地门槛）失败：没有运行时标记的文档被写进来了（会变成死页）');
    process.exit(1);
  }
  if (!err3b.includes('没拿到') && !err3b.includes('站点')) {
    log.err(`冒烟测试（落地门槛）失败：没有如实报错并给出重试（实际：${err3b.slice(0, 120)}）`);
    process.exit(1);
  }
  log.ok('冒烟测试通过：无运行时标记的兜底/壳文档不会被落地（如实报错 + 重试）');
}

/* ---- 3c) 本地缓存齐了就不再重复预缓存，直接进站（"每次打开都要重缓存一次"的回归） ---- */
{
  const dom3c = new JSDOM(fs.readFileSync(shellHtmlPath, 'utf8'), {
    url: 'https://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w3c = dom3c.window;
  const listeners3c = new Set();
  const swMsgs3c = [];
  const worker3c = {
    postMessage(msg) {
      swMsgs3c.push(msg?.type || '?');
      setImmediate(() => {
        const d = { data: { type: 'ck-cache-put-done', pathname: msg.pathname || msg.key } };
        for (const l of [...listeners3c]) l(d);
      });
    },
  };
  Object.defineProperty(w3c.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: worker3c,
      ready: Promise.resolve({ active: worker3c }),
      register: async () => ({ active: worker3c, update: async () => {} }),
      addEventListener: (t, h) => listeners3c.add(h),
      removeEventListener: (t, h) => listeners3c.delete(h),
      getRegistration: async () => ({ unregister: async () => {} }),
    },
  });
  // 缓存"什么都有"：缺的清单应为空 → 整轮预缓存必须被跳过
  w3c.caches = {
    open: async () => ({ match: async () => new Response('cached', { headers: { 'Content-Type': 'text/html' } }) }),
  };
  const siteHtml3c = '<!doctype html><html><head><script src="/ckapp/ck-site.js" data-ck-runtime></script></head><body><main>site-content-fast</main></body></html>';
  w3c.fetch = async (url) => {
    const u = String(url);
    if (u === '/' || u === 'https://localhost/') return new Response(siteHtml3c, { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response(u.endsWith('.css') ? 'body{}' : 'void 0;', { status: 200, headers: { 'Content-Type': u.endsWith('.css') ? 'text/css' : 'application/javascript' } });
  };
  if (typeof w3c.AbortSignal?.timeout !== 'function') w3c.AbortSignal = AbortSignal;
  const errs3c = [];
  w3c.addEventListener('error', (e) => errs3c.push(String(e.message || e)));
  let written3c = false;
  const orig3c = w3c.document.write ? w3c.document.write.bind(w3c.document) : null;
  w3c.document.write = (t) => { if (String(t).includes('site-content-fast')) written3c = true; return orig3c ? orig3c(t) : undefined; };
  try { w3c.eval(fs.readFileSync(bundlePath, 'utf8')); } catch (e) { errs3c.push(String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, 2000));
  const fatal3c = errs3c.join(' ').match(/ReferenceError|TypeError|SyntaxError|is not defined|Cannot read properties/);
  if (fatal3c) {
    log.err(`冒烟测试（秒进路径）失败：${fatal3c[0]}`);
    process.exit(1);
  }
  if (!written3c) {
    log.err('冒烟测试（秒进路径）失败：缓存齐了却没有直接进站');
    process.exit(1);
  }
  const cachePuts3c = swMsgs3c.filter((t) => t === 'ck-cache-put');
  if (cachePuts3c.length) {
    log.err(`冒烟测试（秒进路径）失败：缓存已齐仍发起了 ${cachePuts3c.length} 次预缓存（每次打开都重缓存一次的回归）`);
    process.exit(1);
  }
  log.ok('冒烟测试通过：缓存齐了直接进站，不重复预缓存');
}

/* ---- 3d) 热启动快通道：缓存齐全 → 静默秒进，全程不闪"正在安装/正在缓存"文案 ---- */
// 用户回执：退出再进入会闪一下缓存界面。快通道直接读 CacheStorage 落地站点文档，
// 不更新任何启动页文案、不发一次网络请求、不触发一次预缓存。
{
  const dom3d = new JSDOM(fs.readFileSync(shellHtmlPath, 'utf8'), {
    url: 'https://localhost/Cube/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w3d = dom3d.window;
  const listeners3d = new Set();
  const swMsgs3d = [];
  const worker3d = {
    postMessage(msg) {
      swMsgs3d.push(msg?.type || '?');
      setImmediate(() => {
        const d = { data: { type: 'ck-cache-put-done', pathname: msg.pathname || msg.key } };
        for (const l of [...listeners3d]) l(d);
      });
    },
  };
  Object.defineProperty(w3d.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: worker3d,
      ready: Promise.resolve({ active: worker3d }),
      register: async () => ({ active: worker3d, update: async () => {} }),
      addEventListener: (t, h) => listeners3d.add(h),
      removeEventListener: (t, h) => listeners3d.delete(h),
      getRegistration: async () => ({ unregister: async () => {} }),
    },
  });
  // 缓存"什么都有"，入口文档带运行时标记（SW 入缓存前注入的）→ 应走快通道直接落地
  const cachedDoc3d = '<!doctype html><html><head><script src="/ckapp/ck-site.js" data-ck-runtime></script></head><body><main>warm-site</main></body></html>';
  w3d.caches = {
    open: async () => ({ match: async () => new Response(cachedDoc3d, { headers: { 'Content-Type': 'text/html' } }) }),
  };
  // 快通道一次网络请求都不该发：发了就记下来（作为失败证据），并让它失败
  const fetched3d = [];
  w3d.fetch = async (url) => { fetched3d.push(String(url)); throw new Error('smoke-fast-path-should-not-fetch'); };
  if (typeof w3d.AbortSignal?.timeout !== 'function') w3d.AbortSignal = AbortSignal;
  const errs3d = [];
  w3d.addEventListener('error', (e) => errs3d.push(String(e.message || e)));
  let written3d = '';
  const orig3d = w3d.document.write ? w3d.document.write.bind(w3d.document) : null;
  w3d.document.write = (t) => { written3d = String(t); return orig3d ? orig3d(t) : undefined; };
  try { w3d.eval(fs.readFileSync(bundlePath, 'utf8')); } catch (e) { errs3d.push(String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, 1500));
  const fatal3d = errs3d.join(' ').match(/ReferenceError|TypeError|SyntaxError|is not defined|Cannot read properties/);
  if (fatal3d) {
    log.err(`冒烟测试（热启动快通道）失败：${fatal3d[0]} | ${errs3d.slice(0, 2).join(' | ')}`);
    process.exit(1);
  }
  if (!written3d.includes('warm-site')) {
    log.err(`冒烟测试（热启动快通道）失败：缓存齐全却没有直接落地站点文档（fetch 记录：${fetched3d.slice(0, 3).join(' | ') || '无'}）`);
    process.exit(1);
  }
  const stage3d = w3d.document.querySelector('.ck-boot-stage');
  if (stage3d && stage3d.textContent && !/正在启动/.test(stage3d.textContent)) {
    log.err(`冒烟测试（热启动快通道）失败：静默秒进却闪了文案「${stage3d.textContent}」（退出重进闪缓存界面的回归）`);
    process.exit(1);
  }
  if (fetched3d.length) {
    log.err(`冒烟测试（热启动快通道）失败：快通道不该发任何网络请求（实际：${fetched3d.slice(0, 3).join(' | ')}）`);
    process.exit(1);
  }
  if (swMsgs3d.includes('ck-cache-put')) {
    log.err('冒烟测试（热启动快通道）失败：缓存齐全仍触发了预缓存');
    process.exit(1);
  }
  log.ok('冒烟测试通过：热启动快通道（缓存齐全静默秒进，不闪文案、零请求、零预缓存）');
}

/* ---- 第四阶段：确认框 / 设备选择器必须正确回值（jsdom 真点按钮） ---- */
{
  const dom4 = new JSDOM(fs.readFileSync(shellHtmlPath, 'utf8'), {
    url: 'https://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w4 = dom4.window;
  const errs4 = [];
  w4.addEventListener('error', (e) => errs4.push(String(e.message || e)));
  try { w4.eval(code); } catch (e) { errs4.push(String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, 400));

  const settle = (p, ms = 400) => Promise.race([
    p.then((v) => ({ settled: true, value: v })).catch((e) => ({ settled: true, rejected: true, name: e?.name })),
    new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
  ]);
  const wipe = () => [...w4.document.querySelectorAll('.ck-root > *')].forEach((n) => n.remove());
  const ui = w4.CkApp?.ui;
  if (!ui) {
    log.err('冒烟测试（UI 收口）失败：壳运行时没有暴露 window.CkApp');
    process.exit(1);
  }

  // 确认框：点"确定"必须返回 true（以前永远 false，"重置资源"点了没反应）
  {
    const p = ui.confirm({ title: 't', message: 'm', okLabel: '确定', cancelLabel: '取消' });
    const ok = [...w4.document.querySelectorAll('.ck-sheet-foot button')].find((b) => b.textContent === '确定');
    ok.click();
    await new Promise((r) => setTimeout(r, 60));
    const r = await settle(p);
    if (!r.settled || r.value !== true) {
      log.err(`冒烟测试（UI 收口）失败：确认框点"确定"返回 ${JSON.stringify(r)}`);
      process.exit(1);
    }
    wipe();
  }
  // 确认框：点 ✕ / 遮罩 / Esc 必须返回 false，不能挂着
  for (const how of ['x', 'overlay', 'esc']) {
    const p = ui.confirm({ title: 't', message: 'm', okLabel: '确定', cancelLabel: '取消' });
    await new Promise((r) => setTimeout(r, 60));
    const overlay = w4.document.querySelector('.ck-overlay');
    if (how === 'x') [...w4.document.querySelectorAll('.ck-x')].forEach((b) => b.click());
    else if (how === 'overlay') overlay.click();
    else w4.document.dispatchEvent(new w4.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 60));
    const r = await settle(p);
    if (!r.settled || r.value !== false) {
      log.err(`冒烟测试（UI 收口）失败：确认框通过 ${how} 关闭返回 ${JSON.stringify(r)}`);
      process.exit(1);
    }
    wipe();
  }

  // 设备选择器：✕ / 遮罩 / Esc 都必须把 requestDevice() 的 promise reject 掉
  // （以前只有 cancel() 能 reject，用户点 ✕ 后站点连接流程永远挂在转圈）
  for (const how of ['x', 'overlay', 'esc']) {
    const p = ui.devicePicker({ title: '选择设备' });
    p.result.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    const overlay = w4.document.querySelector('.ck-overlay');
    if (how === 'x') [...w4.document.querySelectorAll('.ck-x')].forEach((b) => b.click());
    else if (how === 'overlay') overlay.click();
    else w4.document.dispatchEvent(new w4.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 60));
    const r = await settle(p.result);
    if (!r.settled || !r.rejected || r.name !== 'NotFoundError') {
      log.err(`冒烟测试（UI 收口）失败：设备选择器通过 ${how} 关闭后 requestDevice() ${JSON.stringify(r)}`);
      process.exit(1);
    }
    wipe();
  }
  // 设备选择器：选中设备必须 resolve（且不被 onClose 反转成取消）
  {
    const p = ui.devicePicker({ title: '选择设备' });
    p.result.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    p.push({ deviceId: 'AA:BB', name: '魔方', rssi: -50 });
    const row = w4.document.querySelector('.ck-dev');
    if (!row) { log.err('冒烟测试（UI 收口）失败：设备选择器没有渲染出设备行'); process.exit(1); }
    row.click();
    await new Promise((r) => setTimeout(r, 60));
    const r = await settle(p.result);
    if (!r.settled || r.rejected || r.value?.deviceId !== 'AA:BB') {
      log.err(`冒烟测试（UI 收口）失败：选中设备后返回 ${JSON.stringify(r)}`);
      process.exit(1);
    }
    wipe();
  }

  const fatal4 = errs4.join(' ').match(/ReferenceError|TypeError|SyntaxError|is not defined|Cannot read properties/);
  if (fatal4) {
    log.err(`冒烟测试（UI 收口）失败：${fatal4[0]} | ${errs4.slice(0, 2).join(' | ')}`);
    process.exit(1);
  }
  log.ok('冒烟测试通过：确认框 / 设备选择器在所有关闭路径上都能正确回值');
}

/* ---- 第五阶段：更新流程（产品要求：先正常打开，后台下载，下完弹确认刷新框） ---- */
// 用壳角色那份运行时（它不会自动跑更新检查，测试完全可控；更新逻辑两个角色同一份源码）。
// 断言四件事：① 发现更新后先弹「正在下载更新」；② 下载完成后弹确认刷新框（可"稍后再说"）；
// ③ 全程页面正文没被动过（不阻拦正常打开）；④ 只下了一半时不弹框、也不写新指纹（下次会重试）。
{
  const dom5 = new JSDOM('<!doctype html><html><head></head><body><main>site-page</main></body></html>', {
    url: 'https://localhost/Cube/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w5 = dom5.window;
  const listeners5 = new Set();
  const puts5 = [];
  const worker5 = {
    postMessage(msg) {
      if (msg?.type === 'ck-cache-put') puts5.push(msg.pathname || msg.key);
      setImmediate(() => {
        const d = { data: { type: 'ck-cache-put-done', pathname: msg?.pathname || msg?.key, key: msg?.key } };
        for (const l of [...listeners5]) l(d);
      });
    },
  };
  Object.defineProperty(w5.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: worker5,
      ready: Promise.resolve({ active: worker5 }),
      register: async () => ({ active: worker5, update: async () => {} }),
      addEventListener: (t, h) => listeners5.add(h),
      removeEventListener: (t, h) => listeners5.delete(h),
      getRegistration: async () => ({ unregister: async () => {} }),
    },
  });
  if (typeof w5.AbortSignal?.timeout !== 'function') w5.AbortSignal = AbortSignal;

  // 探测源：换正文 = 有更新（源不给 ETag 时按正文哈希当指纹）
  let probeBody = '<html>content-v1</html>';
  let failRe = null; // 命中就让下载失败（模拟只下了一半）
  w5.fetch = async (url) => {
    const u = String(url);
    if (/\/index\.html(\?|$)/.test(u)) {
      return new Response(probeBody, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (failRe && failRe.test(u)) throw new Error('smoke-update-partial');
    return new Response(u.endsWith('.css') ? 'body{}' : 'void 0;', {
      status: 200,
      headers: { 'Content-Type': u.endsWith('.css') ? 'text/css' : 'application/javascript' },
    });
  };

  // download() 的第三条通道是 XHR：不桩掉的话 jsdom 会真的去联网
  // （测试里既慢又不稳定，"只下了一半"这个场景会被真实网络救回来）
  w5.XMLHttpRequest = function () {
    return {
      open() {}, setRequestHeader() {}, abort() {},
      send() { setTimeout(() => { if (this.onerror) this.onerror(new Error('smoke-xhr-off')); }, 0); },
    };
  };

  const errs5 = [];
  w5.addEventListener('error', (e) => errs5.push(String(e.message || e)));
  try { w5.eval(fs.readFileSync(bundlePath, 'utf8')); } catch (e) { errs5.push(String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, 400));

  const api5 = w5.CkApp;
  if (!api5?.update?.check) {
    log.err('冒烟测试（更新流程）失败：运行时没有暴露 CkApp.update.check');
    process.exit(1);
  }
  // 第一次检查：写入指纹，判定"已是最新"
  const first5 = await api5.update.check({ silent: true, force: true });
  const fp1 = w5.localStorage.getItem('ck.remote.etag.index');
  if (first5.status !== 'up-to-date' || !fp1) {
    log.err(`冒烟测试（更新流程）失败：首次检查应写入指纹并判定最新（实际 ${JSON.stringify(first5)}，指纹=${fp1}）`);
    process.exit(1);
  }

  // 换正文 → 应判定有更新：先弹"正在下载更新"，下完弹确认刷新框
  probeBody = '<html>content-v2</html>';
  const seen5 = [];
  const poll5 = setInterval(() => {
    const t = w5.document.querySelector('.ck-toast .ck-msg')?.textContent;
    if (t && seen5[seen5.length - 1] !== t) seen5.push(t);
  }, 15);
  const checking5 = api5.update.check({ silent: true, force: true });
  let sheetTitle5 = '';
  let btns5 = null;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    sheetTitle5 = w5.document.querySelector('.ck-sheet-title')?.textContent || '';
    if (sheetTitle5.includes('更新已下载完成')) {
      btns5 = [...w5.document.querySelectorAll('.ck-sheet-foot button')];
      break;
    }
  }
  clearInterval(poll5);
  if (!seen5.some((t) => t.includes('正在下载更新'))) {
    log.err(`冒烟测试（更新流程）失败：下载期间没有"正在下载更新"提示（看到的：${seen5.join(' | ') || '无'}）`);
    process.exit(1);
  }
  if (!puts5.length) {
    log.err('冒烟测试（更新流程）失败：判定有更新却没有真的下载内容');
    process.exit(1);
  }
  if (!btns5) {
    log.err(`冒烟测试（更新流程）失败：下载完成后没有弹出确认刷新的框（当前抽屉标题：${sheetTitle5 || '无'}）`);
    process.exit(1);
  }
  const later5 = btns5.find((b) => b.textContent === '稍后再说');
  if (!later5) {
    log.err(`冒烟测试（更新流程）失败：确认框没有"稍后再说"（按钮：${btns5.map((b) => b.textContent).join('/')}）`);
    process.exit(1);
  }
  later5.click();
  const r5 = await checking5;
  // 等确认框真的从 DOM 撤掉（关闭有 220ms 动画），
  // 否则下一个场景会把它的残留误判成"只下了一半也弹框"
  for (let i = 0; i < 60 && w5.document.querySelector('.ck-sheet-title'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (r5.status !== 'updated' || !r5.downloaded || r5.refreshed !== false) {
    log.err(`冒烟测试（更新流程）失败：点"稍后再说"后应原样返回不刷新（实际 ${JSON.stringify(r5)}）`);
    process.exit(1);
  }
  if (w5.localStorage.getItem('ck.remote.etag.index') === fp1) {
    log.err('冒烟测试（更新流程）失败：下载完成后指纹没更新（会反复提示同一个版本）');
    process.exit(1);
  }
  // 不阻拦页面：正文还在，没有错误页
  if (w5.document.querySelector('main')?.textContent !== 'site-page' || w5.document.querySelector('.ck-boot-err')) {
    log.err('冒烟测试（更新流程）失败：更新过程动到了页面本身（应全程不阻拦）');
    process.exit(1);
  }

  // 只下了一半：不弹确认框、不写新指纹（下次检查会重试）
  probeBody = '<html>content-v3</html>';
  failRe = /nav\.css/;
  const fpBefore5 = w5.localStorage.getItem('ck.remote.etag.index');
  const r5b = await api5.update.check({ silent: true, force: true });
  failRe = null;
  if (r5b.status !== 'updated' || r5b.downloaded) {
    log.err(`冒烟测试（更新流程）失败：下载不完整时应报 partial（实际 ${JSON.stringify(r5b)}）`);
    process.exit(1);
  }
  if (w5.document.querySelector('.ck-sheet-title')) {
    log.err('冒烟测试（更新流程）失败：只下了一半却弹出了确认刷新的框');
    process.exit(1);
  }
  if (w5.localStorage.getItem('ck.remote.etag.index') !== fpBefore5) {
    log.err('冒烟测试（更新流程）失败：只下了一半却写了新指纹（用户会永远看不到新版）');
    process.exit(1);
  }

  // 断点续传：半截时进度必须已落盘（用户回执"更一半停了，退出再进又从头下"的回归）
  const progRaw5 = w5.localStorage.getItem('ck.update.progress');
  let prog5 = null;
  try { prog5 = JSON.parse(progRaw5 || 'null'); } catch (e) { /* noop */ }
  if (!prog5 || !Array.isArray(prog5.done) || !prog5.done.length) {
    log.err(`冒烟测试（更新流程）失败：只下了一半却没有保存续传进度（实际：${String(progRaw5).slice(0, 80)}）`);
    process.exit(1);
  }

  // 同一指纹再检查（模拟退出重进/切页后重来）：只补缺的文件，已下过的绝不重下
  const putsBefore5 = puts5.length;
  const checking5c = api5.update.check({ silent: true, force: true });
  let sheetTitle5c = '';
  let btns5c = null;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    sheetTitle5c = w5.document.querySelector('.ck-sheet-title')?.textContent || '';
    if (sheetTitle5c.includes('更新已下载完成')) {
      btns5c = [...w5.document.querySelectorAll('.ck-sheet-foot button')];
      break;
    }
  }
  btns5c?.find((b) => b.textContent === '稍后再说')?.click();
  const r5c = await checking5c;
  if (r5c.status !== 'updated' || !r5c.downloaded) {
    log.err(`冒烟测试（更新流程）失败：续传轮补齐后应判定下载完成（实际 ${JSON.stringify(r5c)}）`);
    process.exit(1);
  }
  const newPuts5 = puts5.slice(putsBefore5);
  if (!newPuts5.length) {
    log.err('冒烟测试（更新流程）失败：续传轮什么都没下载（上次失败的 nav.css 没补）');
    process.exit(1);
  }
  const redone5 = newPuts5.filter((p) => prog5.done.includes(p));
  if (redone5.length) {
    log.err(`冒烟测试（更新流程）失败：续传轮重下了 ${redone5.length} 个已下载的文件（又从头开始）：${redone5.slice(0, 3).join(', ')}`);
    process.exit(1);
  }
  if (!newPuts5.every((p) => /nav\.css/.test(String(p)))) {
    log.err(`冒烟测试（更新流程）失败：续传轮应只补上次失败的 nav.css，实际下了：${newPuts5.slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  if (w5.localStorage.getItem('ck.update.progress')) {
    log.err('冒烟测试（更新流程）失败：下载全量完成后没清掉续传进度记录');
    process.exit(1);
  }
  if (w5.localStorage.getItem('ck.remote.etag.index') === fpBefore5) {
    log.err('冒烟测试（更新流程）失败：续传补齐后指纹仍未写入');
    process.exit(1);
  }
  // 等确认框从 DOM 撤掉，别影响后面的断言
  for (let i = 0; i < 60 && w5.document.querySelector('.ck-sheet-title'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const fatal5 = errs5.join(' ').match(/ReferenceError|TypeError|SyntaxError|is not defined|Cannot read properties/);
  if (fatal5) {
    log.err(`冒烟测试（更新流程）失败：${fatal5[0]} | ${errs5.slice(0, 2).join(' | ')}`);
    process.exit(1);
  }
  log.ok('冒烟测试通过：更新流程（下载提示 → 下完确认刷新 → 不阻拦页面 → 半截不写指纹）');
}

process.exit(0);
