/*
 * The running-total mode on the phone's metric chart.
 *
 * `mobile/app.js` is a browser module with no build step and no exports, so the
 * functions under test are read out of the source and evaluated, the same trick
 * `failover-selftest.mjs` uses.
 *
 * The timezone is pinned before anything reads a clock. The whole question this
 * mode has to get right is where a day ends, and "a day" is a local calendar
 * thing — 23 hours long twice a year. A test that ran in UTC would pass while
 * the feature was wrong for everyone who is not in it.
 */
process.env.TZ = 'America/New_York';

import { readFileSync } from 'node:fs';

const src = readFileSync('mobile/app.js', 'utf8');
const body = src.slice(
  src.indexOf('const RESET_DAILY_MAX_BUCKET_MS'),
  src.indexOf('/**\n * The data the chart should draw'),
);
const { runningSeries, dayKey, bucketLabel } = new Function(
  `${body}\n return { runningSeries, dayKey, bucketLabel };`,
)();

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  return ok;
};

let pass = true;

const HOUR = 3_600_000;

/** Hourly buckets starting at local midnight on the given date. */
function hourly(startISO, values) {
  const from = new Date(startISO).getTime();
  return {
    values,
    stamps: values.map((_, i) => from + i * HOUR),
    bucketMs: HOUR,
  };
}

// ------------------------------------------------------------------ the shape

// The example this was built for: $0 at midnight, climbing all day.
const oneDay = hourly('2026-06-01T00:00:00-04:00', [1, 0, 2, 0, 0, 3]);
const run = runningSeries(oneDay);
pass &= check('adds up through the day', run.values, [1, 1, 3, 3, 3, 6]);
pass &= check('never falls inside a day', run.values.every((v, i, a) => i === 0 || v >= a[i - 1]), true);
pass &= check('one day has nothing to reset', run.resets, []);
pass &= check('and it is a daily-reset series', run.daily, true);

// Two days: the second starts from zero again, not from the first day's total.
const twoDays = hourly(
  '2026-06-01T00:00:00-04:00',
  [...Array(24).fill(1), ...Array(24).fill(2)],
);
const across = runningSeries(twoDays);
pass &= check('first day ends at its own total', across.values[23], 24);
pass &= check('second day starts again at zero', across.values[24], 2);
pass &= check('second day ends at its own total', across.values[47], 48);
pass &= check('the reset is marked at midnight', across.resets, [24]);

// ------------------------------------------------------------ daylight saving

/*
 * 8 March 2026, US spring forward: local midnight to local midnight is 23 hours.
 * Subtracting a fixed 24 hours to find the boundary would put the reset an hour
 * late and hand the 8th's first hour to the 7th.
 */
const dst = hourly('2026-03-07T00:00:00-05:00', Array(72).fill(1));
const dstRun = runningSeries(dst);
// 24 buckets for the 7th, then only 23 for the 8th — which pulls a fourth
// boundary into the same 72 hours. A fixed 24-hour rule gives [24, 48, 72].
pass &= check('the short day is 23 buckets long', dstRun.resets, [24, 47, 71]);
pass &= check('the 8th ends at 23, not 24', dstRun.values[46], 23);
pass &= check('and the day after it starts again', dstRun.values[47], 1);
pass &= check(
  'midnight either side of the change is a new day',
  dayKey(dst.stamps[23]) !== dayKey(dst.stamps[24]),
  true,
);

// ------------------------------------------------------------- wide buckets

/*
 * ALL over a long history buckets in multi-day steps. A daily reset there would
 * put one point in each tooth and draw nothing, so the running total runs from
 * the first day recorded instead.
 */
const wide = {
  values: [5, 5, 5, 5],
  stamps: [0, 1, 2, 3].map((i) => new Date('2026-06-01T00:00:00-04:00').getTime() + i * 36 * HOUR),
  bucketMs: 36 * HOUR,
};
const wideRun = runningSeries(wide);
pass &= check('wide buckets do not reset', wideRun.resets, []);
pass &= check('and the total keeps climbing', wideRun.values, [5, 10, 15, 20]);
pass &= check('which the caller can tell apart', wideRun.daily, false);

// 6h is the last width that still draws four points a day.
pass &= check(
  '6h buckets still reset daily',
  runningSeries({ ...hourly('2026-06-01T00:00:00-04:00', Array(8).fill(1)), bucketMs: 6 * HOUR })
    .daily,
  true,
);

// -------------------------------------------------------------------- labels

pass &= check('label: minutes', bucketLabel(10 * 60_000), '10 min');
pass &= check('label: hours', bucketLabel(HOUR), '1h');
pass &= check('label: days', bucketLabel(48 * HOUR), '2d');

// ------------------------------------------------------- never resetting

/*
 * The odometer mode. `daily: false` regardless of bucket width, and seeded with
 * everything counted before the window opened.
 */
const odo = runningSeries(twoDays, { daily: false, from: 1000 });
pass &= check('carries in what came before', odo.values[0], 1001);
pass &= check('never resets at midnight', odo.resets, []);
pass &= check('and keeps climbing across the boundary', odo.values[24] > odo.values[23], true);
pass &= check(
  'ends at the prior total plus the range total',
  odo.values.at(-1),
  1000 + twoDays.values.reduce((a, b) => a + b, 0),
);
pass &= check('rises or holds, never falls', odo.values.every((v, i, a) => i === 0 || v >= a[i - 1]), true);

// A quiet window is a flat run at a large number, not a run of zeroes.
const quiet = runningSeries(hourly('2026-06-01T00:00:00-04:00', [0, 0, 0, 0]), {
  daily: false,
  from: 4200,
});
pass &= check('quiet time holds its value', quiet.values, [4200, 4200, 4200, 4200]);

// Wide buckets are a reason to skip the daily reset, never a reason to apply
// one — the caller asking for no resets must win either way.
pass &= check('wide buckets still never reset', runningSeries(wide, { daily: false, from: 7 }).resets, []);

// No seed is the same series the window would draw on its own.
pass &= check(
  'without a prior total it starts from the window',
  runningSeries(twoDays, { daily: false }).values[0],
  twoDays.values[0],
);

// -------------------------------------------------------------------- totals

/*
 * The headline keeps showing the range total in both modes, so the two must
 * agree: the last value of a daily-reset series is only the last day's total,
 * and the sum of the days is the whole range.
 */
const dayTotals = [24, 48];
pass &= check(
  'the days add back up to the range total',
  across.values[23] + across.values[47],
  dayTotals[0] + dayTotals[1],
);
pass &= check(
  'a run with no resets ends at the range total',
  wideRun.values.at(-1),
  wide.values.reduce((a, b) => a + b, 0),
);

process.exit(pass ? 0 : 1);
