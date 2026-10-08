/**
 * 校验签名 APK：包名 / 版本 / 签名者 / 权限 / 壳内容
 * 用法：node scripts/verify-apk.mjs [apk路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { ROOT, ensureDir, loadConfig, log, paths, sha256File, fileSize, writeJson } from './lib.mjs';

const cfg = loadConfig();

function findSdk() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const guesses = [
    env,
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    '/opt/android-sdk',
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  ].filter(Boolean);
  for (const g of guesses) if (fs.existsSync(path.join(g, 'build-tools'))) return g;
  return null;
}

function newestBuildTools(sdk) {
  const dir = path.join(sdk, 'build-tools');
  const list = fs.readdirSync(dir).filter((d) => /^\d+\./.test(d)).sort((a, b) => {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    return 0;
  });
  return list[0] ? path.join(dir, list[0]) : null;
}

/* ------------------------------ 定位 APK ------------------------------ */
let apk = process.argv[2];
if (!apk) {
  // dist/ 里会同时留着历史版本的包（升了版本号后 115 和 117 并存），
  // 按文件名排序取第一个 release 会挑到**旧的那份**，再拿新版本号去比旧包，
  // 报一个"versionCode 不匹配"的假失败（真实踩过）。这里先认当前配置算出来的
  // 确切文件名，认不到再退回 mtime 最新的那个，并说明换成了谁。
  const want = `Ckarefulon-${cfg.versionName}-${cfg.versionCode}-release.apk`;
  const candidates = fs.existsSync(paths.dist)
    ? fs.readdirSync(paths.dist).filter((f) => f.endsWith('.apk'))
    : [];
  let release = candidates.includes(want) ? want : null;
  if (!release) {
    const mtime = (f) => { try { return fs.statSync(path.join(paths.dist, f)).mtimeMs; } catch { return 0; } };
    release = candidates.filter((f) => f.includes('release')).sort((a, b) => mtime(b) - mtime(a))[0] || null;
    if (release) log.warn(`dist/ 里没有 ${want}，改用最新的 ${release}`);
  }
  if (!release) log.die('dist/ 下没有 APK，请先执行：npm run apk');
  apk = path.join(paths.dist, release);
}
apk = path.resolve(apk);
if (!fs.existsSync(apk)) log.die(`APK 不存在：${apk}`);

const sdk = findSdk();
if (!sdk) log.die('找不到 Android SDK（设置 ANDROID_HOME）');
const bt = newestBuildTools(sdk);
const apksigner = path.join(bt, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
const aapt2 = path.join(bt, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');

const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

log.step(`校验 ${path.basename(apk)}`);
log.info(`大小 ${(fileSize(apk) / 1024 / 1024).toFixed(2)} MB · SHA-256 ${sha256File(apk).slice(0, 16)}…`);

/* ------------------------------ 签名 ------------------------------ */
let signOut = '';
try {
  signOut = run(apksigner, ['verify', '--print-certs', '--verbose', apk]);
} catch (e) {
  log.die(`签名校验失败：${String(e.stderr || e.message).split('\n').slice(0, 5).join(' | ')}`);
}
const signer = {
  verified: /Verified using v(\d)/.test(signOut) || /DOES NOT VERIFY/i.test(signOut) === false,
  schemes: [...signOut.matchAll(/Verified using v(\d) scheme \(([^)]+)\):\s*(true|false)/g)]
    .filter((m) => m[3] === 'true').map((m) => `v${m[1]}`),
  cn: (signOut.match(/Signer #1 certificate DN:\s*(.+)/) || [])[1]?.trim() || null,
  sha256: (signOut.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)/) || [])[1] || null,
};

/* ------------------------------ 清单信息 ------------------------------ */
let badging = '';
try {
  badging = run(aapt2, ['dump', 'badging', apk]);
} catch (e) {
  log.warn(`aapt2 读取失败：${String(e.message).split('\n')[0]}`);
}
const grab = (re) => (badging.match(re) || [])[1] || null;
const info = {
  package: grab(/package:\s*name='([^']+)'/),
  versionCode: grab(/versionCode='([^']+)'/),
  versionName: grab(/versionName='([^']+)'/),
  // aapt2 输出的是 minSdkVersion（不是 sdkVersion），以前永远抓到 null
  minSdk: grab(/minSdkVersion:'([^']+)'/),
  targetSdk: grab(/targetSdkVersion:'([^']+)'/),
  label: grab(/application-label:'([^']+)'/),
  permissions: [...badging.matchAll(/uses-permission:\s*name='([^']+)'/g)].map((m) => m[1]),
  features: [...badging.matchAll(/uses-feature[^:]*:\s*name='([^']+)'/g)].map((m) => m[1]),
  launchable: grab(/launchable-activity:\s*name='([^']+)'/),
};

/* ------------------------------ 壳内容检查 ------------------------------ */
// 用 node 直接读 zip 中央目录（避免依赖 unzip）
function listZip(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  // 从尾部找 EOCD
  let i = buf.length - 22;
  while (i > 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i <= 0) return out;
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const size = buf.readUInt32LE(off + 24);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    out.push({ name, size, offset: buf.readUInt32LE(off + 42) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 从 APK 里解出单个文件（store 与 deflate 都支持）；不存在返回 null */
function extractZip(file, entryName) {
  const buf = fs.readFileSync(file);
  const entry = listZip(file).find((e) => e.name === entryName);
  if (!entry) return null;
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(p + 8);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + buf.readUInt32LE(p + 18));
  return method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
}

// 稳定序列化（键序无关），用于对比"包里的配置"和"当前配置"
const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);

const zipEntries = listZip(apk);
const publicAssets = zipEntries.filter((e) => e.name.startsWith('assets/public/'));
const nativeLibs = zipEntries.filter((e) => e.name.startsWith('lib/'));
const publicBytes = publicAssets.reduce((s, e) => s + e.size, 0);

/* ------------------------------ 包内内容新鲜度（防"修好了却没进包"） ------------------------------ */
// 真实事故：出包流程没同步网页代码，APK 里的 ck-app.js / 壳配置一直是上一轮的，
// 所有"修好了"的改动实际没生效。这里把包内文件逐字节和当前构建对比，旧了就拒收。
const apkCfgBytes = extractZip(apk, 'assets/capacitor.config.json');
let apkCfg = null;
try { apkCfg = apkCfgBytes ? JSON.parse(apkCfgBytes.toString('utf8')) : null; } catch (e) { /* noop */ }
const wantCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
const cfgFresh = !!apkCfg && stable(apkCfg.android || {}) === stable(wantCfg.android || {});
const staleFiles = ['index.html', 'sw.js', 'ckapp/ck-app.js', 'ckapp/ck-site.js'].filter((f) => {
  const inApk = extractZip(apk, `assets/public/${f}`);
  const src = path.join(paths.www, f);
  return !inApk || !fs.existsSync(src) || !inApk.equals(fs.readFileSync(src));
});

/* ------------------------------ 断言 ------------------------------ */
const checks = [
  ['签名有效', signer.verified && signer.schemes.length > 0],
  ['签名者为 Ckarefulon', !!signer.cn && /CN=Ckarefulon/i.test(signer.cn)],
  [`包名 = ${cfg.appId}`, info.package === cfg.appId],
  [`versionName = ${cfg.versionName}`, info.versionName === cfg.versionName],
  [`versionCode = ${cfg.versionCode}`, String(info.versionCode) === String(cfg.versionCode)],
  [`应用名 = ${cfg.appName}`, info.label === cfg.appName],
  ['包含蓝牙权限 BLUETOOTH_SCAN', info.permissions.includes('android.permission.BLUETOOTH_SCAN')],
  ['包含蓝牙权限 BLUETOOTH_CONNECT', info.permissions.includes('android.permission.BLUETOOTH_CONNECT')],
  ['声明 BLE 硬件特性（非必需）', info.features.includes('android.hardware.bluetooth_le')],
  ['包含 INTERNET 权限', info.permissions.includes('android.permission.INTERNET')],
  ['壳内含 index.html', publicAssets.some((e) => e.name === 'assets/public/index.html')],
  ['壳内含运行时 ck-app.js', publicAssets.some((e) => e.name === 'assets/public/ckapp/ck-app.js')],
  ['APK 未打包站点内容（壳 < 2MB）', publicBytes < 2 * 1024 * 1024],
  ['壳配置与当前构建一致（设置改动真正进包）', cfgFresh],
  [`壳网页代码与当前构建一致${staleFiles.length ? `（旧版：${staleFiles.join('、')}）` : ''}`, staleFiles.length === 0],
];

log.step('校验结果');
for (const [name, ok] of checks) {
  if (ok) log.ok(name); else log.err(name);
}

log.step('详情');
log.info(`包名/版本   : ${info.package} ${info.versionName}(${info.versionCode})  minSdk=${info.minSdk} targetSdk=${info.targetSdk}`);
log.info(`签名方案    : ${signer.schemes.join(', ') || '(未知)'}`);
log.info(`签名者      : ${signer.cn}`);
log.info(`证书SHA-256 : ${signer.sha256}`);
log.info(`权限(${info.permissions.length})     : ${info.permissions.map((p) => p.replace('android.permission.', '')).join(', ')}`);
log.info(`壳内文件    : ${publicAssets.length} 个，合计 ${(publicBytes / 1024).toFixed(1)} KB`);
log.info(`内容新鲜度  : 配置${cfgFresh ? '一致' : '不一致'}；网页代码${staleFiles.length ? `旧版：${staleFiles.join('、')}` : '全部一致'}；APK 打包自 ${fs.existsSync(paths.www) ? 'www/' : '(缺 www/)'} 最新构建`);
log.info(`原生 so     : ${nativeLibs.length} 个（${[...new Set(nativeLibs.map((l) => l.name.split('/')[1]))].join(', ') || '无'}）`);
log.info(`APK 条目    : ${zipEntries.length}`);

const failed = checks.filter(([, ok]) => !ok);
const verifyJson = {
  apk: path.basename(apk),
  bytes: fileSize(apk),
  sha256: sha256File(apk),
  signer, info, checks: checks.map(([name, ok]) => ({ name, ok })),
  shell: { files: publicAssets.length, bytes: publicBytes },
  freshness: { config: cfgFresh, staleFiles },
  verifiedAt: new Date().toISOString(),
};
writeJson(path.join(paths.dist, 'apk-verify.json'), verifyJson);
ensureDir(path.join(ROOT, 'release'));
writeJson(path.join(ROOT, 'release', 'apk-verify.json'), verifyJson);

if (failed.length) {
  log.die(`${failed.length} 项校验未通过`);
} else {
  log.ok('全部校验通过 ✓');
}
