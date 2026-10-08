/**
 * 按 app.config.json 定制 Capacitor 生成的 Android 工程（可重复执行，幂等）
 *   · AndroidManifest.xml：蓝牙 BLE 权限、uses-feature、软键盘模式
 *   · app/build.gradle   ：versionCode / versionName / release 签名（Ckarefulon keystore）
 *   · variables.gradle   ：minSdk / targetSdk / compileSdk
 *   · gradle.properties  ：JVM 内存（自动适配低内存机器）
 *   · strings.xml/colors.xml：应用名与品牌色
 *
 * 用法：node scripts/patch-android.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, ensureDir, loadConfig, log, paths } from './lib.mjs';

const cfg = loadConfig();
const A = paths.android;
const appDir = path.join(A, 'app');
const mainDir = path.join(appDir, 'src', 'main');

if (!fs.existsSync(appDir)) log.die('android/ 工程不存在，请先执行：npx cap add android');

const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => { ensureDir(path.dirname(f)); fs.writeFileSync(f, s, 'utf8'); };

/** 在 <!-- marker:start --> … <!-- marker:end --> 之间替换；没有标记就按 anchor 插入 */
function upsertBlock(text, marker, block, anchor, { before = false } = {}) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const wrapped = `${start}\n${block}\n    ${end}`;
  if (text.includes(start)) return text.replace(new RegExp(`${esc(start)}[\\s\\S]*?${esc(end)}`), wrapped);
  if (!text.includes(anchor)) throw new Error(`找不到插入锚点：${anchor.slice(0, 60)}…`);
  return before ? text.replace(anchor, `${wrapped}\n\n    ${anchor}`) : text.replace(anchor, `${anchor}\n\n    ${wrapped}`);
}

/* ============================== 1. AndroidManifest.xml ============================== */
log.step('定制 AndroidManifest.xml');
const manifestFile = path.join(mainDir, 'AndroidManifest.xml');
let manifest = read(manifestFile);

if (!manifest.includes('xmlns:tools=')) {
  manifest = manifest.replace(
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools">',
  );
}

const bt = cfg.android?.bluetooth || { enabled: true };
const neverForLocation = bt.neverForLocation === true;

const permissionLines = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
];

if (bt.enabled !== false) {
  permissionLines.push(
    '',
    '<!-- 蓝牙 BLE（智能魔方等设备）：Android 12 / API 31+ -->',
    neverForLocation
      ? '<uses-permission android:name="android.permission.BLUETOOTH_SCAN"\n        android:usesPermissionFlags="neverForLocation"\n        tools:targetApi="s" />'
      : '<uses-permission android:name="android.permission.BLUETOOTH_SCAN"\n        tools:targetApi="s" />',
    '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT"\n        tools:targetApi="s" />',
    '',
    '<!-- Android 11 / API 30 及以下：BLE 扫描需要定位权限（系统限制） -->',
    '<uses-permission android:name="android.permission.BLUETOOTH"\n        android:maxSdkVersion="30" />',
    '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN"\n        android:maxSdkVersion="30" />',
    '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"\n        android:maxSdkVersion="30" />',
    '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"\n        android:maxSdkVersion="30" />',
    '',
    '<uses-feature\n        android:name="android.hardware.bluetooth_le"\n        android:required="false" />',
    '<uses-feature\n        android:name="android.hardware.bluetooth"\n        android:required="false" />',
  );
}

const permBlock = permissionLines.map((l) => (l ? `    ${l}` : '')).join('\n');

// 去掉模板自带的 INTERNET 权限行，统一由我们的块管理
manifest = manifest.replace(/\n[ \t]*<uses-permission android:name="android\.permission\.INTERNET" \/>\n<\/manifest>/, '\n</manifest>');
manifest = manifest.replace(/([ \t]*<!-- Permissions -->\n)([\s\S]*?)(<\/manifest>)/, '$1$3');
manifest = upsertBlock(manifest, 'ck-permissions', permBlock, '</manifest>', { before: true });

if (!manifest.includes('android:windowSoftInputMode')) {
  manifest = manifest.replace(
    'android:launchMode="singleTask"',
    'android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"',
  );
}
manifest = manifest.replace('android:allowBackup="true"', `android:allowBackup="${cfg.android?.allowBackup === false ? 'false' : 'true'}"`);

// http 方案（兼容老 WebView）时允许 cleartext，避免 interception 漏网时直接断网
if ((cfg.android?.webScheme || 'https') === 'http' && !manifest.includes('android:usesCleartextTraffic')) {
  manifest = manifest.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
}

write(manifestFile, manifest);
log.ok(`权限：蓝牙 BLE（neverForLocation=${neverForLocation}）+ 网络状态`);

/* ============================== 2. app/build.gradle ============================== */
log.step('定制 app/build.gradle（版本号 + 签名）');
const gradleFile = path.join(appDir, 'build.gradle');
let gradle = read(gradleFile);

gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${cfg.versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${cfg.versionName}"`);

// gradle 的 rootProject 是 android/，keystore 在工程根目录，所以用 ../ 前缀
const keystoreRel = `../${cfg.signer.keystore.replace(/\\/g, '/').replace(/^\.\//, '')}`;
const keystorePropsRel = `../${cfg.signer.keystoreProperties.replace(/\\/g, '/').replace(/^\.\//, '')}`;

const SIGN_MARK = '// ==== ck:signing:start ====';
const SIGN_END = '// ==== ck:signing:end ====';
const signingBlock = `    ${SIGN_MARK}
    // 签名信息来自 ${keystorePropsRel}（本地文件，不入库）；CI 里由 secrets 生成
    def ckKeystoreProps = new Properties()
    def ckKeystorePropsFile = rootProject.file("${keystorePropsRel}")
    if (ckKeystorePropsFile.exists()) {
        ckKeystorePropsFile.withInputStream { ckKeystoreProps.load(it) }
    }
    def ckKeystoreFile = rootProject.file("${keystoreRel}")

    signingConfigs {
        release {
            if (ckKeystoreFile.exists()) {
                storeFile ckKeystoreFile
                storePassword ckKeystoreProps.getProperty("storePassword", System.getenv("CK_KEYSTORE_PASSWORD") ?: "")
                keyAlias ckKeystoreProps.getProperty("keyAlias", "${cfg.signer.keyAlias}")
                keyPassword ckKeystoreProps.getProperty("keyPassword", System.getenv("CK_KEY_PASSWORD") ?: "")
                storeType ckKeystoreProps.getProperty("storeType", "PKCS12")
                enableV1Signing true
                enableV2Signing true
                enableV3Signing true
                enableV4Signing false
            }
        }
    }
    ${SIGN_END}`;

if (gradle.includes(SIGN_MARK)) {
  gradle = gradle.replace(new RegExp(`[ \\t]*${SIGN_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${SIGN_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), signingBlock);
} else {
  gradle = gradle.replace(/android \{\n/, `android {\n${signingBlock}\n\n`);
}

const BUILD_TYPES_MARK = '// ck-release-signing';const buildTypesBlock = `    buildTypes {
        release {
            ${BUILD_TYPES_MARK}
            if (ckKeystoreFile.exists()) {
                signingConfig signingConfigs.release
            } else {
                signingConfig signingConfigs.debug
                logger.warn("[ck] 未找到 ${keystoreRel}，release 包将使用 debug 签名（不能用于正式发布）")
            }
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }`;
gradle = gradle.replace(/\n {4}buildTypes \{[\s\S]*?\n {4}\}/, `\n${buildTypesBlock}`);

// release 构建默认会跑 lintVital（内存大户，WebView 壳项目收益为零）→ 关掉
const LINT_MARK = '// ck-lint-off';
if (!gradle.includes(LINT_MARK)) {
  gradle = gradle.replace(
    /\n {4}buildTypes \{/,
    `\n    lint {\n        ${LINT_MARK}\n        checkReleaseBuilds false\n        abortOnError false\n    }\n    buildTypes {`,
  );
}

write(gradleFile, gradle);
log.ok(`versionName=${cfg.versionName} versionCode=${cfg.versionCode}，签名 alias=${cfg.signer.keyAlias}`);

/* ============================== 3. variables.gradle ============================== */
log.step('定制 variables.gradle');
const varsFile = path.join(A, 'variables.gradle');
let vars = read(varsFile);
vars = vars.replace(/minSdkVersion = \d+/, `minSdkVersion = ${cfg.android.minSdkVersion}`);
vars = vars.replace(/compileSdkVersion = \d+/, `compileSdkVersion = ${cfg.android.compileSdkVersion}`);
vars = vars.replace(/targetSdkVersion = \d+/, `targetSdkVersion = ${cfg.android.targetSdkVersion}`);
write(varsFile, vars);
log.ok(`minSdk=${cfg.android.minSdkVersion} target/compile=${cfg.android.targetSdkVersion}`);

/* ============================== 4. gradle.properties ============================== */
const propsFile = path.join(A, 'gradle.properties');
let props = read(propsFile);

const setProp = (text, key, value) => {
  const re = new RegExp(`^[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return `${text.replace(/\s+$/, '')}\n${key}=${value}\n`;
};

// 低内存机器（<=2GB，例如小规格 CI runner / 虚拟机）用保守参数，避免进程被 OOM 杀掉
const totalMb = os.totalmem() / 1024 / 1024;
const lowMem = totalMb <= 2048;

props = setProp(props, 'org.gradle.jvmargs', lowMem
  ? '-Xmx320m -XX:MaxMetaspaceSize=280m -XX:MetaspaceSize=128m -XX:ReservedCodeCacheSize=40m -XX:-TieredCompilation -XX:+UseSerialGC -Xss384k -Dfile.encoding=UTF-8'
  : '-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8');
props = setProp(props, 'org.gradle.parallel', lowMem ? 'false' : 'true');
props = setProp(props, 'org.gradle.caching', 'true');
props = setProp(props, 'android.nonTransitiveRClass', 'false');
if (lowMem) {
  props = setProp(props, 'org.gradle.workers.max', '1');
  props = setProp(props, 'kotlin.compiler.execution.strategy', 'in-process');
  props = setProp(props, 'kotlin.daemon.jvmargs', '-Xmx384m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC');
}
write(propsFile, props);
log.ok(`gradle.properties：内存 ${Math.round(totalMb)}MB → ${lowMem ? '低内存模式（-Xmx320m 串行，Kotlin 进程内编译）' : '标准模式（-Xmx2048m 并行）'}`);

/* ============================== 5. strings.xml / colors.xml ============================== */
log.step('定制应用名与品牌色');
const stringsFile = path.join(mainDir, 'res', 'values', 'strings.xml');
write(stringsFile, `<?xml version='1.0' encoding='utf-8'?>\n<resources>\n    <string name="app_name">${cfg.appName}</string>\n    <string name="title_activity_main">${cfg.appName}</string>\n    <string name="package_name">${cfg.appId}</string>\n    <string name="custom_url_scheme">${cfg.appId}</string>\n</resources>\n`);

const colorsFile = path.join(mainDir, 'res', 'values', 'colors.xml');
const bg = cfg.android.backgroundColor || '#161328';
const accent = cfg.android.accentColor || '#24F0EA';
write(colorsFile, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="colorPrimary">#5D4EA8</color>\n    <color name="colorPrimaryDark">${bg}</color>\n    <color name="colorAccent">${accent}</color>\n</resources>\n`);
log.ok(`app_name=${cfg.appName}，主色 ${bg} / ${accent}`);

/* ============================== 7. 精简 splash 资源 ============================== */
// 横屏/竖屏重复的 splash 变体会让 aapt2 内存与 APK 体积翻倍；
// 竖屏版本改名为通用密度版本，横屏直接复用（启动页一闪而过，视觉无差异）。
log.step('精简 splash 资源（省内存、减体积）');
const resDir = path.join(mainDir, 'res');
let moved = 0;
for (const dir of fs.existsSync(resDir) ? fs.readdirSync(resDir) : []) {
  const m = /^drawable-port(-night)?-(ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)$/.exec(dir);
  if (!m) continue;
  const from = path.join(resDir, dir);
  const to = path.join(resDir, `drawable${m[1] || ''}-${m[2]}`);
  if (!fs.existsSync(to)) { fs.renameSync(from, to); moved++; }
  else fs.rmSync(from, { recursive: true, force: true });
}
for (const dir of fs.readdirSync(resDir)) {
  if (/^drawable-land/.test(dir)) { fs.rmSync(path.join(resDir, dir), { recursive: true, force: true }); moved++; }
}
log.ok(`splash 变体合并 ${moved} 处`);

/* ============================== 7. MainActivity：只在版本变化时清旧 SW 注册 ============================== */
// 覆盖安装会保留 WebView 数据（含旧 SW）。旧 SW 若无兜底逻辑会把文档请求直接搞成 ERR_FAILED，
// 且新页面脚本无法运行去自救 —— 所以**版本变化时**清掉 SW 的注册表/脚本缓存（壳会立刻重新注册）。
// 版本没变就保留注册：热启动 controller 立等可取，壳能静默秒进站点（每次启动都清 = 每次都重装
// SW = 启动页每次闪一下"正在安装/正在缓存"，用户回执的"二进闪缓存界面"）。
// **站点离线缓存（Service Worker/CacheStorage）和 Local Storage 一律保留**：
// 产品要求“先保证正常打开，即使不是最新版”，秒进旧内容 + 进站后后台更新才是对的顺序。
log.step('定制 MainActivity（只在版本变化时清旧 SW 注册，离线缓存保留）');
const mainActivityFile = path.join(mainDir, 'java', ...cfg.appId.split('.'), 'MainActivity.java');
const mainActivitySrc = `package ${cfg.appId};

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import java.io.File;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        resetWebRuntimeIfUpgraded();
        super.onCreate(savedInstanceState);
        applySystemBarInsets();
    }

    /**
     * targetSdk 35+ 系统强制 edge-to-edge：WebView 会一直顶到屏幕最上沿，
     * 站点导航就被压在状态栏底下（底部内容也会被手势条盖住）。
     * 这里把系统栏/刘海的 insets 换成 WebView 的外边距 —— 内容从状态栏下面开始，
     * 导航完整可见可点。insets 在这里消费掉，CSS 的 env(safe-area-inset-*) 不会再叠加。
     * 键盘仍走 adjustResize（manifest 已配），这里刻意不吃 ime insets，避免双重避让。
     */
    private void applySystemBarInsets() {
        try {
            View web = findViewById(R.id.webview);
            if (web == null) return;
            ViewCompat.setOnApplyWindowInsetsListener(web, (v, windowInsets) -> {
                applyBarMargins(v, windowInsets);
                return WindowInsetsCompat.CONSUMED;
            });
        } catch (Throwable ignored) {
            // insets 处理失败绝不能影响启动
        }
    }

    /**
     * 兜底：不依赖 insets 派发，直接读根视图的 insets 补一次边距。
     * 个别机型/时序下系统栏 insets 不会派发到 WebView，监听器收不到，
     * 边距就设置不上去 —— 页面继续顶到状态栏底下。onResume 里显式补一次。
     * 两条机制设置的是同一个值，重复执行是幂等的，不会叠加。
     */
    @Override
    public void onResume() {
        super.onResume();
        try {
            View web = findViewById(R.id.webview);
            WindowInsetsCompat root = web == null ? null : ViewCompat.getRootWindowInsets(web);
            if (root != null) applyBarMargins(web, root);
        } catch (Throwable ignored) {
        }
    }

    private void applyBarMargins(View web, WindowInsetsCompat windowInsets) {
        try {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) web.getLayoutParams();
            if (lp != null && (lp.topMargin != bars.top || lp.bottomMargin != bars.bottom)) {
                lp.topMargin = bars.top;
                lp.bottomMargin = bars.bottom;
                web.setLayoutParams(lp);
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 清掉 ServiceWorker 的**注册表和脚本缓存**（任何 profile 目录）。
     * 只在**版本变化（覆盖安装）**时调用 —— 旧 APK 的 SW 可能把 https://localhost/
     * 的文档请求直接搞成 ERR_FAILED，使新代码无法运行自救；清掉后壳会立刻重新注册
     * （脚本在 APK 内，极快）。
     * 版本没变就**保留注册**：热启动时 controller 立等可取，壳能静默秒进站点。
     * 以前每次冷启动都清 → 每次都要重装一遍 SW → 启动页每次都要闪一下
     * "正在安装离线服务/正在缓存"（用户回执的"二进闪缓存界面"）。
     *
     * ⚠️ 只能删 Database / ScriptCache，**绝不能删整个 "Service Worker" 目录**：
     * Chromium 把 CacheStorage（站点离线缓存）存在它的子目录 Service Worker/CacheStorage 里。
     * 以前删的是整个目录 → 每次冷启动都把离线缓存清空 → 用户每次打开都要重新下载首屏，
     * 断网冷启动直接进不去（"每次都要缓存，还没修好"的真凶）。
     */
    private void purgeServiceWorkerRegistrations() {
        try {
            File webview = new File(getDataDir(), "app_webview");
            File[] profiles = webview.listFiles();
            if (profiles == null) return;
            for (File profile : profiles) {
                if (!profile.isDirectory()) continue;
                File sw = new File(profile, "Service Worker");
                deleteDeep(new File(sw, "Database"));
                deleteDeep(new File(sw, "ScriptCache"));
            }
        } catch (Throwable ignored) {
        }
    }

    private void resetWebRuntimeIfUpgraded() {
        try {
            SharedPreferences sp = getSharedPreferences("ck_shell", MODE_PRIVATE);
            int last = sp.getInt("versionCode", 0);
            int now = (int) getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            if (last != 0 && last != now) {
                // 只在版本变化时清理：
                // ① 旧 SW 注册 + 脚本缓存（防旧 SW 拦死文档请求，新代码无法自救）
                purgeServiceWorkerRegistrations();
                // ② HTTP / 代码缓存（旧壳的编译产物）。
                // **不清站点离线缓存（CacheStorage）和 Local Storage**：
                // 产品要求"先保证正常打开，即使不是最新版" —— 升级后照样秒进旧内容，
                // 新版由进站后的更新检查在后台下载完，再弹框让用户确认刷新。
                File def = new File(getDataDir(), "app_webview/Default");
                deleteDeep(new File(def, "Cache"));
                deleteDeep(new File(def, "Code Cache"));
            }
            if (last != now) {
                sp.edit().putInt("versionCode", now).apply();
            }
        } catch (Throwable ignored) {
            // 绝不允许清理逻辑影响启动
        }
    }

    private void deleteDeep(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteDeep(c);
        }
        f.delete();
    }
}
`;
ensureDir(path.dirname(mainActivityFile));
fs.writeFileSync(mainActivityFile, mainActivitySrc, 'utf8');
log.ok(`MainActivity → ${path.relative(ROOT, mainActivityFile)}（只在版本变化时清 SW 注册/脚本缓存，离线缓存与用户数据保留）`);

/* ============================== 8. local.properties ============================== */
const localProps = path.join(A, 'local.properties');
const sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
if (sdkDir && !fs.existsSync(localProps)) {
  write(localProps, `## 本机 Android SDK 路径（自动生成，请勿提交）\nsdk.dir=${sdkDir.replace(/\\/g, '\\\\')}\n`);
  log.ok(`已写入 android/local.properties（sdk.dir=${sdkDir}）`);
}

log.ok('Android 工程定制完成');
