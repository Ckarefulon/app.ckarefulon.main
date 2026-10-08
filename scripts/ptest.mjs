/**
 * 真网功能测试（出包闸门）：
 *   1) 真下载全部首屏核心 + vendor（多传输链）
 *   2) 验证"下载 → 入缓存回执"链路（桩 SW）
 * 离线环境自动跳过（警告），联网环境失败 = 阻断出包。
 * 用法：node scripts/ptest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { ROOT, log, paths, readJson } from './lib.mjs';

const metaPath = path.join(paths.build, 'sw-meta.json');
if (!fs.existsSync(metaPath)) log.die('缺少 .build/sw-meta.json，请先执行 npm run android:sync');

const meta = readJson(metaPath);

/* ---- 连通性探测：离线则跳过 ---- */
let online = false;
for (const o of meta.origins || []) {
  try {
    const r = await fetch(`${o.base}/favicon.svg`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { online = true; break; }
  } catch (e) { /* 下一个源 */ }
}
if (!online) {
  log.warn('ptest：无法连通任何更新源（离线？），跳过真网测试');
  process.exit(0);
}

/* ---- 打包测试入口 ---- */
const outfile = path.join(paths.build, 'ptest.cjs');
await build({
  entryPoints: [path.join(ROOT, 'scripts', 'ptest-entry.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
  banner: { js: 'globalThis.window = globalThis.window || globalThis;' },
});

/* ---- 运行 ---- */
log.step('ptest：真网下载 + 入缓存回执链路');
try {
  execFileSync(process.execPath, [outfile], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CK_SW_META: JSON.stringify(meta) },
    timeout: 180000,
  });
  log.ok('ptest 通过：首屏全文件可下载且回执链路正常');
} catch (e) {
  log.die('ptest 未通过：首屏预缓存链路存在故障，已阻断出包。');
}
