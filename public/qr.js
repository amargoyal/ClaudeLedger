/*
 * Minimal QR encoder — byte mode, error correction level M, versions 1–10.
 *
 * Written rather than depended on because this app ships with no runtime
 * dependencies and the only thing it needs to encode is a pairing URL of about
 * fifty characters. That fits comfortably inside version 4, so the tables below
 * stop at 10 instead of carrying all forty versions.
 *
 * Level M rather than L: this is read off a laptop screen by a phone held at an
 * angle, often with a reflection across it. The extra redundancy costs a slightly
 * denser symbol and buys a scan that works the first time.
 *
 * Reference: ISO/IEC 18004. Verified by scripts/qr-selftest.mjs, which checks the
 * Reed–Solomon remainder is genuinely divisible by the generator polynomial and
 * reads the finished symbol back out through an independent extraction pass.
 */

/** [ecCodewordsPerBlock, [ [blockCount, dataCodewords], … ] ] for level M. */
const EC_TABLE_M = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};

const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;

// ------------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    // 0x11D is the primitive polynomial QR uses: x^8 + x^4 + x^3 + x^2 + 1.
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * Generator polynomial (x - α^0)(x - α^1)…(x - α^(degree-1)), coefficients in
 * *descending* degree so poly[0] is the leading 1.
 *
 * The order matters and is easy to get backwards: the division below indexes
 * poly[i + 1], which is only the right coefficient if the polynomial is monic
 * with its leading term first. Built the other way round it still looks like a
 * plausible polynomial and still produces plausible-looking parity bytes — they
 * are simply not a valid codeword, which no amount of staring at the rendered
 * symbol would reveal.
 */
export function generatorPoly(degree) {
  let poly = [1];
  for (let d = 0; d < degree; d += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i += 1) {
      next[i] ^= poly[i]; // multiply by x
      next[i + 1] ^= gfMul(poly[i], EXP[d]); // multiply by α^d
    }
    poly = next;
  }
  return poly;
}

/** Polynomial division remainder — the error-correction codewords for a block. */
export function reedSolomon(data, ecCount) {
  const gen = generatorPoly(ecCount);
  const remainder = new Array(ecCount).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i += 1) {
        remainder[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return remainder;
}

// ------------------------------------------------------------------ bit stream

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length() {
    return this.bits.length;
  }

  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) bytes[i >> 3] |= 0x80 >> (i & 7);
    });
    return bytes;
  }
}

function totalDataCodewords(version) {
  const [, groups] = EC_TABLE_M[version];
  return groups.reduce((sum, [count, data]) => sum + count * data, 0);
}

function charCountBits(version) {
  // Byte mode: 8 bits up to version 9, 16 from version 10.
  return version <= 9 ? 8 : 16;
}

function pickVersion(byteLength, minVersion) {
  for (let v = Math.max(1, minVersion); v <= MAX_VERSION; v += 1) {
    const capacity = totalDataCodewords(v) * 8;
    if (4 + charCountBits(v) + byteLength * 8 <= capacity) return v;
  }
  throw new Error(`QR payload too long (${byteLength} bytes) for version ${MAX_VERSION}`);
}

/** Mode indicator, length, payload, terminator, then the standard pad pattern. */
function encodeData(bytes, version) {
  const capacity = totalDataCodewords(version) * 8;
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // byte mode
  buf.push(bytes.length, charCountBits(version));
  for (const byte of bytes) buf.push(byte, 8);

  buf.push(0, Math.min(4, capacity - buf.length));
  while (buf.length % 8 !== 0) buf.push(0, 1);

  const out = Array.from(buf.toBytes());
  const pad = [0xec, 0x11];
  let i = 0;
  while (out.length < totalDataCodewords(version)) {
    out.push(pad[i % 2]);
    i += 1;
  }
  return out;
}

/**
 * Split into blocks, add error correction, then interleave.
 *
 * Interleaving is what makes a burst of damage — a thumb over one corner —
 * survivable: consecutive codewords in the symbol come from different blocks, so
 * no single block absorbs all of it.
 */
function buildCodewords(dataCodewords, version) {
  const [ecPerBlock, groups] = EC_TABLE_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, dataLen] of groups) {
    for (let b = 0; b < count; b += 1) {
      const data = dataCodewords.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data, ec: reedSolomon(data, ecPerBlock) });
    }
  }

  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

// -------------------------------------------------------------------- symbol

/** Function-pattern map: 1 where a module is reserved and must not carry data. */
function reserveFunctionModules(size, version) {
  const reserved = new Uint8Array(size * size);
  const mark = (x, y, w, h) => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < size && py < size) reserved[py * size + px] = 1;
      }
    }
  };

  // Finder patterns plus their separators and the adjacent format-info strips.
  mark(0, 0, 9, 9);
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);

  // Timing patterns.
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);

  for (const cy of ALIGNMENT[version]) {
    for (const cx of ALIGNMENT[version]) {
      // The three corners are occupied by finder patterns.
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
      if (nearFinder) continue;
      mark(cx - 2, cy - 2, 5, 5);
    }
  }

  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return reserved;
}

function drawFunctionModules(modules, size, version) {
  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0;
  };

  const finder = (ox, oy) => {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const px = ox + x;
        const py = oy + y;
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        set(px, py, ring !== 2 && ring <= 3);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  for (const cy of ALIGNMENT[version]) {
    for (const cx of ALIGNMENT[version]) {
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
      if (nearFinder) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          const ring = Math.max(Math.abs(x), Math.abs(y));
          set(cx + x, cy + y, ring !== 1);
        }
      }
    }
  }

  // The dark module, always set, always here.
  set(8, size - 8, true);

  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

/** BCH(18,6) with generator 0x1F25. */
function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return ((version << 12) | rem) >>> 0;
}

/** BCH(15,5) with generator 0x537, masked with 0x5412. Level M is 0b00. */
function formatInfoBits(mask) {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return (((data << 10) | rem) ^ 0x5412) >>> 0;
}

function drawFormatInfo(modules, size, mask) {
  const bits = formatInfoBits(mask);
  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0;
  };

  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    // First copy: down the left of the top-left finder, then along its top.
    if (i < 6) set(8, i, dark);
    else if (i < 8) set(8, i + 1, dark);
    else if (i === 8) set(7, 8, dark);
    else set(14 - i, 8, dark);

    // Second copy, split between the other two finders.
    if (i < 8) set(size - 1 - i, 8, dark);
    else set(8, size - 15 + i, dark);
  }
}

/** Zigzag placement: two-module columns, bottom to top then top to bottom. */
function placeData(modules, reserved, size, codewords) {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let c = 0; c < 2; c += 1) {
        const x = right - c;
        if (reserved[y * size + x]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          dark = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
        modules[y * size + x] = dark ? 1 : 0;
      }
    }
    upward = !upward;
  }
}

export const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules from the spec, used to pick the least-noisy mask. */
function penalty(modules, size) {
  const at = (r, c) => modules[r * size + c];
  let score = 0;

  // Rule 1 — runs of five or more identical modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const rowwise of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        const cur = rowwise ? at(i, j) : at(j, i);
        const prev = rowwise ? at(i, j - 1) : at(j - 1, i);
        if (cur === prev) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j + 11 <= size; j += 1) {
      let rowA = true;
      let rowB = true;
      let colA = true;
      let colB = true;
      for (let k = 0; k < 11; k += 1) {
        if (at(i, j + k) !== A[k]) rowA = false;
        if (at(i, j + k) !== B[k]) rowB = false;
        if (at(j + k, i) !== A[k]) colA = false;
        if (at(j + k, i) !== B[k]) colB = false;
      }
      if (rowA) score += 40;
      if (rowB) score += 40;
      if (colA) score += 40;
      if (colB) score += 40;
    }
  }

  // Rule 4 — deviation from an even split of dark and light.
  let dark = 0;
  for (let i = 0; i < modules.length; i += 1) dark += modules[i];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` and return the finished symbol.
 * @returns {{ size: number, version: number, mask: number, modules: Uint8Array }}
 *   `modules` is row-major, 1 = dark.
 */
export function qrMatrix(text, { minVersion = 1 } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length, minVersion);
  const size = version * 4 + 17;

  const codewords = buildCodewords(encodeData(bytes, version), version);
  const reserved = reserveFunctionModules(size, version);

  const base = new Uint8Array(size * size);
  drawFunctionModules(base, size, version);
  placeData(base, reserved, size, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.slice();
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (reserved[r * size + c]) continue;
        if (MASKS[mask](r, c)) candidate[r * size + c] ^= 1;
      }
    }
    drawFormatInfo(candidate, size, mask);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, mask, modules: candidate };
  }

  return { size, version, mask: best.mask, modules: best.modules };
}

/**
 * Render a symbol as an `<svg>` element.
 *
 * One `<path>` of small squares rather than one `<rect>` per module: a version 4
 * symbol is 1,089 modules, and that many elements makes the pairing window
 * noticeably slow to open.
 */
export function qrSvg(text, { size = 220, quiet = 4, dark = '#29241d', light = '#fffdf8' } = {}) {
  const { size: count, modules } = qrMatrix(text);
  const total = count + quiet * 2;

  let path = '';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (modules[r * count + c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Pairing code');

  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('fill', light);
  svg.append(bg);

  const fg = document.createElementNS(ns, 'path');
  fg.setAttribute('d', path);
  fg.setAttribute('fill', dark);
  svg.append(fg);

  return svg;
}
