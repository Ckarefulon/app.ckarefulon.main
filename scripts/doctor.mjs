/**
 * 环境自检（干活前先跑这个，比跑完整流水线快得多）
 *
 *   node scripts/doctor.mjs          # 人读
 *   node scripts/doctor.mjs --quiet  # 只报问题（CI/脚本里用）
 *
 * 为什么要有它：换机器/换 Codespace 时，真正会拦路的从来不是代码，而是环境——
 * JDK 找不到、SDK 路径不对、Chrome 缺系统库、keys/ 没恢复、cordova 插件工程没生成、
 * 网络到不了更新源。这些在完整构建里表现成一堆难懂的报错（或者更糟：静默跳过闸门，
 * 看起来全绿其实什么都没测）。这里把它们逐项查清楚，并给出确切的修复命令。
 *
 * 退出码：0 = 可以出包；1 = 有阻塞项（ERROR）。
 * 注意：缺 keys/ 只算 WARN —— 没签名也能出包（回落 debug 签名，仅测试用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, findAndroidSdk, findChrome, findJavaHome, loadConfig, paths } from './lib.mjs';

const QUIET = process.argv.includes('--quiet');
const cfg = loadConfig();

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', bold: '\x1b[1m', blue: '\x1b[36m',
};
const paint = (c, s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `${c}${s}${C.reset}` : s);

let errors = 0;
let warns = 0;

const head = (s) => { if (!QUIET) console.log(`\n${paint(C.blue + C.bold, '▶')} ${paint(C.bold, s)}`); };
const ok = (s) => { if (!QUIET) console.log(`  ${paint(C.green, '✓')} ${s}`); };
const info = (s) => { if (!QUIET) console.log(`  ${paint(C.dim, '·')} ${s}`); };
const warn = (s, fix) => {
  warns++;
  console.log(`  ${paint(C.yellow, '!')} ${s}`);
  if (fix) console.log(`    ${paint(C.dim, '→ ' + fix)}`);
};
const bad = (s, fix) => {
  errors++;
  console.log(`  ${paint(C.red, '✗')} ${paint(C.bold, s)}`);
  if (fix) console.log(`    ${paint(C.dim, '→ ' + fix)}`);
};

const tryRun = (bin, args, opts = {}) => {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, ...opts }).trim();
  } catch (e) {
    return null;
  }
};

/** java -version 把版本写到 **stderr**（不是 stdout），且退出码是 0 ——
 *  execFileSync 这时返回空字符串、不会抛错，所以必须用 spawnSync 同时收两路。 */
const tryRunBoth = (bin, args, opts = {}) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000, ...opts });
  if (r.error) return null;
  return `${r.stdout || ''}${r.stderr || ''}`.trim() || null;
};

/* ============================== 1. 基础运行时 ============================== */
head('基础运行时');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 22) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} 太旧（Capacitor 8 要 22+）`, '装 Node 22 或更高（nvm install 22 / 升 devcontainer 的 node feature）');

const javaHome = findJavaHome();
if (javaHome) {
  const ver = tryRunBoth(path.join(javaHome, 'bin', 'java'), ['-version']) || '';
  // 兼容 '21.0.8' 与老式 '1.8.0' 两种写法
  const major = Number((ver.match(/version "(\d+)(?:\.(\d+))?/) || []).slice(1)
    .reduce((acc, x) => (acc ? acc : x), '')) || 0;
  if (major >= 21) ok(`JDK ${major}（${javaHome}）`);
  else bad(`JDK ${major || '?'} 太旧（要 21+）：${javaHome}`, '装 Temurin JDK 21（devcontainer 镜像已带；本地装 Android Studio 也自带 jbr）');
} else {
  bad('找不到 JDK 21', '设 JAVA_HOME 指向 JDK 21（本环境通常已在镜像里：/usr/lib/jvm/msopenjdk-current）');
}

/* ============================== 2. Android SDK ============================== */
head('Android SDK');

const sdk = findAndroidSdk();
if (sdk) {
  ok(`SDK 位于 ${sdk}`);
  for (const p of [`platforms;android-${cfg.android?.compileSdkVersion || 36}`,
    `build-tools;${'36.0.0'}`]) {
    const [kind, name] = p.split(';');
    const dir = path.join(sdk, kind === 'platforms' ? 'platforms' : 'build-tools', name);
    if (fs.existsSync(dir)) ok(`${p}`);
    else bad(`缺 SDK 组件 ${p}`, `sdkmanager --install "${p}"`);
  }
} else {
  bad('找不到 Android SDK', '设 ANDROID_HOME（本环境镜像已装在 /opt/android-sdk；本地装 Android Studio）');
}

/* ============================== 3. 依赖与生成物 ============================== */
head('依赖与生成物');

if (fs.existsSync(path.join(ROOT, 'node_modules', '@capacitor', 'cli'))) ok('node_modules 已安装');
else bad('node_modules 缺失', 'npm ci --no-audit --no-fund');

// cordova 插件工程是 gen 出来的、不在仓库里；缺它 gradle 在配置阶段就挂
const cordovaGradle = path.join(paths.android, 'capacitor-cordova-android-plugins', 'cordova.variables.gradle');
if (fs.existsSync(cordovaGradle)) ok('cordova 插件工程已生成');
else info('cordova 插件工程未生成（首次构建会自动 cap sync，不用管）');

// android/local.properties 由 build-apk 自动写；只提示不阻塞
if (fs.existsSync(path.join(paths.android, 'local.properties'))) ok('android/local.properties 已就绪');
else info('android/local.properties 未生成（构建时会自动写）');

/* ============================== 4. 签名（只警告） ============================== */
head('发布签名');

const keystore = path.join(ROOT, cfg.signer.keystore);
const props = path.join(ROOT, cfg.signer.keystoreProperties);
if (fs.existsSync(keystore) && fs.existsSync(props)) {
  ok(`keystore 就绪（alias=${cfg.signer.keyAlias}）`);
  const envB64 = process.env.CK_KEYSTORE_B64 ? '已配置 CK_KEYSTORE_B64' : null;
  if (envB64) info(envB64);
  // 指纹必须与 HANDOFF 记录的上一个发布版一致，否则老用户装不上
  if (javaHome) {
    const out = tryRun(path.join(javaHome, 'bin', 'keytool'),
      ['-list', '-v', '-keystore', keystore, '-alias', cfg.signer.keyAlias, '-storepass',
        (fs.readFileSync(props, 'utf8').match(/^storePassword=(.*)$/m) || [])[1] || '']);
    const fp = out && (out.match(/SHA256:\s*([0-9A-F:]+)/) || [])[1];
    if (fp) {
      const norm = fp.replace(/:/g, '').toLowerCase();
      const baseline = 'dfda920ed20b06ef1d00b32c7c1f9e6fbccac1eb32ddad3c0d5220e7ac10c59e';
      if (norm === baseline) ok(`证书指纹与 131 发布基线一致（${norm.slice(0, 8)}…）`);
      else warn(`证书指纹 ${norm.slice(0, 8)}… 与 131 基线（${baseline.slice(0, 8)}…）不同：这样签出的包老用户装不上`,
        '装了 128~131 的用户必须先卸载；确认这就是你要换的证书再继续');
    }
  }
} else {
  warn('没有发布签名（keys/ 缺失）→ 构建会回落 debug 签名，只能当测试包',
    '配 Codespaces 个人密钥（docs/Codespaces云端构建.md §3.2）；找回原密钥优先，重建 = 换证书');
}

/* ============================== 5. E2E 浏览器 ============================== */
head('E2E 浏览器（真浏览器闸门）');

const chrome = findChrome();
if (!chrome) {
  warn('没装 headless Chrome → E2E 闸门会被跳过（sw.js 类改动就失去真浏览器验证）',
    'npx puppeteer browsers install chrome（装完本脚本与 build-apk 都能自动找到，不用设 CHROME_BIN）');
} else {
  ok(`找到浏览器：${chrome}`);
  // 光有二进制不够：puppeteer 不装系统库，缺 libglib 时启动直接失败。
  // 真正拉起一次最可靠（headless 打印版本即可），比逐个 ldd 猜库名准。
  const probe = tryRun(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'about:blank']);
  if (probe !== null) ok('浏览器能正常启动');
  else {
    bad('浏览器起不来（多半缺系统库）',
      'sudo apt-get update && sudo apt-get install -y libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 '
      + 'libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 '
      + 'libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2');
  }
}

/* ============================== 6. 更新源连通性 ============================== */
head('更新源（App 取内容的通道）');

const mirrors = (cfg.ota?.mirrors || []).filter((m) => m.enabled !== false);
const quiet = process.argv.includes('--offline'); // 显式跳过联网检查
if (quiet) info('已指定 --offline，跳过连通性检查');
else {
  for (const m of mirrors) {
    const url = `${m.base.replace(/\/$/, '')}/favicon.svg`;
    let reachable = false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      reachable = r.ok;
    } catch (e) { reachable = false; }
    if (reachable) ok(`${m.name}`);
    else warn(`${m.name} 当前不可达：${m.base}`, '国内网络下 Gitee/jsDelivr 优先级更高；只影响真网测试与首启下载，不影响本地构建');
  }
  if (!mirrors.length) warn('app.config.json 里没有启用的更新源', '检查 ota.mirrors');
}

/* ============================== 7. 仓库卫生 ============================== */
head('仓库卫生');

// release/ 是随仓库提交的发布基线，必须确认里面的包是发布签名
const releaseApks = fs.existsSync(path.join(ROOT, 'release'))
  ? fs.readdirSync(path.join(ROOT, 'release')).filter((f) => f.endsWith('.apk')) : [];
if (releaseApks.length) {
  const latest = releaseApks.includes(`Ckarefulon-latest-release.apk`)
    ? 'Ckarefulon-latest-release.apk' : releaseApks.sort().reverse()[0];
  const verifyJson = path.join(ROOT, 'release', 'apk-verify.json');
  if (fs.existsSync(verifyJson)) {
    const rec = JSON.parse(fs.readFileSync(verifyJson, 'utf8'));
    const recCn = rec?.signer?.cn || '';
    if (new RegExp(`CN=${cfg.signer.name}`, 'i').test(recCn)) {
      ok(`release/ 基线是发布签名（${latest}，证书 ${String(rec.signer.sha256 || '').slice(0, 8)}…）`);
    } else {
      bad(`release/ 基线被非发布签名覆盖了（记录里是 ${recCn || '未知'}）`,
        'git checkout -- release/ 恢复；debug 签名的包不允许进 release/（build-apk 现在会拦住）');
    }
  } else {
    warn('release/ 里没有 apk-verify.json（基线记录缺失）', '用发布签名出一次包并跑 npm run verify 即可重建');
  }
}

// 私钥绝不能出现在将要提交的东西里
const secretHit = [];
const scanSecrets = (dir, depth = 0) => {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (['node_modules', '.git', '.cache', '.build', 'www', 'dist', 'build', '.gradle'].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { scanSecrets(abs, depth + 1); continue; }
    if (/\.(keystore|jks|p12|pem|key)$/i.test(e.name) || e.name === 'keystore.properties') {
      secretHit.push(path.relative(ROOT, abs));
    }
  }
};
scanSecrets(ROOT);
if (!secretHit.length) ok('工作区没有散落的签名私钥');
else warn(`发现私钥文件：${secretHit.join('、')}`, '确认 keys/ 已在 .gitignore 里，且绝不进 app-kit 包（npm run kit 有硬闸门）');

/* ============================== 汇总 ============================== */
console.log('');
if (errors) {
  console.log(`${paint(C.red + C.bold, '环境不可用于出包')}：${errors} 个阻塞项、${warns} 个提醒`);
  process.exit(1);
}
if (warns) {
  console.log(`${paint(C.green + C.bold, '可以出包')}：${warns} 个提醒（不阻塞）`);
} else {
  console.log(`${paint(C.green + C.bold, '环境就绪，全部检查通过')}`);
}
process.exit(0);
