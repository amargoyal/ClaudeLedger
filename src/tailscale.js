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
 * Nothing here starts or configures Tailscale, and nothing here runs it either.
 * The obvious implementation — shell out to `tailscale status --json` — does not
 * work from inside a GUI app. On the App Store build both binaries in
 * `Tailscale.app/Contents/MacOS/` are front ends that hand the request to the
 * running GUI, and outside a terminal session that hand-off fails with
 *
 *     The Tailscale GUI failed to start: ... (Tailscale.CLIError error 3.)
 *
 * printed on *stdout*, with exit status 0. Nothing about that reads as an error
 * to a caller, so a working tailnet was reported as "installed but not
 * connected" — the app said Tailscale was off while Tailscale said it was on.
 *
 * So the address is read where it is already true: the interface list. If
 * `100.x.y.z` is bound to a `utun`, the tunnel is up, which is the only thing
 * being asked. No subprocess, no environment to get wrong, and no timeout.
 */

import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

/**
 * Where Tailscale installs. The GUI bundle is a directory, so this is presence
 * on disk rather than an executable check.
 */
const INSTALL_PATHS = [
  '/Applications/Tailscale.app',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
];

/**
 * 100.64.0.0/10 — the carrier-grade NAT block Tailscale hands out.
 *
 * This is the whole detector. An address in that range on a live interface is a
 * tailnet address; there is nothing else it could be on a machine that is not
 * itself a carrier.
 */
export function isTailnetAddress(address) {
  const parts = String(address ?? '').split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((n) => Number.parseInt(n, 10));
  return a === 100 && b >= 64 && b <= 127;
}

/** True when Tailscale is on this machine at all, connected or not. */
export function tailscaleInstalled() {
  return INSTALL_PATHS.some((path) => existsSync(path));
}

/**
 * This Mac's tailnet address, or the reason there isn't one.
 *
 * Cheap enough to call per request: one `getifaddrs`, no cache to go stale.
 * `installed` is what separates "turn Tailscale on" from "go install it", which
 * are different enough instructions to be worth telling apart.
 */
export function tailscaleState() {
  let address = null;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isTailnetAddress(a.address)) address ??= a.address;
    }
  }
  return { installed: address ? true : tailscaleInstalled(), running: Boolean(address), address };
}
