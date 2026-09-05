/*
 * The address that does not change.
 *
 * Every other way back to this Mac expires. A LAN address is nothing once the
 * phone leaves the house. A Cloudflare quick tunnel takes a new random hostname
 * every time it starts, and the phone can only learn the new one by reaching
 * this Mac — which, from cellular, is the very thing it needs the hostname for.
 * So one restart while you are out and the phone has nothing but its cache, with
 * no way to recover until it comes home.
 *
 * A tailnet address has neither problem. `100.x.y.z` is assigned to this machine
 * and stays assigned across reboots, network changes and tunnel restarts, and it
 * answers from cellular the same as it answers from the sofa — direct where a
 * direct route exists, over a DERP relay where it does not. It is the primary
 * path for that reason, and the tunnel stays on as the fallback for a phone with
 * no Tailscale on it.
 *
 * Nothing here starts or configures Tailscale. It reads what is already running
 * and reports it, including "installed but switched off", because that is a
 * thing the pairing window should be able to say out loud rather than leaving as
 * an unexplained absence.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

/** The GUI app bundle, the Homebrew CLI, and the standalone installer. */
const BINARIES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
];

/**
 * 100.64.0.0/10 — the carrier-grade NAT block Tailscale hands out.
 *
 * Worth recognising by shape as well as by asking the CLI: the address turns up
 * in the interface list too, and there it has to be told apart from an ordinary
 * private address that only answers on this Wi-Fi.
 */
export function isTailnetAddress(address) {
  const parts = String(address ?? '').split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((n) => Number.parseInt(n, 10));
  return a === 100 && b >= 64 && b <= 127;
}

/** How long a status reading is treated as current. */
const TTL_MS = 30_000;

/** `tailscale status --json` forks a process; it is not for a hot path. */
let cached = { installed: false, running: false, address: null, dnsName: null, error: null };
let checkedAt = 0;
/** @type {Promise<typeof cached>|null} */
let inFlight = null;

export function tailscaleBinary() {
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

/** The last reading, without waiting. Callers on a request path want this one. */
export function tailscaleState() {
  return { ...cached, checkedAt: checkedAt || null };
}

/** Re-read unless the last reading is still inside its TTL. */
export function refreshIfStale({ ttl = TTL_MS } = {}) {
  if (Date.now() - checkedAt < ttl) return Promise.resolve(tailscaleState());
  return refreshTailscale();
}

/**
 * Ask Tailscale where this Mac is, and remember the answer.
 *
 * Never rejects: an absent binary, a hung daemon and unparseable output are all
 * the same answer to the only question being asked, which is whether there is a
 * tailnet address to hand the phone right now.
 */
export function refreshTailscale({ timeout = 4000 } = {}) {
  if (inFlight) return inFlight;

  const binary = tailscaleBinary();
  if (!binary) {
    cached = { installed: false, running: false, address: null, dnsName: null, error: null };
    checkedAt = Date.now();
    return Promise.resolve(tailscaleState());
  }

  inFlight = new Promise((resolve) => {
    execFile(binary, ['status', '--json'], { timeout, maxBuffer: 8 << 20 }, (err, stdout) => {
      cached = { ...parseStatus(stdout), installed: true };
      // A non-zero exit is normal when the daemon is stopped or logged out, and
      // it still prints a usable BackendState — so the output is parsed first
      // and the error only fills in when there was nothing to parse.
      if (err && !cached.running && !cached.address) {
        cached.error = err.killed ? 'Tailscale did not answer in time.' : null;
      }
      checkedAt = Date.now();
      inFlight = null;
      resolve(tailscaleState());
    });
  });

  return inFlight;
}

function parseStatus(stdout) {
  const blank = { installed: true, running: false, address: null, dnsName: null, error: null };
  let root;
  try {
    root = JSON.parse(String(stdout ?? ''));
  } catch {
    return blank;
  }
  if (!root || typeof root !== 'object') return blank;

  const running = root.BackendState === 'Running';
  const self = root.Self ?? {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  // IPv4 only. The phone builds `http://<address>:<port>` out of this, and the
  // v6 form would need brackets it does not add — a v4 address is always issued
  // alongside, so there is nothing to gain by handling both.
  const address = running ? (ips.find((ip) => isTailnetAddress(ip)) ?? null) : null;
  // MagicDNS names arrive fully qualified with a trailing dot.
  const dnsName = running ? (String(self.DNSName ?? '').replace(/\.$/, '') || null) : null;

  return { installed: true, running, address, dnsName, error: null };
}
