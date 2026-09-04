/*
 * What the phone would schedule, given what the Mac last projected.
 *
 * Same approach as the failover selftest and for the same reason: the functions
 * live in a browser module with no exports, and the failure they guard against
 * — a warning that fires at the wrong time, or one that never fires at all — is
 * only visible on a real phone hours later.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('mobile/app.js', 'utf8');
const body = src.slice(
  src.indexOf('const ALERT_THRESHOLD'),
  src.indexOf('/**\n * Rebuild the pending set'),
);

const store = { 'ledger.mobile.alerts': 'on' };
const localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
const KEY_ALERTS = 'ledger.mobile.alerts';

const { plannedAlerts } = new Function(
  'localStorage', 'KEY_ALERTS',
  `${body}\n return { plannedAlerts };`,
)(localStorage, KEY_ALERTS);

const now = Date.parse('2026-09-04T12:00:00Z');
const MIN = 60_000;
const account = (windows, projections) => ({ limits: { windows }, projections });

let pass = true;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  pass &&= ok;
};

// 50% used, 10%/hr, five hours before reset: 80% in three hours, empty in five.
let planned = plannedAlerts(
  account(
    [{ key: 'session', utilization: 50, resetsAt: new Date(now + 300 * MIN).toISOString() }],
    { session: { ratePerHour: 10, exhaustsAt: now + 300 * MIN, resetsAt: now + 330 * MIN, willExhaustBeforeReset: true } },
  ),
  now,
);
check('warns at the threshold and at empty', planned.length, 2);
check('threshold lands three hours out', Math.round((planned[1].at - now) / MIN), 180);
check('and names the window', planned[1].title, '80% of your session limit');
check('the empty one says so', planned[0].title, 'Your session limit is out');

// The same rate, but the window refills before it empties: nothing to warn about
// at the end, and the threshold warning has to fall inside the window too.
planned = plannedAlerts(
  account(
    [{ key: 'session', utilization: 50, resetsAt: new Date(now + 60 * MIN).toISOString() }],
    { session: { ratePerHour: 10, exhaustsAt: now + 300 * MIN, resetsAt: now + 60 * MIN, willExhaustBeforeReset: false } },
  ),
  now,
);
check('a window that resets first is not a warning', planned, []);

// Already past the threshold: the warning shot has been missed, the other stands.
planned = plannedAlerts(
  account(
    [{ key: 'weekly_all', utilization: 92, resetsAt: new Date(now + 600 * MIN).toISOString() }],
    { weekly_all: { ratePerHour: 5, exhaustsAt: now + 96 * MIN, resetsAt: now + 600 * MIN, willExhaustBeforeReset: true } },
  ),
  now,
);
check('past the threshold, only the empty warning', planned.map((a) => a.title), ['Your weekly limit is out']);

// Nothing measurable, nothing scheduled.
check('no projection, no alerts', plannedAlerts(account([{ key: 'session', utilization: 40 }], {}), now), []);
check('no windows, no alerts', plannedAlerts(account([], {}), now), []);

// Imminent crossings are not worth delivering — they have happened by then.
planned = plannedAlerts(
  account(
    [{ key: 'session', utilization: 79.9, resetsAt: new Date(now + 300 * MIN).toISOString() }],
    { session: { ratePerHour: 60, exhaustsAt: now + 20 * MIN, resetsAt: now + 300 * MIN, willExhaustBeforeReset: true } },
  ),
  now,
);
check('a crossing inside three minutes is dropped', planned.map((a) => a.title), ['Your session limit is out']);

// Ids are stable per window and kind, so a reschedule replaces rather than stacks.
const ids = (util) =>
  plannedAlerts(
    account(
      [{ key: 'session', utilization: util, resetsAt: new Date(now + 300 * MIN).toISOString() }],
      { session: { ratePerHour: 10, exhaustsAt: now + 290 * MIN, resetsAt: now + 300 * MIN, willExhaustBeforeReset: true } },
    ),
    now,
  ).map((a) => a.id);
check('ids do not move as the level does', ids(50), ids(55));
check('and the two kinds differ', new Set(ids(50)).size, 2);

process.exit(pass ? 0 : 1);
