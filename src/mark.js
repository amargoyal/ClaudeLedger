/**
 * The Ledger mark, rendered to PNG with no image dependencies.
 *
 * Shapes are signed-distance rounded rectangles evaluated per pixel, encoded via
 * node:zlib. Two consumers:
 *   - scripts/make-icon.mjs  -> the app icon (terracotta tile, cream glyph)
 *   - electron/main.cjs      -> the menu bar icon (black glyph, transparent)
 *
 * Glyph coordinates are in a 0..100 space shared with public/logo.svg. Change one,
 * change the other, or the app icon and the in-app mark drift apart.
 */
import { deflateSync } from 'node:zlib';

// Full mark: a ledger rule with four ascending usage bars standing on it.
export const GLYPH = [
  { x: 22, y: 72, w: 56, h: 7, r: 3.5 },
  { x: 24, y: 56, w: 10, h: 16, r: 5 },
  { x: 38, y: 44, w: 10, h: 28, r: 5 },
  { x: 52, y: 32, w: 10, h: 40, r: 5 },
  { x: 66, y: 20, w: 10, h: 52, r: 5 },
];

/**
 * Menu bar variant. Two departures from the full mark, both for legibility at
 * ~16px: three wider bars instead of four (four bars with 4-unit gaps collapse to
 * under a pixel each), and geometry that fills nearly the whole box so the icon
 * doesn't read as a tiny mark floating in padding.
 */
export const GLYPH_COMPACT = [
  { x: 4, y: 84, w: 92, h: 10, r: 5 },
  { x: 6, y: 54, w: 22, h: 30, r: 7 },
  { x: 39, y: 34, w: 22, h: 50, r: 7 },
  { x: 72, y: 8, w: 22, h: 76, r: 7 },
];

const TILE_TOP = [206, 122, 78];
const TILE_BOTTOM = [178, 87, 51];
const CREAM = [255, 253, 248];

/** Signed distance to a rounded rectangle: negative inside. */
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const qx = Math.max(Math.abs(px - cx) - hx, 0);
  const qy = Math.max(Math.abs(py - cy) - hy, 0);
  const outside = Math.hypot(qx, qy) - r;
  if (outside > 0) return outside;
  const inx = hx + r - Math.abs(px - cx);
  const iny = hy + r - Math.abs(py - cy);
  return -Math.min(inx, iny);
}

/** 0..1 coverage from a signed distance, giving ~1px antialiasing. */
function coverage(d) {
  return Math.min(1, Math.max(0, 0.5 - d));
}

function mapShapes(glyph, size, inset) {
  const scale = (size - inset * 2) / 100;
  const u = (n) => n * scale + inset;
  return glyph.map((s) => ({
    x0: u(s.x),
    y0: u(s.y),
    x1: u(s.x + s.w),
    y1: u(s.y + s.h),
    r: s.r * scale,
  }));
}

function glyphCoverage(shapes, px, py) {
  let cov = 0;
  for (const s of shapes) {
    cov = Math.max(cov, coverage(sdRoundRect(px, py, s.x0, s.y0, s.x1, s.y1, s.r)));
    if (cov >= 1) return 1;
  }
  return cov;
}

/**
 * The app icon: rounded terracotta tile with a vertical gradient, cream glyph.
 * `inset` leaves the margin macOS expects around an app icon.
 */
export function renderAppIcon(size, { inset = Math.round(size * 0.09) } = {}) {
  const shapes = mapShapes(GLYPH, size, inset);
  const radius = size * 0.195;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    const base = TILE_TOP.map((c, i) => Math.round(c + (TILE_BOTTOM[i] - c) * t));
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const tile = coverage(sdRoundRect(px, py, inset, inset, size - inset, size - inset, radius));

      let [r, g, b] = base;
      if (tile > 0) {
        const cov = glyphCoverage(shapes, px, py);
        if (cov > 0) {
          r = Math.round(r + (CREAM[0] - r) * cov);
          g = Math.round(g + (CREAM[1] - g) * cov);
          b = Math.round(b + (CREAM[2] - b) * cov);
        }
      }

      const i = (y * size + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = Math.round(tile * 255);
    }
  }
  return encodePNG(buf, size);
}

/**
 * Menu bar variant: opaque black glyph on transparency, no tile. macOS recolors
 * a template image for light/dark menu bars and for the highlighted state, so the
 * colour here is irrelevant — only the alpha channel matters.
 */
export function renderTemplateMark(size) {
  // Almost no padding: macOS already reserves margin around a menu bar icon, so
  // insetting again just makes the glyph look small.
  const inset = Math.round(size * 0.02);
  const shapes = mapShapes(GLYPH_COMPACT, size, inset);
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cov = glyphCoverage(shapes, x + 0.5, y + 0.5);
      const i = (y * size + x) * 4;
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = Math.round(cov * 255);
    }
  }
  return encodePNG(buf, size);
}

// --- minimal PNG writer -----------------------------------------------------

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
