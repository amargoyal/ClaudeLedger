/*
 * The Mac's half of "reachable from anywhere", checked without leaving the house.
 *
 * `failover-selftest.mjs` covers what the phone does with a list of addresses.
 * This covers what goes into that list, which is where the failure it guards
 * against actually lives: a Mac that only ever hands out LAN addresses gives the
 * phone nothing to fail over *to*, and the symptom — cached figures on cellular
 * and no explanation — looks identical to the Mac being asleep.
 */
import { readFileSync } from 'node:fs';

import { orderOrigins } from '../server.js';
import { addressKind } from '../src/lan.js';
import { isTailnetAddress } from '../src/tailscale.js';

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  return ok;
};

let pass = true;

// ------------------------------------------------------------ address kinds

pass &= check('a tailnet address is recognised', isTailnetAddress('100.67.248.30'), true);
pass &= check('the bottom of 100.64.0.0/10 is in', isTailnetAddress('100.64.0.1'), true);
pass &= check('the top of 100.64.0.0/10 is in', isTailnetAddress('100.127.255.254'), true);
// 100.0/16 and 100.128/9 are ordinary public space; calling them tailnet would
// hand the phone an address belonging to someone else entirely.
pass &= check('100.63 is not tailnet', isTailnetAddress('100.63.1.1'), false);
pass &= check('100.128 is not tailnet', isTailnetAddress('100.128.1.1'), false);
pass &= check('a LAN address is not tailnet', isTailnetAddress('192.168.1.54'), false);

pass &= check('kind: tailnet', addressKind('100.67.248.30'), 'tailnet');
pass &= check('kind: self-assigned', addressKind('169.254.246.122'), 'self-assigned');
pass &= check('kind: lan', addressKind('192.168.1.54'), 'lan');

// ----------------------------------------------------------- origin ordering

const ADDRESSES = [
  { iface: 'en0', address: '192.168.1.54', kind: 'lan' },
  { iface: 'en11', address: '169.254.246.122', kind: 'self-assigned' },
  { iface: 'utun4', address: '100.67.248.30', kind: 'tailnet' },
];
const TAILNET = { running: true, address: '100.67.248.30' };
const TUNNEL = { running: true, origin: 'https://x-y-z.trycloudflare.com' };

pass &= check(
  'reach first, speed second',
  orderOrigins({ port: 4317, tailnet: TAILNET, addresses: ADDRESSES, tunnel: TUNNEL }),
  ['http://100.67.248.30:4317', 'http://192.168.1.54:4317', 'https://x-y-z.trycloudflare.com'],
);

pass &= check(
  'a self-assigned address is never offered',
  orderOrigins({ port: 4317, tailnet: null, addresses: ADDRESSES, tunnel: null }),
  ['http://192.168.1.54:4317'],
);

pass &= check(
  'the tailnet address is not repeated as a LAN one',
  orderOrigins({ port: 4317, tailnet: TAILNET, addresses: ADDRESSES, tunnel: null }).filter((o) =>
    o.includes('100.67.248.30'),
  ).length,
  1,
);

pass &= check(
  'Tailscale off drops the address rather than offering a dead one',
  orderOrigins({
    port: 4317,
    tailnet: { running: false, address: '100.67.248.30' },
    addresses: ADDRESSES,
    tunnel: null,
  }),
  ['http://192.168.1.54:4317'],
);

pass &= check(
  'with sharing off there is nothing to offer but the tunnel',
  orderOrigins({ port: null, tailnet: TAILNET, addresses: ADDRESSES, tunnel: TUNNEL }),
  ['https://x-y-z.trycloudflare.com'],
);

// ----------------------------------------------------- the phone's own read

/*
 * `mobile/app.js` is a browser module with no exports, so the two functions
 * under test are read out of the source, the same trick `failover-selftest.mjs`
 * uses. What matters here is that the phone agrees with the Mac about which
 * addresses survive leaving the house — if it does not, its offline banner tells
 * the user to go fix something that is already on.
 */
const src = readFileSync('mobile/app.js', 'utf8');
const body = src.slice(
  src.indexOf('/**\n * How far an address reaches'),
  src.indexOf('const REACH_LABELS'),
);
const state = { conn: null };
const normalizeBase = (input) => {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw}`;
};
const candidateOrigins = () => (state.conn?.origins ?? []).map(normalizeBase);
const { originReach, hasRemoteOrigin } = new Function(
  'normalizeBase',
  'candidateOrigins',
  `${body}\n return { originReach, hasRemoteOrigin };`,
)(normalizeBase, candidateOrigins);

pass &= check('phone reads a tailnet address', originReach('http://100.67.248.30:4317'), 'tailnet');
pass &= check('phone reads a LAN address', originReach('http://192.168.1.54:4317'), 'lan');
pass &= check(
  'phone reads a tunnel address',
  originReach('https://x-y-z.trycloudflare.com'),
  'relay',
);

state.conn = { origins: ['http://192.168.1.54:4317'] };
pass &= check('LAN only means no way home', hasRemoteOrigin(), false);
state.conn = { origins: ['http://192.168.1.54:4317', 'http://100.67.248.30:4317'] };
pass &= check('a tailnet address is a way home', hasRemoteOrigin(), true);

process.exit(pass ? 0 : 1);
