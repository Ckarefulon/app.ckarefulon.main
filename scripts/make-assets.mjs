/**
 * 生成安卓图标 / 启动图（从站点 favicon.svg 取形，品牌色 #5d4ea8 → #24f0ea）
 *   assets/icon-only.png · icon-foreground.png · icon-background.png · splash.png · splash-dark.png
 *   然后调用 @capacitor/assets 生成各密度 mipmap / drawable
 *
 * 用法：node scripts/make-assets.mjs [--no-generate]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, ensureDir, loadConfig, log, resolveSiteDir } from './lib.mjs';

const cfg = loadConfig();
const assetsDir = path.join(ROOT, 'assets');
ensureDir(assetsDir);

const BG = cfg.android?.backgroundColor || '#161328';
const BG_TOP = '#241d47';

/* ------------------------------ 找到 favicon.svg ------------------------------ */
function findFavicon() {
  const candidates = [
    path.join(ROOT, 'assets-src', 'favicon.svg'),
    path.join(ROOT, 'shell', 'favicon.svg'),
  ];
  try {
    candidates.push(path.join(resolveSiteDir(cfg), 'favicon.svg'));
  } catch (e) { /* 没有站点源码时用内置副本 */ }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const svgFile = findFavicon();
if (!svgFile) log.die('找不到 favicon.svg（把站点的 favicon.svg 放到 assets-src/favicon.svg 后重试）');
const svg = fs.readFileSync(svgFile);
log.step(`图标源：${svgFile}`);

/* 裁掉 favicon 画布自带的大片留白：只取图形本体（bbox ≈ x17.7-102.3, y34-101.7）+ 少量边距 */
const svgRaw = fs.readFileSync(svgFile, 'utf8');
const CROPPED_SVG = svgRaw.replace(
  /width="120"\s+height="120"\s+viewBox="0 0 120 120"/,
  'viewBox="14 30 92 76"',
);
const GLYPH_ASPECT = 76 / 92; // 高/宽

/* 按“图形本体占图标宽度的比例”合成（对标成熟产品的占比） */
async function compose(outName, size, glyphWidth, bgBuilder) {
  const base = bgBuilder ? await bgBuilder(size) : null;
  const pipeline = base
    ? sharp(base)
    : sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });

  if (glyphWidth > 0) {
    const innerW = Math.round(size * glyphWidth);
    const innerH = Math.round(innerW * GLYPH_ASPECT);
    const glyph = await sharp(Buffer.from(CROPPED_SVG), { density: 400 })
      .resize(innerW, innerH, { fit: 'fill' })
      .png()
      .toBuffer();
    await pipeline
      .composite([{ input: glyph, left: Math.round((size - innerW) / 2), top: Math.round((size - innerH) / 2) }])
      .png()
      .toFile(path.join(assetsDir, outName));
  } else {
    await pipeline.png().toFile(path.join(assetsDir, outName));
  }
  log.ok(`${outName}  (${size}×${size}, 图形本体占宽 ${(glyphWidth * 100).toFixed(0)}%)`);
}

/** 品牌背景：应用图标用纯白底（用户要求），启动图保持深色品牌底 */
async function whiteBg(size) {
  const svgBg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="w" cx="50%" cy="38%" r="82%">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="78%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#f1f1f6"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#w)"/>
  </svg>`;
  return sharp(Buffer.from(svgBg)).png().toBuffer();
}

/** 深色渐变背景（启动图用） */
async function gradientBg(size) {
  const grad = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g" cx="24%" cy="16%" r="92%">
        <stop offset="0%" stop-color="${BG_TOP}"/>
        <stop offset="58%" stop-color="${BG}"/>
        <stop offset="100%" stop-color="#0d0b18"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#g)"/>
  </svg>`;
  return sharp(Buffer.from(grad)).png().toBuffer();
}

log.step('生成图标与启动图');
await compose('icon-only.png', 1024, 0.82, whiteBg);          // 传统图标：白底，图形本体占宽 82%
await compose('icon-foreground.png', 1024, 0.64, null);       // 自适应前景：占宽 64%（安全区≈66%）
await compose('icon-background.png', 1024, 0, whiteBg);       // 自适应背景：白

// 启动图：深底 + 居中 logo
await compose('splash.png', 2732, 0.34, gradientBg);
await compose('splash-dark.png', 2732, 0.34, gradientBg);

// 通知栏小图标（单色）
const mono = await sharp(svg, { density: 384 })
  .resize(256, 256)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { data, info } = mono;
for (let i = 0; i < data.length; i += info.channels) {
  const a = data[i + 3];
  data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
}
await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
  .png()
  .toFile(path.join(assetsDir, 'icon-only-notification.png'));
log.ok('icon-only-notification.png (256×256 单色)');

fs.rmSync(path.join(assetsDir, 'tmp.png'), { force: true });

if (!process.argv.includes('--no-generate')) {
  log.step('生成各密度资源（@capacitor/assets）');
  const { execFileSync } = await import('node:child_process');
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['@capacitor/assets', 'generate', '--android'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  log.ok('已写入 android/app/src/main/res/');
}
