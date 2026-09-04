/* Menu bar popover renderer. Talks to the main process over the preload bridge —
   no direct network access, no Node. */
const api = window.ledger;
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Compact, monospace-friendly reset text: "3h 6m · 2:29 AM" / "Thu 9:00 AM". */
function resetText(iso) {
  if (!iso) return 'reset time unknown';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'reset time unknown';

  const diff = ts - Date.now();
  if (diff <= 0) return 'resetting now';

  const clock = new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diff < 24 * 3_600_000) {
    const hours = Math.floor(diff / 3_600_000);
    const mins = Math.round((diff % 3_600_000) / 60_000);
    return `${hours > 0 ? `${hours}h ${mins}m` : `${mins}m`} · ${clock}`;
  }
  return `${new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}

function ago(ts) {
  if (!ts) return 'just now';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'updated now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `updated ${mins}m ago`;
  return `updated ${Math.round(mins / 60)}h ago`;
}

function isSession(w) {
  return w.group === 'session' || w.kind === 'session' || w.key === 'five_hour';
}

function hot(w) {
  return w.utilization >= 75 || (w.severity && w.severity !== 'normal');
}

/** Sparkline of recorded session readings. Needs 3+ points to mean anything. */
function renderSpark(history) {
  const node = $('spark');
  clear(node);
  if (!Array.isArray(history) || history.length < 3) return;

  const W = 88;
  const H = 34;
  const pts = history.map((s) => s.percent);
  const max = Math.max(...pts, 1);
  const min = Math.min(...pts, 0);
  const span = Math.max(1, max - min);

  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => H - 2 - ((v - min) / span) * (H - 6);

  const line = pts.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  node.append(svg('path', { class: 'area', d: `${line} L ${W} ${H} L 0 ${H} Z` }));
  node.append(svg('path', { class: 'line', d: line }));
  node.append(
    svg('circle', { class: 'head-dot', cx: W.toFixed(1), cy: y(pts[pts.length - 1]).toFixed(1), r: 2.1 }),
  );
}

function renderPrimary(account, session) {
  const wrap = $('primary');
  if (!session) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  $('primary-label').textContent = session.label;

  const value = $('primary-value');
  clear(value);
  if (session.utilization == null) {
    value.append(el('small', null, 'not reported'));
  } else {
    value.append(document.createTextNode(session.utilization.toFixed(0)));
    value.append(el('small', null, '%'));
  }

  const fill = $('primary-fill');
  fill.className = hot(session) ? 'hot' : '';
  fill.style.width = session.utilization == null ? '0%' : `${Math.min(100, Math.max(1.5, session.utilization))}%`;

  $('primary-reset').textContent = resetText(session.resetsAt);
  renderSpark(account.sessionHistory);
}

function renderRows(account, others) {
  const rows = $('rows');
  clear(rows);

  for (const w of others) {
    const row = el('div', 'row');
    row.append(el('div', 'row-name', w.label));

    if (w.utilization == null) {
      row.append(el('div', 'row-pct dim', 'not reported'));
    } else {
      row.append(el('div', 'row-pct', `${w.utilization.toFixed(0)}%`));
      const meter = el('div', 'row-meter');
      const fill = el('i', hot(w) ? 'hot' : null);
      fill.style.width = `${Math.min(100, Math.max(1.5, w.utilization))}%`;
      meter.append(fill);
      row.append(meter);
    }

    row.append(el('div', 'row-caption', resetText(w.resetsAt)));
    rows.append(row);
  }

  const extra = account.limits?.extraUsage;
  if (extra?.enabled) {
    const row = el('div', 'row');
    row.append(el('div', 'row-name', 'Extra usage'));
    row.append(el('div', 'row-pct', `${(extra.utilization ?? 0).toFixed(0)}%`));
    const meter = el('div', 'row-meter');
    const fill = el('i');
    fill.style.width = `${Math.min(100, Math.max(1.5, extra.utilization ?? 0))}%`;
    meter.append(fill);
    row.append(meter, el('div', 'row-caption', `${extra.usedCredits} ${extra.currency} credits used`));
    rows.append(row);
  }
}

function renderUnavailable(account) {
  $('primary').hidden = true;
  const rows = $('rows');
  clear(rows);

  const note = el('div', 'state-note');
  if (account?.status === 'expired') {
    note.append(document.createTextNode('Your Claude login expired. Run '));
    note.append(el('code', null, 'claude'));
    note.append(document.createTextNode(' in a terminal to refresh it, then hit refresh above.'));
  } else if (account?.status === 'missing') {
    note.append(document.createTextNode('No Claude Code login found. Run '));
    note.append(el('code', null, 'claude'));
    note.append(document.createTextNode(' and sign in with your Claude account, then hit refresh.'));
  } else if (account?.status === 'connected') {
    const retry = account.retryInMs ? ` Retrying in ~${Math.ceil(account.retryInMs / 60_000)}m.` : '';
    note.textContent = `Usage limits unavailable.${retry}`;
  } else {
    note.textContent = `Claude account unreachable: ${account?.error ?? 'unknown error'}`;
  }
  rows.append(note);
}

const WINDOW_NAMES = { session: 'session', weekly_all: 'weekly' };

/**
 * The window that runs out first, if any does.
 *
 * Projections come from the readings on disk and cover every window, so the
 * weekly limit can be the one worth warning about even while the session window
 * is comfortable — and it is the worse one to walk into, since it ruins a week
 * rather than an afternoon.
 */
function bindingProjection(account) {
  const rows = Object.values(account?.projections ?? {}).filter((p) => p.willExhaustBeforeReset);
  if (!rows.length) return null;
  return rows.sort((a, b) => a.exhaustsAt - b.exhaustsAt)[0];
}

function renderAlert(account) {
  const alert = $('alert');
  // `burn` is the in-memory series and only knows the session window; it stands
  // in until enough readings are on disk to project from.
  const projection = bindingProjection(account);
  const burn = projection ?? (account?.burn?.willExhaustBeforeReset ? account.burn : null);

  // Only warn on a measured rate that actually runs out before the window resets.
  if (!burn) {
    alert.hidden = true;
    return;
  }

  const mins = burn.minutesToExhaust;
  const when = mins < 60 ? `${Math.max(1, Math.round(mins))}m` : `${(mins / 60).toFixed(1)}h`;
  const which = WINDOW_NAMES[burn.key] ?? (burn.key?.startsWith('weekly_scoped:') ? burn.key.split(':')[1] : 'session');
  alert.hidden = false;
  clear(alert);
  alert.append(document.createTextNode('at '));
  alert.append(el('b', null, `${burn.ratePerHour.toFixed(1)}%/hr`));
  alert.append(document.createTextNode(` you'll hit the ${which} limit in ${when}`));
}

function render(account) {
  const a = account?.account;

  const plan = $('plan');
  const tier = a?.rateLimitTier?.match(/(\d+x)$/)?.[1];
  const planText = a?.hasMax ? `Max${tier ? ` ${tier}` : ''}` : a?.hasPro ? 'Pro' : null;
  plan.hidden = !planText;
  if (planText) plan.textContent = planText;

  renderAlert(account);

  const windows = account?.limits?.windows ?? [];
  if (account?.status !== 'connected' || !windows.length) {
    renderUnavailable(account);
  } else {
    const session = windows.find(isSession) ?? windows[0];
    renderPrimary(account, session);
    renderRows(account, windows.filter((w) => w !== session));
  }

  const foot = $('updated');
  foot.textContent = account?.limitsStale
    ? `cached · ${ago(account.limitsFetchedAt).replace('updated ', '')}`
    : ago(account?.limitsFetchedAt);

  // Let the window shrink-wrap whatever we just drew.
  api?.resize?.(Math.ceil($('panel').getBoundingClientRect().height));
}

async function load() {
  try {
    render(await api.getAccount());
  } catch (err) {
    render({ status: 'error', error: err?.message ?? 'Bridge unavailable' });
  }
}

$('btn-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spinning');
  try {
    render(await api.refresh());
  } catch {
    await load();
  } finally {
    btn.classList.remove('spinning');
  }
});

$('btn-open').addEventListener('click', () => api.openDashboard());
$('btn-quit').addEventListener('click', () => api.quit());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
});

// The main process tells us to re-read whenever it reopens the popover.
api?.onShow?.(load);
load();
