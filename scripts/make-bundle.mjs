/**
 * 构建 OTA 站点资源包（www-<version>.zip + latest.json）
 * ---------------------------------------------------------------------------
 * 产物放在 dist/ota/，发布到站点仓库的 app-ota/ 目录后，
 * 手机上的 App 就会自动检测到并静默更新（无需重装 APK）。
 *
 * 步骤：
 *   1. 取站点源码（本地克隆或自动 clone）
 *   2. 按 include/exclude 规则复制到 staging（默认：除点号开头的文件/目录外全部打包）
 *   3. CDN 依赖本地化（supabase-js / jszip / tailwind / lucide / ts-fsrs）→ 离线可用
 *   4. 给每个 HTML 注入壳运行时（BLE 原生桥 + 自动更新）
 *   5. 压成 zip（index.html 在根目录，无隐藏文件）+ 生成清单
 *
 * 用法：
 *   node scripts/make-bundle.mjs [--version=1.0.x] [--notes="..."] [--no-zip] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import {
  ROOT, ensureDir, rmrf, copyTree, listFiles, makeMatcher, loadConfig, log, paths,
  writeJson, sha256File, fileSize, resolveSiteDir, gitMeta, computeWebVersion,
  utcStamp, readContentVersion,
} from './lib.mjs';
import { syncVendor, VENDOR_DIR } from './vendor-sync.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const cfg = loadConfig();
const stamp = utcStamp();
const webVersion = argv.version || computeWebVersion(cfg, stamp);
const staging = path.join(paths.ota, 'staging');
const vendorCfg = cfg.bundle?.vendor || { enabled: false, dir: 'ckapp/vendor' };

/* ------------------------------ 1. 站点源码 ------------------------------ */
log.step('准备站点源码');
const siteDir = argv['site-dir'] ? path.resolve(argv['site-dir']) : resolveSiteDir(cfg);
const siteMeta = gitMeta(siteDir);
const contentVersion = argv['content-version'] || readContentVersion(siteDir, cfg.site.contentVersionFile) || null;
log.ok(`${siteDir}`);
log.info(`提交 ${siteMeta.commit} · ${siteMeta.date}`);
if (contentVersion) log.info(`站点内容版本 ${contentVersion}`);

/* ------------------------------ 2. 复制 + 过滤 ------------------------------ */
log.step('复制站点文件到 staging（按 include/exclude 规则）');
rmrf(staging);
ensureDir(staging);

const matcher = makeMatcher(cfg.bundle.include || ['**/*'], [
  ...(cfg.bundle.exclude || []),
  'app-ota/**',
  cfg.shell?.dir ? `${cfg.shell.dir}/**` : 'shell/**',
  'ckapp/**',
]);

let copied = 0;
let skipped = 0;
let bytes = 0;
for (const rel of listFiles(siteDir)) {
  if (matcher(rel)) {
    const src = path.join(siteDir, rel);
    const dst = path.join(staging, rel);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    copied++;
    bytes += fs.statSync(src).size;
  } else {
    skipped++;
  }
}
log.ok(`已复制 ${copied} 个文件（${(bytes / 1024 / 1024).toFixed(2)} MB），按规则排除 ${skipped} 个`);

/* ------------------------------ 3. CDN 依赖本地化 ------------------------------ */
let vendorMap = new Map();
if (vendorCfg.enabled) {
  const { map } = await syncVendor(cfg);
  vendorMap = map;

  const vendorOut = path.join(staging, vendorCfg.dir || 'ckapp/vendor');
  ensureDir(vendorOut);
  let vbytes = 0;
  for (const file of new Set(vendorMap.values())) {
    const src = path.join(VENDOR_DIR, file);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(vendorOut, path.basename(file)));
    vbytes += fs.statSync(src).size;
  }
  log.ok(`vendor 已写入 ${path.relative(staging, vendorOut)}（${(vbytes / 1024).toFixed(0)} KB）`);
}

/* ------------------------------ 4. 改写引用 + 注入运行时 ------------------------------ */
log.step('改写 CDN 引用 & 注入壳运行时');
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.ts', '.svg', '.xml', '.webmanifest']);
const inject = cfg.bundle?.inject || { script: '/ckapp/ck-app.js', style: '/ckapp/ck-app.css' };
const MARKER = 'data-ck-runtime';

let rewritten = 0;
let injected = 0;
let noHead = [];

function rewriteVendorUrls(text) {
  let n = 0;
  for (const [url, file] of vendorMap) {
    if (!text.includes(url)) continue;
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(esc, 'g'), () => { n++; return `/${vendorCfg.dir || 'ckapp/vendor'}/${path.basename(file)}`; });
  }
  return { text, n };
}

function injectRuntime(html) {
  if (html.includes(MARKER)) return { html, ok: true, already: true };
  const scriptTag = `<script src="${inject.script}" ${MARKER}></script>`;
  const styleTag = `<link rel="stylesheet" href="${inject.style}" ${MARKER}>`;
  let out = html.replace(/<head([^>]*)>/i, (m) => `${m}\n\t${scriptTag}`);
  if (out === html) {
    // 没有 <head>：插到 <html> 之后
    out = html.replace(/<html([^>]*)>/i, (m) => `${m}<head>${scriptTag}${styleTag}</head>`);
    if (out === html) return { html, ok: false };
    return { html: out, ok: true };
  }
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `\t${styleTag}\n</head>`);
  else out = out.replace(scriptTag, `${scriptTag}${styleTag}`);
  return { html: out, ok: true };
}

for (const rel of listFiles(staging)) {
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  if (rel.startsWith(`${(vendorCfg.dir || 'ckapp/vendor').split('/')[0]}/`) && rel.includes('/vendor/')) continue; // 不改 vendor 自身

  const file = path.join(staging, rel);
  let text = fs.readFileSync(file, 'utf8');
  const before = text;

  if (vendorMap.size) {
    const r = rewriteVendorUrls(text);
    text = r.text;
    rewritten += r.n;
  }

  if (ext === '.html' || ext === '.htm') {
    const r = injectRuntime(text);
    if (r.ok) {
      text = r.html;
      if (!r.already) injected++;
    } else {
      noHead.push(rel);
    }
  }

  if (text !== before) fs.writeFileSync(file, text, 'utf8');
}

log.ok(`已改写 ${rewritten} 处 CDN 引用；已注入 ${injected} 个 HTML 页面`);
if (noHead.length) log.warn(`以下文件没有 <head>，未注入：${noHead.join(', ')}`);

/* ------------------------------ 5. 运行时 + 版本信息 ------------------------------ */
log.step('构建 OTA 运行时并打包');
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'scripts', 'build-web.mjs'),
    '--role=bundle',
    `--version=${webVersion}`,
    `--commit=${siteMeta.commit}`,
    ...(contentVersion ? [`--content-version=${contentVersion}`] : []),
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

const runtimeDir = path.join(paths.build, 'bundle', 'ckapp');
copyTree(runtimeDir, path.join(staging, 'ckapp'));

// ck-version.json 补上站点信息（运行时靠它判断“当前是哪个版本”）
const versionFile = path.join(staging, 'ckapp', 'ck-version.json');
const versionMeta = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
writeJson(versionFile, {
  ...versionMeta,
  role: 'bundle',
  version: webVersion,
  contentVersion,
  commit: siteMeta.commit,
  commitSubject: siteMeta.subject,
  builtAt: new Date().toISOString(),
  nativeVersion: cfg.versionName,
  nativeBuild: cfg.versionCode,
});

/* ------------------------------ 6. 压包 + 清单 ------------------------------ */
if (!fs.existsSync(path.join(staging, 'index.html'))) {
  log.die('staging/index.html 不存在 —— OTA 包根目录必须有 index.html，Capgo 才能解压运行');
}

const files = listFiles(staging).filter((f) => !f.split('/').some((seg) => seg.startsWith('.')));
ensureDir(paths.ota);

let zipPath = null;
let zipBytes = 0;
if (!argv['no-zip']) {
  const zipName = (cfg.ota.assetNamePattern || 'www-{version}.zip').replace('{version}', webVersion);
  zipPath = path.join(paths.ota, zipName);

  const zipInput = {};
  for (const rel of files) {
    zipInput[rel] = fs.readFileSync(path.join(staging, rel));
  }
  // 附带一份清单信息，便于排查（不影响运行）
  zipInput['ckapp/ck-bundle.txt'] = strToU8(
    [
      `Ckarefulon OTA bundle`,
      `version: ${webVersion}`,
      `contentVersion: ${contentVersion || '-'}`,
      `commit: ${siteMeta.commitFull}`,
      `builtAt: ${new Date().toISOString()}`,
      `files: ${files.length}`,
      `minNative: ${cfg.ota.minNativeVersion} (${cfg.versionCode})`,
      '',
    ].join('\n'),
  );

  const zipped = zipSync(zipInput, { level: 9, mem: 8 });
  fs.writeFileSync(zipPath, zipped);
  zipBytes = fileSize(zipPath);
  log.ok(`zip → ${path.relative(ROOT, zipPath)}（${(zipBytes / 1024 / 1024).toFixed(2)} MB，${files.length} 个文件）`);
}

const publishDir = (cfg.ota.publishDir || 'app-ota').replace(/^\/|\/$/g, '');
const manifestFile = cfg.ota.manifestFile || 'latest.json';
const assetName = (cfg.ota.assetNamePattern || 'www-{version}.zip').replace('{version}', webVersion);
const relativeUrl = `${publishDir}/${assetName}`;

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const mirrors = (cfg.ota.mirrors || [])
  .filter((m) => m && m.base && m.enabled !== false && !/你的域名/.test(m.base))
  .map((m) => ({
    name: m.name,
    base: trimSlash(m.base),
    manifest: `${trimSlash(m.base)}/${publishDir}/${manifestFile}`,
    url: `${trimSlash(m.base)}/${relativeUrl}`,
  }));
if (!mirrors.length) log.die('app.config.json 里没有启用的更新源（ota.mirrors）');

const manifest = {
  channel: cfg.ota.channel || 'production',
  version: webVersion,
  // url 指向首选更新源；客户端还会用 relativeUrl 在各镜像间自动切换
  url: mirrors[0].url,
  relativeUrl,
  file: assetName,
  mirrors,
  bytes: zipBytes,
  sha256: zipPath ? sha256File(zipPath) : null,
  contentVersion,
  commit: siteMeta.commit,
  commitSubject: siteMeta.subject,
  files: files.length,
  minNativeVersion: cfg.ota.minNativeVersion || cfg.versionName,
  minNativeCode: cfg.versionCode,
  nativeVersion: cfg.versionName,
  nativeBuild: cfg.versionCode,
  notes: typeof argv.notes === 'string' ? argv.notes : '',
  apkUrl: argv['apk-url'] || cfg.ota.apkUrls?.[0]?.url || null,
  publishedAt: new Date().toISOString(),
  generator: 'ckarefulon-app/scripts/make-bundle.mjs',
};

if (argv['dry-run']) {
  log.warn('dry-run：不写清单文件');
  console.log(JSON.stringify(manifest, null, 2));
} else {
  writeJson(path.join(paths.ota, 'latest.json'), manifest);
  log.ok(`清单 → ${path.relative(ROOT, path.join(paths.ota, 'latest.json'))}`);
}

log.step('完成');
log.info(`资源包版本 : ${webVersion}`);
log.info(`内容版本   : ${contentVersion || '-'}`);
log.info(`站点提交   : ${siteMeta.commit}`);
log.info(`文件数     : ${files.length}`);
if (zipPath) log.info(`体积       : ${(zipBytes / 1024 / 1024).toFixed(2)} MB（未压缩 ${(bytes / 1024 / 1024).toFixed(2)} MB）`);
log.info(`下载地址   : ${manifest.url}`);
console.log(`\n下一步：npm run ota:publish  （把 ${publishDir}/ 提交到站点仓库，GitHub Pages 发布后 App 自动更新）\n`);
