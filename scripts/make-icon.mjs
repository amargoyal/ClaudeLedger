/**
 * Generate build/icon.icns (and icon.png) from the shared mark in src/mark.js,
 * then hand off to the macOS `sips` + `iconutil` pair for the .icns.
 * On non-macOS hosts it writes the PNG and stops.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAppIcon } from '../src/mark.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const SIZE = 1024;

mkdirSync(BUILD, { recursive: true });
const png = renderAppIcon(SIZE);
const pngPath = join(BUILD, 'icon.png');
writeFileSync(pngPath, png);
console.log(`wrote ${pngPath} (${(png.length / 1024).toFixed(1)} KB)`);

if (process.platform !== 'darwin') {
  console.log('not macOS — skipping .icns generation');
  process.exit(0);
}

const iconset = join(BUILD, 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

// The exact filename set `iconutil` expects.
const variants = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

for (const [px, name] of variants) {
  execFileSync('sips', ['-z', String(px), String(px), pngPath, '--out', join(iconset, name)], {
    stdio: 'ignore',
  });
}

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD, 'icon.icns')], {
  stdio: 'inherit',
});
rmSync(iconset, { recursive: true, force: true });
console.log(`wrote ${join(BUILD, 'icon.icns')}`);
