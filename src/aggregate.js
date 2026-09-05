import { costOf, lookupModel, ratesFor } from './pricing.js';

const DAY_MS = 86_400_000;
/** Two messages further apart than this are treated as separate work sessions. */
const ACTIVE_GAP_MS = 5 * 60_000;

export const RANGES = ['5h', 'today', '7d', '30d', 'all'];
const RANGE_LABELS = {
  '5h': '5 hours',
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  all: 'All time',
};
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- date helpers

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ------------------------------------------------------------------- formatting

function fmtCount(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n / 1e6 >= 100 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n / 1e3 >= 100 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function fmtHour(h) {
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 || 12}${suffix}`;
}

function fmtRelative(ts, now) {
  const diff = now - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < DAY_MS) return `${Math.round(diff / 3_600_000)}h ago`;
  const days = Math.round(diff / DAY_MS);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- token helpers

function emptyTotals() {
  return {
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cost: 0,
    toolCalls: 0,
    thinkingMessages: 0,
  };
}

function addEvent(t, e) {
  t.messages += 1;
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.cacheRead += e.cacheRead;
  t.cacheCreate5m += e.cacheCreate5m;
  t.cacheCreate1h += e.cacheCreate1h;
  t.cost += costOf(e, e.model, e.ts);
  t.toolCalls += e.tools.length;
  if (e.thinking) t.thinkingMessages += 1;
  return t;
}

/** Every token the model actually read, cached or not. */
function totalIn(t) {
  return t.inputTokens + t.cacheRead + t.cacheCreate5m + t.cacheCreate1h;
}

/** The half of `totalIn` the model had not seen before: everything but cache hits. */
function freshIn(t) {
  return t.inputTokens + t.cacheCreate5m + t.cacheCreate1h;
}

// ------------------------------------------------------------------ range slice

/**
 * How far back the comparison window sits. Shifting by the range's calendar
 * length — rather than by (to - from) — is what makes "today" compare against
 * yesterday *up to the same clock time*, which is what the card's subtitle
 * claims. Subtracting the elapsed span instead compared today against the last
 * few hours of yesterday.
 */
function rangeShiftMs(range) {
  switch (range) {
    case '5h':
      return 5 * HOUR_MS;
    case 'today':
      return DAY_MS;
    case '7d':
      return 7 * DAY_MS;
    case '30d':
      return 30 * DAY_MS;
    default:
      return null;
  }
}

function rangeBounds(range, now) {
  const today = startOfLocalDay(now);
  switch (range) {
    case '5h':
      // Mirrors the 5-hour usage window the API enforces. When the caller knows
      // the window's reset time it is passed in, so the axis lines up with the
      // limit being plotted instead of floating on a rolling "last 5 hours".
      return { from: now - 5 * HOUR_MS, to: now };
    case 'today':
      return { from: today, to: now };
    case '7d':
      return { from: today - 6 * DAY_MS, to: now };
    case '30d':
      return { from: today - 29 * DAY_MS, to: now };
    default:
      return { from: -Infinity, to: now };
  }
}

// -------------------------------------------------------------- active time

/**
 * Sum of gaps between consecutive events, ignoring gaps longer than
 * ACTIVE_GAP_MS. This measures hands-on time rather than wall-clock span, so an
 * overnight break between two messages doesn't count as eight hours of work.
 */
function activeTime(events) {
  let total = 0;
  for (let i = 1; i < events.length; i += 1) {
    const gap = events[i].ts - events[i - 1].ts;
    if (gap > 0 && gap <= ACTIVE_GAP_MS) total += gap;
  }
  return total;
}

// ------------------------------------------------------------------ daily index

function dailyCounts(events) {
  const byDay = new Map();
  for (const e of events) {
    const key = dayKey(e.ts);
    const d = byDay.get(key) ?? { messages: 0, tokens: 0, cost: 0 };
    d.messages += 1;
    d.tokens += e.inputTokens + e.outputTokens + e.cacheRead + e.cacheCreate5m + e.cacheCreate1h;
    d.cost += costOf(e, e.model, e.ts);
    byDay.set(key, d);
  }
  return byDay;
}

function streaks(byDay, now) {
  const today = startOfLocalDay(now);

  let current = 0;
  for (let i = 0; ; i += 1) {
    const key = dayKey(today - i * DAY_MS);
    if (byDay.has(key)) current += 1;
    else if (i === 0) continue; // today may simply not have started yet
    else break;
  }

  // Longest run over the sorted set of active days.
  const days = [...byDay.keys()].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  let longestEnd = null;
  let runStart = null;
  let longestStart = null;
  for (const key of days) {
    const ts = startOfLocalDay(Date.parse(`${key}T12:00:00`));
    if (prev != null && ts - prev === DAY_MS) {
      run += 1;
    } else {
      run = 1;
      runStart = ts;
    }
    if (run > longest) {
      longest = run;
      longestEnd = ts;
      longestStart = runStart;
    }
    prev = ts;
  }

  return {
    current,
    longest,
    longestRange:
      longestStart != null && longestEnd != null
        ? `${new Date(longestStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(longestEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
        : null,
    activeDays: byDay.size,
  };
}

// --------------------------------------------------------------------- heatmap

const HEAT_COLORS = [
  '#EFE8DA',
  'oklch(0.60 0.13 45 / 0.3)',
  'oklch(0.60 0.13 45 / 0.55)',
  'oklch(0.60 0.13 45 / 0.8)',
  'oklch(0.55 0.14 45)',
];

function buildHeatmap(byDay, weeks, now) {
  const today = startOfLocalDay(now);
  // End the grid on the Saturday of the current week so columns are whole weeks.
  const endOfWeek = today + (6 - new Date(today).getDay()) * DAY_MS;
  const start = endOfWeek - (weeks * 7 - 1) * DAY_MS;

  const counts = [...byDay.values()].map((d) => d.messages).filter((n) => n > 0);
  counts.sort((a, b) => a - b);
  const q = (p) => (counts.length ? counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] : 0);
  // Quartile thresholds so the scale adapts to how heavy a user actually is.
  const thresholds = [q(0.25), q(0.5), q(0.75), q(0.92)];

  const level = (n) => {
    if (!n) return 0;
    let lvl = 1;
    for (const t of thresholds) if (n > t) lvl += 1;
    return Math.min(4, lvl);
  };

  const weekCols = [];
  const monthMarks = [];
  let lastMonth = null;

  for (let w = 0; w < weeks; w += 1) {
    const days = [];
    for (let d = 0; d < 7; d += 1) {
      const ts = start + (w * 7 + d) * DAY_MS;
      if (ts > today) {
        days.push({ empty: true, color: 'transparent', tip: '' });
        continue;
      }
      const rec = byDay.get(dayKey(ts));
      const messages = rec?.messages ?? 0;
      days.push({
        // `level` is the semantic value; `color` is the light-theme rendering of
        // it. Clients that theme themselves (both of them, now) use the level and
        // pick their own colour — a baked hex can't follow a dark mode.
        level: level(messages),
        color: HEAT_COLORS[level(messages)],
        date: new Date(ts).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        messages,
        tokens: fmtCount(rec?.tokens ?? 0),
        cost: fmtMoney(rec?.cost ?? 0),
        tip: `${new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${messages} message${messages === 1 ? '' : 's'}`,
      });
    }
    weekCols.push({ days });

    const monthOfCol = new Date(start + w * 7 * DAY_MS).getMonth();
    if (monthOfCol !== lastMonth) {
      lastMonth = monthOfCol;
      monthMarks.push({
        col: w,
        label: new Date(start + w * 7 * DAY_MS).toLocaleDateString('en-US', { month: 'short' }),
      });
    }
  }

  return { weeks: weekCols, months: monthMarks, legendColors: HEAT_COLORS };
}

// ----------------------------------------------------------------- token trend

/**
 * Bucket width per range. Deliberately fine: the earlier version used one bucket
 * per hour for "today" and one per day for a week, which flattened real spikes
 * into a smooth curve and made short bursts invisible. Short ranges now resolve
 * to minutes.
 */
function trendResolution(range, bounds) {
  const span = bounds.to - bounds.from;
  switch (range) {
    case '5h':
      return { step: 5 * 60_000, labelEvery: 12 }; // 5-minute buckets, hourly labels
    case 'today':
      return { step: 10 * 60_000, labelEvery: 18 }; // 10-minute buckets, 3-hourly labels
    case '7d':
      return { step: HOUR_MS, labelEvery: 24 }; // hourly buckets, daily labels
    case '30d':
      return { step: 4 * HOUR_MS, labelEvery: 30 }; // 4-hourly buckets
    default: {
      // Keep "all time" near 240 points regardless of how long the history is.
      const step = Math.max(HOUR_MS, Math.ceil(span / 240 / HOUR_MS) * HOUR_MS);
      return { step, labelEvery: Math.max(1, Math.round(240 / 6)) };
    }
  }
}

function buildTrend(events, range, bounds, now) {
  const from = Number.isFinite(bounds.from)
    ? bounds.from
    : (events.length ? events[0].ts : startOfLocalDay(now));
  const { step, labelEvery } = trendResolution(range, { from, to: bounds.to });
  const count = Math.max(2, Math.ceil((bounds.to - from) / step));

  const shortRange = range === '5h' || range === 'today';
  const labelFor = (t) =>
    shortRange
      ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : new Date(t).toLocaleDateString('en-US',
          range === '7d' ? { weekday: 'short' } : { month: 'short', day: 'numeric' });

  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    const bFrom = from + i * step;
    buckets.push({
      from: bFrom,
      to: bFrom + step,
      label: i % labelEvery === 0 || i === count - 1 ? labelFor(bFrom) : '',
      in: 0,
      out: 0,
    });
  }

  // Direct index rather than a scan per event: bucket counts are now in the
  // hundreds, so the old nested loop would be O(events x buckets).
  for (const e of events) {
    if (e.ts < from) continue;
    const idx = Math.min(count - 1, Math.floor((e.ts - from) / step));
    const b = buckets[idx];
    b.in += e.inputTokens + e.cacheRead + e.cacheCreate5m + e.cacheCreate1h;
    b.out += e.outputTokens;
  }

  return {
    labels: buckets.map((b) => b.label),
    input: buckets.map((b) => b.in),
    output: buckets.map((b) => b.out),
    // Bucket start times, so the UI can label a hovered point precisely.
    stamps: buckets.map((b) => b.from),
    bucketMs: step,
  };
}

// ---------------------------------------------------------------------- models

function buildModels(events) {
  const byModel = new Map();
  for (const e of events) {
    const info = lookupModel(e.model);
    const cur = byModel.get(info.id) ?? { info, totals: emptyTotals() };
    addEvent(cur.totals, e);
    byModel.set(info.id, cur);
  }

  const rows = [...byModel.values()]
    .map(({ info, totals }) => ({
      id: info.id,
      name: info.label,
      color: info.color,
      // The tier is what the colour actually means, and it is what a themed
      // client needs in order to choose its own.
      tier: info.tier ?? 'other',
      estimated: Boolean(info.estimated),
      messages: totals.messages,
      tokensIn: totalIn(totals),
      tokensOut: totals.outputTokens,
      avgOut: totals.messages ? Math.round(totals.outputTokens / totals.messages) : 0,
      cost: totals.cost,
      cacheRead: totals.cacheRead,
    }))
    .sort((a, b) => b.messages - a.messages);

  const totalMessages = rows.reduce((s, r) => s + r.messages, 0) || 1;
  for (const r of rows) r.share = (r.messages / totalMessages) * 100;

  return rows;
}

// -------------------------------------------------------------- workload mix

/**
 * The design's "Products" row (Chat / Code / Design / API / Mobile) can't be
 * populated: local transcripts only ever describe Claude Code, and there is no
 * public API that exposes claude.ai chat or Design history. These five cards use
 * dimensions the transcripts genuinely carry instead.
 */
function buildWorkload(events, prompts, totals) {
  const main = emptyTotals();
  const sub = emptyTotals();
  for (const e of events) addEvent(e.isSidechain ? sub : main, e);

  const distinctTools = new Set();
  for (const e of events) for (const t of e.tools) distinctTools.add(t);

  const cacheWrite = totals.cacheCreate5m + totals.cacheCreate1h;
  const cacheHitRate = totals.cacheRead + cacheWrite > 0
    ? (totals.cacheRead / (totals.cacheRead + cacheWrite)) * 100
    : 0;
  // What the cached prefix would have cost at full input price minus what it
  // actually cost at the 0.1x read rate.
  const cacheSavings = events.reduce((sum, e) => {
    const rate = ratesFor(e.model, e.ts).in;
    return sum + e.cacheRead * (rate / 1e6) * 0.9;
  }, 0);

  const allMessages = totals.messages || 1;
  const cards = [
    {
      name: 'Main thread',
      pct: (main.messages / allMessages) * 100,
      rows: [
        ['Messages', fmtCount(main.messages)],
        ['Prompts', fmtCount(prompts.filter((p) => !p.isSidechain).length)],
      ],
      tokens: fmtCount(totalIn(main) + main.outputTokens),
    },
    {
      name: 'Subagents',
      pct: (sub.messages / allMessages) * 100,
      rows: [
        ['Messages', fmtCount(sub.messages)],
        ['Tool calls', fmtCount(sub.toolCalls)],
      ],
      tokens: fmtCount(totalIn(sub) + sub.outputTokens),
    },
    {
      name: 'Tool use',
      pct: allMessages ? Math.min(100, (totals.toolCalls / allMessages) * 100) : 0,
      rows: [
        ['Calls', fmtCount(totals.toolCalls)],
        ['Distinct tools', String(distinctTools.size)],
      ],
      tokens: `${(totals.toolCalls / allMessages).toFixed(2)}/msg`,
    },
    {
      name: 'Cache',
      pct: cacheHitRate,
      rows: [
        ['Hit rate', `${cacheHitRate.toFixed(0)}%`],
        ['Saved', fmtMoney(cacheSavings)],
      ],
      tokens: fmtCount(totals.cacheRead),
    },
    {
      name: 'Thinking',
      pct: (totals.thinkingMessages / allMessages) * 100,
      rows: [
        ['Messages', fmtCount(totals.thinkingMessages)],
        ['Share', `${((totals.thinkingMessages / allMessages) * 100).toFixed(0)}%`],
      ],
      tokens: fmtCount(totals.outputTokens),
    },
  ];

  return cards.map((c) => ({ ...c, pctW: `${Math.max(2, Math.min(100, c.pct)).toFixed(1)}%` }));
}

// ----------------------------------------------------------------------- tools

function buildTools(events) {
  const counts = new Map();
  for (const e of events) {
    for (const name of e.tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([name, count]) => ({ name: prettyToolName(name), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);
  const max = rows.length ? rows[0].count : 1;
  return rows.map((r, i) => ({
    ...r,
    pct: `${Math.max(2, (r.count / max) * 100).toFixed(1)}%`,
    color: i % 2 ? 'oklch(0.60 0.10 155)' : 'oklch(0.60 0.13 45)',
  }));
}

function prettyToolName(name) {
  // MCP tools arrive as mcp__<server>__<tool>; show "server / tool".
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `${m[1].replace(/_/g, ' ')} / ${m[2]}`;
  return name;
}

// -------------------------------------------------------------------- sessions

function buildSessions(events, titles, now) {
  const bySession = new Map();
  for (const e of events) {
    const id = e.sessionId ?? 'unknown';
    let s = bySession.get(id);
    if (!s) {
      s = {
        id,
        first: e.ts,
        last: e.ts,
        events: [],
        project: e.project,
        cwd: e.cwd,
        models: new Map(),
        totals: emptyTotals(),
      };
      bySession.set(id, s);
    }
    s.first = Math.min(s.first, e.ts);
    s.last = Math.max(s.last, e.ts);
    s.events.push(e);
    s.models.set(e.model, (s.models.get(e.model) ?? 0) + 1);
    addEvent(s.totals, e);
  }

  const sessions = [...bySession.values()].map((s) => {
    const topModel = [...s.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      ...s,
      duration: activeTime(s.events.slice().sort((a, b) => a.ts - b.ts)),
      span: s.last - s.first,
      title: titles.get(s.id) ?? null,
      topModel,
    };
  });

  const hourBuckets = new Array(24).fill(0);
  for (const e of events) hourBuckets[new Date(e.ts).getHours()] += 1;
  const maxHour = Math.max(1, ...hourBuckets);
  const peakHourIdx = hourBuckets.indexOf(Math.max(...hourBuckets));

  const durations = sessions.map((s) => s.duration).filter((d) => d > 0);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const longest = sessions.reduce((m, s) => Math.max(m, s.duration), 0);

  return {
    count: sessions.length,
    avgLength: fmtDuration(avg),
    longest: fmtDuration(longest),
    peakHour: events.length ? fmtHour(peakHourIdx) : '—',
    hourBars: hourBuckets.map((v, h) => ({
      height: `${Math.max(3, Math.round((v / maxHour) * 100))}%`,
      color:
        v >= maxHour * 0.85
          ? 'oklch(0.55 0.14 45)'
          : v >= maxHour * 0.4
            ? 'oklch(0.60 0.13 45 / 0.65)'
            : '#E3DAC8',
      tip: `${fmtHour(h)} · ${v} message${v === 1 ? '' : 's'}`,
    })),
    list: sessions.sort((a, b) => b.last - a.last),
    now,
  };
}

// -------------------------------------------------------------------- projects

const PROJECT_TAGS = [
  ['#F3E4DA', 'oklch(0.45 0.12 45)'],
  ['#E2EAE2', 'oklch(0.42 0.09 155)'],
  ['#EFE6F0', 'oklch(0.45 0.10 320)'],
  ['#E4E8F2', 'oklch(0.42 0.09 265)'],
  ['#EAE4D6', '#57503F'],
];

function buildProjects(events, sessions, now) {
  const byProject = new Map();
  for (const e of events) {
    const key = e.cwd ?? e.project ?? 'unknown';
    let p = byProject.get(key);
    if (!p) {
      p = { key, name: e.project ?? key, cwd: e.cwd, totals: emptyTotals(), sessions: new Set(), last: 0, models: new Map() };
      byProject.set(key, p);
    }
    addEvent(p.totals, e);
    if (e.sessionId) p.sessions.add(e.sessionId);
    p.last = Math.max(p.last, e.ts);
    p.models.set(e.model, (p.models.get(e.model) ?? 0) + 1);
  }

  return [...byProject.values()]
    .sort((a, b) => totalIn(b.totals) + b.totals.outputTokens - (totalIn(a.totals) + a.totals.outputTokens))
    .map((p, i) => {
      const topModel = [...p.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const [tagBg, tagFg] = PROJECT_TAGS[i % PROJECT_TAGS.length];
      return {
        name: p.name,
        cwd: p.cwd,
        model: lookupModel(topModel).label,
        tagBg,
        tagFg,
        sessions: p.sessions.size,
        messages: p.totals.messages,
        tokens: fmtCount(totalIn(p.totals) + p.totals.outputTokens),
        cost: fmtMoney(p.totals.cost),
        last: fmtRelative(p.last, now),
        // Unformatted values for client-side sorting — "429M" and "$1,009" don't
        // compare correctly as strings.
        tokensRaw: totalIn(p.totals) + p.totals.outputTokens,
        costRaw: p.totals.cost,
        lastTs: p.last,
      };
    });
}

// ------------------------------------------------------------------------ feed

function buildFeed(sessions, now, limit = 8) {
  return sessions.list.slice(0, limit).map((s, i) => {
    const [tagBg, tagFg] = PROJECT_TAGS[i % PROJECT_TAGS.length];
    const tokensIn = totalIn(s.totals);
    return {
      surface: s.project ?? '—',
      tagBg,
      tagFg,
      title: s.title ?? `${s.totals.messages} messages in ${s.project ?? 'session'}`,
      meta: `${fmtCount(tokensIn)} in · ${fmtCount(s.totals.outputTokens)} out · ${lookupModel(s.topModel).label} · ${fmtDuration(s.duration)}`,
      time: fmtRelative(s.last, now),
    };
  });
}

// -------------------------------------------------------------------- badges

function buildBadges(allEvents, allByDay, streak, allTotals, sessions) {
  const tokens = totalIn(allTotals) + allTotals.outputTokens;
  const distinctModels = new Set(allEvents.map((e) => lookupModel(e.model).id)).size;
  const nightMessages = allEvents.filter((e) => {
    const h = new Date(e.ts).getHours();
    return h >= 0 && h < 5;
  }).length;
  const bestDay = Math.max(0, ...[...allByDay.values()].map((d) => d.messages));
  const longestSession = sessions.list.reduce((m, s) => Math.max(m, s.duration), 0);
  const cacheWrite = allTotals.cacheCreate5m + allTotals.cacheCreate1h;
  const hitRate = allTotals.cacheRead + cacheWrite > 0
    ? allTotals.cacheRead / (allTotals.cacheRead + cacheWrite)
    : 0;

  const defs = [
    ['◆', 'Marathon', '30-day streak', streak.longest >= 30, `${streak.longest}/30 days`],
    ['●', 'Ten million', '10M tokens processed', tokens >= 1e7, `${fmtCount(tokens)}/10M`],
    ['▲', 'Polymath', 'Used 4+ distinct models', distinctModels >= 4, `${distinctModels}/4 models`],
    ['✳', 'Night owl', '50 messages after midnight', nightMessages >= 50, `${nightMessages}/50`],
    ['✦', 'Toolsmith', '1,000 tool calls', allTotals.toolCalls >= 1000, `${fmtCount(allTotals.toolCalls)}/1k`],
    ['◇', 'Centurion', '100 messages in one day', bestDay >= 100, `${bestDay}/100`],
    ['⬢', 'Deep work', 'A single 3-hour session', longestSession >= 3 * 3_600_000, `${fmtDuration(longestSession)}/3h`],
    ['○', 'Cache miser', '80% cache hit rate', hitRate >= 0.8, `${(hitRate * 100).toFixed(0)}%/80%`],
  ];

  return defs.map(([icon, name, desc, earned, progress]) => ({
    icon,
    name,
    desc: earned ? desc : `${desc} · ${progress}`,
    earned,
  }));
}

// ------------------------------------------------------------------- entrypoint

/**
 * Build the full dashboard snapshot.
 *
 * Range-scoped: stat cards, token trend, model table, workload, tools,
 * sessions, projects, feed.
 * All-time regardless of range: heatmap, streaks, achievements — those are
 * lifetime facts and the design shows them as such.
 */
export function buildSnapshot({ assistant, prompts, titles, meta }, { range = '7d', weeks = 26 } = {}) {
  const now = Date.now();
  const activeRange = RANGES.includes(range) ? range : '7d';
  const bounds = rangeBounds(activeRange, now);

  const events = assistant.filter((e) => e.ts >= bounds.from && e.ts <= bounds.to);
  const rangePrompts = prompts.filter((p) => p.ts >= bounds.from && p.ts <= bounds.to);

  const totals = events.reduce(addEvent, emptyTotals());
  const allTotals = assistant.reduce(addEvent, emptyTotals());

  /**
   * Previous equal-length window, for the delta chips.
   *
   * Only computed when that whole window falls inside recorded history. Otherwise
   * the baseline is a period we have no data for, and the comparison is against
   * near-zero — which produced chips like "+100905%" rather than anything useful.
   */
  const prev = (() => {
    const shift = rangeShiftMs(activeRange);
    if (shift == null || !Number.isFinite(bounds.from)) return null;
    const prevFrom = bounds.from - shift;
    const prevTo = bounds.to - shift;
    if (meta.firstTs == null || prevFrom < meta.firstTs) return null;
    const prevEvents = assistant.filter((e) => e.ts >= prevFrom && e.ts < prevTo);
    return prevEvents.reduce(addEvent, emptyTotals());
  })();

  const delta = (cur, before) => {
    if (before == null || before === 0) return null;
    const pct = ((cur - before) / before) * 100;
    // A change this large says more about a thin baseline than about a trend.
    if (Math.abs(pct) > 999) return null;
    return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`, positive: pct >= 0 };
  };

  const allByDay = dailyCounts(assistant);
  const streak = streaks(allByDay, now);
  const sessions = buildSessions(events, titles, now);
  const allSessions = buildSessions(assistant, titles, now);
  const active = activeTime(events);
  const models = buildModels(events);

  const cacheWrite = totals.cacheCreate5m + totals.cacheCreate1h;
  const statCards = [
    {
      label: 'Messages',
      metric: 'messages',
      value: fmtCount(totals.messages),
      unit: '',
      sub: `${fmtCount(rangePrompts.length)} prompt${rangePrompts.length === 1 ? '' : 's'} sent`,
      delta: delta(totals.messages, prev?.messages),
      series: sparkSeries(events, bounds, now, (t, e) => t + 1),
    },
    {
      label: 'Tokens in',
      metric: 'tokensIn',
      value: fmtCount(totalIn(totals)),
      unit: '',
      sub: `${fmtCount(totals.cacheRead)} of it cached reads, billed at 1/10`,
      delta: prev ? delta(totalIn(totals), totalIn(prev)) : null,
      series: sparkSeries(events, bounds, now, (t, e) => t + e.inputTokens + e.cacheRead + e.cacheCreate5m + e.cacheCreate1h),
      // Cached reads dwarf fresh context by two orders of magnitude, which makes
      // the combined figure look wrong next to "Tokens out". The split lets the
      // card open into its two halves without costing a grid slot.
      split: [
        {
          label: 'Fresh in',
          metric: 'freshIn',
          value: fmtCount(freshIn(totals)),
          sub: 'tokens in, full rate',
          delta: prev ? delta(freshIn(totals), freshIn(prev)) : null,
          series: sparkSeries(events, bounds, now, (t, e) => t + e.inputTokens + e.cacheCreate5m + e.cacheCreate1h),
        },
        {
          label: 'Cache read',
          metric: 'cacheRead',
          value: fmtCount(totals.cacheRead),
          sub: 'tokens in, 1/10 rate',
          delta: delta(totals.cacheRead, prev?.cacheRead),
          series: sparkSeries(events, bounds, now, (t, e) => t + e.cacheRead),
        },
      ],
    },
    {
      label: 'Tokens out',
      metric: 'tokensOut',
      value: fmtCount(totals.outputTokens),
      unit: '',
      sub: totals.messages
        ? `avg ${fmtCount(totals.outputTokens / totals.messages)} per reply`
        : 'no replies yet',
      delta: delta(totals.outputTokens, prev?.outputTokens),
      series: sparkSeries(events, bounds, now, (t, e) => t + e.outputTokens),
    },
    {
      label: 'API-equivalent',
      metric: 'cost',
      value: fmtMoney(totals.cost),
      unit: '',
      sub: 'what this would cost on the API',
      delta: delta(totals.cost, prev?.cost),
      series: sparkSeries(events, bounds, now, (t, e) => t + costOf(e, e.model, e.ts)),
    },
    {
      label: 'Active time',
      value: fmtDuration(active),
      unit: '',
      sub: `across ${sessions.count} session${sessions.count === 1 ? '' : 's'}`,
      delta: null,
      series: activeTimeSeries(events, bounds, now),
    },
    {
      label: 'Current streak',
      value: String(streak.current),
      unit: streak.current === 1 ? 'day' : 'days',
      sub: `personal best: ${streak.longest}`,
      delta: null,
      series: streakSeries(allByDay, now),
    },
  ];

  return {
    generatedAt: now,
    range: activeRange,
    rangeLabel: RANGE_LABELS[activeRange],
    ranges: RANGES.map((id) => ({ id, label: RANGE_LABELS[id] })),
    empty: assistant.length === 0,
    meta: {
      ...meta,
      firstActivity: meta.firstTs
        ? new Date(meta.firstTs).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
        : null,
      sizeLabel: `${(meta.bytes / 1e6).toFixed(1)} MB`,
    },
    statCards,
    activity: {
      heatmap: buildHeatmap(allByDay, weeks, now),
      heatmapTitle: `Daily activity — last ${weeks} weeks`,
      weeks,
      streak,
      bestDay: Math.max(0, ...[...allByDay.values()].map((d) => d.messages)),
      avgPerActiveDay: allByDay.size
        ? Math.round(assistant.length / allByDay.size)
        : 0,
      busiestWeekday: busiestWeekday(assistant),
    },
    tokens: {
      trend: buildTrend(events, activeRange, bounds, now),
      totalMessages: fmtCount(totals.messages),
      models,
      hasEstimatedPricing: models.some((m) => m.estimated),
    },
    workload: buildWorkload(events, rangePrompts, totals),
    tools: buildTools(events),
    sessions: {
      count: sessions.count,
      avgLength: sessions.avgLength,
      longest: sessions.longest,
      peakHour: sessions.peakHour,
      hourBars: sessions.hourBars,
    },
    projects: buildProjects(events, sessions, now),
    feed: buildFeed(sessions, now),
    badges: buildBadges(assistant, allByDay, streak, allTotals, allSessions),
  };
}

function busiestWeekday(events) {
  if (!events.length) return '—';
  const counts = new Array(7).fill(0);
  for (const e of events) counts[new Date(e.ts).getDay()] += 1;
  const idx = counts.indexOf(Math.max(...counts));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][idx];
}

/**
 * Active minutes per bucket — the same 5-minute-gap rule as activeTime(), but
 * bucketed. The Active time card previously plotted message counts, which is a
 * different quantity wearing the same label.
 */
function activeTimeSeries(events, bounds, now, points = 12) {
  const from = Number.isFinite(bounds.from) ? bounds.from : (events[0]?.ts ?? now);
  const span = Math.max(1, bounds.to - from);
  const step = span / points;
  const out = new Array(points).fill(0);
  for (let i = 1; i < events.length; i += 1) {
    const gap = events[i].ts - events[i - 1].ts;
    if (gap <= 0 || gap > ACTIVE_GAP_MS) continue;
    if (events[i].ts < from) continue;
    const idx = Math.min(points - 1, Math.floor((events[i].ts - from) / step));
    out[idx] += gap / 60_000;
  }
  return out;
}

/**
 * One point per day, 1 when the day had any activity. A streak is a run of active
 * days, so a binary series is what the card is actually about — it previously drew
 * message volume.
 */
function streakSeries(byDay, now, days = 14) {
  const today = startOfLocalDay(now);
  return Array.from({ length: days }, (_, i) =>
    byDay.has(dayKey(today - (days - 1 - i) * DAY_MS)) ? 1 : 0,
  );
}

/** 12-point series for a stat card sparkline. */
function sparkSeries(events, bounds, now, reducer) {
  const points = 12;
  const from = Number.isFinite(bounds.from) ? bounds.from : (events[0]?.ts ?? now);
  const span = Math.max(1, bounds.to - from);
  const step = span / points;
  const out = new Array(points).fill(0);
  for (const e of events) {
    if (e.ts < from) continue;
    const idx = Math.min(points - 1, Math.floor((e.ts - from) / step));
    out[idx] = reducer(out[idx], e);
  }
  return out;
}

// ---------------------------------------------------------------- metric series

/*
 * One tappable figure, resolved over time.
 *
 * The stat cards each carry a 12-point sparkline, which is enough to suggest a
 * shape and nothing like enough to scrub. This builds the full-resolution
 * version of the same figure — the trend bucketing, one metric at a time — so
 * the phone can open a card into a chart without re-fetching the whole snapshot
 * every time the range changes.
 */
const METRICS = {
  messages: {
    label: 'Messages',
    format: 'count',
    unit: 'messages',
    source: 'assistant',
    of: () => 1,
  },
  prompts: {
    label: 'Prompts',
    format: 'count',
    unit: 'prompts',
    source: 'prompts',
    of: () => 1,
  },
  tokensIn: {
    label: 'Tokens in',
    format: 'count',
    unit: 'tokens',
    source: 'assistant',
    of: (e) => e.inputTokens + e.cacheRead + e.cacheCreate5m + e.cacheCreate1h,
  },
  freshIn: {
    label: 'Fresh in',
    format: 'count',
    unit: 'tokens',
    source: 'assistant',
    of: (e) => e.inputTokens + e.cacheCreate5m + e.cacheCreate1h,
  },
  cacheRead: {
    label: 'Cache read',
    format: 'count',
    unit: 'tokens',
    source: 'assistant',
    of: (e) => e.cacheRead,
  },
  tokensOut: {
    label: 'Tokens out',
    format: 'count',
    unit: 'tokens',
    source: 'assistant',
    of: (e) => e.outputTokens,
  },
  cost: {
    label: 'API-equivalent',
    format: 'money',
    unit: 'spend',
    source: 'assistant',
    of: (e) => costOf(e, e.model, e.ts),
  },
  toolCalls: {
    label: 'Tool calls',
    format: 'count',
    unit: 'calls',
    source: 'assistant',
    of: (e) => e.tools.length,
  },
};

export const METRIC_IDS = Object.keys(METRICS);

/** Metrics worth offering as a next tap from a given one. */
const RELATED = {
  tokensIn: ['freshIn', 'cacheRead'],
  freshIn: ['tokensIn', 'cacheRead'],
  cacheRead: ['tokensIn', 'freshIn'],
  messages: ['prompts', 'toolCalls'],
  prompts: ['messages'],
  toolCalls: ['messages'],
  tokensOut: ['tokensIn', 'cost'],
  cost: ['tokensIn', 'tokensOut'],
};

function bucketize(rows, metric, from, to, step) {
  const count = Math.max(2, Math.ceil((to - from) / step));
  const out = new Array(count).fill(0);
  for (const row of rows) {
    if (row.ts < from || row.ts > to) continue;
    const idx = Math.min(count - 1, Math.floor((row.ts - from) / step));
    out[idx] += metric.of(row);
  }
  return out;
}

function fmtMetric(value, format) {
  return format === 'money' ? fmtMoney(value) : fmtCount(value);
}

/**
 * A full-resolution series for one metric over one range, plus the figures the
 * chart screen shows underneath it.
 */
export function metricSeries({ assistant, prompts, meta }, { metric: id, range = '7d' } = {}) {
  const metric = METRICS[id];
  if (!metric) return null;

  const now = Date.now();
  const activeRange = RANGES.includes(range) ? range : '7d';
  const bounds = rangeBounds(activeRange, now);
  const rows = metric.source === 'prompts' ? prompts : assistant;
  const from = Number.isFinite(bounds.from) ? bounds.from : (rows[0]?.ts ?? startOfLocalDay(now));
  const { step } = trendResolution(activeRange, { from, to: bounds.to });

  const values = bucketize(rows, metric, from, bounds.to, step);
  const stamps = values.map((_, i) => from + i * step);
  const total = values.reduce((a, b) => a + b, 0);

  /*
   * Everything this metric had already counted before the window opens.
   *
   * The phone's cumulative chart draws a line that never falls, on any range —
   * so on a five-hour window it has to start from the all-time figure at 5pm
   * rather than from zero, or the "cumulative" total silently means something
   * different on every range. One pass over rows already in memory.
   */
  const priorTotal = rows.reduce((sum, r) => (r.ts < from ? sum + metric.of(r) : sum), 0);

  // Same-length window one period back, on the same rule the stat chips use:
  // only compared when history actually covers it.
  const shift = rangeShiftMs(activeRange);
  const prevTotal = (() => {
    if (shift == null || !Number.isFinite(bounds.from)) return null;
    const prevFrom = bounds.from - shift;
    if (meta?.firstTs == null || prevFrom < meta.firstTs) return null;
    return rows
      .filter((r) => r.ts >= prevFrom && r.ts < bounds.from)
      .reduce((sum, r) => sum + metric.of(r), 0);
  })();

  const delta = (() => {
    if (prevTotal == null || prevTotal === 0) return null;
    const pct = ((total - prevTotal) / prevTotal) * 100;
    if (Math.abs(pct) > 999) return null;
    return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`, positive: pct >= 0 };
  })();

  const active = values.filter((v) => v > 0);
  const peakIdx = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
  const bucketLabel = (ms) => {
    const min = Math.round(ms / 60_000);
    if (min < 60) return `${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
  };
  const whenLabel = (ts) =>
    new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const stats = [
    { label: 'Total', value: fmtMetric(total, metric.format) },
    {
      label: 'Peak',
      value: fmtMetric(values[peakIdx] ?? 0, metric.format),
      sub: values[peakIdx] ? whenLabel(stamps[peakIdx]) : null,
    },
    {
      label: `Avg per ${bucketLabel(step)}`,
      value: active.length ? fmtMetric(total / active.length, metric.format) : '—',
      sub: 'while active',
    },
    {
      label: 'Previous period',
      value: prevTotal == null ? '—' : fmtMetric(prevTotal, metric.format),
      sub: prevTotal == null ? 'not enough history' : RANGE_LABELS[activeRange].toLowerCase() + ' before',
    },
    {
      label: 'Active buckets',
      value: `${active.length} of ${values.length}`,
      sub: `${bucketLabel(step)} each`,
    },
    {
      label: 'Quietest gap',
      value: bucketLabel(longestGap(values) * step),
      sub: 'longest run with nothing',
    },
  ];

  return {
    metric: id,
    label: metric.label,
    // Tokens in is the sum of two very differently-priced halves, and the split
    // is the first question the total provokes. Offer it as a jump rather than
    // making the phone go back and hunt for it.
    related: (RELATED[id] ?? []).map((rid) => ({ metric: rid, label: METRICS[rid].label })),
    unit: metric.unit,
    format: metric.format,
    range: activeRange,
    rangeLabel: RANGE_LABELS[activeRange],
    ranges: RANGES.map((rid) => ({ id: rid, label: RANGE_LABELS[rid] })),
    from,
    to: bounds.to,
    bucketMs: step,
    values,
    stamps,
    total,
    totalText: fmtMetric(total, metric.format),
    priorTotal,
    delta,
    stats,
  };
}

/** Longest run of empty buckets, in buckets. */
function longestGap(values) {
  let best = 0;
  let run = 0;
  for (const v of values) {
    run = v > 0 ? 0 : run + 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Cumulative cost-weighted usage between two instants, as `points` samples.
 *
 * Used to reconstruct the shape of a limit window's utilization curve. Cost is the
 * weight because quota plainly is not counted in raw tokens — an Opus/Fable token
 * consumes far more allowance than a Haiku one — and relative price is the best
 * public proxy for that weighting.
 *
 * This is an estimate, not a measurement, and the UI must say so: the real
 * weighting is unpublished, and usage from claude.ai chat or mobile never appears
 * in local transcripts at all.
 */
export function usageCurve(assistant, { from, to, points = 120, model = null }) {
  const step = Math.max(1, (to - from) / points);
  const out = [];
  let cum = 0;
  let i = 0;

  // Scope names the family ("Fable") while model labels carry a version
  // ("Fable 5"), so match on prefix.
  const needle = model?.toLowerCase();
  const events = needle
    ? assistant.filter((e) => lookupModel(e.model).label.toLowerCase().startsWith(needle))
    : assistant;
  const inWindow = events.filter((e) => e.ts >= from && e.ts <= to);

  for (let p = 0; p <= points; p += 1) {
    const t = from + p * step;
    while (i < inWindow.length && inWindow[i].ts <= t) {
      cum += costOf(inWindow[i], inWindow[i].model, inWindow[i].ts);
      i += 1;
    }
    out.push({ t: Math.round(t), c: Number(cum.toFixed(6)) });
  }
  return { points: out, total: cum, events: inWindow.length };
}

export { fmtCount, fmtMoney, fmtDuration };
