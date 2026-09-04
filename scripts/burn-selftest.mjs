/*
 * Projection maths, against readings the test writes itself.
 *
 * The interesting cases are the ones real usage produces rarely and at the worst
 * moment: a window that has just reset, a flat hour, one reading. Every one of
 * them has to come back null rather than a plausible-looking number, because a
 * duration that is sometimes invented is a duration nobody can act on.
 */
import { projectWindow, shortDuration } from '../src/burn.js';

const MIN = 60_000;
const now = Date.now();
/** Readings at fixed minutes back, in the shape history.js stores. */
const at = (pairs) => pairs.map(([minsAgo, percent]) => ({ t: now - minsAgo * MIN, v: { session: percent } }));

let pass = true;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  pass &&= ok;
};

const window = (utilization, resetsInMinutes) => ({
  key: 'session',
  utilization,
  resetsAt: new Date(now + resetsInMinutes * MIN).toISOString(),
});

// 10% an hour, 60% used, five hours before the window resets: it runs out first.
let p = projectWindow(window(60, 300), at([[60, 50], [30, 55], [0, 60]]));
check('rate is per hour', Math.round(p.ratePerHour), 10);
check('runs out in four hours', shortDuration(p.minutesToExhaust), '4h');
check('and that is before the reset', p.willExhaustBeforeReset, true);

// Same rate, but the window resets in one hour: the reset wins.
p = projectWindow(window(60, 60), at([[60, 50], [30, 55], [0, 60]]));
check('a reset before exhaustion is not a warning', p.willExhaustBeforeReset, false);
check('and headroom stops at the reset', shortDuration(p.minutesLeft), '1h');

// A window that just rolled over: the drop is the boundary, and what is left is
// one reading.
check('a reset drops the readings before it', projectWindow(window(3, 300), at([[90, 80], [60, 95], [10, 3]])), null);

check('flat is not a rate', projectWindow(window(40, 120), at([[60, 40], [0, 40]])), null);
check('falling is not a rate', projectWindow(window(30, 120), at([[60, 40], [0, 30]])), null);
check('one reading says nothing', projectWindow(window(40, 120), at([[0, 40]])), null);
check('two readings a minute apart say nothing', projectWindow(window(40, 120), at([[1, 39], [0, 40]])), null);
check('no readings at all', projectWindow(window(40, 120), []), null);
check('a window with no level', projectWindow({ key: 'session', utilization: null }, at([[60, 10], [0, 20]])), null);

check('durations round, never decimal', [shortDuration(45), shortDuration(90), shortDuration(120), shortDuration(3000)],
  ['45m', '1h 30m', '2h', '2d 2h']);

process.exit(pass ? 0 : 1);
