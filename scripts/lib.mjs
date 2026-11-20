/**
 * 构建脚本公共库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pm from 'picomatch';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/* ------------------------------ 日志 ------------------------------ */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[36m', bold: '\x1b[1m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : s);

export const log = {
  step: (msg) => console.log(`\n${paint(C.blue + C.bold, '▶')} ${paint(C.bold, msg)}`),
  info: (msg) => console.log(`  ${paint(C.dim, '·')} ${msg}`),
  ok: (msg) => console.log(`  ${paint(C.green, '✓')} ${msg}`),
  warn: (msg) => console.warn(`  ${paint(C.yellow, '!')} ${msg}`),
  err: (msg) => console.error(`  ${paint(C.red, '✗')} ${msg}`),
  die: (msg, code = 1) => { console.error(`\n${paint(C.red + C.bold, '构建失败：')} ${msg}\n`); process.exit(code); },
};

/* ------------------------------ 配置 ------------------------------ */
export function loadConfig() {
  const file = path.join(ROOT, 'app.config.json');
  if (!fs.existsSync(file)) log.die(`找不到 ${file}`);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 环境变量覆盖（CI 用）
  const env = process.env;
  if (env.CK_VERSION_NAME) cfg.versionName = env.CK_VERSION_NAME;
  if (env.CK_VERSION_CODE) cfg.versionCode = Number(env.CK_VERSION_CODE);
  if (env.CK_APP_ID) cfg.appId = env.CK_APP_ID;
  if (env.CK_APP_NAME) cfg.appName = env.CK_APP_NAME;
  if (env.CK_SITE_LOCAL) cfg.site.localPath = env.CK_SITE_LOCAL;
  if (env.CK_OTA_MANIFEST) cfg.ota.manifestUrl = env.CK_OTA_MANIFEST;
  return cfg;
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/* ------------------------------ 文件工具 ------------------------------ */
export function rmrf(target) { fs.rmSync(target, { recursive: true, force: true }); }
export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

export function copyTree(src, dest, { filter } = {}) {
  let count = 0;
  const walk = (s, d) => {
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      ensureDir(d);
      for (const name of fs.readdirSync(s)) {
        if (filter && filter(path.join(s, name), name, true) === false) continue;
        walk(path.join(s, name), path.join(d, name));
      }
    } else {
      if (filter && filter(s, path.basename(s), false) === false) return;
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
      count++;
    }
  };
  walk(src, dest);
  return count;
}

export function sha256File(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

export function fileSize(file) { return fs.statSync(file).size; }

/** 列出目录下所有文件（相对路径，POSIX 分隔符） */
export function listFiles(dir, { skipHiddenDirs = false } = {}) {
  const out = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      const abs = path.join(cur, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (skipHiddenDirs && name.startsWith('.')) continue;
        walk(abs, r);
      } else if (st.isFile()) {
        out.push(r);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

/** 按 include/exclude（picomatch 语法）筛选相对路径 */
export function makeMatcher(include = ['**/*'], exclude = []) {
  const inc = include.map((p) => pm(p, { dot: true }));
  const exc = exclude.map((p) => pm(p, { dot: true }));
  return (rel) => {
    const p = rel.split(path.sep).join('/');
    if (exc.some((m) => m(p))) return false;
    if (!inc.length) return true;
    return inc.some((m) => m(p));
  };
}

/* ------------------------------ Git ------------------------------ */
export function git(args, cwd = ROOT, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

export function gitMeta(cwd) {
  try {
    return {
      commit: git(['rev-parse', '--short', 'HEAD'], cwd),
      commitFull: git(['rev-parse', 'HEAD'], cwd),
      date: git(['log', '-1', '--format=%cI'], cwd),
      subject: git(['log', '-1', '--format=%s'], cwd),
    };
  } catch (e) {
    return { commit: 'unknown', commitFull: 'unknown', date: new Date().toISOString(), subject: '' };
  }
}

/** 站点源码目录：优先用本地克隆，否则自动 clone 到 .cache/site */
export function resolveSiteDir(cfg) {
  const local = path.isAbsolute(cfg.site.localPath)
    ? cfg.site.localPath
    : path.resolve(ROOT, cfg.site.localPath);

  if (fs.existsSync(path.join(local, '.git')) || fs.existsSync(path.join(local, 'index.html'))) {
    if (process.env.CK_SITE_PULL !== '0' && fs.existsSync(path.join(local, '.git'))) {
      try {
        git(['fetch', '--depth', '1', 'origin', cfg.site.branch || 'main'], local, { timeout: 120000 });
        git(['reset', '--hard', 'FETCH_HEAD'], local);
        log.info(`已同步站点源码 → ${git(['rev-parse', '--short', 'HEAD'], local)}`);
      } catch (e) {
        log.warn(`站点源码同步失败，使用本地现有内容：${e.message?.split('\n')[0]}`);
      }
    }
    return local;
  }

  const cacheDir = path.join(ROOT, '.cache', 'site');
  if (fs.existsSync(path.join(cacheDir, '.git'))) {
    git(['fetch', '--depth', '1', 'origin', cfg.site.branch || 'main'], cacheDir, { timeout: 180000 });
    git(['reset', '--hard', 'FETCH_HEAD'], cacheDir);
    return cacheDir;
  }

  ensureDir(path.dirname(cacheDir));
  rmrf(cacheDir);
  // 按顺序尝试仓库地址（默认 Gitee 优先，GitHub 兜底）
  const repos = [process.env.CK_SITE_REPO, cfg.site.repo, cfg.site.repoFallback].filter(Boolean);
  let lastErr = null;
  for (const repo of repos) {
    try {
      log.info(`克隆站点源码：${repo}`);
      git(['clone', '--depth', '1', '--branch', cfg.site.branch || 'main', repo, cacheDir], ROOT, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600000,
      });
      return cacheDir;
    } catch (err) {
      lastErr = err;
      rmrf(cacheDir);
      log.warn(`克隆失败：${repo} → ${String(err.message || err).split('\n')[0]}`);
    }
  }
  log.die(`无法获取站点源码：${String(lastErr?.message || lastErr)}\n  可手动克隆到 ${local} 或设置 CK_SITE_REPO / CK_SITE_LOCAL`);
}

/* ------------------------------ 版本号 ------------------------------ */
export function utcStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** OTA 资源包版本：主.次.UTC时间戳（保证单调递增，且是合法 semver） */
export function computeWebVersion(cfg, stamp = utcStamp()) {
  const parts = String(cfg.versionName || '1.0.0').split('.');
  const major = parts[0] || '1';
  const minor = parts[1] || '0';
  return `${major}.${minor}.${stamp}`;
}

/** 从站点 Changelog 里取“内容版本号”，如 13.0.1777 */
export function readContentVersion(siteDir, relFile) {
  try {
    const text = fs.readFileSync(path.join(siteDir, relFile), 'utf8');
    const m = text.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
    if (m) return m[1];
  } catch (e) { /* noop */ }
  return null;
}

/* ------------------------------ 工具链探测 ------------------------------ */
// 这三处（JDK / Android SDK / Chrome）以前每个脚本各写一份候选表，结果就是
// 「换台机器就有一个脚本找不到」：本环境 JDK 在 /usr/lib/jvm/msopenjdk-current，
// 老表里没有它，全靠 JAVA_HOME 兜着；一旦环境变量没设，build-apk 就报"找不到 JDK"，
// 而 JDK 明明就在那儿。集中到这里，谁用谁 import，改一处全场生效。

const isExec = (p) => {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
};

/** 找 JDK（21+ 的目录）。优先 JAVA_HOME，其次扫常见的发行版目录。找不到返回 null。 */
export function findJavaHome() {
  const bin = process.platform === 'win32' ? 'java.exe' : 'java';
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  // 扫 /usr/lib/jvm 与 /opt：覆盖 Debian/Ubuntu 的 msopenjdk/temurin/zulu/corretto 各种命名，
  // 也覆盖 devcontainer java feature 的布局
  for (const base of ['/usr/lib/jvm', '/opt', '/usr/java']) {
    try {
      for (const d of fs.readdirSync(base).sort().reverse()) {
        if (/jdk|java|temurin|msopenjdk|zulu|corretto|jbr/i.test(d)) cands.push(path.join(base, d));
      }
    } catch (e) { /* 目录不存在 */ }
  }
  cands.push('/opt/jdk21', '/opt/jdk17',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
    'C:\\Program Files\\Java\\jdk-21',
    'C:\\Program Files\\Android\\Android Studio\\jbr');
  for (const g of cands) if (g && isExec(path.join(g, 'bin', bin))) return g;
  return null;
}

/** 找 Android SDK（含 build-tools 的目录）。找不到返回 null。 */
export function findAndroidSdk() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cands = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    path.join(home, 'Android', 'Sdk'),
    path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
    '/opt/android-sdk', '/usr/local/android-sdk',
    path.join(home, 'Library', 'Android', 'sdk')].filter(Boolean);
  for (const g of cands) {
    try { if (fs.statSync(path.join(g, 'build-tools')).isDirectory()) return g; } catch (e) { /* next */ }
  }
  return null;
}

/** build-tools 里版本最高的那个目录（apksigner/aapt2 在这里） */
export function newestBuildTools(sdk) {
  const dir = path.join(sdk, 'build-tools');
  let list = [];
  try { list = fs.readdirSync(dir).filter((d) => /^\d+\./.test(d)); } catch (e) { return null; }
  list.sort((a, b) => {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    return 0;
  });
  return list[0] ? path.join(dir, list[0]) : null;
}

/**
 * 找 headless Chrome（E2E 闸门用）。找到返回绝对路径，找不到返回 null。
 *
 * 顺序：$CHROME_BIN → 常见的系统安装路径 → puppeteer 的下载缓存。
 * 为什么要认 puppeteer 缓存：Codespace 里不装系统 chromium（不该用 apt 装，见
 * docs/Codespaces云端构建.md §5），标准做法是 `npx puppeteer browsers install chrome`，
 * 它把二进制下到 ~/.cache/puppeteer/chrome/<ver>/chrome-linux64/chrome。
 * 早先只有 build-apk.mjs 认这个路径，于是单独跑 `npm run e2e` 会直接报
 * "Browser was not found at the configured executablePath (/usr/bin/chromium)"。
 */
export function findChrome() {
  const env = process.env.CHROME_BIN;
  if (env && fs.existsSync(env)) return env;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/chrome']) {
    if (fs.existsSync(p)) return p;
  }
  for (const dir of ['/opt/chrome', '/opt/chromium']) {
    try {
      const hit = fs.readdirSync(dir, { recursive: true }).find((f) => {
        const abs = path.join(dir, String(f));
        try { return fs.statSync(abs).isFile() && /chrome(-headless-shell)?$/.test(String(f)); } catch (e) { return false; }
      });
      if (hit) return path.join(dir, hit);
    } catch (e) { /* 目录不存在 */ }
  }
  // puppeteer 缓存：取版本号最高的那个
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const caches = [process.env.PUPPETEER_CACHE_DIR, path.join(home, '.cache', 'puppeteer'),
    path.join(home, 'AppData', 'Local', 'puppeteer')].filter(Boolean);
  for (const cache of caches) {
    const root = path.join(cache, 'chrome');
    let versions = [];
    try { versions = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch (e) { continue; }
    for (const v of versions) {
      const p = process.platform === 'win32'
        ? path.join(root, v, 'chrome-win64', 'chrome.exe')
        : process.platform === 'darwin'
          ? path.join(root, v, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
          : path.join(root, v, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/* ------------------------------ 下载 ------------------------------ */
export async function download(url, destFile, { timeoutMs = 60000 } = {}) {
  ensureDir(path.dirname(destFile));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destFile, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}

export const paths = {
  ROOT,
  www: path.join(ROOT, 'www'),
  shell: (cfg) => path.join(ROOT, cfg.shell?.dir || 'shell'),
  build: path.join(ROOT, '.build'),
  dist: path.join(ROOT, 'dist'),
  ota: path.join(ROOT, 'dist', 'ota'),
  cache: path.join(ROOT, '.cache'),
  android: path.join(ROOT, 'android'),
  keys: path.join(ROOT, 'keys'),
};
