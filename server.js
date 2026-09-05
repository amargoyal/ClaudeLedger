import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAccount, invalidateAccountCache } from './src/anthropic.js';
import { readConnection } from './src/credentials.js';
import { METRIC_IDS, buildSnapshot, metricSeries, usageCurve } from './src/aggregate.js';
import { query as queryHistory, span as historySpan } from './src/history.js';
import { fingerprint, loadEvents } from './src/transcripts.js';
import { refreshTunnel, tunnelState } from './src/tunnel.js';
import { refreshTailscale, tailscaleState } from './src/tailscale.js';
import {
  lanAddresses,
  listDevices,
  pairingState,
  persistLastSeen,
  redeemPairCode,
  revokeDevice,
  verifyToken,
} from './src/lan.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
/** The phone UI. Also what Capacitor bundles into the iOS app. */
const MOBILE_DIR = join(ROOT, 'mobile');

/** Read once at startup so the UI can show which build is running. */
const APP_VERSION = await (async () => {
  try {
    return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname URL path, already stripped of any mount prefix
 * @param {string} dir directory to serve from
 * @param {string} indexFile file to return for "/"
 */
async function serveStatic(res, pathname, dir, indexFile = 'index.html') {
  // normalize() collapses ".." before we join, so a crafted path can't escape
  // the served directory.
  const rel = normalize(pathname === '/' || pathname === '' ? `/${indexFile}` : pathname).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const file = join(dir, rel);
  if (!file.startsWith(dir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      // `no-cache` still lets Chromium reuse a cached copy when the response
      // carries no ETag or Last-Modified — which meant edited HTML/CSS/JS kept
      // rendering stale in the app window. Nothing here is worth caching anyway.
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

/*
 * Every address this Mac can be reached on, best first.
 *
 * The phone stores the list rather than the one address it happened to pair on.
 * That address was only ever right for one network: a LAN address is nothing
 * from cellular, and a Cloudflare quick tunnel takes a new random hostname every
 * time it starts, so a phone holding one string is a phone that works until the
 * Mac is restarted once.
 *
 * The order is by reach first and speed second:
 *
 *   1. the tailnet address, which answers from anywhere the phone has Tailscale
 *      and — the part that matters — is the same string tomorrow. It takes the
 *      direct route on the same Wi-Fi, so being first costs nothing at home;
 *   2. the LAN addresses, which answer only at home but answer fastest there,
 *      and cover a phone with no Tailscale on this Wi-Fi;
 *   3. the Cloudflare tunnel, a round trip through Cloudflare's edge, and the
 *      one entry that needs nothing installed on the phone at all.
 *
 * Every response the phone can reach carries this list, so it is re-learned
 * rather than remembered — come home, connect over Wi-Fi, and today's tunnel
 * address arrives with the next snapshot. That re-learning is exactly what a
 * phone on cellular cannot do, which is why entry 1 exists.
 */
/** The port the phone-facing listener is on, or null while it is off. */
let lanPort = null;

export function orderOrigins({ port, tailnet, addresses = [], tunnel }) {
  const origins = [];
  if (port) {
    if (tailnet?.running && tailnet.address) origins.push(`http://${tailnet.address}:${port}`);
    for (const { address, kind } of addresses) {
      // `self-assigned` is 169.254/16, what an interface gives itself when no
      // DHCP answered: never reachable by anything, and on the phone it costs a
      // timeout on the way to an address that works. `tailnet` is already above,
      // where it is labelled rather than mistaken for a local address.
      if (kind !== 'lan') continue;
      origins.push(`http://${address}:${port}`);
    }
  }
  if (tunnel?.running && tunnel.origin) origins.push(tunnel.origin);
  return [...new Set(origins)];
}

function reachableOrigins(port) {
  return orderOrigins({
    port,
    tailnet: tailscaleState(),
    addresses: lanAddresses(),
    tunnel: tunnelState(),
  });
}

/**
 * How this Mac can currently be reached, for a client that wants to say so.
 *
 * The phone can work most of this out from the address that answered, but not
 * the difference between "Tailscale is off on the Mac" and "you never installed
 * it" — and that is the difference between two very different next steps.
 */
function reachState() {
  const tailnet = tailscaleState();
  const tunnel = tunnelState();
  return {
    tailscale: { installed: tailnet.installed, running: tailnet.running, address: tailnet.address },
    relay: { installed: tunnel.installed, running: tunnel.running, origin: tunnel.origin },
  };
}

/**
 * Keep the address list honest while the phone-facing listener is up.
 *
 * Both readings go stale on their own schedule and neither announces it: the
 * tailnet address appears when Tailscale connects, and the tunnel hostname
 * changes when cloudflared reconnects. Polled here so that whatever the phone is
 * handed was true within the last half minute, rather than at the moment sharing
 * was switched on.
 */
const REACH_POLL_MS = 30_000;

function pollReach() {
  void refreshTailscale();
  void refreshTunnel();
}

async function handleSnapshot(url, res) {
  const range = url.searchParams.get('range') ?? '7d';
  const weeksRaw = Number.parseInt(url.searchParams.get('weeks') ?? '26', 10);
  const weeks = Number.isFinite(weeksRaw) ? Math.min(52, Math.max(8, weeksRaw)) : 26;

  // Local transcripts and the account API are independent: if the network is
  // down, every locally-sourced panel still renders.
  const [events, account] = await Promise.all([
    loadEvents(),
    fetchAccount().catch((e) => ({ status: 'error', error: e.message })),
  ]);

  sendJSON(res, 200, {
    snapshot: buildSnapshot(events, { range, weeks }),
    account,
    app: { version: APP_VERSION },
    origins: reachableOrigins(lanPort),
    reach: reachState(),
  });
}

/**
 * Read a JSON request body, with a hard cap.
 *
 * Only pairing posts a body, and a pairing body is under 100 bytes. Anything
 * larger is either a bug or someone poking at the listener.
 */
function readJSONBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Routes a phone may call before it holds a token. Everything else needs one. */
const PUBLIC_LAN_ROUTES = new Set(['/api/ping', '/api/pair']);

/**
 * @param {{ mode?: 'local' | 'lan' }} options
 *   `local` — loopback listener for the desktop window. No auth: nothing off this
 *   machine can reach it, and the desktop UI predates pairing.
 *   `lan`  — listener bound to every interface for phones. Bearer token required,
 *   and the only UI it serves is the phone one.
 */
export function createApp({ mode = 'local' } = {}) {
  const isLan = mode === 'lan';

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // The iOS app runs at capacitor://localhost, so every API call it makes is
    // cross-origin. No cookies or credentials are involved — the bearer token is
    // the only thing that grants access — so a wildcard origin adds no exposure.
    if (isLan) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }

    let device = null;
    if (isLan && url.pathname.startsWith('/api/') && !PUBLIC_LAN_ROUTES.has(url.pathname)) {
      const header = req.headers.authorization ?? '';
      device = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
      if (!device) {
        sendJSON(res, 401, { error: 'This device is not paired.', code: 'unpaired' });
        return;
      }
    }

    try {
      // -------------------------------------------------------------- pairing
      if (url.pathname === '/api/ping') {
        // Deliberately says nothing about the account — it answers "is a Claude
        // Ledger here?" for a phone that has just been handed an address.
        sendJSON(res, 200, {
          app: 'claude-ledger',
          version: APP_VERSION,
          pairing: pairingState().active,
          origins: reachableOrigins(lanPort),
          reach: reachState(),
        });
        return;
      }
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        if (!isLan) {
          sendJSON(res, 400, { error: 'Pairing is only available on the shared listener.' });
          return;
        }
        const body = await readJSONBody(req);
        if (!body) {
          sendJSON(res, 400, { error: 'Malformed request.' });
          return;
        }
        const result = redeemPairCode(body.code, body.name);
        if (result.error) {
          sendJSON(res, 403, { error: result.error });
          return;
        }
        sendJSON(res, 200, {
          ...result,
          host: req.headers.host ?? null,
          origins: reachableOrigins(lanPort),
        });
        return;
      }
      if (url.pathname === '/api/devices') {
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          sendJSON(res, 200, { removed: id ? revokeDevice(id) : false, devices: listDevices() });
          return;
        }
        sendJSON(res, 200, { devices: listDevices(), addresses: lanAddresses() });
        return;
      }

      // ----------------------------------------------------------------- data
      if (url.pathname === '/api/snapshot') {
        await handleSnapshot(url, res);
        return;
      }
      if (url.pathname === '/api/account') {
        sendJSON(res, 200, await fetchAccount());
        return;
      }
      if (url.pathname === '/api/connection') {
        sendJSON(res, 200, await readConnection());
        return;
      }
      if (url.pathname === '/api/history') {
        const since = Number.parseFloat(url.searchParams.get('since') ?? '0');
        sendJSON(res, 200, {
          span: historySpan(),
          readings: queryHistory(Number.isFinite(since) ? since : 0),
        });
        return;
      }
      if (url.pathname === '/api/metric-series') {
        const metric = url.searchParams.get('metric') ?? '';
        if (!METRIC_IDS.includes(metric)) {
          sendJSON(res, 400, { error: `metric must be one of ${METRIC_IDS.join(', ')}` });
          return;
        }
        const events = await loadEvents();
        sendJSON(res, 200, metricSeries(events, { metric, range: url.searchParams.get('range') ?? '7d' }));
        return;
      }
      if (url.pathname === '/api/usage-curve') {
        const from = Number.parseFloat(url.searchParams.get('from') ?? '');
        const to = Number.parseFloat(url.searchParams.get('to') ?? '');
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          sendJSON(res, 400, { error: 'from and to (epoch ms) are required' });
          return;
        }
        const points = Math.min(400, Math.max(10, Number.parseInt(url.searchParams.get('points') ?? '120', 10)));
        const model = url.searchParams.get('model') || null;
        const { assistant } = await loadEvents();
        sendJSON(res, 200, usageCurve(assistant, { from, to, points, model }));
        return;
      }
      if (url.pathname === '/api/pulse') {
        // Polled frequently by the dashboard; must stay cheap (stat only).
        sendJSON(res, 200, await fingerprint());
        return;
      }
      if (url.pathname === '/api/reconnect' && req.method === 'POST') {
        // Re-read the credential from scratch: this is what the "Connect" and
        // "Reconnect" buttons call after the user has run `claude` to log in.
        invalidateAccountCache();
        sendJSON(res, 200, await fetchAccount());
        return;
      }

      // --------------------------------------------------------------- static
      /*
       * Where the pairing QR points. It carries an http address rather than the
       * `claudeledger://` link itself because the iOS Camera app reliably offers
       * to open http and is unreliable about custom schemes; this page is what
       * hands the phone over to the app.
       */
      if (url.pathname === '/pair' || url.pathname === '/pair/') {
        await serveStatic(res, '/pair.html', MOBILE_DIR);
        return;
      }
      if (isLan) {
        // A phone gets the phone UI at the root. The desktop dashboard is never
        // served over the network: it assumes an unauthenticated API and a
        // 1320px window, and neither holds here.
        await serveStatic(res, url.pathname, MOBILE_DIR);
        return;
      }
      if (url.pathname === '/m/pair' || url.pathname === '/m/pair/') {
        await serveStatic(res, '/pair.html', MOBILE_DIR);
        return;
      }
      if (url.pathname === '/m' || url.pathname === '/m/') {
        await serveStatic(res, '/', MOBILE_DIR);
        return;
      }
      if (url.pathname.startsWith('/m/')) {
        // Lets the phone UI be developed in a desktop browser against the same
        // loopback server the app uses.
        await serveStatic(res, url.pathname.slice(2), MOBILE_DIR);
        return;
      }
      await serveStatic(res, url.pathname, PUBLIC_DIR);
    } catch (err) {
      sendJSON(res, 500, { error: err?.message ?? 'Internal error' });
    }
  });
}

/**
 * Bind to 127.0.0.1 only — this dashboard reads local credentials and must
 * never be reachable from the network. Port 0 asks the OS for a free port,
 * which is what the Electron shell uses.
 */
export function startServer({ port = Number(process.env.PORT ?? 4317), host = '127.0.0.1' } = {}) {
  const server = createApp({ mode: 'local' });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, host });
    });
  });
}

/**
 * Start the phone-facing listener. Opt-in, and the caller is expected to stop it
 * again — nothing here starts on its own.
 *
 * The port is fixed rather than OS-assigned on purpose: the address gets typed
 * into a phone by hand, and "192.168.1.42:4317" every time beats a number that
 * changes on each launch.
 */
export function startLanServer({ port = Number(process.env.LEDGER_LAN_PORT ?? 4317) } = {}) {
  const server = createApp({ mode: 'lan' });
  const flush = setInterval(() => persistLastSeen(), 60_000);
  flush.unref?.();
  const reach = setInterval(pollReach, REACH_POLL_MS);
  reach.unref?.();

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearInterval(flush);
      clearInterval(reach);
      reject(err);
    });
    server.listen(port, '0.0.0.0', () => {
      const addr = server.address();
      lanPort = typeof addr === 'object' && addr ? addr.port : port;
      // The first phone to ask may ask a second later, and an unasked tailnet
      // address is an address the phone is not told about.
      pollReach();
      resolve({
        server,
        port: lanPort,
        addresses: lanAddresses(),
        stop: () =>
          new Promise((done) => {
            clearInterval(flush);
            clearInterval(reach);
            lanPort = null;
            persistLastSeen();
            server.close(() => done());
            // close() waits for keep-alive sockets, and the phone holds one open
            // between polls. Without this the toggle appeared to hang.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const { port, host } = await startServer();
  console.log(`Claude Ledger running at http://${host}:${port}`);
  console.log(`Phone UI (dev preview)   http://${host}:${port}/m/`);
}
