/*
 * The heatmap and streaks: where a day is, and whether it happened.
 *
 * Pinned to a US timezone before anything reads a clock, because both bugs this
 * covers only exist where the clocks change: a day there is 23 or 25 hours, and
 * stepping by 24 put every cell and every streak day on the wrong date for half
 * the year.
 */
process.env.TZ = 'America/Chicago';

const { buildSnapshot } = await import('../src/aggregate.js');

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('   got ', JSON.stringify(got), '\n   want', JSON.stringify(want));
  return ok;
};

let pass = true;

function message(iso) {
  return {
    uuid: iso,
    ts: Date.parse(iso),
    model: 'claude-opus-5',
    sessionId: 's',
    project: 'p',
    inputTokens: 1,
    outputTokens: 1,
    cacheRead: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    tools: [],
  };
}

function snapshot(days, { now, recorded, oldestFileAt } = {}) {
  const assistant = days.map((day) => message(`${day}T12:00:00`));
  const realNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    return buildSnapshot(
      {
        assistant,
        prompts: [],
        titles: new Map(),
        recorded,
        meta: { files: 1, bytes: 1, firstTs: null, lastTs: null, oldestFileAt },
      },
      { range: 'all', weeks: 26 },
    );
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------- clock changes

// 2026-03-08 is the spring change: that day is 23 hours long.
const spring = snapshot(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'], {
  now: '2026-03-10T15:00:00',
});
pass &= check('a run across the spring change is one run', spring.activity.streak.longest, 5);
pass &= check('and counts as the current streak', spring.activity.streak.current, 5);

// A window reaching back past the spring change, into winter.
const april = snapshot([], { now: '2026-04-10T12:00:00' });
const topRow = april.activity.heatmap.weeks.map((week) => week.days[0].date.slice(0, 3));
pass &= check('every top-row cell is a Sunday', [...new Set(topRow)], ['Sun']);

// ------------------------------------------------------------------ pruned days

const recorded = new Map([
  ['2026-08-26', 4767],
  ['2026-09-10', 1833],
]);
const pruned = snapshot(['2026-08-25', '2026-08-27', '2026-09-10'], {
  now: '2026-09-28T12:00:00',
  recorded,
  oldestFileAt: Date.parse('2026-08-28T09:00:00'),
});
const cells = new Map(
  pruned.activity.heatmap.weeks
    .flatMap((week) => week.days)
    .filter((day) => !day.empty)
    .map((day) => [day.date, day]),
);
const aug26 = cells.get('Wed, Aug 26, 2026');
pass &= check('a pruned day takes Claude Code’s count', aug26.messages, 4767);
pass &= check('and says so', aug26.recorded, true);
pass &= check('with no invented tokens', aug26.tokens, '—');
pass &= check(
  'a day with transcripts keeps its own count',
  cells.get('Thu, Sep 10, 2026').messages,
  1,
);
pass &= check('the filled day joins the streak', pruned.activity.streak.longest, 3);

const noFile = snapshot(['2026-08-25'], { now: '2026-09-28T12:00:00', recorded });
pass &= check(
  'nothing is filled without knowing what was pruned',
  noFile.activity.heatmap.weeks.flatMap((week) => week.days).some((day) => day.recorded),
  false,
);

process.exit(pass ? 0 : 1);
