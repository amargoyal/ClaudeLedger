/**
 * Append-only record of limit utilization over time.
 *
 * The usage endpoint reports a *level*, never a series, so plotting the 5-hour /
 * weekly / Fable limits against time is only possible from readings this app
 * stored itself. One consequence is unavoidable and must not be hidden in the UI:
 * history begins the first time the app runs and cannot be backfilled, so those
 * lines start sparse and fill in.
 *
 * Storage is JSONL, one reading per line, pruned to RETENTION_DAYS.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HISTORY_FILE =
  process.env.CLAUDE_LEDGER_HISTORY_FILE ?? join(homedir(), '.claude-ledger', 'usage-history.jsonl');
const RETENTION_MS = 90 * 86_400_000;
/** Skip a reading that adds nothing: identical values, less than this apart. */
const MIN_GAP_MS = 60_000;

let series = null;

function load() {
  if (series) return series;
  series = [];
  try {
    const cutoff = Date.now() - RETENTION_MS;
    for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.t === 'number' && row.t >= cutoff) series.push(row);
      } catch {
        // Skip a torn line rather than losing the file.
      }
    }
  } catch {
    // No history yet.
  }
  series.sort((a, b) => a.t - b.t);
  return series;
}

function sameValues(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** Record one reading. `limits` is the shaped object from anthropic.js. */
export function record(limits) {
  if (!limits?.windows?.length) return false;
  load();

  const values = {};
  for (const w of limits.windows) {
    if (w.utilization != null) values[w.key] = w.utilization;
  }
  if (!Object.keys(values).length) return false;

  const now = Date.now();
  const last = series[series.length - 1];
  if (last && now - last.t < MIN_GAP_MS && sameValues(last.v, values)) return false;

  const row = { t: now, v: values };
  series.push(row);
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    appendFileSync(HISTORY_FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    /* non-fatal */
  }

  const cutoff = now - RETENTION_MS;
  if (series.length && series[0].t < cutoff) {
    series = series.filter((r) => r.t >= cutoff);
    try {
      writeFileSync(HISTORY_FILE, `${series.map((r) => JSON.stringify(r)).join('\n')}\n`, {
        mode: 0o600,
      });
    } catch {
      /* non-fatal */
    }
  }
  return true;
}

/** Readings from `since` (epoch ms) onward, oldest first. */
export function query(since = 0) {
  load();
  return series.filter((r) => r.t >= since);
}

export function span() {
  load();
  if (!series.length) return null;
  return { from: series[0].t, to: series[series.length - 1].t, count: series.length };
}
