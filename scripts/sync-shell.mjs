/**
 * 生成 APK 的 webDir（www/）——里面只有“壳”，不含站点内容
 *   www/index.html            启动页（首次下载 / 激活 OTA 资源包）
 *   www/ckapp/ck-app.js       壳运行时
 *   www/ckapp/ck-app.css      运行时样式
 *   www/ckapp/ck-version.json 壳版本信息
 *
 * 用法：node scripts/sync-shell.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ensureDir, rmrf, copyTree, loadConfig, log, paths } from './lib.mjs';

const cfg = loadConfig();
const shellDir = path.join(ROOT, cfg.shell?.dir || 'shell');
const runtimeDir = path.join(paths.build, 'shell', 'ckapp');

if (!fs.existsSync(shellDir)) log.die(`找不到壳目录：${shellDir}`);
if (!fs.existsSync(path.join(runtimeDir, 'ck-app.js'))) {
  log.die('壳运行时尚未构建，请先执行：npm run bundle:js');
}

log.step('生成 www/（仅壳，不含站点内容）');
rmrf(paths.www);
ensureDir(paths.www);

const n1 = copyTree(shellDir, paths.www);
const n2 = copyTree(runtimeDir, path.join(paths.www, 'ckapp'));
const rootExtra = path.join(paths.build, 'shell', 'root');
let n3 = 0;
if (fs.existsSync(rootExtra)) n3 = copyTree(rootExtra, paths.www);

if (!fs.existsSync(path.join(paths.www, 'index.html'))) {
  log.die('www/index.html 不存在，壳不完整');
}

const total = [...fs.readdirSync(paths.www)];
log.ok(`壳页面 ${n1} 个文件 + 运行时 ${n2} 个文件 + 根资源 ${n3} 个 → www/ (${[...fs.readdirSync(paths.www)].join(', ')})`);

// 体积自检：壳应该非常小
let bytes = 0;
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else bytes += st.size;
  }
};
walk(paths.www);
log.info(`www/ 合计 ${(bytes / 1024).toFixed(1)} KB`);
if (bytes > 2 * 1024 * 1024) log.warn('壳体积超过 2 MB，请确认没有把站点内容误打进 APK');
