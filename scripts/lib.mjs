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
