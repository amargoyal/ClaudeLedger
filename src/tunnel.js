/*
 * The path that answers when the phone has no Tailscale.
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
 *
 * Two things make it a fallback rather than the primary path, and both are about
 * the hostname being disposable. It is new on every start, so a phone that is
 * away from home when this Mac restarts cannot be told the new one. And it can
 * change again underneath a running tunnel when cloudflared reconnects. See
 * `src/tailscale.js` for the address that has neither property.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';

/** Where Homebrew and the official installer put it. */
const BINARIES = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];

/** cloudflared announces the hostname in a banner line and nowhere else useful. */
const HOSTNAME_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let child = null;
let origin = null;
let error = null;
let startedAt = null;
/**
 * Whether the switch is on, as opposed to whether a process happens to be alive.
 *
 * A tunnel that dies stays dead otherwise, and nothing says so: the switch still
 * reads on, and the only symptom is that the phone stops answering to anything
 * but the LAN. `refreshTunnel` uses this to tell "the user turned it off" apart
 * from "it fell over".
 */
let wanted = false;
let wantedPort = null;
/**
 * cloudflared's own metrics server, pinned rather than left to the random port
 * it picks otherwise. `/quicktunnel` on it reports the hostname the tunnel is
 * actually serving, which is the only authoritative answer — see
 * `liveHostname()`.
 */
let metricsPort = null;
/** Whether the cloudflared on `metricsPort` is the one this app started. */
let metricsOwned = false;

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
    wanted,
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
export async function startTunnel({ port, timeout = 60_000 } = {}) {
  wanted = true;
  wantedPort = port ?? wantedPort;
  if (child) return tunnelState();

  const binary = cloudflaredBinary();
  if (!binary) {
    error = 'cloudflared is not installed. Run `brew install cloudflared` and try again.';
    return tunnelState();
  }

  error = null;
  origin = null;

  // Whoever is already on that port is not ours, and the hostname it would
  // report is not ours either — most likely an orphaned cloudflared from an app
  // that was killed rather than quit. cloudflared is left to pick its own port
  // in that case and the banner is the only source, which is what this was
  // before: nothing is lost but the certainty.
  metricsPort = wantedPort + 2;
  metricsOwned = await portIsFree(metricsPort);
  // Awaiting let a second call in. The first one owns the process.
  if (child) return tunnelState();

  return new Promise((resolve) => {
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${wantedPort}`];
    if (metricsOwned) args.push('--metrics', `127.0.0.1:${metricsPort}`);

    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      // left to say. A surprise exit while the switch is still on is picked back
      // up by `refreshTunnel`, which is on a timer and so restarts at a sane
      // rate rather than spinning on a binary that cannot run.
      if (child !== proc) return;
      child = null;
      origin = null;
      startedAt = null;
      metricsOwned = false;
      if (wanted) {
        error = `cloudflared exited (${signal ?? code}). Retrying.`;
      } else if (!settled) {
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

/**
 * Keep the switch position and the world in agreement.
 *
 * Called on a slow timer while sharing is on. Two things it repairs, both of
 * which used to end with the phone being handed an address nothing answers on:
 *
 *   - a cloudflared that exited is started again, because the switch says the
 *     user still wants a tunnel;
 *   - the hostname is re-read from cloudflared rather than remembered from its
 *     banner. Scraping a log line once makes the whole path depend on that line
 *     arriving in one piece, and says nothing at all when the tunnel reconnects
 *     under a new name — after which this Mac advertises a dead address for the
 *     rest of its life while a perfectly good tunnel is up.
 */
export async function refreshTunnel() {
  if (!wanted) return tunnelState();
  if (!child) {
    if (wantedPort) void startTunnel({ port: wantedPort });
    return tunnelState();
  }
  const live = await liveHostname();
  if (live && live !== origin) {
    origin = live;
    error = null;
  }
  return tunnelState();
}

/**
 * The hostname cloudflared says it is serving, from its metrics server.
 *
 * Only asked when this app is the one that put a cloudflared on that port. A
 * tunnel outlives its owner when the app is killed rather than quit, and the
 * orphan keeps the metrics port — so asking without checking would read a
 * hostname belonging to a *different* tunnel, pointing at a process that may not
 * be serving any more, and hand it to the phone as this Mac's own.
 */
async function liveHostname() {
  if (!metricsOwned || !metricsPort) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const hostname = typeof body?.hostname === 'string' ? body.hostname.trim() : '';
    if (!hostname) return null;
    return hostname.includes('://') ? hostname.replace(/\/+$/, '') : `https://${hostname}`;
  } catch {
    return null;
  }
}

/**
 * True when nothing holds `port` on loopback right now.
 *
 * Answered by binding it, because that is the only answer that is not a guess.
 * The port is released immediately and handed to cloudflared, which is a race in
 * theory and has one contender in practice.
 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

export function stopTunnel() {
  const proc = child;
  wanted = false;
  child = null;
  origin = null;
  startedAt = null;
  metricsOwned = false;
  error = null;
  if (proc) proc.kill('SIGTERM');
}
