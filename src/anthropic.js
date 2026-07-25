import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { record as recordHistory } from './history.js';
import { readCredentials } from './credentials.js';

const BASE = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';

/**
 * Where the last good account response is persisted.
 *
 * This exists because the cache used to live only in memory: every app restart
 * threw it away, refetched both endpoints, and a few restarts in quick succession
 * were enough to trip the usage endpoint's rate limit — at which point a cold
 * start had no fallback and the limits panel rendered empty. Persisting means a
 * fresh launch shows the last known values immediately, marked stale, and only
 * goes to the network once the TTL has actually elapsed.
 *
 * Contains account metadata and utilization numbers only. The OAuth token is
 * never written here — it stays in the keychain.
 */
const CACHE_FILE =
  process.env.CLAUDE_LEDGER_CACHE_FILE ?? join(homedir(), '.claude-ledger', 'account-cache.json');

/**
 * Cache lifetimes. These are deliberately long: the usage endpoint rate-limits,
 * and utilization does not move second to second (reset times are absolute
 * timestamps, so the countdown is computed client-side from a cached value).
 */
const TTL = {
  profile: 30 * 60_000,
  usage: 5 * 60_000,
};

const BACKOFF_MIN = 5 * 60_000;
const BACKOFF_MAX = 30 * 60_000;

// OAuth tokens go on Authorization: Bearer and require the oauth beta header.
function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  };
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(token) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return body;
}

/** key -> { value, fetchedAt }. Last good value is kept indefinitely. */
const store = new Map();
/**
 * key -> { until, ms }. Backoff is per-endpoint, not global.
 *
 * It was global at first, and that was a bug: `profile` and `usage` are fetched
 * concurrently, so when `usage` was rate limited and `profile` succeeded, the
 * success path reset the shared backoff to zero and the next poll retried
 * immediately — holding the rate limit open indefinitely instead of backing off.
 * In practice the limit applies to one endpoint at a time, so the state has to be
 * tracked per key.
 */
const backoff = new Map();
/**
 * Rolling samples of the session window's utilization, used to derive a burn rate
 * (%/hr) and project when the limit will be hit. The API reports a level, not a
 * rate, so the only way to get a rate is to remember previous readings.
 */
let samples = [];
const MAX_SAMPLES = 120;
let loaded = false;

function backoffFor(key) {
  return backoff.get(key) ?? { until: 0, ms: 0 };
}

/** Read the persisted cache once, on first use. Any problem is non-fatal. */
function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const disk = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    for (const [key, entry] of Object.entries(disk.entries ?? {})) {
      if (entry && typeof entry.fetchedAt === 'number') store.set(key, entry);
    }
    // Carry backoffs across restarts, so relaunching can't be used to bypass one.
    for (const [key, state] of Object.entries(disk.backoff ?? {})) {
      if (state && typeof state.until === 'number' && state.until > Date.now()) {
        backoff.set(key, { until: state.until, ms: Number(state.ms) || 0 });
      }
    }
    if (Array.isArray(disk.samples)) samples = disk.samples.filter((s) => s && typeof s.t === 'number');
  } catch {
    // No cache yet, or unreadable — start clean.
  }
}

function saveCache() {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({
        entries: Object.fromEntries(store),
        backoff: Object.fromEntries(backoff),
        samples,
      }),
      { mode: 0o600 },
    );
  } catch {
    // A read-only home directory shouldn't break the app; the in-memory cache
    // still works for this session.
  }
}

/**
 * Fetch with a TTL cache that degrades to stale-but-valid rather than to nothing.
 *
 * A rate-limited or failed refresh must not blank the dashboard: the previously
 * fetched value is still the best information available, so it is returned with
 * `stale: true` and the caller decides how to label it. Only a failure with no
 * prior value at all propagates as an error.
 */
async function cached(key, ttl, fn) {
  loadCache();
  const hit = store.get(key);
  const now = Date.now();

  if (hit && now - hit.fetchedAt < ttl) {
    return { value: hit.value, stale: false, fetchedAt: hit.fetchedAt };
  }

  // While backing off, don't add load — serve what we have.
  const waiting = backoffFor(key);
  if (now < waiting.until) {
    if (hit) {
      return { value: hit.value, stale: true, fetchedAt: hit.fetchedAt, reason: 'rate limited' };
    }
    const mins = Math.ceil((waiting.until - now) / 60_000);
    throw new Error(`Rate limited by the Claude API. Retrying in about ${mins}m.`);
  }

  try {
    const value = await fn();
    // Only this key's backoff clears — a sibling endpoint may still be limited.
    backoff.delete(key);
    const fetchedAt = Date.now();
    store.set(key, { value, fetchedAt });
    saveCache();
    return { value, stale: false, fetchedAt };
  } catch (err) {
    if (err.status === 429 || err.status === 529) {
      const ms = Math.min(BACKOFF_MAX, err.retryAfterMs ?? (waiting.ms ? waiting.ms * 2 : BACKOFF_MIN));
      backoff.set(key, { until: Date.now() + ms, ms });
      saveCache();
    }
    if (hit) {
      return { value: hit.value, stale: true, fetchedAt: hit.fetchedAt, reason: err.message };
    }
    throw err;
  }
}

/**
 * Force the next call to refetch, without discarding what we already have.
 *
 * Deliberately expires entries instead of deleting them: the last good value is
 * the fallback the stale path depends on, so clearing the store outright would
 * turn "refresh failed" back into "no data" — which is the bug this whole layer
 * exists to prevent. The rate-limit backoff is preserved too; a manual refresh
 * shouldn't let the user hammer an endpoint that already asked us to stop.
 */
export function invalidateAccountCache() {
  loadCache();
  for (const entry of store.values()) entry.fetchedAt = 0;
}

function sessionWindow(limits) {
  return limits?.windows?.find((w) => w.group === 'session' || w.kind === 'session' || w.key === 'five_hour') ?? null;
}

/** Remember a fresh session-window reading so a rate can be derived later. */
function recordSample(limits) {
  const session = sessionWindow(limits);
  if (!session || session.utilization == null) return;

  const last = samples[samples.length - 1];
  // A changed reset time means the window rolled over; the old series no longer
  // describes the current one, and keeping it would show a negative burn rate.
  if (last && last.resetsAt !== session.resetsAt) samples = [];

  const now = Date.now();
  const latest = samples[samples.length - 1];
  if (latest && latest.percent === session.utilization && now - latest.t < 60_000) return;

  samples.push({ t: now, percent: session.utilization, resetsAt: session.resetsAt });
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
}

/**
 * Burn rate for the session window, or null when there isn't enough history to
 * say anything honest. Requires two readings at least three minutes apart within
 * the same window.
 */
function computeBurn(limits) {
  const session = sessionWindow(limits);
  if (!session || session.utilization == null) return null;

  const series = samples.filter((s) => s.resetsAt === session.resetsAt);
  if (series.length < 2) return null;

  const first = series[0];
  const last = series[series.length - 1];
  const hours = (last.t - first.t) / 3_600_000;
  if (hours < 0.05) return null;

  const ratePerHour = (last.percent - first.percent) / hours;
  if (!(ratePerHour > 0)) return null;

  const remaining = Math.max(0, 100 - session.utilization);
  const minutesToExhaust = (remaining / ratePerHour) * 60;
  const resetsInMinutes = session.resetsAt
    ? Math.max(0, (Date.parse(session.resetsAt) - Date.now()) / 60_000)
    : null;

  return {
    ratePerHour,
    minutesToExhaust,
    // Only a warning if the limit would run out before the window resets.
    willExhaustBeforeReset: resetsInMinutes != null && minutesToExhaust < resetsInMinutes,
    sampleCount: series.length,
  };
}

/**
 * The recorded readings for the current session window, oldest first. Drives the
 * popover's sparkline — a rate is only visible if you remember past levels.
 */
function sessionHistory(limits) {
  const session = sessionWindow(limits);
  if (!session) return [];
  return samples
    .filter((s) => s.resetsAt === session.resetsAt)
    .slice(-40)
    .map((s) => ({ t: s.t, percent: s.percent }));
}

/** Milliseconds until the given endpoint's backoff expires, or 0 if not backing off. */
export function backoffRemaining(key = 'usage') {
  loadCache();
  return Math.max(0, backoffFor(key).until - Date.now());
}

/**
 * Account identity + usage limits, read with your Claude account's own OAuth
 * token. Returns `{ status, account?, limits?, ... }` and never throws — a dead
 * network shouldn't take the dashboard down, since every other panel is local.
 */
export async function fetchAccount() {
  const creds = await readCredentials();
  if (!creds) return { status: 'missing' };
  if (creds.expiresAt != null && creds.expiresAt <= Date.now()) {
    return { status: 'expired', subscriptionType: creds.subscriptionType };
  }

  const token = creds.accessToken;
  const settle = (p) => p.then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, error: e.message }));

  const [profile, usage] = await Promise.all([
    settle(cached('profile', TTL.profile, () => get('/api/oauth/profile', token))),
    settle(cached('usage', TTL.usage, () => get('/api/oauth/usage', token))),
  ]);

  if (!profile.ok && !usage.ok) {
    return {
      status: 'error',
      error: usage.error ?? profile.error,
      subscriptionType: creds.subscriptionType,
      retryInMs: backoffRemaining(),
    };
  }

  const warnings = [];
  if (!profile.ok) warnings.push(`Profile unavailable: ${profile.error}`);
  if (!usage.ok) warnings.push(`Usage limits unavailable: ${usage.error}`);
  if (usage.ok && usage.stale) warnings.push(`Usage limits are cached (${usage.reason}).`);

  const limits = usage.ok ? shapeUsage(usage.value) : null;
  // Only a genuinely fresh reading advances the burn-rate series; replaying a
  // cached value would invent a flat rate.
  if (limits && !usage.stale) {
    recordSample(limits);
    saveCache();
    // Time series for the limit lines on the token chart.
    recordHistory(limits);
  }

  return {
    status: 'connected',
    source: creds.source,
    subscriptionType: creds.subscriptionType,
    scopes: creds.scopes,
    tokenExpiresAt: creds.expiresAt,
    account: profile.ok ? shapeProfile(profile.value) : null,
    limits,
    burn: computeBurn(limits),
    sessionHistory: sessionHistory(limits),
    limitsStale: Boolean(usage.ok && usage.stale),
    limitsFetchedAt: usage.ok ? usage.fetchedAt : null,
    retryInMs: backoffRemaining(),
    warnings,
  };
}

function shapeProfile(p) {
  const a = p?.account ?? {};
  const o = p?.organization ?? {};
  return {
    email: a.email ?? null,
    displayName: a.display_name ?? a.full_name ?? null,
    hasMax: Boolean(a.has_claude_max),
    hasPro: Boolean(a.has_claude_pro),
    memberSince: a.created_at ?? null,
    organization: o.name ?? null,
    organizationType: o.organization_type ?? null,
    rateLimitTier: o.rate_limit_tier ?? null,
    subscriptionStatus: o.subscription_status ?? null,
    extraUsageEnabled: Boolean(o.has_extra_usage_enabled),
  };
}

/**
 * The usage payload describes limits two ways.
 *
 * The authoritative one is a `limits` array of `{kind, group, percent, severity,
 * resets_at, scope, is_active}` entries — this is where model-scoped caps live
 * (e.g. `kind: "weekly_scoped"` with `scope.model.display_name: "Fable"`).
 *
 * The legacy shape is a set of top-level keys (`five_hour`, `seven_day`,
 * `seven_day_opus`, …). On current plans the scoped legacy keys are all null,
 * which is misleading: reading only those makes it look like no per-model limit
 * exists when the array reports one. So the array wins when present, and the flat
 * keys are the fallback for older responses.
 */
const LEGACY_LABELS = {
  five_hour: 'Current Session',
  seven_day: 'Weekly Limit',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_cowork: 'Weekly (Cowork)',
};

const KIND_LABELS = {
  session: 'Current Session',
  weekly_all: 'Weekly Limit',
  weekly_scoped: 'Weekly (scoped)',
};

function humanizeKey(key) {
  const label = key.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Map one entry of the `limits` array onto a window. */
function windowFromLimit(entry, index) {
  const model = entry.scope?.model?.display_name ?? null;
  const surface = entry.scope?.surface ?? null;
  const label = model ?? (surface ? humanizeKey(String(surface)) : KIND_LABELS[entry.kind]) ?? humanizeKey(entry.kind ?? `limit ${index}`);
  return {
    key: model ? `${entry.kind}:${model}` : (entry.kind ?? `limit_${index}`),
    label,
    group: entry.group ?? null,
    kind: entry.kind ?? null,
    scopeModel: model,
    utilization: entry.percent != null ? Number(entry.percent) : null,
    resetsAt: entry.resets_at ?? null,
    severity: entry.severity ?? 'normal',
    isActive: Boolean(entry.is_active),
  };
}

function shapeUsage(u) {
  if (!u || typeof u !== 'object') return null;

  const windows = [];

  if (Array.isArray(u.limits) && u.limits.length) {
    u.limits.forEach((entry, i) => {
      if (entry && typeof entry === 'object') windows.push(windowFromLimit(entry, i));
    });
  } else {
    // Legacy fallback: flat keys, in a sensible display order.
    const order = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
    const seen = new Set();
    const push = (key, w) => {
      if (seen.has(key) || !w || typeof w !== 'object') return;
      seen.add(key);
      windows.push({
        key,
        label: LEGACY_LABELS[key] ?? humanizeKey(key),
        group: key === 'five_hour' ? 'session' : 'weekly',
        kind: key,
        scopeModel: null,
        utilization: w.utilization != null ? Number(w.utilization) : null,
        resetsAt: w.resets_at ?? null,
        severity: 'normal',
        isActive: key === 'five_hour',
      });
    };
    for (const key of order) push(key, u[key]);
    for (const [key, w] of Object.entries(u)) {
      if (key === 'extra_usage' || key === 'spend' || key === 'limits') continue;
      if (!w || typeof w !== 'object' || w.utilization == null) continue;
      push(key, w);
    }
  }

  const extra = u.extra_usage ?? null;
  return {
    windows,
    extraUsage: extra
      ? {
          enabled: Boolean(extra.is_enabled),
          usedCredits: extra.used_credits ?? 0,
          monthlyLimit: extra.monthly_limit ?? null,
          utilization: extra.utilization ?? null,
          currency: extra.currency ?? 'USD',
          disabledReason: extra.disabled_reason ?? null,
        }
      : null,
  };
}
