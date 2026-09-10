import { watch } from 'node:fs';

import { PROJECTS_DIR, fingerprint } from './transcripts.js';

/*
 * Notice transcript changes as they happen, instead of asking every few seconds.
 *
 * Every client used to discover new messages the same way: call `/api/pulse` on a
 * timer and compare the answer to the last one. That put a floor under how fresh
 * anything could be — five seconds in the desktop window, sixty on the phone —
 * and the floor was visible. Claude Code writes a line to a transcript the moment
 * a message completes; the numbers on screen have that line in hand within a
 * frame or two of it landing, so a poll interval is pure added latency.
 *
 * So the directory is watched instead, and the watch is what everything else
 * hangs off: the event stream that pushes to the window and the phone, and the
 * menu bar item's account refresh. One watch, one fingerprint, many listeners.
 */

/**
 * How long to wait for the writes to stop before reporting.
 *
 * One assistant message is one appended line, but the OS reports the write, the
 * metadata update and (on macOS) a coalesced directory event separately, and a
 * resumed session copies a whole transcript in many chunks. Fingerprinting each
 * of those would stat the entire tree several times for one logical change.
 * 120ms is long enough to collapse a burst and short enough to stay invisible.
 */
const SETTLE_MS = 120;

/**
 * How often to fingerprint when there is no usable watch.
 *
 * `fs.watch` needs the directory to exist and needs recursive support from the
 * platform. Neither is guaranteed — `~/.claude/projects` does not exist until
 * Claude Code has been run once — so this module degrades to what the clients
 * used to do rather than going silent. Two seconds is still better than the five
 * the dashboard polled at, and costs nothing off this machine.
 */
const FALLBACK_POLL_MS = 2_000;

/** @typedef {{ files: number, bytes: number, newest: number }} Fingerprint */

/** @type {Set<(fp: Fingerprint) => void>} */
const listeners = new Set();

let watcher = null;
let fallbackTimer = null;
let settleTimer = null;
/** Last fingerprint reported to listeners, and the key it compared as. */
let latest = null;
let latestKey = null;
/** Guards against overlapping scans, and remembers that another one is owed. */
let scanning = false;
let scanQueued = false;

/** Compare fingerprints as one value; a change in any part is a change. */
export function fingerprintKey(fp) {
  return fp ? `${fp.files}:${fp.bytes}:${fp.newest}` : '';
}

/** The most recent fingerprint, or null if nothing has been read yet. */
export function current() {
  return latest;
}

async function scan() {
  if (scanning) {
    scanQueued = true;
    return;
  }
  scanning = true;
  try {
    const fp = await fingerprint();
    const key = fingerprintKey(fp);
    // Only a change is worth waking anyone for. A watch fires on reads of some
    // filesystems and the fallback fires on a timer, so most scans find nothing.
    if (key !== latestKey) {
      latest = fp;
      latestKey = key;
      for (const fn of listeners) {
        try {
          fn(fp);
        } catch {
          // One bad listener must not stop the others from being told.
        }
      }
    }
  } catch {
    // The directory can vanish mid-scan; the next event picks it back up.
  } finally {
    scanning = false;
    if (scanQueued) {
      scanQueued = false;
      void scan();
    }
  }
}

function nudge() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => void scan(), SETTLE_MS);
  settleTimer.unref?.();
}

function startFallback() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => void scan(), FALLBACK_POLL_MS);
  fallbackTimer.unref?.();
}

function start() {
  try {
    watcher = watch(PROJECTS_DIR, { recursive: true, persistent: false }, nudge);
    // A watch can die after it starts — the directory is renamed, or the OS runs
    // out of handles. Polling from then on beats reporting nothing ever again.
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
      startFallback();
    });
  } catch {
    startFallback();
  }
  // Read once so the first subscriber has a baseline to compare against, and so
  // `current()` answers before anything has changed.
  void scan();
}

function stop() {
  clearTimeout(settleTimer);
  settleTimer = null;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
  watcher?.close();
  watcher = null;
}

/**
 * Be told when the transcripts change. Returns the unsubscribe function.
 *
 * The watch starts with the first subscriber and stops with the last, so a build
 * that never opens a stream never holds a file handle.
 */
export function subscribe(fn) {
  listeners.add(fn);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}
