/*
 * Self-test for public/qr.js.
 *
 * A QR encoder either works or produces a picture that silently fails to scan,
 * and "it looks like a QR code" is not evidence of anything. Two checks here are
 * meaningful:
 *
 *   1. Syndromes. A valid Reed-Solomon codeword evaluates to zero at the first n
 *      powers of the generator root. This is arithmetic, computed here with its
 *      own GF(256) implementation, so it does not agree with the encoder by
 *      construction — it agrees with the standard or it fails.
 *
 *   2. Round trip. The finished symbol is read back: format information decoded
 *      by brute-forcing the BCH code, mask undone, data bits walked out of the
 *      zigzag, blocks de-interleaved, syndromes checked per block, and the byte
 *      payload compared with the input.
 *
 * Run: node scripts/qr-selftest.mjs
 */
import { MASKS, generatorPoly, qrMatrix, reedSolomon } from '../public/qr.js';

// ------------------------------------------------------------- GF(256), again

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Horner evaluation of the codeword polynomial at α^power. */
function evaluateAt(codeword, power) {
  let acc = 0;
  for (const byte of codeword) acc = mul(acc, EXP[power]) ^ byte;
  return acc;
}

function syndromesZero(codeword, ecCount) {
  for (let i = 0; i < ecCount; i += 1) {
    if (evaluateAt(codeword, i) !== 0) return false;
  }
  return true;
}

// ----------------------------------------------------------------- test tables

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
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// ------------------------------------------------------------------- decoding

function reservedMap(size, version) {
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
  mark(0, 0, 9, 9);
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  for (const cy of ALIGNMENT[version]) {
    for (const cx of ALIGNMENT[version]) {
      if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
      mark(cx - 2, cy - 2, 5, 5);
    }
  }
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return reserved;
}

/** Brute-force the 32 valid format strings and find the one that was written. */
function decodeFormat(modules, size) {
  const at = (x, y) => modules[y * size + x];
  let raw = 0;
  for (let i = 0; i < 15; i += 1) {
    let bit;
    if (i < 6) bit = at(8, i);
    else if (i < 8) bit = at(8, i + 1);
    else if (i === 8) bit = at(7, 8);
    else bit = at(14 - i, 8);
    raw |= bit << i;
  }

  for (let level = 0; level < 4; level += 1) {
    for (let mask = 0; mask < 8; mask += 1) {
      const data = (level << 3) | mask;
      let rem = data;
      for (let k = 0; k < 10; k += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const encoded = (((data << 10) | rem) ^ 0x5412) >>> 0;
      if (encoded === raw) return { level, mask };
    }
  }
  return null;
}

function readCodewords(modules, size, version) {
  const reserved = reservedMap(size, version);
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let c = 0; c < 2; c += 1) {
        const x = right - c;
        if (reserved[y * size + x]) continue;
        bits.push(modules[y * size + x]);
      }
    }
    upward = !upward;
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | bits[i + k];
    bytes.push(byte);
  }
  return bytes;
}

/** Undo the interleave and hand back one array per block. */
function deinterleave(codewords, version) {
  const [ecPerBlock, groups] = EC_TABLE_M[version];
  const lengths = [];
  for (const [count, dataLen] of groups) {
    for (let i = 0; i < count; i += 1) lengths.push(dataLen);
  }

  const blocks = lengths.map(() => ({ data: [], ec: [] }));
  const maxData = Math.max(...lengths);
  let idx = 0;
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < lengths[b]) blocks[b].data.push(codewords[idx++]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) blocks[b].ec.push(codewords[idx++]);
  }
  return { blocks, ecPerBlock };
}

function decodePayload(dataCodewords, version) {
  const bits = [];
  for (const byte of dataCodewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  }
  let pos = 0;
  const take = (n) => {
    let value = 0;
    for (let i = 0; i < n; i += 1) value = (value << 1) | bits[pos++];
    return value;
  };

  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode, got ${mode.toString(2)}`);
  const length = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = take(8);
  return new TextDecoder().decode(out);
}

// ---------------------------------------------------------------------- suite

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/*
 * Generator polynomials as published in ISO/IEC 18004 Annex A, written as the α
 * exponent of each coefficient in descending degree. Comparing against these
 * catches a reversed or non-monic polynomial, which the syndrome test alone would
 * not: a consistently wrong generator still divides its own output cleanly.
 */
const PUBLISHED_GENERATORS = {
  7: [0, 87, 229, 146, 149, 238, 102, 21],
  10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
};

console.log('Generator polynomials');
for (const [degree, expected] of Object.entries(PUBLISHED_GENERATORS)) {
  const actual = Array.from(generatorPoly(Number(degree))).map((v) => LOG[v]);
  check(
    `degree ${degree} matches the published coefficients`,
    actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `got ${actual.join(',')}`,
  );
}

console.log('\nReed-Solomon syndromes');
for (const ecCount of [10, 16, 18, 22, 24, 26]) {
  const data = Array.from({ length: 30 }, (_, i) => (i * 37 + ecCount * 11) & 0xff);
  const ec = reedSolomon(data, ecCount);
  check(`${ecCount} EC codewords divide cleanly`, syndromesZero([...data, ...ec], ecCount));
}

console.log('\nSymbol round trip');
const SAMPLES = [
  'claudeledger://pair?host=192.168.1.42&code=417392',
  'claudeledger://pair?host=10.0.0.7:4317&code=000001',
  'A',
  'x'.repeat(140),
  'https://example.com/a/rather/longer/path?with=query&and=more#fragment',
];

for (const text of SAMPLES) {
  const label = text.length > 34 ? `${text.slice(0, 31)}…` : text;
  const { size, version, mask, modules } = qrMatrix(text);

  check(`v${version} size is ${version * 4 + 17}`, size === version * 4 + 17);

  const format = decodeFormat(modules, size);
  check(`v${version} format info decodes`, Boolean(format), 'no valid BCH format string found');
  check(`v${version} level is M`, format?.level === 0, `level bits ${format?.level}`);
  check(`v${version} mask matches`, format?.mask === mask, `wrote ${mask}, read ${format?.mask}`);

  // Undo the mask before reading anything back out.
  const unmasked = modules.slice();
  const reserved = reservedMap(size, version);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved[r * size + c]) continue;
      if (MASKS[mask](r, c)) unmasked[r * size + c] ^= 1;
    }
  }

  const codewords = readCodewords(unmasked, size, version);
  const { blocks, ecPerBlock } = deinterleave(codewords, version);
  const allValid = blocks.every((b) => syndromesZero([...b.data, ...b.ec], ecPerBlock));
  check(`v${version} every block is a valid codeword`, allValid);

  const payload = decodePayload(blocks.flatMap((b) => b.data), version);
  check(`v${version} payload survives: ${label}`, payload === text, `got ${payload.slice(0, 40)}`);

  // Finder patterns are the first thing a scanner looks for.
  const finderOk = [[0, 0], [size - 7, 0], [0, size - 7]].every(([ox, oy]) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        if (modules[(oy + y) * size + ox + x] !== (ring !== 2 ? 1 : 0)) return false;
      }
    }
    return true;
  });
  check(`v${version} finder patterns intact`, finderOk);
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
