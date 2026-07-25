/*
 * Claude Ledger — phone client.
 *
 * There is no Node on a phone, so unlike the desktop window this UI computes
 * nothing: it pairs with the Mac over the local network and renders the same
 * shaped snapshot the desktop renderer receives. Everything that touches your
 * credential stays on the Mac.
 *
 * Runs in three places, deliberately identically:
 *   - the iOS app (Capacitor, origin capacitor://localhost)
 *   - mobile Safari pointed at http://<your-mac>:4317
 *   - a desktop browser at http://127.0.0.1:4317/m/ while developing
 */

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_PORT = 4317;
/** 18 weeks of heatmap is what fits a phone without becoming a smear. */
const HEATMAP_WEEKS = 18;
const PULSE_MS = 60_000;
const FULL_REFRESH_MS = 4 * 60_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Resolved value of a CSS custom property.
 *
 * Inline styles take `var()` happily, but an SVG *presentation attribute* is a
 * different path and support for custom properties there is not something to
 * bet a chart on. Reading the value keeps the stylesheet authoritative either
 * way. Cache is dropped by `render()` so a theme change re-reads.
 */
let paletteCache = new Map();

function color(name) {
  if (!paletteCache.has(name)) {
    paletteCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return paletteCache.get(name);
}

/** Series palette. Chosen here rather than taken from the snapshot because the
 *  server bakes light-mode hexes and this UI has a dark theme. */
const SERIES_VARS = ['--accent', '--green', '--blue', '--violet', '--amber', '--ink-3'];
const seriesColor = (i) => color(SERIES_VARS[i % SERIES_VARS.length]);

const HEAT_LEVELS = [
  'var(--track)',
  'color-mix(in srgb, var(--accent) 26%, var(--track))',
  'color-mix(in srgb, var(--accent) 50%, var(--track))',
  'color-mix(in srgb, var(--accent) 74%, var(--track))',
  'var(--accent)',
];

// -------------------------------------------------------------- native bridge

/**
 * Capacitor registers native plugins on `window.Capacitor.Plugins` at runtime, so
 * none of this needs a bundler or an import. Every call is a no-op in a browser,
 * which is what makes the same build work in Safari.
 */
const Native = {
  get plugins() {
    return globalThis.Capacitor?.Plugins ?? {};
  },
  get isNative() {
    return Boolean(globalThis.Capacitor?.isNativePlatform?.());
  },
  tap(style = 'Light') {
    this.plugins.Haptics?.impact({ style }).catch(() => {});
  },
  notify(type = 'Success') {
    this.plugins.Haptics?.notification({ type }).catch(() => {});
  },
  onResume(fn) {
    this.plugins.App?.addListener('appStateChange', ({ isActive }) => {
      if (isActive) fn();
    });
  },
  onUrl(fn) {
    this.plugins.App?.addListener('appUrlOpen', ({ url }) => fn(url));
  },
  /**
   * Keep the status bar text legible against the paper/ink backgrounds.
   *
   * Reads the effective theme rather than the system one — with the Appearance
   * control set to Light on a phone in dark mode, the bar would otherwise stay
   * white-on-white.
   */
  syncStatusBar() {
    // Capacitor's naming is the opposite of what it looks like: `DARK` means dark
    // *content*, i.e. what a light background needs.
    this.plugins.StatusBar?.setStyle({ style: effectiveTheme() === 'dark' ? 'LIGHT' : 'DARK' }).catch(
      () => {},
    );
  },
};

// --------------------------------------------------------------------- theme

const KEY_THEME = 'ledger.mobile.theme';
const THEMES = ['system', 'light', 'dark'];

function storedTheme() {
  const value = localStorage.getItem(KEY_THEME);
  return THEMES.includes(value) ? value : 'system';
}

function effectiveTheme() {
  const stored = storedTheme();
  if (stored !== 'system') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme, { repaint = true } = {}) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;

  localStorage.setItem(KEY_THEME, theme);
  Native.syncStatusBar();
  // The charts bake their colours in as literals when drawn, so they only follow
  // the theme on a redraw.
  if (repaint) render();
}

// -------------------------------------------------------------------- storage

const KEY_CONN = 'ledger.mobile.conn';
const KEY_CACHE = 'ledger.mobile.cache';
const KEY_TAB = 'ledger.mobile.tab';
const KEY_RANGE = 'ledger.mobile.range';

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // A full snapshot can exceed the quota on a device with a long history. The
    // cache is an optimisation; losing it must not break the app.
    return false;
  }
}

// ----------------------------------------------------------------------- state

const state = {
  conn: readJSON(KEY_CONN), // { baseUrl, token, name, pairedAt }
  tab: localStorage.getItem(KEY_TAB) ?? 'now',
  range: localStorage.getItem(KEY_RANGE) ?? '7d',
  snapshot: null,
  account: null,
  version: null,
  cachedAt: null,
  offline: false,
  error: null,
  loading: false,
  lastFullAt: 0,
  pulse: null,
  projectQuery: '',
  scrollTops: {},
};

// ------------------------------------------------------------------------ net

/** "192.168.1.42" / "mac.local:4317" / "http://…" all become a usable origin. */
function normalizeBase(input) {
  let raw = String(input ?? '').trim();
  if (!raw) return null;
  raw = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.port && url.protocol === 'http:') url.port = String(DEFAULT_PORT);
  return `${url.protocol}//${url.host}`;
}

class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { base, token, method = 'GET', body, timeout = 20_000 } = {}) {
  const origin = base ?? state.conn?.baseUrl;
  if (!origin) throw new ApiError('Not paired with a Mac yet.', { code: 'unpaired' });

  const auth = token !== undefined ? token : state.conn?.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${origin}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new ApiError(data?.error ?? `HTTP ${res.status}`, { status: res.status, code: data?.code });
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') {
      throw new ApiError('Your Mac took too long to answer.', { code: 'timeout' });
    }
    // fetch() reports every network-layer failure as the same opaque TypeError,
    // so this is as specific as the message can honestly get.
    throw new ApiError('Can’t reach your Mac. Check it’s awake and on the same Wi‑Fi.', {
      code: 'offline',
    });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ formatting

function fmtCount(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n / 1e6 >= 100 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n / 1e3 >= 100 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "3h 6m · 2:29 AM" while it matters, "Thu 9:00 AM" once it doesn't. */
function resetText(iso) {
  if (!iso) return 'reset time unknown';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'reset time unknown';
  const diff = ts - Date.now();
  if (diff <= 0) return 'resetting now';
  if (diff < 24 * 3_600_000) {
    const h = Math.floor(diff / 3_600_000);
    const m = Math.round((diff % 3_600_000) / 60_000);
    return `${h > 0 ? `${h}h ${m}m` : `${m}m`} · ${clock(ts)}`;
  }
  return `${new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })} ${clock(ts)}`;
}

function ago(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isSessionWindow(w) {
  return w.group === 'session' || w.kind === 'session' || w.key === 'five_hour';
}

function isHot(w) {
  return w.utilization >= 75 || (w.severity && w.severity !== 'normal');
}

// -------------------------------------------------------------------- charting

/** Polyline points for a tile sparkline, drawn with a non-scaling stroke. */
function sparkPoints(series, w = 100, h = 22, pad = 2) {
  if (!series?.length) return '';
  const max = Math.max(...series, 1);
  const step = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;
  return series
    .map((v, i) => `${(pad + i * step).toFixed(2)},${(h - pad - (v / max) * (h - pad * 2)).toFixed(2)}`)
    .join(' ');
}

function sparkline(series) {
  const node = svg('svg', {
    class: 'tile-spark',
    viewBox: '0 0 100 22',
    preserveAspectRatio: 'none',
  });
  node.append(
    svg('polyline', {
      points: sparkPoints(series),
      fill: 'none',
      stroke: color('--accent'),
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      // Without this the horizontal stretch from preserveAspectRatio="none"
      // squashes the stroke into a hairline at one end and a slab at the other.
      'vector-effect': 'non-scaling-stroke',
    }),
  );
  return node;
}

/** Progress ring for the session window. */
function ring(pct, hot) {
  const R = 88;
  const C = 2 * Math.PI * R;
  const node = svg('svg', { viewBox: '0 0 208 208' });
  node.append(svg('circle', { class: 'ring-track', cx: 104, cy: 104, r: R }));
  const fill = svg('circle', {
    class: `ring-fill${hot ? ' is-hot' : ''}`,
    cx: 104,
    cy: 104,
    r: R,
    'stroke-dasharray': C.toFixed(2),
    // Starts empty and animates to the value on first paint, which reads as the
    // app measuring something rather than snapping a static image into place.
    'stroke-dashoffset': C.toFixed(2),
  });
  node.append(fill);
  requestAnimationFrame(() => {
    const shown = Math.max(0, Math.min(100, pct ?? 0));
    fill.setAttribute('stroke-dashoffset', (C * (1 - shown / 100)).toFixed(2));
  });
  return node;
}

function donut(slices) {
  const R = 46;
  const C = 2 * Math.PI * R;
  const node = svg('svg', { viewBox: '0 0 116 116' });
  node.append(
    svg('circle', { cx: 58, cy: 58, r: R, fill: 'none', stroke: color('--track'), 'stroke-width': 16 }),
  );
  let offset = 0;
  slices.forEach((s, i) => {
    if (s.share <= 0) return;
    const len = (s.share / 100) * C;
    node.append(
      svg('circle', {
        cx: 58,
        cy: 58,
        r: R,
        fill: 'none',
        stroke: seriesColor(i),
        'stroke-width': 16,
        'stroke-dasharray': `${Math.max(0, len - 1.5).toFixed(2)} ${(C - len + 1.5).toFixed(2)}`,
        'stroke-dashoffset': (-offset).toFixed(2),
      }),
    );
    offset += len;
  });
  return node;
}

/**
 * Token flow, with touch scrubbing.
 *
 * Drawn at measured pixel size rather than through a stretched viewBox: this
 * chart carries text labels, and text in a non-uniformly scaled viewBox comes
 * out visibly distorted.
 */
function tokenChart(trend, width) {
  const W = Math.max(240, width);
  const H = 168;
  const PAD_L = 6;
  const PAD_R = 6;
  const PAD_T = 10;
  const PAD_B = 20;

  const wrap = el('div');
  const node = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}` });
  const readout = el('div', 'chart-readout');

  const input = trend.input ?? [];
  const output = trend.output ?? [];
  const n = Math.max(input.length, output.length);
  if (!n) {
    wrap.append(el('div', 'empty', 'No messages in this range.'));
    return wrap;
  }

  const max = Math.max(1, ...input, ...output);
  const x = (i) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => H - PAD_B - (v / max) * (H - PAD_T - PAD_B);

  for (let g = 0; g <= 3; g += 1) {
    const gy = PAD_T + (g / 3) * (H - PAD_T - PAD_B);
    node.append(svg('line', { class: 'grid-line', x1: PAD_L, x2: W - PAD_R, y1: gy, y2: gy }));
  }

  const areaPath = (series) => {
    const line = series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return `${line}L${x(series.length - 1).toFixed(1)},${H - PAD_B}L${x(0).toFixed(1)},${H - PAD_B}Z`;
  };

  const layers = [
    { series: input, color: color('--accent'), label: 'Tokens in' },
    { series: output, color: color('--green'), label: 'Tokens out' },
  ];

  for (const layer of layers) {
    if (!layer.series.length) continue;
    node.append(svg('path', { d: areaPath(layer.series), fill: layer.color, 'fill-opacity': 0.14 }));
    node.append(
      svg('path', {
        d: layer.series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''),
        fill: 'none',
        stroke: layer.color,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }

  // Only the labels the aggregator marked as label-worthy, and only if they fit.
  const labels = trend.labels ?? [];
  const every = Math.max(1, Math.ceil(labels.filter(Boolean).length / 5));
  let shown = 0;
  labels.forEach((label, i) => {
    if (!label) return;
    if (shown % every === 0) {
      const text = svg('text', {
        class: 'axis-text',
        x: Math.min(W - PAD_R - 2, Math.max(PAD_L + 2, x(i))),
        y: H - 6,
        'text-anchor': i === 0 ? 'start' : i >= labels.length - 2 ? 'end' : 'middle',
      });
      text.textContent = label;
      node.append(text);
    }
    shown += 1;
  });

  const scrub = svg('line', { class: 'scrub-line', y1: PAD_T, y2: H - PAD_B, x1: 0, x2: 0, opacity: 0 });
  const dotIn = svg('circle', { r: 3.5, fill: color('--accent'), opacity: 0 });
  const dotOut = svg('circle', { r: 3.5, fill: color('--green'), opacity: 0 });
  node.append(scrub, dotIn, dotOut);

  const defaultReadout = () => {
    clear(readout);
    const totalIn = input.reduce((a, b) => a + b, 0);
    const totalOut = output.reduce((a, b) => a + b, 0);
    readout.append(
      document.createTextNode('Total '),
      el('b', null, fmtCount(totalIn)),
      document.createTextNode(' in · '),
      el('b', null, fmtCount(totalOut)),
      document.createTextNode(' out — drag across the chart for a moment.'),
    );
  };
  defaultReadout();

  const showAt = (clientX) => {
    const rect = node.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
    const px = x(i);
    scrub.setAttribute('x1', px);
    scrub.setAttribute('x2', px);
    scrub.setAttribute('opacity', 1);
    dotIn.setAttribute('cx', px);
    dotIn.setAttribute('cy', y(input[i] ?? 0));
    dotIn.setAttribute('opacity', 1);
    dotOut.setAttribute('cx', px);
    dotOut.setAttribute('cy', y(output[i] ?? 0));
    dotOut.setAttribute('opacity', 1);

    clear(readout);
    const stamp = trend.stamps?.[i];
    const when = stamp
      ? new Date(stamp).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : (trend.labels?.[i] ?? '');
    readout.append(
      el('b', null, fmtCount(input[i] ?? 0)),
      document.createTextNode(' in · '),
      el('b', null, fmtCount(output[i] ?? 0)),
      document.createTextNode(` out — ${when}`),
    );
  };

  let scrubbing = false;
  node.addEventListener(
    'touchstart',
    (e) => {
      scrubbing = true;
      showAt(e.touches[0].clientX);
    },
    { passive: true },
  );
  node.addEventListener(
    'touchmove',
    (e) => {
      if (!scrubbing) return;
      showAt(e.touches[0].clientX);
    },
    { passive: true },
  );
  const end = () => {
    scrubbing = false;
    scrub.setAttribute('opacity', 0);
    dotIn.setAttribute('opacity', 0);
    dotOut.setAttribute('opacity', 0);
    defaultReadout();
  };
  node.addEventListener('touchend', end, { passive: true });
  node.addEventListener('touchcancel', end, { passive: true });
  // Mouse support exists purely so the layout can be checked in a desktop browser.
  node.addEventListener('mousemove', (e) => showAt(e.clientX));
  node.addEventListener('mouseleave', end);

  const legend = el('div', 'chart-legend');
  for (const layer of layers) {
    const item = el('div');
    const swatch = el('i');
    swatch.style.background = layer.color;
    item.append(swatch, document.createTextNode(layer.label));
    legend.append(item);
  }

  wrap.append(node, legend, readout);
  return wrap;
}

// ------------------------------------------------------------------ components

function card(...children) {
  const node = el('div', 'card');
  node.append(...children);
  return node;
}

function sectionLabel(title, note) {
  const wrap = el('div', 'section-label');
  wrap.append(el('h2', null, title));
  if (note) wrap.append(el('div', 'section-note', note));
  return wrap;
}

function kv(label, value) {
  const row = el('div', 'kv');
  row.append(el('dt', null, label), el('dd', null, value));
  return row;
}

function bar(pct, hot) {
  const track = el('div', 'bar');
  const fill = el('i', hot ? 'is-hot' : null);
  fill.style.width = '0%';
  track.append(fill);
  requestAnimationFrame(() => {
    fill.style.width = `${Math.min(100, Math.max(pct > 0 ? 1.5 : 0, pct))}%`;
  });
  return track;
}

function chevron() {
  const node = svg('svg', { class: 'chev', viewBox: '0 0 8 13' });
  node.append(svg('path', { d: 'M1.5 1.5 6.5 6.5 1.5 11.5' }));
  return node;
}

function emptyCard(message) {
  const node = el('div', 'card');
  node.append(el('div', 'empty', message));
  return node;
}

// ------------------------------------------------------------------ view: now

function renderNow(view) {
  const account = state.account;
  const snap = state.snapshot;

  if (!account || account.status !== 'connected') {
    view.append(accountProblemCard(account));
  } else {
    const windows = account.limits?.windows ?? [];
    const session = windows.find(isSessionWindow) ?? null;
    const others = windows.filter((w) => w !== session);

    if (session) {
      const ringCard = el('div', 'card ring-card');
      ringCard.append(el('div', 'eyebrow', session.label ?? 'Current session'));

      const wrap = el('div', 'ring-wrap');
      wrap.append(ring(session.utilization ?? 0, isHot(session)));
      const center = el('div', 'ring-center');
      const value = el('div', 'ring-value');
      if (session.utilization == null) {
        value.append(el('small', null, 'n/a'));
      } else {
        value.append(document.createTextNode(session.utilization.toFixed(0)), el('small', null, '%'));
      }
      center.append(value, el('div', 'ring-caption', 'of this window used'));
      wrap.append(center);
      ringCard.append(wrap);

      ringCard.append(el('div', 'ring-reset', `Resets in ${resetText(session.resetsAt)}`));

      const burn = account.burn;
      const foot = el('div', 'ring-foot');
      if (burn?.ratePerHour) {
        foot.append(el('span', null, `Burning ${burn.ratePerHour.toFixed(1)}%/hr`));
        if (burn.willExhaustBeforeReset) {
          const chip = el('span', 'tag', `Out in ~${Math.round(burn.minutesToExhaust)}m`);
          chip.style.background = 'var(--hot-wash)';
          chip.style.color = 'var(--hot)';
          foot.append(chip);
        }
      } else {
        foot.append(
          el('span', null, 'Burn rate needs a few minutes of readings before it means anything.'),
        );
      }
      ringCard.append(foot);
      view.append(ringCard);
    }

    if (others.length) {
      view.append(sectionLabel('Other windows'));
      const list = el('div', 'card flush');
      for (const w of others) {
        const row = el('div', 'limit-row');
        const top = el('div', 'limit-top');
        top.append(el('div', 'limit-name', w.label));
        top.append(
          w.utilization == null
            ? el('div', 'limit-pct dim', 'not reported')
            : el('div', 'limit-pct', `${w.utilization.toFixed(0)}%`),
        );
        row.append(top);
        if (w.utilization != null) {
          row.append(bar(w.utilization, isHot(w)));
          row.append(el('div', 'limit-sub', `Resets ${resetText(w.resetsAt)}`));
        } else {
          row.append(el('div', 'limit-sub', 'Not tracked on this plan.'));
        }
        list.append(row);
      }
      view.append(list);
    }

    const extra = account.limits?.extraUsage;
    if (extra?.enabled) {
      const c = card();
      c.append(el('div', 'eyebrow', 'Extra usage'));
      const dl = el('dl');
      dl.style.margin = '10px 0 0';
      dl.append(
        kv('Used', `${extra.usedCredits} ${extra.currency}`),
        kv('Monthly limit', extra.monthlyLimit == null ? '—' : `${extra.monthlyLimit} ${extra.currency}`),
      );
      c.append(dl);
      view.append(c);
    }
  }

  if (snap) {
    view.append(sectionLabel('Usage', snap.rangeLabel));
    view.append(headlineTiles(snap));

    if (snap.feed?.length) {
      view.append(sectionLabel('Latest sessions'));
      const list = el('div', 'card flush');
      for (const item of snap.feed.slice(0, 4)) list.append(feedRow(item));
      view.append(list);
    }
  }
}

function accountProblemCard(account) {
  const c = card();
  c.append(el('div', 'eyebrow', 'Claude account'));
  const status = account?.status ?? 'unknown';
  const message =
    status === 'missing'
      ? 'Your Mac has no Claude Code credential. Run `claude` there and log in.'
      : status === 'expired'
        ? 'The stored access token has expired. Run `claude` on your Mac to refresh it.'
        : (account?.error ?? 'Your Mac could not read your account.');
  const title = el('div', 'card-title', 'Limits unavailable');
  title.style.marginTop = '8px';
  c.append(title, el('p', 'section-note', message));
  return c;
}

/** The Now tab shows the first four figures for whatever range Usage is set to. */
function headlineTiles(snap) {
  const grid = el('div', 'tiles');
  for (const cardData of snap.statCards.slice(0, 4)) grid.append(statTile(cardData));
  return grid;
}

function statTile(c) {
  const tile = el('div', 'tile');
  const top = el('div', 'tile-top');
  top.append(el('div', 'eyebrow', c.label));
  if (c.delta) top.append(el('div', `delta ${c.delta.positive ? '' : 'down'}`, c.delta.text));
  tile.append(top);

  const value = el('div', 'tile-value');
  value.append(document.createTextNode(c.value));
  if (c.unit) value.append(el('span', null, ` ${c.unit}`));
  tile.append(value, el('div', 'tile-sub', c.sub));
  if (c.series?.length) tile.append(sparkline(c.series));
  return tile;
}

function feedRow(item) {
  const row = el('div', 'row');
  const main = el('div', 'row-main');
  main.append(el('div', 'row-name', item.title));
  main.append(el('div', 'row-meta', item.meta));
  const right = el('div', 'row-value', item.time);
  row.append(main, right);
  return row;
}

// ---------------------------------------------------------------- view: usage

function renderUsage(view) {
  const snap = state.snapshot;
  if (!snap) {
    view.append(emptyCard('No snapshot yet.'));
    return;
  }

  view.append(rangeSwitch(snap));

  const grid = el('div', 'tiles');
  for (const c of snap.statCards) grid.append(statTile(c));
  view.append(grid);

  view.append(sectionLabel('Token flow', snap.rangeLabel));
  const chartCard = el('div', 'card chart-card');
  // Measured after insertion — the card has to be in the document before its
  // content box has a width.
  view.append(chartCard);
  requestAnimationFrame(() => {
    clear(chartCard);
    chartCard.append(tokenChart(snap.tokens.trend, chartCard.clientWidth - 24));
  });

  const models = snap.tokens.models ?? [];
  view.append(sectionLabel('Model mix'));
  if (!models.length) {
    view.append(emptyCard('No messages in this range.'));
  } else {
    const mixCard = card();
    const row = el('div', 'donut-row');
    const wrap = el('div', 'donut-wrap');
    wrap.append(donut(models));
    const hole = el('div', 'donut-hole');
    hole.append(el('div', 'donut-total', snap.tokens.totalMessages), el('div', 'donut-label', 'messages'));
    wrap.append(hole);

    const legend = el('div', 'legend');
    models.slice(0, 6).forEach((m, i) => {
      const line = el('div', 'legend-row');
      const dot = el('span', 'legend-dot');
      dot.style.background = seriesColor(i);
      line.append(dot, el('span', 'legend-name', m.name), el('span', 'legend-val', `${m.share.toFixed(0)}%`));
      legend.append(line);
    });
    row.append(wrap, legend);
    mixCard.append(row);
    view.append(mixCard);

    const table = el('div', 'card flush');
    for (const m of models) {
      const r = el('button', 'row');
      r.type = 'button';
      const main = el('div', 'row-main');
      main.append(el('div', 'row-name', m.name));
      main.append(
        el('div', 'row-meta', `${fmtCount(m.messages)} msgs · ${fmtCount(m.tokensIn)} in · ${fmtCount(m.tokensOut)} out`),
      );
      const right = el('div', 'row-value', fmtMoney(m.cost));
      right.append(el('small', null, 'API-equiv.'));
      r.append(main, right, chevron());
      r.addEventListener('click', () => openModelSheet(m, snap));
      table.append(r);
    }
    view.append(table);

    if (snap.tokens.hasEstimatedPricing) {
      view.append(
        el(
          'p',
          'section-note',
          'Some models have no published price yet, so their API-equivalent figure is an estimate.',
        ),
      );
    }
  }

  view.append(sectionLabel('Workload mix'));
  const workCard = el('div', 'card flush');
  for (const w of snap.workload ?? []) {
    const item = el('div', 'hbar');
    item.append(el('div', 'hbar-name', w.name), el('div', 'hbar-count', w.tokens));
    const track = el('div', 'hbar-track');
    const fill = el('i');
    fill.style.width = w.pctW;
    track.append(fill);
    item.append(track);
    workCard.append(item);
  }
  view.append(workCard);
}

const THEME_LABELS = { system: 'Auto', light: 'Light', dark: 'Dark' };

function themeSwitch() {
  const wrap = el('div', 'segmented');
  const active = storedTheme();
  for (const theme of THEMES) {
    const btn = el('button', theme === active ? 'is-active' : null, THEME_LABELS[theme]);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(theme === active));
    btn.addEventListener('click', () => {
      if (storedTheme() === theme) return;
      Native.tap('Light');
      applyTheme(theme);
    });
    wrap.append(btn);
  }
  return wrap;
}

function rangeSwitch(snap) {
  const wrap = el('div', 'segmented');
  const ranges = snap.ranges ?? [{ id: '7d', label: '7 days' }];
  for (const r of ranges) {
    const btn = el('button', r.id === state.range ? 'is-active' : null, r.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (state.range === r.id) return;
      state.range = r.id;
      localStorage.setItem(KEY_RANGE, r.id);
      Native.tap('Light');
      refresh({ silent: false });
    });
    wrap.append(btn);
  }
  return wrap;
}

// ------------------------------------------------------------- view: activity

function renderActivity(view) {
  const snap = state.snapshot;
  if (!snap) {
    view.append(emptyCard('No snapshot yet.'));
    return;
  }

  const a = snap.activity;
  const streakCard = card();
  const streak = el('div', 'streak');
  const num = el('div', 'streak-num');
  num.append(
    document.createTextNode(String(a.streak.current)),
    el('span', null, a.streak.current === 1 ? 'day' : 'days'),
  );
  const side = el('div', 'streak-side');
  side.append(el('div', 'eyebrow', 'Current streak'));
  side.append(el('div', null, `Best: ${a.streak.longest} days`));
  if (a.streak.longestRange) side.append(el('div', 'row-meta', a.streak.longestRange));
  streak.append(num, side);
  streakCard.append(streak);
  view.append(streakCard);

  const heatCard = card();
  const head = el('div', 'card-head');
  head.append(el('div', 'card-title', 'Daily activity'), el('div', 'eyebrow', `${a.weeks} weeks`));
  heatCard.append(head);

  const scroll = el('div', 'heat-scroll');
  const grid = el('div', 'heat-grid');
  const legendColors = a.heatmap.legendColors ?? [];
  for (const week of a.heatmap.weeks) {
    const col = el('div', 'heat-col');
    for (const day of week.days) {
      const cell = el('div', 'heat-cell');
      if (day.empty) {
        cell.style.background = 'transparent';
      } else {
        const level = Math.max(0, legendColors.indexOf(day.color));
        cell.style.background = HEAT_LEVELS[level] ?? HEAT_LEVELS[0];
        cell.addEventListener('click', () => openDaySheet(day));
      }
      col.append(cell);
    }
    grid.append(col);
  }
  scroll.append(grid);
  heatCard.append(scroll);
  // The recent weeks are the interesting ones, and they're on the right.
  requestAnimationFrame(() => {
    scroll.scrollLeft = scroll.scrollWidth;
  });

  const legend = el('div', 'heat-legend');
  legend.append(el('span', null, 'Less'));
  for (const colour of HEAT_LEVELS) {
    const k = el('span', 'heat-key');
    k.style.background = colour;
    legend.append(k);
  }
  legend.append(el('span', null, 'More'));
  heatCard.append(legend);
  view.append(heatCard);

  const statsCard = card();
  const dl = el('dl');
  dl.style.margin = '0';
  dl.append(
    kv('Active days', String(a.streak.activeDays)),
    kv('Best day', `${a.bestDay} messages`),
    kv('Average active day', `${a.avgPerActiveDay} messages`),
    kv('Busiest weekday', a.busiestWeekday),
  );
  statsCard.append(dl);
  view.append(statsCard);

  view.append(sectionLabel('When you work', snap.rangeLabel));
  const hoursCard = card();
  const hours = el('div', 'hours');
  const bars = snap.sessions.hourBars ?? [];
  const heights = bars.map((b) => Number.parseFloat(b.height) || 0);
  const maxHeight = Math.max(1, ...heights);
  bars.forEach((b, i) => {
    const barEl = el('i');
    barEl.style.height = b.height;
    const ratio = heights[i] / maxHeight;
    barEl.style.background =
      ratio >= 0.85 ? 'var(--accent)' : ratio >= 0.4 ? 'color-mix(in srgb, var(--accent) 55%, var(--track))' : 'var(--track)';
    hours.append(barEl);
  });
  hoursCard.append(hours);
  const axis = el('div', 'hour-axis');
  for (const t of ['12a', '6a', '12p', '6p', '11p']) axis.append(el('span', null, t));
  hoursCard.append(axis);

  const dl2 = el('dl');
  dl2.style.margin = '12px 0 0';
  dl2.append(
    kv('Sessions', String(snap.sessions.count)),
    kv('Average length', snap.sessions.avgLength),
    kv('Longest', snap.sessions.longest),
    kv('Peak hour', snap.sessions.peakHour),
  );
  hoursCard.append(dl2);
  view.append(hoursCard);

  const tools = snap.tools ?? [];
  view.append(sectionLabel('Tools & skills', snap.rangeLabel));
  if (!tools.length) {
    view.append(emptyCard('No tool calls in this range.'));
  } else {
    const toolCard = el('div', 'card flush');
    for (const t of tools) {
      const item = el('div', 'hbar');
      item.append(el('div', 'hbar-name', t.name), el('div', 'hbar-count', fmtCount(t.count)));
      const track = el('div', 'hbar-track');
      const fill = el('i');
      fill.style.width = t.pct;
      track.append(fill);
      item.append(track);
      toolCard.append(item);
    }
    view.append(toolCard);
  }
}

// ------------------------------------------------------------- view: projects

function renderProjects(view) {
  const snap = state.snapshot;
  if (!snap) {
    view.append(emptyCard('No snapshot yet.'));
    return;
  }

  const search = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Filter projects';
  input.value = state.projectQuery;
  input.autocapitalize = 'off';
  input.spellcheck = false;
  search.append(input);
  view.append(search);

  const listWrap = el('div');
  view.append(listWrap);

  const paint = () => {
    clear(listWrap);
    const q = state.projectQuery.trim().toLowerCase();
    const rows = (snap.projects ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || (p.cwd ?? '').toLowerCase().includes(q),
    );
    if (!rows.length) {
      listWrap.append(emptyCard(q ? 'No project matches that.' : 'No projects in this range.'));
      return;
    }
    const list = el('div', 'card flush');
    for (const p of rows) {
      const row = el('button', 'row');
      row.type = 'button';
      const main = el('div', 'row-main');
      main.append(el('div', 'row-name', p.name));
      main.append(
        el('div', 'row-meta', `${plural(p.sessions, 'session')} · ${fmtCount(p.messages)} msgs · ${p.last}`),
      );
      const right = el('div', 'row-value', p.tokens);
      right.append(el('small', null, p.cost));
      row.append(main, right, chevron());
      row.addEventListener('click', () => openProjectSheet(p));
      list.append(row);
    }
    listWrap.append(list);
  };
  paint();

  input.addEventListener('input', () => {
    state.projectQuery = input.value;
    paint();
  });

  view.append(sectionLabel('Recent activity', snap.rangeLabel));
  if (!snap.feed?.length) {
    view.append(emptyCard('Nothing recorded in this range.'));
  } else {
    const feed = el('div', 'card flush');
    for (const item of snap.feed) feed.append(feedRow(item));
    view.append(feed);
  }
}

// ------------------------------------------------------------------ view: you

function renderYou(view) {
  const account = state.account;
  const snap = state.snapshot;

  const who = card();
  who.append(el('div', 'eyebrow', 'Claude account'));
  const plan = el('div', 'card-title');
  plan.style.margin = '8px 0 10px';
  plan.textContent =
    account?.account?.hasMax
      ? 'Claude Max'
      : account?.account?.hasPro
        ? 'Claude Pro'
        : account?.subscriptionType
          ? `Claude ${account.subscriptionType}`
          : 'Not connected';
  who.append(plan);

  const dl = el('dl');
  dl.style.margin = '0';
  if (account?.account?.email) dl.append(kv('Email', account.account.email));
  if (account?.account?.displayName) dl.append(kv('Name', account.account.displayName));
  if (account?.account?.organization) dl.append(kv('Organization', account.account.organization));
  if (account?.account?.memberSince) {
    dl.append(
      kv('Member since', new Date(account.account.memberSince).toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
      })),
    );
  }
  if (account?.limitsFetchedAt) dl.append(kv('Limits read', ago(account.limitsFetchedAt)));
  who.append(dl);
  view.append(who);

  for (const warning of account?.warnings ?? []) {
    view.append(el('p', 'section-note', warning));
  }

  if (snap?.badges?.length) {
    view.append(sectionLabel('Achievements'));
    const grid = el('div', 'badges');
    for (const b of snap.badges) {
      const node = el('div', `badge${b.earned ? '' : ' locked'}`);
      node.append(el('div', 'badge-icon', b.icon));
      node.append(el('div', 'badge-name', b.name));
      node.append(el('div', 'badge-desc', b.desc));
      grid.append(node);
    }
    view.append(grid);
  }

  view.append(sectionLabel('Appearance'));
  view.append(themeSwitch());

  view.append(sectionLabel('This Mac'));
  const conn = card();
  const dl2 = el('dl');
  dl2.style.margin = '0';
  dl2.append(kv('Address', state.conn?.baseUrl ?? 'not paired'));
  dl2.append(kv('Paired', state.conn?.pairedAt ? ago(state.conn.pairedAt) : '—'));
  dl2.append(kv('Last sync', state.cachedAt ? ago(state.cachedAt) : '—'));
  if (snap?.meta) {
    dl2.append(kv('Transcripts', `${snap.meta.files} files · ${snap.meta.sizeLabel}`));
    if (snap.meta.firstActivity) dl2.append(kv('History since', snap.meta.firstActivity));
  }
  if (state.version) dl2.append(kv('Mac app', `v${state.version}`));
  conn.append(dl2);
  view.append(conn);

  const unpair = el('button', 'btn danger', 'Unpair this phone');
  unpair.type = 'button';
  unpair.addEventListener('click', async () => {
    Native.notify('Warning');
    const id = state.conn?.deviceId;
    // Tell the Mac first, while the token still works. If it can't be reached the
    // local half still happens — the user asked to unpair, and they can remove a
    // stale entry from the pairing window.
    if (id) {
      await api(`/api/devices?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    localStorage.removeItem(KEY_CONN);
    localStorage.removeItem(KEY_CACHE);
    state.conn = null;
    state.snapshot = null;
    state.account = null;
    showConnect();
  });
  view.append(unpair);

  view.append(
    el(
      'p',
      'section-note',
      'Claude Ledger reads your Claude Code history on your Mac. Your OAuth token never leaves it — this phone only receives the figures.',
    ),
  );
}

// -------------------------------------------------------------------- sheets

let sheetOpen = false;

function openSheet(build) {
  const sheet = $('sheet');
  const scrim = $('sheet-scrim');
  const body = $('sheet-body');
  clear(body);
  build(body);
  sheet.hidden = false;
  sheet.classList.remove('is-closing');
  scrim.hidden = false;
  sheetOpen = true;
  Native.tap('Light');
}

function closeSheet() {
  if (!sheetOpen) return;
  const sheet = $('sheet');
  sheetOpen = false;
  sheet.classList.add('is-closing');
  $('sheet-scrim').hidden = true;
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove('is-closing');
  }, 220);
}

function openProjectSheet(p) {
  openSheet((body) => {
    body.append(el('div', 'sheet-title', p.name));
    if (p.cwd) body.append(el('div', 'sheet-sub', p.cwd));
    const dl = el('dl');
    dl.style.margin = '0';
    dl.append(
      kv('Sessions', String(p.sessions)),
      kv('Messages', fmtCount(p.messages)),
      kv('Tokens', p.tokens),
      kv('API-equivalent', p.cost),
      kv('Top model', p.model),
      kv('Last active', p.last),
    );
    body.append(dl);
    const close = el('button', 'btn primary', 'Done');
    close.type = 'button';
    close.style.marginTop = '18px';
    close.addEventListener('click', closeSheet);
    body.append(close);
  });
}

function openModelSheet(m, snap) {
  openSheet((body) => {
    body.append(el('div', 'sheet-title', m.name));
    body.append(el('div', 'sheet-sub', `${snap.rangeLabel} · ${m.share.toFixed(1)}% of messages`));
    const dl = el('dl');
    dl.style.margin = '0';
    dl.append(
      kv('Messages', fmtCount(m.messages)),
      kv('Tokens in', fmtCount(m.tokensIn)),
      kv('Cached reads', fmtCount(m.cacheRead)),
      kv('Tokens out', fmtCount(m.tokensOut)),
      kv('Average reply', `${fmtCount(m.avgOut)} tokens`),
      kv('API-equivalent', fmtMoney(m.cost)),
    );
    body.append(dl);
    if (m.estimated) {
      body.append(
        el('p', 'section-note', 'This model has no published price yet — the cost above is an estimate.'),
      );
    }
    const close = el('button', 'btn primary', 'Done');
    close.type = 'button';
    close.style.marginTop = '18px';
    close.addEventListener('click', closeSheet);
    body.append(close);
  });
}

function openDaySheet(day) {
  openSheet((body) => {
    body.append(el('div', 'sheet-title', day.date ?? 'That day'));
    const dl = el('dl');
    dl.style.margin = '0';
    dl.append(kv('Messages', String(day.messages ?? 0)), kv('Tokens', day.tokens ?? '0'), kv('API-equivalent', day.cost ?? '$0'));
    body.append(dl);
    const close = el('button', 'btn primary', 'Done');
    close.type = 'button';
    close.style.marginTop = '18px';
    close.addEventListener('click', closeSheet);
    body.append(close);
  });
}

// --------------------------------------------------------------------- shell

const TAB_TITLES = {
  now: 'Now',
  usage: 'Usage',
  activity: 'Activity',
  projects: 'Projects',
  you: 'You',
};

function subtitleFor(tab) {
  if (state.offline && state.cachedAt) return `Offline — figures from ${clock(state.cachedAt)}`;
  if (state.loading && !state.snapshot) return 'Reading your Mac…';
  switch (tab) {
    case 'now':
      return state.account?.limitsStale ? 'Limits are cached — your Mac is rate limited' : 'Live usage limits';
    case 'usage':
      return state.snapshot?.rangeLabel ?? '';
    case 'activity':
      return 'All-time history';
    case 'projects':
      return state.snapshot ? `${state.snapshot.projects?.length ?? 0} in ${state.snapshot.rangeLabel}` : '';
    case 'you':
      return state.conn?.baseUrl ?? '';
    default:
      return '';
  }
}

function renderChrome() {
  $('bigtitle').textContent = TAB_TITLES[state.tab];
  $('topbar-title').textContent = TAB_TITLES[state.tab];
  const sub = subtitleFor(state.tab);
  $('bigsub').textContent = sub;
  $('topbar-sub').textContent = sub;

  const banner = $('banner');
  clear(banner);
  if (state.error) {
    banner.hidden = false;
    banner.className = 'banner is-error';
    banner.append(el('span', null, state.error));
    const retry = el('button', null, 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => refresh());
    banner.append(retry);
  } else if (state.offline) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.append(el('span', null, `Showing cached figures from ${clock(state.cachedAt)}.`));
    const retry = el('button', null, 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => refresh());
    banner.append(retry);
  } else {
    banner.hidden = true;
  }
}

const RENDERERS = {
  now: renderNow,
  usage: renderUsage,
  activity: renderActivity,
  projects: renderProjects,
  you: renderYou,
};

function renderView() {
  const view = document.querySelector(`.view[data-view="${state.tab}"]`);
  for (const node of document.querySelectorAll('.view')) node.hidden = node !== view;
  clear(view);

  if (!state.snapshot && !state.account && state.loading) {
    view.append(skeleton());
    return;
  }
  RENDERERS[state.tab](view);
}

function skeleton() {
  const wrap = el('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '12px';
  for (const height of [230, 96, 96, 150]) {
    const block = el('div', 'sk');
    block.style.height = `${height}px`;
    block.style.borderRadius = '18px';
    wrap.append(block);
  }
  return wrap;
}

function render() {
  // A render is the only moment the theme can have changed under us, so this is
  // where the resolved-colour cache gets dropped.
  paletteCache = new Map();
  renderChrome();
  renderView();
}

function setTab(tab, { haptic = true } = {}) {
  if (!RENDERERS[tab]) return;
  const scroller = $('scroller');
  state.scrollTops[state.tab] = scroller.scrollTop;
  state.tab = tab;
  localStorage.setItem(KEY_TAB, tab);

  for (const btn of document.querySelectorAll('.tabbar button')) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  if (haptic) Native.tap('Light');
  render();
  scroller.scrollTop = state.scrollTops[tab] ?? 0;
  updateCondensed();
  // The `.view` elements are reused rather than recreated, so their entry
  // animation would only ever play once. Restart it deliberately here — and only
  // here, so a background refresh doesn't make the page flinch.
  const view = document.querySelector(`.view[data-view="${tab}"]`);
  if (view) {
    view.style.animation = 'none';
    void view.offsetHeight;
    view.style.animation = '';
  }
}

// ------------------------------------------------------------------- loading

function applyPayload(payload) {
  state.snapshot = payload.snapshot;
  state.account = payload.account;
  state.version = payload.app?.version ?? state.version;
  state.cachedAt = Date.now();
  state.offline = false;
  state.error = null;
  state.lastFullAt = Date.now();
  writeJSON(KEY_CACHE, { at: state.cachedAt, range: state.range, ...payload });
}

function loadCache() {
  const cached = readJSON(KEY_CACHE);
  if (!cached?.snapshot) return false;
  state.snapshot = cached.snapshot;
  state.account = cached.account;
  state.version = cached.app?.version ?? null;
  state.cachedAt = cached.at ?? null;
  // The cached snapshot was built for whatever range was last requested; showing
  // it under a different range's label would be a lie.
  if (cached.range) state.range = cached.range;
  return true;
}

let refreshing = false;

async function refresh({ silent = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  state.loading = true;
  if (!silent) $('refresh-btn').classList.add('is-busy');
  if (!state.snapshot) render();

  try {
    const payload = await api(`/api/snapshot?range=${encodeURIComponent(state.range)}&weeks=${HEATMAP_WEEKS}`);
    applyPayload(payload);
    render();
  } catch (err) {
    if (err.status === 401 || err.code === 'unpaired') {
      // The Mac forgot this device (or the token was revoked there).
      localStorage.removeItem(KEY_CONN);
      state.conn = null;
      showConnect({ message: 'Your Mac no longer recognises this phone. Pair it again.' });
      return;
    }
    state.offline = true;
    // With nothing cached there is nothing to fall back to, so the failure is the
    // whole story and gets the loud treatment.
    state.error = state.snapshot ? null : err.message;
    render();
  } finally {
    refreshing = false;
    state.loading = false;
    $('refresh-btn').classList.remove('is-busy');
  }
}

/**
 * Cheap change detection. `/api/snapshot` re-reads every transcript; `/api/pulse`
 * only stats them, so the phone can poll often without making the Mac work.
 */
async function tick() {
  if (document.hidden || !state.conn) return;
  try {
    const pulse = await api('/api/pulse', { timeout: 8000 });
    const changed = !state.pulse || pulse.newest !== state.pulse.newest || pulse.files !== state.pulse.files;
    state.pulse = pulse;
    if (changed || Date.now() - state.lastFullAt > FULL_REFRESH_MS) {
      await refresh({ silent: true });
    } else if (state.offline) {
      state.offline = false;
      state.error = null;
      renderChrome();
    }
  } catch {
    if (!state.offline) {
      state.offline = true;
      renderChrome();
    }
  }
}

// -------------------------------------------------------------------- connect

function showApp() {
  $('connect').hidden = true;
  $('app').hidden = false;
}

function showConnect({ message = null, host = null } = {}) {
  $('app').hidden = true;
  $('connect').hidden = false;
  const err = $('connect-error');
  if (message) {
    err.hidden = false;
    err.textContent = message;
  } else {
    err.hidden = true;
  }
  if (host) $('host-input').value = host;
}

async function doPair() {
  const btn = $('pair-btn');
  const err = $('connect-error');
  const base = normalizeBase($('host-input').value);
  const code = $('code-input').value.replace(/\D/g, '');

  const fail = (message) => {
    err.hidden = false;
    err.textContent = message;
    Native.notify('Error');
  };

  if (!base) return fail('That address doesn’t look right. Try something like 192.168.1.42');
  if (code.length !== 6) return fail('The pairing code is six digits.');

  btn.disabled = true;
  btn.textContent = 'Pairing…';
  err.hidden = true;

  try {
    const name = Native.isNative ? 'iPhone' : 'Browser';
    const result = await api('/api/pair', { base, token: null, method: 'POST', body: { code, name } });
    state.conn = {
      baseUrl: base,
      token: result.token,
      // Kept so "Unpair" can revoke this device on the Mac rather than only
      // forgetting the token here, which would leave a live credential behind.
      deviceId: result.device?.id ?? null,
      name: result.device?.name ?? name,
      pairedAt: Date.now(),
    };
    writeJSON(KEY_CONN, state.conn);
    Native.notify('Success');
    $('code-input').value = '';
    showApp();
    render();
    await refresh();
    toast('Paired');
  } catch (e) {
    fail(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pair';
  }
}

/**
 * Work out where the data is without asking, when that is possible.
 *
 * Served from the Mac's own loopback listener (the /m/ dev preview), the origin
 * needs no token at all. Served from the shared listener, the origin is right but
 * a token is still required, so the address field can at least be pre-filled.
 */
async function autoDetect() {
  if (!/^https?:$/.test(location.protocol)) return null;
  const base = `${location.protocol}//${location.host}`;
  try {
    await api('/api/ping', { base, token: null, timeout: 4000 });
  } catch {
    return null;
  }
  try {
    await api('/api/pulse', { base, token: null, timeout: 6000 });
    return { baseUrl: base, token: null, name: 'This Mac', pairedAt: Date.now(), needsPairing: false };
  } catch (err) {
    if (err.status === 401) return { baseUrl: base, needsPairing: true };
    return null;
  }
}

/**
 * One-tap pairing from a link.
 *
 * Two shapes reach here. `claudeledger://pair?host=…&code=…` is what the QR in
 * the pairing window encodes and what iOS hands the installed app. The other is
 * `http://<mac>:4317/?code=…`, which is the same page opened in mobile Safari —
 * there the host is simply where the page came from, so it isn't in the query.
 */
function applyPairLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const code = parsed.searchParams.get('code');
  const host = parsed.searchParams.get('host') ?? (/^https?:$/.test(location.protocol) ? location.host : null);
  if (!host) return false;

  showConnect({ host });
  $('host-input').value = host;
  if (code) $('code-input').value = code.replace(/\D/g, '').slice(0, 6);
  // Leaving the code in the address bar means a reload replays a code that has
  // already been spent, and greets the user with a pairing failure.
  if (/^https?:$/.test(location.protocol)) {
    history.replaceState(null, '', location.pathname);
  }
  if (code) void doPair();
  return true;
}

// ------------------------------------------------------------------- gestures

function updateCondensed() {
  const scroller = $('scroller');
  $('topbar').classList.toggle('is-condensed', scroller.scrollTop > 40);
}

/**
 * Pull to refresh, measured from the finger rather than from the scroll position.
 *
 * The obvious implementation watches `scrollTop` go negative during the rubber
 * band, but an inner `overflow: auto` element clamps at zero on iOS — only the
 * document scroller reports the overscroll, and this layout deliberately doesn't
 * use the document scroller (the tab bar has to stay put). Tracking the touch
 * delta while the scroller is already at the top works in the app, in mobile
 * Safari, and in a desktop browser that has no bounce at all.
 */
const PULL_TRIGGER = 68;

function wirePullToRefresh() {
  const scroller = $('scroller');
  const pull = $('pull');
  let startY = null;
  let distance = 0;

  const reset = () => {
    startY = null;
    distance = 0;
    pull.classList.remove('is-armed');
    pull.style.opacity = '0';
    pull.style.transform = '';
  };

  scroller.addEventListener('scroll', updateCondensed, { passive: true });

  scroller.addEventListener(
    'touchstart',
    (event) => {
      // Only a gesture that begins at the very top is a pull; anywhere else it is
      // an ordinary scroll and must be left alone.
      startY = scroller.scrollTop <= 0 && event.touches.length === 1 ? event.touches[0].clientY : null;
      distance = 0;
    },
    { passive: true },
  );

  scroller.addEventListener(
    'touchmove',
    (event) => {
      if (startY == null || refreshing) return;
      if (scroller.scrollTop > 0) {
        reset();
        return;
      }
      const dy = event.touches[0].clientY - startY;
      if (dy <= 0) {
        distance = 0;
        pull.style.opacity = '0';
        pull.classList.remove('is-armed');
        return;
      }
      // Damped so the indicator lags the finger, the way the system gesture does.
      distance = Math.min(110, dy * 0.55);
      pull.style.opacity = String(Math.min(1, distance / 46));
      pull.style.transform = `translateY(${distance * 0.5}px)`;
      pull.classList.toggle('is-armed', distance > PULL_TRIGGER * 0.55);
    },
    { passive: true },
  );

  const release = async () => {
    const trigger = distance > PULL_TRIGGER * 0.55 && !refreshing;
    if (!trigger) {
      reset();
      return;
    }
    startY = null;
    distance = 0;
    pull.classList.add('is-spinning');
    pull.style.opacity = '1';
    pull.style.transform = 'translateY(16px)';
    Native.tap('Medium');
    await refresh();
    pull.classList.remove('is-spinning');
    reset();
  };

  scroller.addEventListener('touchend', release, { passive: true });
  scroller.addEventListener('touchcancel', reset, { passive: true });
}

let toastTimer = null;

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 1800);
}

// ---------------------------------------------------------------------- boot

function wireUI() {
  for (const btn of document.querySelectorAll('.tabbar button')) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
  $('refresh-btn').addEventListener('click', () => {
    Native.tap('Light');
    refresh();
  });
  $('sheet-scrim').addEventListener('click', closeSheet);
  $('sheet-grip').addEventListener('click', closeSheet);
  $('pair-btn').addEventListener('click', () => doPair());
  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doPair();
  });
  $('pair-help').addEventListener('click', () => {
    openSheet((body) => {
      body.append(el('div', 'sheet-title', 'Pairing'));
      body.append(
        el(
          'p',
          'section-note',
          'On your Mac, open Claude Ledger and choose “Pair a Phone” from the Claude Ledger menu (or right-click the menu bar icon). It shows the address to type here and a six-digit code that lasts five minutes.',
        ),
      );
      body.append(
        el(
          'p',
          'section-note',
          'Both devices need to be on the same Wi‑Fi. The first connection asks iOS for permission to find devices on your local network — allow it, or the app can’t reach your Mac.',
        ),
      );
      const close = el('button', 'btn primary', 'Got it');
      close.type = 'button';
      close.style.marginTop = '16px';
      close.addEventListener('click', closeSheet);
      body.append(close);
    });
  });

  wirePullToRefresh();

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Only matters on 'Auto'; a pinned theme should ignore the system entirely.
    if (storedTheme() !== 'system') return;
    Native.syncStatusBar();
    render();
  });

  addEventListener('orientationchange', () => setTimeout(render, 220));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
  Native.onResume(() => tick());
  Native.onUrl((url) => applyPairLink(url));
}

async function boot() {
  // Before anything paints, so a phone set to Dark never flashes paper white.
  applyTheme(storedTheme(), { repaint: false });
  wireUI();

  // A pairing link may have launched the app, or opened this page in Safari.
  const params = new URLSearchParams(location.search);
  if ((params.has('code') || params.has('host')) && applyPairLink(location.href)) return;

  if (!state.conn) {
    const detected = await autoDetect();
    if (detected?.needsPairing) {
      showConnect({ host: location.host });
      return;
    }
    if (detected) {
      state.conn = detected;
      writeJSON(KEY_CONN, state.conn);
    }
  }

  if (!state.conn) {
    showConnect();
    return;
  }

  showApp();
  // Paint the last snapshot immediately and mark it as such — a phone app that
  // shows a spinner every cold start feels broken even when it isn't.
  const hadCache = loadCache();
  state.offline = hadCache;
  state.loading = !hadCache;
  setTab(state.tab, { haptic: false });

  await refresh();
  setInterval(tick, PULSE_MS);
}

boot();
