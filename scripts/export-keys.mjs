/**
 * 导出发布签名，供备份 / Codespaces 个人密钥 / Actions 仓库 Secret 使用。
 *
 *   node scripts/export-keys.mjs            # 打印清单与用法，不打印敏感值
 *   node scripts/export-keys.mjs --show     # 连 base64 一起打印（只在你能信任终端时用）
 *   node scripts/export-keys.mjs --out=DIR  # 写成文件（DIR 建议在仓库外）
 *
 * 为什么单独做一个脚本：这个项目的签名私钥已经丢过两次，每次都是「生成完就接着用，
 * 没人备份、没人同步 CI」。而手工 base64 又容易出错（换行、大小写、漏了口令文件）。
 * 这里把「要备份哪几个值、分别贴到哪里」一次说清楚，并给出可直接复制的命令。
 *
 * ⚠️ base64 只是编码、不是加密：keys-b64.txt 与私钥等价，绝不能进仓库
 *    （.gitignore 已按"私钥的一切形态"忽略，见那里的注释）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, log, paths } from './lib.mjs';

const cfg = loadConfig();
const argv = process.argv.slice(2);
const SHOW = argv.includes('--show');
const outArg = argv.find((a) => a.startsWith('--out='))?.split('=')[1];

const keystore = path.join(ROOT, cfg.signer.keystore);
const propsFile = path.join(ROOT, cfg.signer.keystoreProperties);

if (!fs.existsSync(keystore)) {
  log.die(`没有可导出的签名：${cfg.signer.keystore} 不存在\n  需要的话先跑 npm run keystore（注意：那是换证书，老用户要卸载重装）`);
}
if (!fs.existsSync(propsFile)) {
  log.die(`缺少口令文件 ${cfg.signer.keystoreProperties}，无法确认 storePassword`);
}

const props = Object.fromEntries(
  fs.readFileSync(propsFile, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const b64 = fs.readFileSync(keystore).toString('base64');
const alias = props.keyAlias || cfg.signer.keyAlias;
const storePassword = props.storePassword || '';
const keyPassword = props.keyPassword || storePassword;

log.step('发布签名清单');
log.info(`keystore      : ${cfg.signer.keystore}（${(fs.statSync(keystore).size / 1024).toFixed(1)} KB）`);
log.info(`口令文件      : ${cfg.signer.keystoreProperties}`);
log.info(`别名          : ${alias}`);
log.info(`base64 长度   : ${b64.length} 字符`);
if (!storePassword) log.warn('口令文件里没有 storePassword，CI 里需要自己设 CK_KEYSTORE_PASSWORD');

/* ---- 指纹：换机器后用它核对"还是不是同一张证书" ---- */
log.step('证书指纹（换机器后务必核对）');
const { findJavaHome } = await import('./lib.mjs');
const javaHome = findJavaHome();
if (javaHome) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(path.join(javaHome, 'bin', 'keytool'),
    ['-list', '-v', '-keystore', keystore, '-storepass', storePassword, '-alias', alias],
    { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fp = (out.match(/SHA256:\s*([0-9A-F:]+)/i) || [])[1];
  if (fp) {
    log.info(`SHA-256: ${fp}`);
    log.info('这一串应与 HANDOFF 头部「证书断代」表一致；不一致说明拿错了密钥');
  }
} else {
  log.warn('找不到 JDK，跳过指纹读取（用 keytool -list -v 手动核对）');
}

/* ---- 输出 ---- */
if (outArg) {
  const dir = path.resolve(outArg);
  fs.mkdirSync(dir, { recursive: true });
  const b64File = path.join(dir, 'Ckarefulon.keystore.b64');
  fs.writeFileSync(b64File, b64, { encoding: 'ascii', mode: 0o600 });
  const noteFile = path.join(dir, 'README-如何恢复.txt');
  fs.writeFileSync(noteFile, [
    '发布签名备份（Ckarefulon）',
    '',
    `keystore      : ${path.basename(keystore)}`,
    `别名          : ${alias}`,
    `storePassword : ${storePassword}`,
    `keyPassword   : ${keyPassword}`,
    '',
    '恢复方法（换机器 / 新 Codespace）：',
    `  1) base64 -d ${path.basename(b64File)} > keys/${path.basename(cfg.signer.keystore)}`,
    '  2) 新建 keys/keystore.properties，内容：',
    `       storeFile=../keys/${path.basename(cfg.signer.keystore)}`,
    `       storePassword=${storePassword}`,
    `       keyAlias=${alias}`,
    `       keyPassword=${keyPassword}`,
    '       storeType=PKCS12',
    '  3) npm run doctor 核对证书指纹',
    '',
    '⚠️ 这个目录就是私钥本体。放密码管理器 / 离线磁盘，别进任何 git 仓库。',
  ].join('\n'), 'utf8');
  log.ok(`已写入 ${path.relative(process.cwd(), b64File)}（权限 600）`);
  log.ok(`已写入 ${path.relative(process.cwd(), noteFile)}`);
  log.warn('目录里有私钥本体的 base64，确认不在仓库内、并尽快转存到密码管理器');
}

if (SHOW) {
  log.step('base64（可直接粘贴到 Secret）');
  console.log(b64);
} else {
  log.info('要显示 base64 请加 --show（注意终端回滚与日志留存）');
}

/* ---- 三个落地位置，逐条说清楚 ---- */
log.step('这三个地方各放什么（安全模型不同，别混）');
console.log(`
  ① Codespaces 个人密钥  —— 只影响「你自己开的 Codespace」
     头像 → Settings → Codespaces → Secrets → New secret
     Repository access 选 Ckarefulon/app.ckarefulon.main
     建：CK_KEYSTORE_B64 / CK_KEYSTORE_PASSWORD / CK_KEY_PASSWORD / CK_KEY_ALIAS
     ✅ 安全：凭据属于你个人，别人开的 Codespace 拿不到。

  ② Actions 仓库级 Secret —— 只影响「CI 跑工作流」，推荐放这里
     仓库 → Settings → Secrets and variables → Actions → New repository secret
     同样四个名字，值相同。
     ✅ 安全：工作流能读，fork 的 PR 拿不到，Codespace 也读不到。
     👉 放这里之后，CI 就能直接出正式签名包，本机/Codespace 完全不需要私钥。

  ③ ❌ 不要放进 Codespaces 的「仓库级」Secret（Settings → Secrets and variables → Codespaces）
     本仓库是 public，而**任何有额度的 GitHub 用户都能给公开仓库开 Codespace**；
     仓库级 Codespaces secret 会注入到该仓库的所有 Codespace → 等于把私钥公开。
     2026-09 那次泄露就是这么出的事（那次是裹进 zip 上了仓库）。

  备份（最重要，密钥已经丢过两次）：
     node scripts/export-keys.mjs --out=~/ck-signing-backup
     然后把目录里两个文件转存到密码管理器 / 离线磁盘（keystore 与口令**分开**存放）。
`);
log.info('提醒：私钥不进 git（.gitignore 已覆盖 keystore/properties/base64 各种形态）');
