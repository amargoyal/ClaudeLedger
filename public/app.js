const $ = (id) => document.getElementById(id);

/**
 * Resolved value of a CSS custom property, as a literal colour string.
 *
 * SVG needs literals: a `var()` inside a presentation attribute such as
 * `stroke="…"` is not reliably resolved and leaves the shape uncoloured. Reading
 * the property keeps the stylesheet the single source of truth anyway.
 *
 * Cached because this runs once per drawn element and getComputedStyle forces
 * style resolution; `clearPalette()` drops the cache when the theme moves.
 */
const paletteCache = new Map();

function color(name) {
  if (!paletteCache.has(name)) {
    paletteCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return paletteCache.get(name);
}

function clearPalette() {
  paletteCache.clear();
}

/*
 * The snapshot still carries baked colours for the heatmap, models, tools, hour
 * bars and project tags. Those are light-theme values computed on the server,
 * which has no idea what theme is on screen — so the client re-derives every one
 * of them from the stylesheet, using the semantic field the payload also carries
 * (level, tier, index, magnitude).
 */
const heatColor = (day) => color(`--heat-${Math.max(0, Math.min(4, day.level ?? 0))}`);
const modelColor = (m) => color(`--model-${m.tier ?? 'other'}`);
const toolColor = (i) => color(i % 2 ? '--series-output' : '--series-input');

function applyTag(node, i) {
  node.style.background = color(`--tag-${i % 5}-bg`);
  node.style.color = color(`--tag-${i % 5}-fg`);
}

const SERIES_COLORS = {
  get input() {
    return color('--series-input');
  },
  get output() {
    return color('--series-output');
  },
  get limit0() {
    return color('--series-limit0');
  },
  get limit1() {
    return color('--series-limit1');
  },
  get limit2() {
    return color('--series-limit2');
  },
};

const state = {
  // Which chart series are visible. Any combination; tokens and limit
  // percentages coexist on separate axes.
  visibleSeries: new Set(
    JSON.parse(localStorage.getItem('ledger.series') ?? 'null') ?? ['input', 'output'],
  ),
  limitHistory: [],
  // Wheel-zoom window on the token chart, {from, to} in epoch ms, or null for the
  // whole range. Deliberately not persisted: a zoom is a gesture, not a preference.
  zoom: null,
  // key -> { points, total } reconstruction, cached between renders.
  curves: {},
  pulse: null,
  projectSort: { key: 'tokensRaw', dir: 'desc' },
  version: null,
  range: localStorage.getItem('ledger.range') ?? '7d',
  weeks: 26,
  snapshot: null,
  account: null,
};

if (new URLSearchParams(location.search).get('shell') === 'electron') {
  document.body.classList.add('is-electron');
}

// ------------------------------------------------------------------ utilities

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Build an SVG polyline `points` string from a numeric series. */
function sparkPoints(series, w = 100, h = 28, pad = 2) {
  if (!series.length) return '';
  const max = Math.max(...series, 1);
  const step = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;
  return series
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - (v / max) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');
}

function svgEl(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// --------------------------------------------------------------------- theme

const THEME_KEY = 'ledger.theme';
/** 'system' follows the OS; the other two pin it. */
const THEMES = ['system', 'light', 'dark'];

const THEME_ICONS = {
  system: ['M12 3.5a8.5 8.5 0 1 0 0 17z', 'M12 3.5a8.5 8.5 0 1 1 0 17'],
  light: [
    'M12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8z',
    'M12 2.4v2M12 19.6v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.4 12h2M19.6 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  ],
  dark: ['M20 14.2A8.4 8.4 0 0 1 9.8 4 8.6 8.6 0 1 0 20 14.2z'],
};

function currentTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  return THEMES.includes(stored) ? stored : 'system';
}

/**
 * Apply a theme choice.
 *
 * Two mechanisms on purpose. `data-theme` pins `color-scheme` for this document,
 * which is what makes the switch work in a plain browser. Inside Electron the
 * main process also sets `nativeTheme.themeSource`, which moves the popover, the
 * pairing window and the native window chrome at the same time — none of which a
 * `data-theme` attribute on this one document could reach.
 */
function applyTheme(theme, { repaint = true } = {}) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;

  localStorage.setItem(THEME_KEY, theme);
  globalThis.ledgerShell?.setTheme?.(theme);

  clearPalette();
  renderThemeSwitch();
  // Every chart resolves its colours at draw time, so they only move on a redraw.
  if (repaint) paint();
}

function renderThemeSwitch() {
  const wrap = $('theme-switch');
  if (!wrap) return;
  const active = currentTheme();
  clear(wrap);

  for (const theme of THEMES) {
    const btn = el('button', theme === active ? 'is-active' : '');
    btn.type = 'button';
    btn.title = theme === 'system' ? 'Match the system appearance' : `Always ${theme}`;
    btn.setAttribute('aria-pressed', String(theme === active));

    const icon = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    for (const d of THEME_ICONS[theme]) icon.append(svgEl('path', { d }));
    btn.append(icon, el('span', null, theme === 'system' ? 'Auto' : theme[0].toUpperCase() + theme.slice(1)));

    btn.addEventListener('click', () => {
      if (currentTheme() === theme) return;
      applyTheme(theme);
    });
    wrap.appendChild(btn);
  }
}

// ------------------------------------------------------------------ rendering

function renderRangeSwitch() {
  const wrap = $('range-switch');
  clear(wrap);
  const ranges = state.snapshot?.ranges ?? [
    { id: 'today', label: 'Today' },
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
    { id: 'all', label: 'All time' },
  ];
  for (const r of ranges) {
    const btn = el('button', r.id === state.range ? 'is-active' : '', r.label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(r.id === state.range));
    btn.tabIndex = r.id === state.range ? 0 : -1;
    const select = () => {
      if (state.range === r.id) return;
      state.range = r.id;
      // A zoom window from the old range means nothing in the new one.
      state.zoom = null;
      localStorage.setItem('ledger.range', r.id);
      renderRangeSwitch();
      load();
    };
    btn.addEventListener('click', select);
    // A tablist should be arrow-navigable, not tab-through-every-option.
    btn.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      const i = ranges.findIndex((x) => x.id === state.range);
      const next = ranges[(i + delta + ranges.length) % ranges.length];
      state.range = next.id;
      state.zoom = null;
      localStorage.setItem('ledger.range', next.id);
      renderRangeSwitch();
      $('range-switch').querySelector('button.is-active')?.focus();
      load();
    });
    wrap.appendChild(btn);
  }
}

function renderStats(cards) {
  const grid = $('stat-grid');
  clear(grid);
  for (const c of cards) {
    const card = el('div', 'stat');

    const top = el('div', 'stat-top');
    top.append(el('div', 'stat-label', c.label));
    if (c.delta) {
      top.append(el('div', `stat-delta ${c.delta.positive ? 'up' : 'down'}`, c.delta.text));
    } else {
      top.append(el('div', 'stat-delta', ''));
    }

    const mid = el('div', 'stat-mid');
    const value = el('div', 'stat-value');
    value.append(document.createTextNode(c.value));
    if (c.unit) value.append(el('span', null, ` ${c.unit}`));
    mid.append(value);

    const svg = svgEl('svg', { viewBox: '0 0 100 28', class: 'stat-spark' });
    svg.append(
      svgEl('polyline', {
        points: sparkPoints(c.series),
        fill: 'none',
        stroke: color('--accent'),
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
    mid.append(svg);

    card.append(top, mid, el('div', 'stat-sub', c.sub));
    grid.appendChild(card);
  }
}

/** Per-cell day figures for the heatmap hover, keyed by element. */
const heatDays = new WeakMap();

function positionTip(event) {
  const tip = $('chart-tip');
  tip.hidden = false;
  const rect = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - rect.width - 12, event.clientX + 14)}px`;
  tip.style.top = `${Math.max(8, event.clientY - rect.height - 12)}px`;
}

function hideTip() {
  $('chart-tip').hidden = true;
}

function tipRow(label, value) {
  const row = el('div', 'tip-row');
  row.append(el('span', null, label), el('b', null, value));
  return row;
}

/** Hover a day to read that day's real figures, not just a title attribute. */
function attachHeatHover(cols) {
  const tip = $('chart-tip');
  cols.onmouseleave = hideTip;
  cols.onmousemove = (event) => {
    const cell = event.target.closest('.heat-cell');
    const day = cell ? heatDays.get(cell) : null;
    if (!day) {
      hideTip();
      return;
    }
    clear(tip);
    tip.append(el('div', 'tip-title', day.date));
    tip.append(tipRow('Messages', String(day.messages)));
    tip.append(tipRow('Tokens', day.tokens));
    tip.append(tipRow('API-equiv.', day.cost));
    positionTip(event);
  };
}

function renderActivity(activity) {
  $('heatmap-title').textContent = activity.heatmapTitle;

  const cols = $('heat-cols');
  clear(cols);
  // One flexible track per week, so the grid spans the card and the month labels
  // below can use the identical template and line up exactly.
  const tracks = `repeat(${activity.weeks}, minmax(0, 1fr))`;
  cols.style.gridTemplateColumns = tracks;

  for (const week of activity.heatmap.weeks) {
    const col = el('div', 'heat-col');
    for (const day of week.days) {
      const cell = el('div', 'heat-cell');
      cell.style.background = heatColor(day);
      if (!day.empty) heatDays.set(cell, day);
      col.appendChild(cell);
    }
    cols.appendChild(col);
  }
  attachHeatHover(cols);

  // Place each month label in the grid column its month actually starts in.
  // `col` was already computed server-side and previously ignored, which left the
  // labels evenly spaced and pointing at the wrong weeks.
  const months = $('heat-months');
  clear(months);
  months.style.gridTemplateColumns = tracks;
  for (const m of activity.heatmap.months) {
    const span = el('span', null, m.label);
    span.style.gridColumnStart = String(m.col + 1);
    months.appendChild(span);
  }

  const s = activity.streak;
  const streakValue = $('streak-value');
  clear(streakValue);
  streakValue.append(
    document.createTextNode(String(s.current)),
    el('span', null, s.current === 1 ? ' day' : ' days'),
  );
  $('streak-sub').textContent = s.longest
    ? `Longest: ${s.longest} days${s.longestRange ? ` · ${s.longestRange}` : ''}`
    : 'No streak yet';

  renderMiniGrid($('activity-stats'), [
    ['Active days', String(s.activeDays), null],
    ['Busiest day', activity.busiestWeekday, null],
    ['Best day ever', String(activity.bestDay), 'msgs'],
    ['Avg / active day', String(activity.avgPerActiveDay), 'msgs'],
  ]);
}

function renderMiniGrid(node, rows) {
  clear(node);
  for (const [label, value, unit] of rows) {
    const cell = el('div');
    cell.append(el('div', 'mini-label', label));
    const v = el('div', 'mini-value');
    v.append(document.createTextNode(value));
    if (unit) v.append(el('small', null, ` ${unit}`));
    cell.append(v);
    node.appendChild(cell);
  }
}

/**
 * Which series can be plotted right now: always the two token series, plus one
 * per limit window the account actually reports (5-hour, weekly, Fable, ...).
 */
const HOUR = 3_600_000;

/** How long a limit window lasts, from its kind. */
function windowLength(w) {
  if (w.group === 'session' || w.kind === 'session' || w.key === 'five_hour') return 5 * HOUR;
  return 7 * 86_400_000;
}

/**
 * Fetch reconstructed usage curves for the visible limit series.
 *
 * Recorded readings only begin when this app first ran, so a limit line is mostly
 * empty on a fresh install. The *shape* of the window, though, is recoverable from
 * local transcripts: cumulative cost-weighted usage since the window opened,
 * rescaled so its endpoint equals the measured utilization. That is an estimate —
 * the real weighting is unpublished and usage outside Claude Code is invisible —
 * so it is drawn distinctly and labelled.
 */
async function loadCurves(account) {
  const now = Date.now();
  const wanted = availableSeries(account).filter(
    (sr) => sr.axis === 'percent' && state.visibleSeries.has(sr.id),
  );
  for (const sr of wanted) {
    const w = account?.limits?.windows?.find((x) => x.key === sr.key);
    if (!w?.resetsAt || w.utilization == null) continue;
    const resets = Date.parse(w.resetsAt);
    if (!Number.isFinite(resets)) continue;

    const from = resets - windowLength(w);
    const to = Math.min(now, resets);
    const cacheKey = `${sr.key}:${from}`;
    if (state.curves[cacheKey]?.fetchedFor === state.pulse) continue;

    const params = new URLSearchParams({ from: String(from), to: String(to), points: '160' });
    if (w.scopeModel) params.set('model', w.scopeModel);
    try {
      const data = await (await fetch(`/api/usage-curve?${params}`)).json();
      state.curves[cacheKey] = { ...data, from, to, fetchedFor: state.pulse };
    } catch {
      /* leave previous curve in place */
    }
  }
}

function availableSeries(account) {
  const out = [
    { id: 'input', label: 'Input', axis: 'tokens', color: SERIES_COLORS.input },
    { id: 'output', label: 'Output', axis: 'tokens', color: SERIES_COLORS.output },
  ];
  const windows = account?.limits?.windows ?? [];
  windows
    .filter((w) => w.utilization != null)
    .forEach((w, i) => {
      out.push({
        id: `limit:${w.key}`,
        key: w.key,
        label: w.label.replace(/ Limit$/, '').replace(/^Current /, ''),
        axis: 'percent',
        color: SERIES_COLORS[`limit${i % 3}`],
      });
    });
  return out;
}

function renderSeriesToggle(account) {
  const wrap = $('series-toggle');
  clear(wrap);
  for (const sr of availableSeries(account)) {
    const on = state.visibleSeries.has(sr.id);
    const btn = el('button', `chip${on ? ' is-on' : ''}`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(on));
    const dot = el('i', 'chip-dot');
    // A custom property, not `background` directly: an inline background would
    // out-specify the hollow "off" rule in CSS.
    dot.style.setProperty('--dot', sr.color);
    btn.append(dot, el('span', null, sr.label));
    btn.addEventListener('click', () => {
      if (state.visibleSeries.has(sr.id)) state.visibleSeries.delete(sr.id);
      else state.visibleSeries.add(sr.id);
      // Never leave the chart with nothing on it.
      if (!state.visibleSeries.size) state.visibleSeries.add(sr.id);
      localStorage.setItem('ledger.series', JSON.stringify([...state.visibleSeries]));
      renderSeriesToggle(account);
      renderTrend(state.snapshot.tokens.trend, account);
      // A newly enabled limit series may need its reconstruction fetched.
      loadCurves(account).then(() => renderTrend(state.snapshot.tokens.trend, account));
    });
    wrap.appendChild(btn);
  }
}

/** Fixed chart height; the width is measured per render (see renderTrend). */
const TREND_H = 190;
const TREND_PAD = 8;
/** Right gutter reserved for the percentage axis, only when one is shown. */
const TREND_AXIS_W = 30;
/** Below this share of the axis, a limit window is a level rather than a curve. */
const MIN_WINDOW_FRACTION = 0.25;

/** "a" · "a and b" · "a, b and c" */
function joinLabels(items) {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Linear read of a plotted series (data space) at a time. */
function valueAt(pts, t) {
  if (!pts.length) return null;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i][0] >= t) {
      const [ta, va] = pts[i - 1];
      const [tb, vb] = pts[i];
      return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Geometry for each visible limit window, in data space (time, percent), so the
 * drawing code and the hover readout cannot disagree.
 *
 * Two shapes, chosen by how much of its window the axis actually shows:
 *
 *  - `curve` — the reconstructed trajectory, clipped to the range.
 *  - `level` — the current utilization carried across the axis, stepped through
 *    whatever readings were recorded. Drawn dashed: it is a level, not a history.
 *
 * The `level` fallback is what makes the chart legible at every combination of
 * range and window. A 5-hour window plotted on a 7-day axis is a vertical wall
 * three pixels wide, and a reconstruction that has no matching local usage is
 * nothing at all — the previous version drew a marker per recorded reading in
 * those cases, which came out as a knot of dots in a 1%-wide sliver of the plot
 * with no line joining them.
 *
 * Either shape spans the whole plot width.
 */
function limitPlots(pctSeries, account, t0, t1, now) {
  const span = Math.max(1, t1 - t0);
  return pctSeries
    .map((sr) => {
      const w = account?.limits?.windows?.find((x) => x.key === sr.key);
      if (!w || w.utilization == null) return null;

      const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      const opened = Number.isFinite(resets) ? resets - windowLength(w) : NaN;
      // How much of this window falls inside the visible axis.
      const shown = Number.isFinite(opened)
        ? Math.max(0, Math.min(t1, resets) - Math.max(t0, opened))
        : 0;
      const wide = shown / span >= MIN_WINDOW_FRACTION;
      const curve = Number.isFinite(opened) ? state.curves[`${sr.key}:${opened}`] : null;

      if (wide && curve?.points?.length > 1 && curve.total > 0) {
        const scale = w.utilization / curve.total;
        const pts = curve.points
          .filter((p) => p.t >= t0 && p.t <= t1)
          .map((p) => [p.t, p.c * scale]);
        if (pts.length > 1) {
          // The measured reading is still current, so carry it to the right edge.
          if (pts[pts.length - 1][0] < t1) pts.push([t1, w.utilization]);
          return { sr, kind: 'curve', pts };
        }
      }

      const obs = state.limitHistory
        .filter((r) => r.v[sr.key] != null)
        .map((r) => ({ t: r.t, v: r.v[sr.key] }));
      // The live value is itself an observation, at now.
      if (!obs.length || now - obs[obs.length - 1].t > 30_000) {
        obs.push({ t: Math.min(now, t1), v: w.utilization });
      }
      /*
       * Thin the readings to the axis's own resolution, newest per slot. Twenty
       * readings a minute apart all land inside one percent of a 7-day axis, where
       * the steps between them read as a squiggle of noise beside the marker.
       */
      const minGap = span / 200;
      // Readings taken before this window opened belong to the previous one, and
      // stepping through them would draw a reset as a real drop in usage.
      const floor = Math.max(t0, Number.isFinite(opened) ? opened : t0);
      const kept = [];
      for (const o of obs) {
        if (o.t < floor || o.t > t1) continue;
        if (kept.length && o.t - kept[kept.length - 1].t < minGap) kept[kept.length - 1] = o;
        else kept.push(o);
      }
      // Step-after through the readings, held out to both edges.
      const pts = [[t0, (kept[0] ?? obs[obs.length - 1]).v]];
      for (const o of kept) pts.push([o.t, pts[pts.length - 1][1]], [o.t, o.v]);
      pts.push([t1, pts[pts.length - 1][1]]);
      return { sr, kind: 'level', pts, why: wide ? 'unmatched' : 'short' };
    })
    .filter(Boolean);
}

/** Footnote explaining how each limit line was arrived at. */
function trendNoteFor(plots) {
  const parts = [];
  const curved = plots.filter((p) => p.kind === 'curve').map((p) => p.sr.label);
  const short = plots.filter((p) => p.why === 'short').map((p) => p.sr.label);
  const unmatched = plots.filter((p) => p.why === 'unmatched').map((p) => p.sr.label);

  if (curved.length) {
    parts.push(
      `${joinLabels(curved)}: the shaded area is reconstructed from your local transcripts — cost-weighted usage since the window opened, scaled to the current reading. An estimate, since the real weighting is unpublished and usage outside Claude Code is invisible here.`,
    );
  }
  if (short.length) {
    parts.push(
      `${joinLabels(short)}: dashed, because that window is short next to this range — the line is the current reading held across the axis, not a history.`,
    );
  }
  if (unmatched.length) {
    parts.push(
      `${joinLabels(unmatched)}: dashed, because no local usage matches that window, so only the current reading is known.`,
    );
  }
  if (state.limitHistory.length) {
    const since = new Date(state.limitHistory[0].t).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    parts.push(
      `${state.limitHistory.length} reading${state.limitHistory.length === 1 ? '' : 's'} recorded since ${since}.`,
    );
  }
  return parts.join(' ');
}

/**
 * Token flow and limit utilization on one time axis.
 *
 * x is real time, not bucket index, so token buckets and limit readings (which
 * arrive at arbitrary moments) can share the plot. Tokens scale to the left axis;
 * percentages use a fixed 0-100 right axis.
 */
function renderTrend(trend, account) {
  const svg = $('trend-chart');
  const labels = $('trend-labels');
  const note = $('trend-note');
  clear(svg);
  clear(labels);

  const n = trend.input.length;
  if (!n) return;

  /*
   * The viewBox tracks the element's real width rather than a fixed 640.
   *
   * With a fixed viewBox and preserveAspectRatio="none", every x coordinate was
   * scaled by up to 1.5x on a wide window: the axis text came out horizontally
   * stretched and the round markers came out as ellipses.
   */
  const H = TREND_H;
  const PAD = TREND_PAD;
  const W = Math.max(320, Math.round(svg.getBoundingClientRect().width || 640));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const now = Date.now();
  const active = availableSeries(account).filter((sr) => state.visibleSeries.has(sr.id));
  const tokenSeries = active.filter((sr) => sr.axis === 'tokens');
  const pctSeries = active.filter((sr) => sr.axis === 'percent');
  const right = W - PAD - (pctSeries.length ? TREND_AXIS_W : 0);

  /*
   * The selected range owns the x-domain, and the axis never runs past now.
   *
   * Stretching it to a limit window's reset time — which is what this did — pushed
   * the axis days into the future: enabling a weekly window on the 7-day view
   * widened the domain to 11 days, squashed the token curve into the left half and
   * left the remainder as a dead grey block. Limit series are clipped to the range
   * instead, and a window too short to plot against it becomes a level line.
   */
  const full0 = trend.stamps[0];
  const full1 = Math.max(
    full0 + 1,
    Math.min(trend.stamps[n - 1] + (trend.bucketMs || 0), now),
  );
  const view = zoomWindow(trend, full0, full1);
  const { t0, t1 } = view;
  const span = t1 - t0;
  // No clamping: out-of-window geometry is cut by the plot clip below, so a zoomed
  // edge shows a real partial segment instead of a spike pinned to the boundary.
  const xOf = (t) => PAD + ((t - t0) / span) * (right - PAD);
  const tOf = (x) => t0 + ((Math.min(right, Math.max(PAD, x)) - PAD) / (right - PAD)) * span;

  /*
   * Buckets inside the window, plus one either side so the line enters and leaves
   * the plot rather than stopping a bucket short of each edge.
   */
  const step = trend.bucketMs || 1;
  const lo = Math.max(0, Math.floor((t0 - full0) / step) - 1);
  const hi = Math.min(n - 1, Math.ceil((t1 - full0) / step) + 1);

  // Scaled to what is on screen, so zooming in resolves detail instead of leaving
  // it flattened against a peak that is no longer in view.
  const tokenMax =
    Math.max(
      1,
      ...tokenSeries.flatMap((sr) =>
        (sr.id === 'input' ? trend.input : trend.output).slice(lo, hi + 1),
      ),
    ) * 1.15;
  const yTokens = (v) => H - PAD - (v / tokenMax) * (H - PAD * 2);
  const yPct = (v) => H - PAD - (Math.min(100, Math.max(0, v)) / 100) * (H - PAD * 2);

  // Gridlines follow the percentage scale whenever one is shown, so the lines and
  // the right-hand labels coincide. The labels sit in a reserved gutter rather than
  // on top of the plot, where they used to overprint the data.
  if (pctSeries.length) {
    for (const pct of [0, 25, 50, 75, 100]) {
      const y = yPct(pct);
      svg.append(
        svgEl('line', { x1: 0, y1: y, x2: right, y2: y, stroke: color('--line'), 'stroke-width': 1 }),
      );
      const label = svgEl('text', {
        x: right + 5,
        y: Math.min(H - 2, Math.max(9, y + 3)),
        fill: color('--ink-4'),
        'font-size': 9,
      });
      label.textContent = `${pct}%`;
      svg.append(label);
    }
  } else {
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = PAD + frac * (H - PAD * 2);
      svg.append(
        svgEl('line', { x1: 0, y1: y, x2: right, y2: y, stroke: color('--line'), 'stroke-width': 1 }),
      );
    }
  }

  const pathFrom = (points) =>
    points.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

  // Every data mark lives in a clipped layer, so a zoomed window can run its lines
  // off both edges without spilling over the percentage gutter.
  const clip = svgEl('clipPath', { id: 'trend-clip' });
  clip.append(svgEl('rect', { x: 0, y: 0, width: right, height: H }));
  const defs = svgEl('defs', {});
  defs.append(clip);
  const plot = svgEl('g', { 'clip-path': 'url(#trend-clip)' });
  svg.append(defs, plot);

  for (const sr of tokenSeries) {
    const values = sr.id === 'input' ? trend.input : trend.output;
    const pts = [];
    for (let i = lo; i <= hi; i += 1) pts.push([xOf(trend.stamps[i]), yTokens(values[i])]);
    if (pts.length < 2) continue;
    if (tokenSeries.length === 1 || sr.id === 'input') {
      plot.append(
        svgEl('path', {
          d: `${pathFrom(pts)} L ${pts[pts.length - 1][0].toFixed(1)} ${H - PAD} L ${pts[0][0].toFixed(1)} ${H - PAD} Z`,
          fill: sr.color,
          opacity: 0.13,
        }),
      );
    }
    plot.append(
      svgEl('path', {
        d: pathFrom(pts),
        fill: 'none',
        stroke: sr.color,
        'stroke-width': 2.2,
        'stroke-linejoin': 'round',
      }),
    );
  }

  const plots = limitPlots(pctSeries, account, t0, t1, now);
  for (const line of plots) {
    const pts = line.pts.map(([t, v]) => [xOf(t), yPct(v)]);
    if (line.kind === 'curve') {
      plot.append(
        svgEl('path', {
          d: `${pathFrom(pts)} L ${pts[pts.length - 1][0].toFixed(1)} ${yPct(0)} L ${pts[0][0].toFixed(1)} ${yPct(0)} Z`,
          fill: line.sr.color,
          opacity: 0.1,
        }),
      );
    }
    plot.append(
      svgEl('path', {
        d: pathFrom(pts),
        fill: 'none',
        stroke: line.sr.color,
        'stroke-width': line.kind === 'curve' ? 2 : 1.6,
        'stroke-linejoin': 'round',
        opacity: line.kind === 'curve' ? 0.9 : 0.8,
        ...(line.kind === 'curve' ? {} : { 'stroke-dasharray': '5 4' }),
      }),
    );
    // One marker, on the current value, so the live level is findable without
    // scattering a dot per recorded reading across the plot.
    const end = pts[pts.length - 1];
    plot.append(
      svgEl('circle', {
        cx: end[0].toFixed(1),
        cy: end[1].toFixed(1),
        r: 3.2,
        fill: line.sr.color,
        stroke: color('--card'),
        'stroke-width': 1.4,
      }),
    );
  }

  /*
   * Ticks are generated from the domain, not from the token buckets: deriving them
   * from buckets meant the labels stopped wherever the token data stopped.
   */
  // Zooming into a few hours of a multi-day range makes a bare "9:15 PM" ambiguous,
  // so the date comes along — and the tick count drops, since the longer labels
  // would otherwise collide.
  const spansDays = full1 - full0 > 36 * HOUR;
  const withinDay = span <= 36 * HOUR;
  const tickFmt = withinDay
    ? spansDays
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { hour: 'numeric', minute: '2-digit' }
    : span <= 8 * 86_400_000
      ? { weekday: 'short', hour: 'numeric' }
      : { month: 'short', day: 'numeric' };
  const ticks = withinDay && spansDays ? 3 : 5;
  for (let i = 0; i <= ticks; i += 1) {
    const t = t0 + (span * i) / ticks;
    const tick = el('span', null, new Date(t).toLocaleString(undefined, tickFmt));
    tick.style.left = `${((xOf(t) / W) * 100).toFixed(2)}%`;
    tick.style.transform =
      i === 0 ? 'none' : i === ticks ? 'translateX(-100%)' : 'translateX(-50%)';
    labels.appendChild(tick);
  }

  note.textContent = plots.length ? trendNoteFor(plots) : '';

  const reset = $('trend-reset');
  reset.hidden = !state.zoom;
  reset.onclick = () => {
    state.zoom = null;
    renderTrend(trend, account);
  };

  attachTrendHover(svg, trend, { W, H, xOf, tOf, yTokens, yPct, tokenSeries, plots });
  attachTrendZoom(svg, trend, account, {
    W,
    right,
    t0,
    t1,
    span,
    full0,
    full1,
    fullSpan: view.fullSpan,
    minSpan: view.minSpan,
    tOf,
  });
}

/**
 * The visible slice of the range's domain, after any wheel zoom.
 *
 * Clamped on read rather than on write, because a zoom outlives both a data refresh
 * (which moves `full1` forward every few seconds) and a range switch, and has to
 * land somewhere sensible either way.
 */
function zoomWindow(trend, full0, full1) {
  const fullSpan = full1 - full0;
  // Never below what the buckets can resolve — four of them.
  const minSpan = Math.min(fullSpan, Math.max(4 * (trend.bucketMs || 60_000), 60_000));
  const whole = { t0: full0, t1: full1, fullSpan, minSpan };
  if (!state.zoom) return whole;

  const want = Math.min(fullSpan, Math.max(minSpan, state.zoom.to - state.zoom.from));
  if (want >= fullSpan) {
    state.zoom = null;
    return whole;
  }
  const t0 = Math.min(Math.max(full0, state.zoom.from), full1 - want);
  state.zoom = { from: t0, to: t0 + want };
  return { t0, t1: t0 + want, fullSpan, minSpan };
}

/**
 * Wheel to zoom the time axis about the cursor, horizontal wheel (or shift-wheel)
 * to pan, double-click or the Reset button to go back to the whole range.
 *
 * The wheel is only swallowed while a zoom is in play. At full extent a further
 * zoom-out falls through to the document, so a chart sitting in the middle of a
 * scrolling page never traps the scroll of the page.
 */
function attachTrendZoom(svg, trend, account, ctx) {
  let queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderTrend(trend, account);
    });
  };

  /** Store a window, clamped into the range. Reports whether anything moved. */
  const apply = (from, to) => {
    const want = Math.min(ctx.fullSpan, Math.max(ctx.minSpan, to - from));
    if (want >= ctx.fullSpan) {
      if (!state.zoom) return false;
      state.zoom = null;
      return true;
    }
    const start = Math.min(Math.max(ctx.full0, from), ctx.full1 - want);
    const prev = state.zoom;
    if (prev && Math.abs(prev.from - start) < 1 && Math.abs(prev.to - prev.from - want) < 1) {
      return false;
    }
    state.zoom = { from: start, to: start + want };
    return true;
  };

  // deltaY arrives in lines or pages on some devices, not pixels.
  const px = (d, mode) => d * (mode === 1 ? 16 : mode === 2 ? 100 : 1);

  // Property assignment, not addEventListener: renderTrend runs on every refresh and
  // listeners would otherwise stack up on the same persistent <svg>.
  svg.onwheel = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const dy = px(event.deltaY, event.deltaMode);
    const dx = px(event.deltaX, event.deltaMode);

    let changed;
    if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const shift = ((event.shiftKey ? dy : dx) / (ctx.right - TREND_PAD)) * ctx.span;
      changed = apply(ctx.t0 + shift, ctx.t1 + shift);
    } else {
      const want = ctx.span * Math.exp(dy * 0.002);
      const at = ctx.tOf(((event.clientX - rect.left) / rect.width) * ctx.W);
      const frac = ctx.span ? (at - ctx.t0) / ctx.span : 0.5;
      changed = apply(at - frac * want, at + (1 - frac) * want);
    }

    if (!changed && !state.zoom) return;
    event.preventDefault();
    if (changed) redraw();
  };

  svg.ondblclick = () => {
    if (!state.zoom) return;
    state.zoom = null;
    redraw();
  };
}

/** Hover readout: every visible series at the nearest bucket. */
function attachTrendHover(svg, trend, ctx) {
  const tip = $('chart-tip');
  const n = trend.input.length;

  const guide = svgEl('line', {
    y1: TREND_PAD,
    y2: ctx.H - TREND_PAD,
    stroke: color('--line-strong'),
    'stroke-width': 1,
    'stroke-dasharray': '2 3',
    visibility: 'hidden',
  });
  svg.append(guide);

  // One reusable marker per visible series, so the readout points at the lines
  // instead of leaving the reader to work out which is which.
  const series = [...ctx.tokenSeries, ...ctx.plots.map((p) => p.sr)];
  const dots = series.map((sr) => {
    const dot = svgEl('circle', {
      r: 3,
      fill: color('--card'),
      stroke: sr.color,
      'stroke-width': 2,
      visibility: 'hidden',
    });
    svg.append(dot);
    return dot;
  });

  const hide = () => {
    tip.hidden = true;
    guide.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
  };

  // Property assignment, not addEventListener: renderTrend runs on every refresh
  // and listeners would otherwise stack up on the same persistent <svg>.
  svg.onmouseleave = hide;
  svg.onmousemove = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !n) return;
    /*
     * Cursor -> time -> bucket, through the same mapping the plot uses. Taking the
     * bucket straight from the cursor's fraction of the element (as this did) is
     * wrong the moment the plot is inset from the element edge: the guide drifted
     * from the pointer by the width of the axis gutter.
     */
    const at = trend.stamps[
      Math.max(
        0,
        Math.min(
          n - 1,
          Math.round((ctx.tOf(((event.clientX - rect.left) / rect.width) * ctx.W) - trend.stamps[0]) / (trend.bucketMs || 1)),
        ),
      )
    ];
    const gx = ctx.xOf(at);

    guide.setAttribute('x1', gx.toFixed(1));
    guide.setAttribute('x2', gx.toFixed(1));
    guide.setAttribute('visibility', 'visible');

    clear(tip);
    const perDay = (trend.bucketMs || 0) >= 86_400_000;
    tip.append(
      el(
        'div',
        'tip-title',
        new Date(at).toLocaleString(undefined,
          perDay
            ? { weekday: 'short', month: 'short', day: 'numeric' }
            : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      ),
    );

    const i = trend.stamps.indexOf(at);
    let d = 0;
    const readout = (sr, text, y) => {
      const row = el('div', 'tip-row');
      const swatch = el('i', 'swatch');
      swatch.style.background = sr.color;
      row.append(swatch, el('span', null, sr.label), el('b', null, text));
      tip.append(row);
      const dot = dots[d];
      d += 1;
      dot.setAttribute('cx', gx.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('visibility', 'visible');
    };

    for (const sr of ctx.tokenSeries) {
      const v = (sr.id === 'input' ? trend.input : trend.output)[i];
      readout(sr, fmt(v), ctx.yTokens(v));
    }
    // Read the drawn geometry rather than re-deriving from history, so the number
    // in the tooltip is the one the line shows.
    for (const plot of ctx.plots) {
      const v = valueAt(plot.pts, at);
      readout(plot.sr, v == null ? '—' : `${v.toFixed(0)}%`, ctx.yPct(v ?? 0));
    }

    positionTip(event);
  };
}

function renderModels(tokens) {
  $('donut-total').textContent = tokens.totalMessages;

  const models = tokens.models;
  const donut = $('donut');
  if (!models.length) {
    donut.style.background = 'var(--track)';
  } else {
    let acc = 0;
    const stops = models.map((m) => {
      const from = acc;
      acc += m.share;
      return `${modelColor(m)} ${from.toFixed(2)}% ${acc.toFixed(2)}%`;
    });
    donut.style.background = `conic-gradient(${stops.join(', ')})`;
  }

  const legend = $('donut-legend');
  clear(legend);
  for (const m of models.slice(0, 5)) {
    const row = el('div', 'legend-row');
    const sw = el('span', 'legend-swatch');
    sw.style.background = modelColor(m);
    row.append(sw, el('span', 'legend-name', m.name), el('span', 'legend-pct', `${m.share.toFixed(0)}%`));
    legend.appendChild(row);
  }

  const rows = $('model-rows');
  clear(rows);
  if (!models.length) {
    rows.appendChild(el('div', 'empty-note', 'No model activity in this range.'));
  }
  for (const m of models) {
    const tr = el('div', 'tr');

    const name = el('div', 'cell-name');
    const dot = el('span', 'model-dot');
    dot.style.background = modelColor(m);
    name.append(dot, el('span', null, m.name + (m.estimated ? ' *' : '')));

    tr.append(
      name,
      el('div', 'num', fmt(m.messages)),
      el('div', 'num', fmt(m.tokensIn)),
      el('div', 'num', fmt(m.tokensOut)),
      el('div', 'num muted', fmt(m.avgOut)),
      el('div', 'num', money(m.cost)),
    );

    const barCell = el('div');
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${Math.max(1, m.share).toFixed(1)}%`;
    fill.style.background = modelColor(m);
    bar.append(fill);
    barCell.append(bar);
    tr.append(barCell);

    rows.appendChild(tr);
  }

  const note = $('pricing-note');
  note.hidden = !tokens.hasEstimatedPricing;
  note.textContent =
    '* Public list price not published for this model; costed at its tier rate. API-equivalent cost is what this usage would bill on the API — your Max subscription is flat-rate, so you are not charged this.';
}

function renderWorkload(cards) {
  const grid = $('workload-grid');
  clear(grid);
  for (const c of cards) {
    const card = el('div', 'workload-card');

    const head = el('div', 'workload-head');
    head.append(el('div', 'workload-name', c.name), el('div', 'workload-pct', `${c.pct.toFixed(0)}%`));

    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = c.pctW;
    fill.style.background = color('--accent');
    bar.append(fill);

    const rows = el('div', 'workload-rows');
    for (const [label, value] of c.rows) {
      const row = el('div');
      row.append(el('span', null, label), el('b', null, value));
      rows.append(row);
    }
    const totalRow = el('div');
    totalRow.append(el('span', null, 'Tokens'), el('b', null, c.tokens));
    rows.append(totalRow);

    card.append(head, bar, rows);
    grid.appendChild(card);
  }
}

function renderTools(tools) {
  const card = $('tools-card');
  clear(card);
  if (!tools.length) {
    card.appendChild(el('div', 'empty-note', 'No tool calls in this range.'));
    return;
  }
  tools.forEach((t, i) => {
    const row = el('div', 'tool-row');
    const name = el('div', 'tool-name', t.name);
    name.title = t.name;
    const bar = el('div', 'tool-bar');
    const fill = el('i');
    fill.style.width = t.pct;
    fill.style.background = toolColor(i);
    bar.append(fill);
    row.append(name, bar, el('div', 'tool-count', fmt(t.count)));
    card.appendChild(row);
  });
}

function renderSessions(sessions) {
  renderMiniGrid($('session-stats'), [
    ['Sessions', String(sessions.count), null],
    ['Avg length', sessions.avgLength, null],
    ['Longest', sessions.longest, null],
    ['Peak hour', sessions.peakHour, null],
  ]);

  const bars = $('hour-bars');
  clear(bars);
  // The payload's `color` is a light-theme hex; the height it ships alongside is
  // the real signal, so the shade is re-derived from that instead.
  const heights = sessions.hourBars.map((h) => Number.parseFloat(h.height) || 0);
  const tallest = Math.max(1, ...heights);
  sessions.hourBars.forEach((h, i) => {
    const bar = el('div');
    bar.style.height = h.height;
    const ratio = heights[i] / tallest;
    bar.style.background =
      ratio >= 0.85 ? color('--accent-dark') : ratio >= 0.4 ? color('--heat-2') : color('--track-strong');
    bar.title = h.tip;
    bars.appendChild(bar);
  });
}

function sortProjects(projects) {
  const { key, dir } = state.projectSort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...projects].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * sign;
    }
    return ((av ?? 0) - (bv ?? 0)) * sign;
  });
}

function renderProjectHead() {
  for (const btn of document.querySelectorAll('#project-head .sort')) {
    const active = btn.dataset.sort === state.projectSort.key;
    btn.classList.toggle('is-sorted', active);
    btn.setAttribute(
      'aria-sort',
      active ? (state.projectSort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
    );
  }
}

function renderProjects(projects) {
  const rows = $('project-rows');
  clear(rows);
  renderProjectHead();
  projects = sortProjects(projects);
  if (!projects.length) {
    rows.appendChild(el('div', 'empty-note', 'No project activity in this range.'));
    return;
  }
  projects.forEach((p, i) => {
    const tr = el('div', 'tr');

    const name = el('div', 'cell-name');
    const label = el('span', null, p.name);
    if (p.cwd) label.title = p.cwd;
    name.append(label);

    const tagCell = el('div');
    const tag = el('span', 'tag', p.model);
    applyTag(tag, i);
    tagCell.append(tag);

    tr.append(
      name,
      tagCell,
      el('div', 'num', String(p.sessions)),
      el('div', 'num', String(p.messages)),
      el('div', 'num', p.tokens),
      el('div', 'num', p.cost),
      el('div', 'num muted', p.last),
    );
    rows.appendChild(tr);
  });
}

function renderFeed(feed) {
  const card = $('feed-card');
  clear(card);
  if (!feed.length) {
    card.appendChild(el('div', 'empty-note', 'Nothing in this range yet.'));
    return;
  }
  feed.forEach((f, i) => {
    const row = el('div', 'feed-row');
    const tag = el('span', 'tag', f.surface);
    applyTag(tag, i);

    const body = el('div', 'feed-body');
    const title = el('div', 'feed-title', f.title);
    title.title = f.title;
    body.append(title, el('div', 'feed-meta', f.meta));

    row.append(tag, body, el('div', 'feed-time', f.time));
    card.appendChild(row);
  });
}

function renderBadges(badges) {
  const grid = $('badge-grid');
  clear(grid);
  for (const b of badges) {
    const card = el('div', `badge${b.earned ? '' : ' locked'}`);
    card.append(el('div', 'badge-icon', b.icon));
    const body = el('div');
    body.append(el('div', 'badge-name', b.name), el('div', 'badge-desc', b.desc));
    card.append(body);
    grid.appendChild(card);
  }
}

/** Series colours for limit windows, by position. */
const WINDOW_VARS = ['--series-input', '--series-output', '--series-limit0', '--ink-4'];

function windowColor(i) {
  return color(WINDOW_VARS[i % WINDOW_VARS.length]);
}

/** The three (or more) limit cards at the top of the page. */
function renderLimitStrip(account) {
  const strip = $('limit-strip');
  const note = $('limits-note');
  clear(strip);

  if (account?.status !== 'connected' || !account.limits) {
    if (account?.status === 'connected') {
      const retry = account.retryInMs
        ? ` Retrying in about ${Math.ceil(account.retryInMs / 60_000)} minutes.`
        : '';
      note.textContent = `Connected, but the usage endpoint did not answer.${retry} Every other panel is local and unaffected.`;
    } else {
      note.textContent = 'Connect your Claude account to read live rate-limit windows.';
    }
    strip.appendChild(el('div', 'empty-note', 'No live limit data.'));
    return;
  }

  account.limits.windows.forEach((w, i) => {
    const reported = w.utilization != null;
    const card = el('div', `limit-card${reported ? '' : ' is-unreported'}`);

    const head = el('div', 'limit-head');
    head.append(el('div', 'limit-name', w.label));
    if (w.isActive) head.append(el('span', 'live-dot', ''));
    card.append(head);

    const big = el('div', 'limit-figure');
    if (reported) {
      big.append(document.createTextNode(w.utilization.toFixed(0)));
      big.append(el('span', null, '%'));
    } else {
      big.append(el('span', 'limit-none', 'not reported'));
    }
    card.append(big);

    const track = el('div', 'limit-track');
    if (reported) {
      const fill = el('i');
      fill.style.width = `${Math.min(100, Math.max(0.8, w.utilization))}%`;
      fill.style.background = w.utilization >= 75 ? color('--hot') : windowColor(i);
      track.append(fill);
    }
    card.append(track);
    card.append(el('div', 'limit-sub', reported ? resetLabel(w.resetsAt) : 'Not tracked on this plan'));
    strip.appendChild(card);
  });

  if (account.limitsStale) {
    const age = account.limitsFetchedAt
      ? Math.max(1, Math.round((Date.now() - account.limitsFetchedAt) / 60_000))
      : null;
    note.textContent = `Cached${age ? ` ${age} minutes ago` : ''} — a live refresh is currently rate limited, so these are last-known rather than missing.`;
  } else {
    note.textContent =
      'Live from your Claude account — the same windows the Claude apps enforce. Everything below is computed from local transcripts.';
  }
}

function resetLabel(iso) {
  if (!iso) return 'Reset time unavailable';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'Reset time unavailable';
  const diff = ts - Date.now();
  if (diff <= 0) return 'Resetting now';
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.round((diff % 3_600_000) / 60_000);
  if (hours >= 24) {
    return `Resets ${new Date(ts).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}`;
  }
  return `Resets in ${hours > 0 ? `${hours}h ` : ''}${mins}m`;
}

// -------------------------------------------------------------- account card

function renderAccount(account) {
  const card = $('account-card');
  clear(card);
  card.className = 'account-card';

  if (!account || account.status === 'missing' || account.status === 'expired') {
    card.classList.add('is-problem');
    const row = el('div', 'account-row');
    row.append(el('span', 'dot warn'), el('div', 'account-name', 'Not connected'));
    card.append(row);
    card.append(
      el(
        'div',
        'account-meta',
        account?.status === 'expired'
          ? 'Your Claude Code login has expired. Run any claude command to refresh it, then reconnect.'
          : 'No Claude Code login found on this machine. Run claude in a terminal and sign in with your Claude account, then connect.',
      ),
    );
    card.append(connectButton('Connect Claude account'));
    return;
  }

  if (account.status === 'error') {
    card.classList.add('is-problem');
    const row = el('div', 'account-row');
    row.append(el('span', 'dot warn'), el('div', 'account-name', 'Account unreachable'));
    card.append(row, el('div', 'account-meta', account.error ?? 'Unknown error'));
    card.append(connectButton('Retry'));
    return;
  }

  card.classList.add('is-connected');
  const a = account.account;
  const row = el('div', 'account-row');
  row.append(el('span', 'dot ok'), el('div', 'account-name', a?.displayName ?? 'Connected'));
  card.append(row);
  if (a?.email) card.append(el('div', 'account-meta', a.email));

  const plan = a?.hasMax ? 'Claude Max' : a?.hasPro ? 'Claude Pro' : (account.subscriptionType ?? 'Claude');
  card.append(el('div', 'plan-badge', plan));

  if (a?.rateLimitTier) {
    card.append(el('div', 'account-meta', `Tier: ${a.rateLimitTier.replace(/_/g, ' ')}`));
  }
  card.append(connectButton('Refresh'));
}

function connectButton(label) {
  const btn = el('button', label === 'Refresh' ? 'btn' : 'btn primary', label);
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      const res = await fetch('/api/reconnect', { method: 'POST' });
      state.account = await res.json();
      renderAccount(state.account);
      renderLimits(state.account);
      renderBanner();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      showBanner(`Could not reach the local server: ${err.message}`);
    }
  });
  return btn;
}

function renderBanner() {
  const banner = $('banner');
  const account = state.account;
  const snapshot = state.snapshot;

  if (snapshot?.empty) {
    banner.hidden = false;
    clear(banner);
    banner.append(
      document.createTextNode('No Claude Code transcripts found under '),
      el('code', null, snapshot.meta.dir),
      document.createTextNode(
        '. Every panel except Usage limits is computed from those files, so the dashboard has nothing to show yet. Use Claude Code once and reload.',
      ),
    );
    return;
  }

  if (account && account.status !== 'connected') {
    banner.hidden = false;
    clear(banner);
    if (account.status === 'expired') {
      banner.append(
        document.createTextNode('Your stored Claude login has expired. Run '),
        el('code', null, 'claude'),
        document.createTextNode(
          ' in a terminal — it refreshes the credential in place — then press Connect. Local history below is unaffected.',
        ),
      );
    } else if (account.status === 'missing') {
      banner.append(
        document.createTextNode('Not connected to your Claude account. Run '),
        el('code', null, 'claude'),
        document.createTextNode(
          ' and sign in with your Claude subscription; this app reads that existing login rather than asking for a password or API key. Usage limits stay empty until then.',
        ),
      );
    } else {
      banner.append(
        document.createTextNode(`Claude account unreachable: ${account.error ?? 'unknown error'}.`),
      );
    }
    return;
  }

  banner.hidden = true;
}

function showBanner(text) {
  const banner = $('banner');
  banner.hidden = false;
  clear(banner);
  banner.textContent = text;
}


// ---------------------------------------------------------------- formatting

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n / 1e6 >= 100 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n / 1e3 >= 100 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function money(n) {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

// --------------------------------------------------------------------- load

async function load() {
  try {
    const res = await fetch(`/api/snapshot?range=${encodeURIComponent(state.range)}&weeks=${state.weeks}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.snapshot = data.snapshot;
    state.account = data.account;
    state.version = data.app?.version ?? null;

    // Limit lines need the recorded utilization series.
    try {
      const h = await (await fetch('/api/history')).json();
      state.limitHistory = h.readings ?? [];
    } catch {
      state.limitHistory = [];
    }
  } catch (err) {
    showBanner(`Failed to load data: ${err.message}`);
    return;
  }

  paint();
}

/**
 * Redraw everything from the state already in memory.
 *
 * Split out of load() because a theme change has to repaint — every SVG carries
 * literal colours resolved at draw time — and refetching the whole snapshot to
 * change a colour would be absurd.
 */
function paint() {
  const s = state.snapshot;
  if (!s) return;

  const today = new Date(s.generatedAt).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  $('page-sub').textContent = `${today} · every message, token and streak from your local Claude Code history`;
  $('trend-range').textContent = s.rangeLabel;
  $('mix-range').textContent = s.rangeLabel;
  $('source-note').textContent = [
    `${s.meta.files} transcripts · ${s.meta.sizeLabel}`,
    s.meta.firstActivity ? `since ${s.meta.firstActivity}` : null,
    state.version ? `Ledger v${state.version}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  renderStats(s.statCards);
  renderActivity(s.activity);
  renderSeriesToggle(state.account);
  renderTrend(s.tokens.trend, state.account);
  loadCurves(state.account).then(() => renderTrend(s.tokens.trend, state.account));
  renderModels(s.tokens);
  renderWorkload(s.workload);
  renderTools(s.tools);
  renderSessions(s.sessions);
  renderProjects(s.projects);
  renderFeed(s.feed);
  renderBadges(s.badges);
  renderAccount(state.account);
  renderLimitStrip(state.account);
  renderBanner();
  renderRangeSwitch();
  // Rendering changes the page height, which moves every section boundary.
  refreshNavHighlight?.();
}

/** A section becomes active once its top crosses this fraction of the viewport. */
const NAV_LINE_RATIO = 0.4;
/** Upper bound on trailing whitespace added to buy scroll room for the tail. */
const NAV_MAX_SPACER = 140;

/**
 * Highlight the nav entry for whichever section is in view.
 *
 * Two things make the naive versions of this wrong, and both were bugs here:
 *
 *  - An IntersectionObserver with a narrow rootMargin band never fires for the
 *    final section, because the page runs out of scroll before that section can
 *    reach the band. The previous entry stays lit forever.
 *  - Special-casing "scrolled to the bottom -> last section" fixes that one
 *    entry but starves the second-to-last: Achievements and Usage limits
 *    together are shorter than a viewport, so Achievements' turn is swallowed by
 *    the bottom case the moment it begins.
 *
 * So each section gets an explicit activation threshold — the scroll position at
 * which it takes over. Mid-page sections use the natural value (their top
 * reaching the line). The tail sections, whose natural thresholds sit past the
 * end of the document, get those thresholds remapped: the leftover scroll is
 * divided evenly among them so each still gets a usable window. Padding the page
 * out far enough to avoid the remap entirely also works, but costs several
 * hundred pixels of dead space at the bottom — so the spacer here is capped and
 * the remap does the rest.
 */
function setupNavHighlight() {
  const entries = [...document.querySelectorAll('#nav a')]
    .map((link) => ({ link, section: document.querySelector(link.getAttribute('href')) }))
    .filter((e) => e.section);
  if (!entries.length) return () => {};

  const main = document.querySelector('.main');
  const spacer = el('div', 'scroll-spacer');
  spacer.setAttribute('aria-hidden', 'true');
  main.appendChild(spacer);

  const setActive = (link) => {
    for (const e of entries) {
      const active = e.link === link;
      e.link.classList.toggle('is-active', active);
      if (active) e.link.setAttribute('aria-current', 'true');
      else e.link.removeAttribute('aria-current');
    }
  };

  // Buy back a little scroll room for the tail, capped so it reads as ordinary
  // bottom padding rather than a void.
  const sizeSpacer = () => {
    const lastHeight = entries[entries.length - 1].section.getBoundingClientRect().height;
    const padBottom = Number.parseFloat(getComputedStyle(main).paddingBottom) || 0;
    const need = window.innerHeight * (1 - NAV_LINE_RATIO) - lastHeight - padBottom;
    spacer.style.height = `${Math.min(NAV_MAX_SPACER, Math.max(0, Math.round(need)))}px`;
  };

  /** Scroll offset at which each section takes over, in document coordinates. */
  const thresholds = () => {
    const lineOffset = window.innerHeight * NAV_LINE_RATIO;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const natural = entries.map((e) =>
      Math.max(0, e.section.getBoundingClientRect().top + window.scrollY - lineOffset),
    );

    // Sections whose natural threshold lies past the end of the document can
    // never activate on their own. Find where that tail starts.
    let tailStart = natural.length;
    while (tailStart > 0 && natural[tailStart - 1] > maxScroll) tailStart -= 1;
    if (tailStart >= natural.length) return natural;

    const lower = tailStart > 0 ? natural[tailStart - 1] : 0;
    const tailCount = natural.length - tailStart;
    // +1 share so the final section keeps a window of its own rather than
    // activating only at the exact last pixel.
    const step = Math.max(0, maxScroll - lower) / (tailCount + 1);
    for (let i = tailStart; i < natural.length; i += 1) {
      natural[i] = lower + step * (i - tailStart + 1);
    }
    return natural;
  };

  // A click wins immediately and holds while the smooth scroll animates,
  // otherwise the scroll handler overrides the user's choice mid-flight.
  let lockUntil = 0;
  for (const e of entries) {
    e.link.addEventListener('click', () => {
      setActive(e.link);
      lockUntil = Date.now() + 900;
    });
  }

  const update = () => {
    document.body.classList.toggle('is-scrolled', window.scrollY > 6);
    if (Date.now() < lockUntil) return;

    const at = thresholds();
    let current = entries[0];
    for (let i = 0; i < entries.length; i += 1) {
      if (window.scrollY >= at[i]) current = entries[i];
    }
    setActive(current.link);
  };

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };

  // Re-measure only when the layout can actually have changed — never per frame.
  const refresh = () => {
    sizeSpacer();
    update();
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', refresh);
  refresh();
  return refresh;
}

renderRangeSwitch();
const refreshNavHighlight = setupNavHighlight();

// Sorting is client-side: the snapshot already carries raw numeric fields.
for (const btn of document.querySelectorAll('#project-head .sort')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    state.projectSort =
      state.projectSort.key === key
        ? { key, dir: state.projectSort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' };
    if (state.snapshot) renderProjects(state.snapshot.projects);
  });
}

// The chart's viewBox is measured in pixels, so a resize has to redraw it or the
// axis text and markers stretch with the element.
let trendResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(trendResizeTimer);
  trendResizeTimer = setTimeout(() => {
    if (state.snapshot) renderTrend(state.snapshot.tokens.trend, state.account);
  }, 120);
});

// Applied before the first load so the initial paint is already in the right
// theme, and so the main process learns the stored choice on launch.
applyTheme(currentTheme(), { repaint: false });

// On 'system', an OS appearance change has to redraw the charts — their colours
// are literals resolved when they were drawn, not live `var()` references.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentTheme() !== 'system') return;
  clearPalette();
  paint();
});

load();
/**
 * Poll a cheap fingerprint of the transcript files so a new message shows up in
 * seconds. Only a change triggers the (heavier) snapshot reload, and account data
 * is still governed by its own 5-minute cache — so this costs no API calls.
 */
setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
  try {
    const p = await (await fetch('/api/pulse')).json();
    const key = `${p.files}:${p.bytes}:${p.newest}`;
    if (state.pulse && state.pulse !== key) load();
    state.pulse = key;
  } catch {
    /* server not ready */
  }
}, 5_000);

// Refresh quietly while the window is open. Two minutes, not one: each load also
// asks for account data, and polling that endpoint aggressively from both here and
// the menu bar is what got this app rate limited during development. The server's
// 5-minute usage cache absorbs the rest.
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, 120_000);
