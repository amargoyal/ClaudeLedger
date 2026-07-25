/**
 * Phone pairing over the local network.
 *
 * The desktop window talks to a loopback-only listener that needs no auth — it is
 * unreachable from anything but this Mac. The phone can't use that, so sharing to
 * a phone starts a *second* listener bound to every interface. That one is a real
 * network service reading your Claude usage, so it is:
 *
 *   - off until you turn it on, and it stops when the app quits;
 *   - only reachable with a bearer token issued during pairing;
 *   - paired with a 6-digit code that expires in five minutes and dies after a
 *     handful of wrong guesses.
 *
 * The OAuth token itself never leaves this machine. The phone receives shaped
 * snapshots — the same JSON the desktop window renders — and nothing else.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';

const DEVICES_FILE =
  process.env.CLAUDE_LEDGER_DEVICES_FILE ?? join(homedir(), '.claude-ledger', 'devices.json');

/** A pairing code is a one-time convenience, not a password. Keep the window short. */
const CODE_TTL_MS = 5 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

/** @typedef {{ id: string, name: string, token: string, pairedAt: number, lastSeen: number|null }} Device */

/** @type {Device[]|null} */
let devices = null;
/** @type {{ code: string, expiresAt: number, attempts: number }|null} */
let pending = null;

function load() {
  if (devices) return devices;
  devices = [];
  try {
    const disk = JSON.parse(readFileSync(DEVICES_FILE, 'utf8'));
    if (Array.isArray(disk?.devices)) {
      devices = disk.devices.filter((d) => d && typeof d.token === 'string' && typeof d.id === 'string');
    }
  } catch {
    // No devices paired yet.
  }
  return devices;
}

function save() {
  try {
    mkdirSync(dirname(DEVICES_FILE), { recursive: true });
    // 0600: this file contains bearer tokens for a live network service.
    writeFileSync(DEVICES_FILE, JSON.stringify({ devices: load() }, null, 2), { mode: 0o600 });
  } catch {
    // A read-only home directory costs persistence, not this session.
  }
}

/** Public view of a paired device — never includes the token. */
function shape(d) {
  return { id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen };
}

export function listDevices() {
  return load().map(shape);
}

export function revokeDevice(id) {
  const before = load().length;
  devices = load().filter((d) => d.id !== id);
  if (devices.length !== before) save();
  return devices.length !== before;
}

export function revokeAll() {
  devices = [];
  save();
}

// ------------------------------------------------------------------ pair codes

/**
 * Start a pairing window. Digits only: this gets typed on a phone keyboard, and
 * a numeric pad is the difference between "fine" and "annoying".
 */
export function startPairing() {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  pending = { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
  return pairingState();
}

export function stopPairing() {
  pending = null;
  return pairingState();
}

export function pairingState() {
  if (pending && pending.expiresAt <= Date.now()) pending = null;
  return pending
    ? { active: true, code: pending.code, expiresAt: pending.expiresAt, attemptsLeft: MAX_CODE_ATTEMPTS - pending.attempts }
    : { active: false, code: null, expiresAt: null, attemptsLeft: 0 };
}

/**
 * Trade a valid pairing code for a long-lived device token.
 * @returns {{ token: string, device: ReturnType<typeof shape> } | { error: string }}
 */
export function redeemPairCode(code, name) {
  if (!pending || pending.expiresAt <= Date.now()) {
    pending = null;
    return { error: 'No pairing session is open. Open Claude Ledger on your Mac and choose Pair a Phone.' };
  }

  const given = String(code ?? '').replace(/\D/g, '');
  const expected = pending.code;
  const ok =
    given.length === expected.length &&
    timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));

  if (!ok) {
    pending.attempts += 1;
    // Burning the code on repeated failure is the whole point of the counter:
    // six digits is only strong if guessing is not free.
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      pending = null;
      return { error: 'Too many wrong codes. Start pairing again on your Mac.' };
    }
    return { error: `That code doesn't match. ${MAX_CODE_ATTEMPTS - pending.attempts} tries left.` };
  }

  pending = null;
  const device = {
    id: randomBytes(8).toString('hex'),
    name: String(name ?? 'iPhone').slice(0, 48) || 'iPhone',
    token: randomBytes(32).toString('base64url'),
    pairedAt: Date.now(),
    lastSeen: Date.now(),
  };
  load().push(device);
  save();
  return { token: device.token, device: shape(device) };
}

// ---------------------------------------------------------------------- tokens

/**
 * Constant-time bearer-token lookup.
 *
 * A plain `find(d => d.token === token)` leaks token length and prefix through
 * timing. There are never many devices, so comparing against all of them costs
 * nothing.
 */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const given = Buffer.from(token, 'utf8');
  let found = null;
  for (const d of load()) {
    const known = Buffer.from(d.token, 'utf8');
    if (known.length === given.length && timingSafeEqual(known, given)) found = d;
  }
  if (found) {
    found.lastSeen = Date.now();
    // Not saved on every request — `lastSeen` is a nicety, and this runs on the
    // hot path for the phone's poll loop.
  }
  return found ? shape(found) : null;
}

/** Flush in-memory `lastSeen` updates. Called on a slow timer, not per request. */
export function persistLastSeen() {
  if (devices) save();
}

// -------------------------------------------------------------------- addresses

/**
 * Reachable IPv4 addresses for this Mac, best candidate first.
 *
 * Wi-Fi (`en0`) is what a phone will actually be on, so it is ranked above
 * Thunderbolt bridges and virtual adapters, which are usually unreachable and
 * used to be offered first purely because of interface enumeration order.
 */
export function lanAddresses() {
  const rank = (name) => {
    if (/^en0/.test(name)) return 0;
    if (/^en\d/.test(name)) return 1;
    if (/^(bridge|utun|awdl|llw|anpi|ap\d)/.test(name)) return 3;
    return 2;
  };

  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface: name, address: a.address });
    }
  }
  return out.sort((a, b) => rank(a.iface) - rank(b.iface) || a.address.localeCompare(b.address));
}
