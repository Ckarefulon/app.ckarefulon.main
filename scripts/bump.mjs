/**
 * 版本号管理：node scripts/bump.mjs [patch|minor|major] [--set=1.2.3] [--code=123]
 * 只改 app.config.json（构建时自动同步到 android 工程）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log, readJson, writeJson } from './lib.mjs';

const file = path.join(ROOT, 'app.config.json');
const cfg = readJson(file);
const argv = process.argv.slice(2);
const kind = argv.find((a) => ['patch', 'minor', 'major'].includes(a));
const setArg = argv.find((a) => a.startsWith('--set='))?.split('=')[1];
const codeArg = argv.find((a) => a.startsWith('--code='))?.split('=')[1];

let [major, minor, patch] = String(cfg.versionName).split('.').map((n) => parseInt(n, 10) || 0);

if (setArg) {
  cfg.versionName = setArg.replace(/^v/, '');
} else if (kind === 'major') {
  cfg.versionName = `${major + 1}.0.0`;
} else if (kind === 'minor') {
  cfg.versionName = `${major}.${minor + 1}.0`;
} else if (kind === 'patch') {
  cfg.versionName = `${major}.${minor}.${patch + 1}`;
}

if (codeArg) {
  cfg.versionCode = Number(codeArg);
} else if (setArg || kind) {
  cfg.versionCode = Number(cfg.versionCode) + 1;
}

fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
log.ok(`versionName=${cfg.versionName}  versionCode=${cfg.versionCode}`);
log.info('下一步：npm run android:patch && npm run apk');
