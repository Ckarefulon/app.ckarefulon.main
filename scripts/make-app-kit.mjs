/**
 * 打「换机器重建」用的源码包：release/Ckarefulon-app-kit.zip
 *
 *   node scripts/make-app-kit.mjs
 *
 * 内容 = 本目录（壳工程）打包成 app-android/，对应站点仓库里 README 描述的目录名。
 * 排除：依赖、构建产物、签名私钥。
 *
 * ⚠️ 签名私钥**绝不能进这个包**：它会被提交到远程仓库。
 *    2026-09 事故：旧版这里带着 keys/Ckarefulon.keystore，而目标仓库可匿名克隆，
 *    等于把签名私钥公开发布（后果：任何人都能签出被系统认可为「正规升级」的假安装包）。
 *    所以下面有一道硬闸门：扫描到任何私钥文件直接报错退出，不允许「打包成功但带了私钥」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { ROOT, ensureDir, log } from './lib.mjs';

const OUT = path.join(ROOT, 'release', 'Ckarefulon-app-kit.zip');
const PREFIX = 'app-android/';

/** 不进包的东西（相对 ROOT 的路径片段） */
const EXCLUDE_DIRS = new Set([
  '.git', 'node_modules', '.build', '.cache', 'www', 'dist', 'release',
  'keys', // 私钥的合法存放地：整个目录不进包，最后用一段说明顶位
]);
const EXCLUDE_FILES = new Set(['local.properties']);
/** 私钥特征：命中即报错 */
const SECRET_PATTERNS = [/\.keystore$/i, /\.jks$/i, /^keystore\.properties$/i, /\.p12$/i, /\.pem$/i, /\.key$/i];

/** 目录前缀命中即跳过 */
const EXCLUDE_PREFIXES = [
  ['android', 'app', 'build'],
  ['android', 'build'],
  ['android', '.gradle'],
  ['android', 'capacitor-cordova-android-plugins', 'build'],
];

const skipDir = (rel, name) => {
  if (EXCLUDE_DIRS.has(name)) return true;
  const segs = rel ? `${rel}/${name}`.split('/') : [name];
  return EXCLUDE_PREFIXES.some((p) => p.length === segs.length && p.every((s, i) => s === segs[i]));
};

const files = {};
const secrets = [];
let bytes = 0;

(function walk(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDir(rel, entry.name)) continue;
      walk(abs, rel ? `${rel}/${entry.name}` : entry.name);
      continue;
    }
    if (EXCLUDE_FILES.has(entry.name)) continue;
    if (/\.log$/i.test(entry.name)) continue;
    if (SECRET_PATTERNS.some((re) => re.test(entry.name))) {
      secrets.push(rel ? `${rel}/${entry.name}` : entry.name);
      continue;
    }
    const data = fs.readFileSync(abs);
    files[PREFIX + (rel ? `${rel}/${entry.name}` : entry.name)] = new Uint8Array(data);
    bytes += data.length;
  }
})(ROOT, '');

// keys/ 已在 EXCLUDE_DIRS 里跳过，所以这里扫到的私钥 = 掉在别处的（比如误拖进 src/）
if (secrets.length) {
  log.die(
    `app-kit 里扫到签名私钥，已中止：\n  ${secrets.join('\n  ')}\n` +
    '这个包会提交到远程仓库——私钥只能放在本机 keys/（见 HANDOFF §7）。',
  );
}

// 空目录也要留（否则解包后 shell/ 之类没了）
for (const d of ['shell', 'src', 'scripts', 'docs', 'assets', 'android', 'keys']) {
  if (fs.existsSync(path.join(ROOT, d))) files[PREFIX + d + '/'] = strToU8('');
}
// keys/ 里只放「该带什么过来」的说明，私钥由使用者自己从原机器拷贝
files[PREFIX + 'keys/README.md'] = strToU8(
  '# keys/\n\n'
  + '签名私钥（`Ckarefulon.keystore` / `keystore.properties`）**不在这个包里**，只留在原机器的本机目录中。\n\n'
  + '换机器重建发布版时必须先把这两份文件拷过来，否则会生成一张新证书，\n'
  + '老用户就无法覆盖安装（必须卸载重装）。见 HANDOFF §6 / §7。\n\n'
  + '缺失时可用 `node scripts/make-keystore.mjs` 重新生成——但那是**换证书**，慎用。\n',
);

ensureDir(path.dirname(OUT));
fs.writeFileSync(OUT, Buffer.from(zipSync(files, { level: 9, mem: 8 })));
log.ok(`app-kit → ${path.relative(ROOT, OUT)}（${Object.keys(files).length} 项，原始 ${(bytes / 1048576).toFixed(1)} MB）`);
log.info('已确认不含任何签名私钥文件');
