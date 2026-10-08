/**
 * 构建签名 APK
 *   node scripts/build-apk.mjs [--debug] [--no-daemon] [--variant=release]
 *
 * 环境变量：
 *   JAVA_HOME / ANDROID_HOME（或 ANDROID_SDK_ROOT）
 *   CK_KEYSTORE_PASSWORD / CK_KEY_PASSWORD（CI 用；本地读 keys/keystore.properties）
 *   CK_GRADLE_ARGS（附加 gradle 参数）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT, ensureDir, loadConfig, log, paths, sha256File, fileSize, writeJson, utcStamp } from './lib.mjs';

const cfg = loadConfig();
const argv = process.argv.slice(2);
const debug = argv.includes('--debug');
const variant = debug ? 'debug' : 'release';
const noDaemon = argv.includes('--no-daemon') || !!process.env.CI;

/* ------------------------------ 环境检查 ------------------------------ */
function findJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'java'))) return process.env.JAVA_HOME;
  const guesses = [
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/usr/lib/jvm/java-17-openjdk-amd64',
    '/opt/jdk21', '/opt/jdk17',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
    'C:\\Program Files\\Java\\jdk-21',
    'C:\\Program Files\\Android\\Android Studio\\jbr',
  ];
  for (const g of guesses) if (fs.existsSync(path.join(g, 'bin', 'java'))) return g;
  return null;
}

function findAndroidSdk() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env && fs.existsSync(env)) return env;
  const guesses = [
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    '/opt/android-sdk',
    '/usr/local/android-sdk',
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

const JAVA_HOME = findJavaHome();
const ANDROID_HOME = findAndroidSdk();
if (!JAVA_HOME) log.die('找不到 JDK（需要 21+）。请安装 Temurin JDK 21 并设置 JAVA_HOME');
if (!ANDROID_HOME) log.die('找不到 Android SDK。请安装 Android Studio 或 cmdline-tools，并设置 ANDROID_HOME');

log.step(`构建 ${variant} APK`);
log.info(`JAVA_HOME    = ${JAVA_HOME}`);
log.info(`ANDROID_HOME = ${ANDROID_HOME}`);
log.info(`appId        = ${cfg.appId}  versionName=${cfg.versionName}  versionCode=${cfg.versionCode}`);

/* ------------------------------ local.properties ------------------------------ */
const localProps = path.join(paths.android, 'local.properties');
const sdkLine = `sdk.dir=${ANDROID_HOME.replace(/\\/g, '\\\\')}`;
if (!fs.existsSync(localProps) || !fs.readFileSync(localProps, 'utf8').includes('sdk.dir')) {
  fs.writeFileSync(localProps, `${sdkLine}\n`, 'utf8');
  log.info('已写入 android/local.properties');
}

/* ------------------------------ keystore 检查 ------------------------------ */
const keystoreFile = path.join(ROOT, cfg.signer.keystore);
if (variant === 'release' && !fs.existsSync(keystoreFile)) {
  log.warn(`未找到签名文件 ${cfg.signer.keystore}，先执行：npm run keystore`);
}

/* ------------------------------ 同步网页代码 + 壳配置进 APK（防旧代码出门） ------------------------------ */
// 真实事故：`npm run apk` 以前不打这一步 —— 改完 src/ 只重打了原生层，APK 里的
// 网页代码和壳配置一直是上一轮的，"修好了"的东西根本没进包（120 就是这么翻车的：
// 缓存跳过、输入开关、页面原生桥全没生效）。这里强制按顺序跑一遍，再让
// verify-apk 校验包内内容与当前构建一致，双保险。
for (const s of ['write-config.mjs', 'build-web.mjs', 'sync-shell.mjs']) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', s)], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    log.die(`${s} 失败：` + String(e?.message || e).slice(0, 200));
  }
}
const capBin = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
try {
  execFileSync(process.execPath, [capBin, 'copy', 'android'], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log.die('cap copy 失败：' + String(e?.message || e).slice(0, 200));
}

/* ------------------------------ Android 工程定制（版本号/签名/权限/MainActivity） ------------------------------ */
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'patch-android.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log.die('patch-android 失败：' + String(e?.message || e).slice(0, 200));
}

/* ------------------------------ 离线单元 + 真网功能测试 + 冒烟测试（阻断脚本/链路错误出门） ------------------------------ */
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'utest.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log.die('离线单元检查未通过：出站 MIME/镜像兜底链路存在回归，已阻断出包。');
}
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ptest.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log.die('真网功能测试未通过：首屏预缓存链路故障，已阻断出包。');
}
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log.die('冒烟测试未通过：壳运行时存在脚本错误，已阻断出包。');
}

/* ---- 真浏览器端到端：只测"进不进得去首页 + 断网进不进得去" ---- */
// 这是一道关键闸门（sw.js 的改动只有真浏览器能暴露），以前只认 /usr/bin/chromium
// 这三个路径 —— 机器上装的是 chrome-headless-shell 时整道闸门被**静默跳过**，
// 看起来一切正常，其实什么都没测到。
function findChrome() {
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
  return null;
}
const chromeBin = findChrome();
if (chromeBin) {
  log.info(`E2E 浏览器：${chromeBin}`);
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'e2e.mjs')], {
      cwd: ROOT, stdio: 'inherit', timeout: 300000, env: { ...process.env, CHROME_BIN: chromeBin },
    });
  } catch (e) {
    log.die('E2E 未通过：真浏览器进不去首页，已阻断出包。');
  }
} else {
  log.warn('未检测到 chromium/chrome，跳过 E2E（建议安装后重跑以获得真浏览器验证）');
}

/* ------------------------------ gradle ------------------------------ */
const gradlew = path.join(paths.android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
if (!fs.existsSync(gradlew)) log.die('android/gradlew 不存在，请先执行：npx cap add android');
if (process.platform !== 'win32') fs.chmodSync(gradlew, 0o755);

// 清理上次崩溃残留的构建进程（Gradle/Kotlin daemon、aapt2）与 e2e 残留浏览器，避免内存被占满
if (process.platform !== 'win32') {
  try {
    const pids = execFileSync('sh', ['-c',
      'for p in /proc/[0-9]*; do c=$(cat $p/comm 2>/dev/null); case "$c" in java|aapt2|chromium|chromium-browse) echo ${p#/proc/};; esac; done'],
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid), 9); } catch (e) { /* noop */ } }
    if (pids.length) log.warn(`已清理 ${pids.length} 个残留进程（java/aapt2/chromium）`);
  } catch (e) { /* noop */ }
}

const task = variant === 'debug' ? 'assembleDebug' : 'assembleRelease';

// 低内存机器（<=2GB）：把构建拆成几个阶段、每阶段独立 JVM，
// 避免 aapt2 守护进程 / Kotlin 编译 / D8 同时在内存里互相挤死
const lowMemHost = os.totalmem() / 1024 / 1024 <= 2048;
const stages = lowMemHost && variant === 'release'
  ? [
      // Kotlin 冷编译最吃 metaspace，单独给一组参数
      ['蓝牙插件 Kotlin', [':capacitor-community-bluetooth-le:compileReleaseKotlin'],
        ['-Dorg.gradle.jvmargs=-Xmx240m -XX:MaxMetaspaceSize=340m -XX:MetaspaceSize=128m -XX:ReservedCodeCacheSize=40m -XX:-TieredCompilation -XX:+UseSerialGC -Xss384k -Dfile.encoding=UTF-8']],
      ['资源处理', [':app:mergeReleaseResources', ':app:processReleaseResources'],
        ['-Dorg.gradle.jvmargs=-Xmx160m -XX:MaxMetaspaceSize=300m -XX:MetaspaceSize=128m -XX:ReservedCodeCacheSize=32m -XX:-TieredCompilation -XX:+UseSerialGC -Xss384k -Dfile.encoding=UTF-8']],
      ['依赖 dex', [':app:mergeExtDexRelease'], []],
      ['打包签名', [task], []],
    ]
  : [[task, [task], []]];

const extraArgsCli = [noDaemon ? '--no-daemon' : '--daemon', '--stacktrace', ...(process.env.CK_GRADLE_ARGS ? process.env.CK_GRADLE_ARGS.split(' ') : [])];

const started = Date.now();
for (const [label, tasks, extraArgs = []] of stages) {
  log.info(`gradle 阶段：${label}（${tasks.join(' ')}）`);
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      execFileSync(gradlew, [...extraArgs, ...tasks, ...extraArgsCli], {
        cwd: paths.android,
        stdio: 'inherit',
        env: { ...process.env, JAVA_HOME, ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME },
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        log.warn(`${label} 第 1 次失败（多为内存抖动），清理后重试…`);
        try {
          const pids = execFileSync('sh', ['-c',
            'for p in /proc/[0-9]*; do c=$(cat $p/comm 2>/dev/null); case "$c" in java|aapt2) echo ${p#/proc/};; esac; done'],
            { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
          for (const pid of pids) { try { process.kill(Number(pid), 9); } catch (e) { /* noop */ } }
        } catch (e) { /* noop */ }
        continue;
      }
    }
  }
  if (lastErr) {
    log.die(`gradle 构建失败（${label}：${tasks.join(' ')}）。常见原因：SDK 组件缺失、JDK 版本过低、内存不足、网络无法下载依赖。`);
  }
}
log.ok(`gradle ${task} 完成，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);

/* ------------------------------ 收集产物 ------------------------------ */
const outDir = path.join(paths.android, 'app', 'build', 'outputs', 'apk', variant);
let apkPath = path.join(outDir, `app-${variant}.apk`);
if (!fs.existsSync(apkPath)) {
  const found = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.apk')) : [];
  if (!found.length) log.die(`找不到产物 APK：${apkPath}`);
  apkPath = path.join(outDir, found[0]);
}

ensureDir(paths.dist);
const stamp = utcStamp();
const name = `Ckarefulon-${cfg.versionName}-${cfg.versionCode}-${variant}.apk`;
const dest = path.join(paths.dist, name);
fs.copyFileSync(apkPath, dest);
fs.copyFileSync(apkPath, path.join(paths.dist, `Ckarefulon-latest-${variant}.apk`));

// 额外镜像一份到 release/（工作区持久目录，dist/ 不会被保留）
const releaseDir = path.join(ROOT, 'release');
ensureDir(releaseDir);
fs.copyFileSync(apkPath, path.join(releaseDir, name));
fs.copyFileSync(apkPath, path.join(releaseDir, `Ckarefulon-latest-${variant}.apk`));

// 顺带重打「换机器重建」源码包（release/Ckarefulon-app-kit.zip）。它同样要提交进仓库，
// 所以必须跟着发版走：2026-10 出 131 时它就停在 129，包里少了 130/131 的跨域兜底，
// 用户拿着这个包换机器重建会得到一个旧版本。失败不算构建失败（APK 已经出好了）。
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-app-kit.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  log.warn(`app-kit 源码包未能刷新（不影响本次 APK）：${(e && e.message) || e}`);
}

const bytes = fileSize(dest);
const sha = sha256File(dest);

log.step('产物');
log.ok(`${path.relative(ROOT, dest)}`);
log.info(`大小     : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
log.info(`SHA-256  : ${sha}`);

writeJson(path.join(paths.dist, 'apk-info.json'), {
  file: name,
  variant,
  appId: cfg.appId,
  versionName: cfg.versionName,
  versionCode: cfg.versionCode,
  bytes,
  sha256: sha,
  builtAt: new Date().toISOString(),
  stamp,
  signer: { alias: cfg.signer.keyAlias, name: cfg.signer.name },
});

console.log(`\n安装：adb install -r ${path.relative(process.cwd(), dest)}\n`);
