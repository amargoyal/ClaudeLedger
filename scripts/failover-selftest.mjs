/*
 * The phone's address failover, exercised without a phone.
 *
 * `mobile/app.js` is a browser module with no build step and no exports, so the
 * three functions under test are read out of the source and evaluated against a
 * stubbed request. That is uglier than importing them and worth it: the failure
 * this guards against — a phone that silently stops finding its Mac after the
 * tunnel hostname rotates — is invisible until someone is away from home.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('mobile/app.js', 'utf8');
const cut = (start, end) => src.slice(src.indexOf(start), src.indexOf(end));

const DEFAULT_PORT = 4317;
const KEY_CONN = 'conn';
const store = {};
const writeJSON = (k, v) => { store[k] = v; return true; };
const state = { conn: null };
class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) { super(message); this.status = status; this.code = code; }
}

let served = new Set();
let calls = [];
async function request(path, { base, timeout } = {}) {
  calls.push({ base, timeout });
  if (!served.has(base)) throw new ApiError('offline', { code: 'offline' });
  if (path === '/api/boom') throw new ApiError('nope', { status: 401 });
  return { ok: true, origins: [...served] };
}

const body = [
  cut('function normalizeBase(input)', 'class ApiError'),
  cut('/** Addresses worth trying', '// ------------------------------------------------------------------ formatting'),
].join('\n');

const load = new Function(
  'DEFAULT_PORT', 'KEY_CONN', 'writeJSON', 'state', 'ApiError', 'request',
  `${body}\n return { api, candidateOrigins, learnOrigins, normalizeBase };`,
);
const { api, candidateOrigins } = load(DEFAULT_PORT, KEY_CONN, writeJSON, state, ApiError, request);

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  return ok;
};

let pass = true;

// Paired on the tunnel; the Mac restarts and hands out a new one.
state.conn = {
  baseUrl: 'https://old-tunnel.trycloudflare.com',
  origins: ['https://old-tunnel.trycloudflare.com', 'http://192.168.1.54:4317'],
};
served = new Set(['http://192.168.1.54:4317', 'https://new-tunnel.trycloudflare.com']);
calls = [];
await api('/api/snapshot');
pass &= check('dead tunnel falls through to the LAN address', state.conn.baseUrl, 'http://192.168.1.54:4317');
pass &= check('new tunnel learned, dead one dropped', state.conn.origins,
  ['http://192.168.1.54:4317', 'https://new-tunnel.trycloudflare.com']);
pass &= check('fallbacks get the short timeout', calls.map((c) => c.timeout), [undefined, 6000]);

// Later, away from home: only the tunnel answers.
served = new Set(['https://new-tunnel.trycloudflare.com']);
calls = [];
await api('/api/snapshot');
pass &= check('on cellular it promotes the tunnel it learned', state.conn.baseUrl, 'https://new-tunnel.trycloudflare.com');
pass &= check('tried the last-good address first', calls[0].base, 'http://192.168.1.54:4317');

// An answering Mac that refuses is not a reason to go looking elsewhere.
calls = [];
let status = 0;
try { await api('/api/boom'); } catch (err) { status = err.status; }
pass &= check('a 401 is not retried against other addresses', calls.length, 1);
pass &= check('and it surfaces as itself', status, 401);

// Nothing answers.
served = new Set();
let code = null;
try { await api('/api/snapshot'); } catch (err) { code = err.code; }
pass &= check('all dead reports offline', code, 'offline');
pass &= check('and keeps the list for next time', state.conn.origins.length, 2);

process.exit(pass ? 0 : 1);
