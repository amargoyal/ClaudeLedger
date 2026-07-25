import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAccount, invalidateAccountCache } from './src/anthropic.js';
import { readConnection } from './src/credentials.js';
import { buildSnapshot, usageCurve } from './src/aggregate.js';
import { query as queryHistory, span as historySpan } from './src/history.js';
import { fingerprint, loadEvents } from './src/transcripts.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

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

async function serveStatic(res, pathname) {
  // normalize() collapses ".." before we join, so a crafted path can't escape
  // PUBLIC_DIR.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
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
  });
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
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
      await serveStatic(res, url.pathname);
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
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, host });
    });
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const { port, host } = await startServer();
  console.log(`Claude Ledger running at http://${host}:${port}`);
}
