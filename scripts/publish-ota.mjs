/**
 * 发布 OTA 资源包到站点仓库的 app-ota/ 目录（更新源：Gitee raw）
 *
 * 用法：
 *   node scripts/publish-ota.mjs                 # 只复制文件到站点仓库，不提交
 *   node scripts/publish-ota.mjs --push          # 复制 + 提交 + 推送到 publish.remotes（默认 gitee）
 *   node scripts/publish-ota.mjs --push --remote=gitee,origin
 *   node scripts/publish-ota.mjs --keep=3        # 仓库里最多保留几个历史 zip（0=不清理）
 *
 * 前置：先执行 npm run ota:bundle 生成 dist/ota/
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT, ensureDir, loadConfig, log, paths, readJson, git, resolveSiteDir, fileSize, sha256File,
} from './lib.mjs';

const cfg = loadConfig();
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const manifestFile = path.join(paths.ota, 'latest.json');
if (!fs.existsSync(manifestFile)) log.die('找不到 dist/ota/latest.json，请先执行：npm run ota:bundle');
const manifest = readJson(manifestFile);

const zipFile = path.join(paths.ota, manifest.file);
if (!fs.existsSync(zipFile)) log.die(`找不到资源包 ${zipFile}`);

/* ------------------------------ 目标仓库 ------------------------------ */
const siteDir = argv['site-dir']
  ? path.resolve(argv['site-dir'])
  : (cfg.publish?.siteRepoPath
      ? (path.isAbsolute(cfg.publish.siteRepoPath) ? cfg.publish.siteRepoPath : path.resolve(ROOT, cfg.publish.siteRepoPath))
      : null);

const repoDir = siteDir && fs.existsSync(path.join(siteDir, '.git')) ? siteDir : resolveSiteDir(cfg);
const outDir = path.join(repoDir, cfg.ota.publishDir || 'app-ota');

log.step(`发布到 ${repoDir}/${path.basename(outDir)}`);
ensureDir(outDir);

const destZip = path.join(outDir, manifest.file);
const destJson = path.join(outDir, cfg.ota.manifestFile || 'latest.json');
fs.copyFileSync(zipFile, destZip);
fs.writeFileSync(destJson, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
log.ok(`${manifest.file}（${(fileSize(destZip) / 1024 / 1024).toFixed(2)} MB）`);
log.ok(`${path.basename(destJson)} → 版本 ${manifest.version}`);

/* ------------------------------ 清理历史包 ------------------------------ */
const keep = argv.keep != null ? Number(argv.keep) : (cfg.ota.keepReleases ?? 3);
if (keep > 0) {
  const zips = fs.readdirSync(outDir)
    .filter((f) => /^www-.*\.zip$/.test(f) && f !== manifest.file)
    .map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const stale = zips.slice(Math.max(0, keep - 1));
  for (const s of stale) {
    fs.rmSync(path.join(outDir, s.f));
    log.info(`清理历史资源包 ${s.f}`);
  }
}

/* ------------------------------ 提交并推送 ------------------------------ */
if (!argv.push) {
  log.warn('未推送（加 --push 可自动提交并推送到远端）');
  printVerifyUrls(manifest);
  process.exit(0);
}

const rel = path.relative(repoDir, outDir).split(path.sep).join('/');
const message = (typeof argv.message === 'string' && argv.message)
  || (cfg.publish?.commitMessage || 'chore(ota): 发布资源包 {version}').replace('{version}', manifest.version);

const remotes = String(argv.remote || (cfg.publish?.remotes || []).join(',') || 'origin')
  .split(',').map((s) => s.trim()).filter(Boolean);

log.step('提交并推送');
const available = git(['remote'], repoDir).split('\n').map((s) => s.trim()).filter(Boolean);
log.info(`仓库现有 remote：${available.join(', ') || '(无)'}`);

git(['add', rel], repoDir);
try {
  git(['-c', 'user.name=Ckarefulon OTA Bot', '-c', 'user.email=ota@ckarefulon.local',
       'commit', '-m', message, '--', rel], repoDir);
  log.ok(`已提交：${message}`);
} catch (e) {
  if (/nothing to commit|无文件要提交/i.test(String(e.stdout || '') + String(e.stderr || ''))) {
    log.warn('内容没有变化，跳过提交');
  } else {
    log.die(`提交失败：${String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ')}`);
  }
}

const branch = argv.branch || cfg.publish?.branch || 'main';
for (const remote of remotes) {
  if (!available.includes(remote)) {
    log.warn(`跳过 ${remote}（仓库里没有这个 remote，可执行：git remote add ${remote} <地址>）`);
    continue;
  }
  try {
    git(['push', remote, `HEAD:${branch}`], repoDir, { timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
    log.ok(`已推送到 ${remote}/${branch}`);
  } catch (e) {
    log.err(`推送 ${remote} 失败：${String(e.stderr || e.message).split('\n').slice(0, 3).join(' | ')}`);
    log.info('提示：Gitee 推送需要账号密码或私人令牌（git remote set-url gitee https://<用户名>:<令牌>@gitee.com/Ckarefulon/Ckarefulon.github.io.git）');
  }
}

printVerifyUrls(manifest);

function printVerifyUrls(m) {
  log.step('验证（推送生效后 1 分钟内可访问）');
  for (const mir of m.mirrors || []) {
    log.info(`${mir.name.padEnd(14)} 清单 ${mir.manifest}`);
    log.info(`${''.padEnd(14)} 资源 ${mir.url}`);
  }
  console.log('\n手机上：打开 App → 会自动检查更新；或控制台执行 CkApp.update.check()\n');
}
