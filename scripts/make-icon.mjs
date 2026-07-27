/**
 * Generate the packaging icons from the shared mark in src/mark.js:
 *   build/icon.png   1024px master, also the Linux/dev window icon
 *   build/icon.ico   Windows, written here rather than shelled out
 *   build/icon.icns  macOS, via the `sips` + `iconutil` pair — macOS hosts only
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

// --- Windows .ico -----------------------------------------------------------

/**
 * Pack PNGs into an ICO container.
 *
 * PNG-compressed entries (rather than the older BMP form) are read by every
 * Windows since Vista, which means no image tooling is needed here and the file
 * can be produced on any host — the point being that a Mac can build the Windows
 * icon without wine or a Windows machine in the loop.
 */
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 — the field is a single byte.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size: none, it's a truecolour image
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// The sizes Windows picks between: 16 in the notification area and title bars,
// 32 on the desktop and taskbar, 48 in Explorer, 256 for large icon views.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeICO(ICO_SIZES.map((size) => ({ size, data: renderAppIcon(size) })));
const icoPath = join(BUILD, 'icon.ico');
writeFileSync(icoPath, ico);
console.log(`wrote ${icoPath} (${(ico.length / 1024).toFixed(1)} KB, ${ICO_SIZES.length} sizes)`);

// --- macOS .icns ------------------------------------------------------------

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
