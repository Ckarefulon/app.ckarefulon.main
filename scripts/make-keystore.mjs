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

if (fs.existsSync(keystoreFile) && !FORCE) {
  log.ok(`keystore 已存在：${path.relative(ROOT, keystoreFile)}（--force 可重建）`);
} else {
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

// 供 CI 使用的摘要
writeJson(path.join(ROOT, '.build', 'keystore-info.json'), {
  alias: cfg.signer.keyAlias,
  keystore: cfg.signer.keystore,
  sha256: (out.match(/SHA256:\s*([0-9A-F:]+)/i) || [])[1] || null,
  owner: (out.match(/Owner:\s*(.+)/) || [])[1]?.trim() || null,
});
