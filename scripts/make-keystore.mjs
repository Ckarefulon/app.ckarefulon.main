/**
 * 生成/检查发布签名 keystore（签名者：Ckarefulon）
 *   keys/Ckarefulon.keystore      PKCS12，别名 Ckarefulon，有效期 30 年
 *   keys/keystore.properties      口令（默认写入 .gitignore，CI 用 secrets）
 *
 * 用法：
 *   node scripts/make-keystore.mjs            # 已存在则跳过
 *   node scripts/make-keystore.mjs --force    # 重新生成（会导致老用户无法覆盖安装！）
 *   环境变量：CK_KEYSTORE_PASSWORD / CK_KEY_PASSWORD
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, ensureDir, loadConfig, log, writeJson } from './lib.mjs';

const cfg = loadConfig();
const FORCE = process.argv.includes('--force');

const keystoreFile = path.join(ROOT, cfg.signer.keystore);
const propsFile = path.join(ROOT, cfg.signer.keystoreProperties);

function findKeytool() {
  const jh = process.env.JAVA_HOME;
  const candidates = [
    jh && path.join(jh, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
    process.platform === 'win32' ? 'keytool.exe' : 'keytool',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['-help'], { stdio: 'ignore' });
      return c;
    } catch (e) { /* try next */ }
  }
  return null;
}

const keytool = findKeytool();
if (!keytool) log.die('找不到 keytool，请先安装 JDK 17+（并设置 JAVA_HOME）');

/*
 * 重建签名 = 换掉整个发版身份，代价是**已装用户必须卸载重装**（Android 只认可
 * 同一证书的覆盖安装）。所以这条路径刻意做成「不容易顺手跑过去」：
 *   · 已有 keystore 时，光 --force 不够，还要 CK_CONFIRM_ROTATE=1；
 *   · 打印旧证书指纹，让你先确认丢的是不是真的这一张；
 *   · 生成完给出必须立刻做的三件事（备份、配密钥、更新基线文档）。
 * 历史上这个项目已经因为私钥泄露换过一次证书（124–127 全部重装），不该再有第二次。
 */
if (fs.existsSync(keystoreFile) && !FORCE) {
  log.ok(`keystore 已存在：${path.relative(ROOT, keystoreFile)}（--force 可重建）`);
  log.info('查看证书指纹：npm run doctor 的「发布签名」一节');
} else {
  if (fs.existsSync(keystoreFile) && FORCE && process.env.CK_CONFIRM_ROTATE !== '1') {
    log.die(
      '拒绝执行：重建 keystore 会让已安装用户（128~131）无法覆盖安装。\n'
      + '  确认要换证书的话，用：CK_CONFIRM_ROTATE=1 npm run keystore -- --force\n'
      + '  更优先的做法是先把原密钥找回来（密码管理器 / 旧手机 / 换机器前的旧目录）。',
    );
  }
  if (fs.existsSync(keystoreFile) && FORCE) {
    log.warn('!! 重建 keystore 后，旧签名的 APK 将无法覆盖安装，用户必须卸载重装');
  }
  const storePass = process.env.CK_KEYSTORE_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const keyPass = process.env.CK_KEY_PASSWORD || storePass;

  ensureDir(path.dirname(keystoreFile));
  log.step(`生成 keystore（alias=${cfg.signer.keyAlias}）`);
  execFileSync(
    keytool,
    [
      '-genkeypair',
      '-v',
      '-keystore', keystoreFile,
      '-storetype', cfg.signer.storeType || 'PKCS12',
      '-alias', cfg.signer.keyAlias,
      '-keyalg', 'RSA',
      '-keysize', '4096',
      '-validity', String(cfg.signer.validityDays || 10950),
      '-storepass', storePass,
      '-keypass', keyPass,
      '-dname', cfg.signer.dname,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  log.ok(`已生成 ${path.relative(ROOT, keystoreFile)}`);

  fs.writeFileSync(
    propsFile,
    [
      '# Ckarefulon 发布签名口令（请勿提交到公开仓库 / 请自行备份 keystore）',
      `storeFile=${path.relative(path.dirname(propsFile), keystoreFile).split(path.sep).join('/')}`,
      `storePassword=${storePass}`,
      `keyAlias=${cfg.signer.keyAlias}`,
      `keyPassword=${keyPass}`,
      `storeType=${cfg.signer.storeType || 'PKCS12'}`,
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(propsFile, 0o600);
  log.ok(`口令已写入 ${path.relative(ROOT, propsFile)}`);
}

/* 打印证书指纹，方便核对/上传到应用商店 */
log.step('证书信息');
const out = execFileSync(
  keytool,
  ['-list', '-v', '-keystore', keystoreFile, '-storepass', readStorePass()],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
for (const line of out.split('\n')) {
  if (/^(Alias name|Entry type|Valid|Owner|Issuer|SHA1:|SHA256:|MD5:)/i.test(line.trim())) {
    log.info(line.trim());
  }
}

function readStorePass() {
  if (process.env.CK_KEYSTORE_PASSWORD) return process.env.CK_KEYSTORE_PASSWORD;
  if (fs.existsSync(propsFile)) {
    const text = fs.readFileSync(propsFile, 'utf8');
    const m = text.match(/^storePassword=(.*)$/m);
    if (m) return m[1].trim();
  }
  log.die('无法确定 keystore 口令（设置 CK_KEYSTORE_PASSWORD 或补全 keys/keystore.properties）');
}

const sha256 = (out.match(/SHA256:\s*([0-9A-F:]+)/i) || [])[1] || null;

// 供 CI 使用的摘要
writeJson(path.join(ROOT, '.build', 'keystore-info.json'), {
  alias: cfg.signer.keyAlias,
  keystore: cfg.signer.keystore,
  sha256,
  owner: (out.match(/Owner:\s*(.+)/) || [])[1]?.trim() || null,
});

/* 新密钥生成后必须立刻做的三件事 —— 这个项目的密钥已经丢过两次，
   每次都因为「生成完了就接着用」，没人备份、没人同步 CI。 */
const BASELINE_SHA = '4b164aa552e1af52bf171ebece28fa6c304b3bc20b9a0cc37bb9e05e5e0eafb9';
const norm = String(sha256 || '').replace(/:/g, '').toLowerCase();
log.step('接下来必须做的三件事（别跳）');
if (norm && norm === BASELINE_SHA) {
  log.ok('这张证书与 131 发布基线一致 —— 老用户可以直接覆盖安装，不用卸载');
} else {
  log.warn(`这是**一张新证书**（与当前基线 ${BASELINE_SHA.slice(0, 8)}… 不同）`
    + ' → 装了旧证书版本的用户必须卸载重装');
  log.info('换证书前先把上面这个 SHA-256 记下来，写进 HANDOFF 头部的「证书断代」');
}
console.log(`
  1) 立刻备份（丢了就只能再换一次证书）
       cp keys/${path.basename(cfg.signer.keystore)} keys/${path.basename(cfg.signer.keystoreProperties)} ~/ck-backup/
     口令和 keystore **分开**存放（密码管理器 / 离线磁盘）

  2) 同步到 Codespaces 个人密钥（不要用仓库级 —— 本仓库公开，仓库级对所有人可见）
       base64 -w0 keys/${path.basename(cfg.signer.keystore)} > keys-b64.txt
     GitHub → 头像 → Settings → Codespaces → Secrets，建四个：
       CK_KEYSTORE_B64 / CK_KEYSTORE_PASSWORD / CK_KEY_PASSWORD / CK_KEY_ALIAS
     （Actions 的仓库级 Secrets 也配同一套，工作流才出正式签名包）

  3) 更新文档里的基线
     HANDOFF.md 头部、docs/签名与发布.md §1 的证书 SHA-256 与「证书断代」表
     改成上面的新指纹；再跑 npm run verify 重建 release/apk-verify.json
`);
