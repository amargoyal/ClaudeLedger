/*
 * The path that answers when the phone is not on this Wi-Fi.
 *
 * A LAN address is only an address at home: the same phone on cellular gets a
 * page that never loads, which is indistinguishable from the Mac being off. A
 * Cloudflare quick tunnel gives this Mac one `https://…trycloudflare.com` origin
 * that answers from anywhere, with no account and no DNS to set up.
 *
 * It is opt-in, and the reason is plain: it publishes the listener to the
 * internet. What defends it is the same thing that defends the LAN listener —
 * every `/api/` route but ping and pair needs a device token, and pairing needs a
 * six-digit code that expires in five minutes and burns after five wrong tries.
 *
 * The tunnel points at the loopback side of the phone-facing listener, so it
 * inherits that listener's authentication rather than the desktop one's absence
 * of it.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

/** Where Homebrew and the official installer put it. */
const BINARIES = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];

/** cloudflared announces the hostname in a banner line and nowhere else useful. */
const HOSTNAME_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let child = null;
let origin = null;
let error = null;
let startedAt = null;

export function cloudflaredBinary() {
  for (const path of BINARIES) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

export function tunnelState() {
  return {
    installed: Boolean(cloudflaredBinary()),
    running: Boolean(child),
    origin,
    error,
    startedAt,
  };
}

/**
 * Start a quick tunnel in front of `port` and resolve once it has a hostname.
 *
 * Resolving on the hostname rather than on spawn is what lets the pairing window
 * put a working URL in the QR the moment the switch reports on. cloudflared
 * takes a second or two to register the tunnel; a QR built before that would
 * encode `null`.
 */
export function startTunnel({ port, timeout = 60_000 } = {}) {
  if (child) return Promise.resolve(tunnelState());

  const binary = cloudflaredBinary();
  if (!binary) {
    error = 'cloudflared is not installed. Run `brew install cloudflared` and try again.';
    return Promise.resolve(tunnelState());
  }

  error = null;
  origin = null;

  return new Promise((resolve) => {
    const proc = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    startedAt = Date.now();

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tunnelState());
    };

    const timer = setTimeout(() => {
      if (origin) return settle();
      error = 'Cloudflare did not hand out an address in time. Try again.';
      settle();
    }, timeout);

    const read = (chunk) => {
      const found = String(chunk).match(HOSTNAME_RE);
      if (!found || origin) return;
      origin = found[0];
      // The banner is printed before Cloudflare's edge will route to it — for
      // ten to twenty seconds the hostname resolves and then refuses. A QR built
      // in that window sends the phone to a page that never loads, which is the
      // exact failure this path exists to end, so the address is not reported
      // until it answers.
      void waitUntilAnswering(origin, timer, settle);
    };
    proc.stdout.on('data', read);
    proc.stderr.on('data', read);

    proc.on('error', (err) => {
      error = err?.message ?? 'Could not start cloudflared.';
      child = null;
      origin = null;
      settle();
    });

    proc.on('exit', (code, signal) => {
      // Only a surprise exit is a failure worth reporting: `stopTunnel` clears
      // `child` before it kills, so a deliberate stop lands here with nothing
      // left to say.
      if (child !== proc) return;
      child = null;
      origin = null;
      startedAt = null;
      if (!settled) {
        error = `cloudflared exited (${signal ?? code}) before it published an address.`;
      }
      settle();
    });
  });
}

/**
 * Poll the tunnel's own `/api/ping` until Cloudflare routes to it.
 *
 * The first probe waits, deliberately. Asking the instant the banner prints
 * gets NXDOMAIN — the record is seconds behind — and the resolver caches that
 * answer for longer than the tunnel takes to come up, so an eager probe is what
 * makes a working tunnel look dead. Left alone for a few seconds it answers on
 * the first try.
 */
async function waitUntilAnswering(url, timer, settle) {
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, 4000));
  while (Date.now() < deadline) {
    if (origin !== url) return; // stopped, or replaced by a restart
    try {
      const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        clearTimeout(timer);
        settle();
        return;
      }
    } catch {
      /* not routable yet */
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  // The address is kept: an unproven tunnel is still far more likely to work
  // than no tunnel, and the phone will say so plainly if it does not.
  error = 'Cloudflare has not answered on that address yet. Give it a moment.';
  clearTimeout(timer);
  settle();
}

export function stopTunnel() {
  const proc = child;
  child = null;
  origin = null;
  startedAt = null;
  if (proc) proc.kill('SIGTERM');
}
