/*
 * How long a limit window has left at the rate it is being spent.
 *
 * A percentage on its own does not answer the question anyone actually has,
 * which is whether to start the long thing now. 62% is comfortable four hours
 * into a window and alarming twenty minutes in, and the difference is the slope.
 *
 * Rates come from the readings on disk rather than from the samples the account
 * module keeps in memory. Two reasons: those live only as long as the process,
 * so quitting the app once resets every rate to "not enough history"; and they
 * only cover the session window, while the weekly one is the limit that ruins a
 * week rather than an afternoon.
 */

import { query as queryHistory } from './history.js';

/** Two readings at least this far apart, or the slope is noise. */
const MIN_SPAN_MS = 3 * 60_000;
/** How far back to look. Longer than any window, short enough to stay cheap. */
const LOOKBACK_MS = 8 * 86_400_000;

/**
 * The readings belonging to the window that is open now.
 *
 * A reading records levels, not which window they belonged to, so the boundary
 * has to be recovered: utilization only ever climbs inside a window, and the
 * only thing that lowers it is a reset. Walking back from the newest reading and
 * stopping at the first drop is what separates this window from the last one.
 */
function currentWindowReadings(readings, key) {
  const series = readings
    .filter((r) => typeof r.v?.[key] === 'number')
    .map((r) => ({ t: r.t, percent: r.v[key] }));
  if (series.length < 2) return series;

  let start = series.length - 1;
  while (start > 0 && series[start - 1].percent <= series[start].percent) start -= 1;
  return series.slice(start);
}

/**
 * What this window is doing, or null when the readings cannot say.
 *
 * Null rather than a guess: a made-up rate on a fresh install would put "2h
 * left" in the menu bar on no evidence at all, and a number that is sometimes
 * invented is a number nobody can act on.
 */
export function projectWindow(window, readings) {
  if (!window || window.utilization == null) return null;

  const series = currentWindowReadings(readings, window.key);
  if (series.length < 2) return null;

  const first = series[0];
  const last = series[series.length - 1];
  const spanMs = last.t - first.t;
  if (spanMs < MIN_SPAN_MS) return null;

  const ratePerHour = ((last.percent - first.percent) / spanMs) * 3_600_000;
  if (!(ratePerHour > 0)) return null;

  const remaining = Math.max(0, 100 - window.utilization);
  const msToExhaust = (remaining / ratePerHour) * 3_600_000;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null;
  const now = Date.now();
  const exhaustsAt = now + msToExhaust;

  return {
    key: window.key,
    ratePerHour,
    minutesToExhaust: msToExhaust / 60_000,
    exhaustsAt,
    resetsAt,
    // The only case worth interrupting anyone over: the window runs out before
    // it refills.
    willExhaustBeforeReset: resetsAt != null && exhaustsAt < resetsAt,
    // Minutes of headroom, capped at the reset — past that the answer is "the
    // window resets first", not a bigger number.
    minutesLeft: Math.max(
      0,
      (Math.min(exhaustsAt, resetsAt ?? exhaustsAt) - now) / 60_000,
    ),
    samples: series.length,
    spanMinutes: spanMs / 60_000,
  };
}

/** Every window that has enough history to say something, keyed by window key. */
export function projectLimits(limits, { readings } = {}) {
  const windows = limits?.windows ?? [];
  if (!windows.length) return {};

  const rows = readings ?? queryHistory(Date.now() - LOOKBACK_MS);
  const out = {};
  for (const window of windows) {
    const projection = projectWindow(window, rows);
    if (projection) out[window.key] = projection;
  }
  return out;
}

/** "4h 20m", "35m" — menu-bar short, and never a decimal. */
export function shortDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
