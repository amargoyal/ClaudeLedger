// Public Anthropic API list prices, USD per million tokens.
//
// A Max subscription is flat-rate, so none of this is billed to you. The
// dashboard uses it to answer "what would this usage have cost on the API?",
// which is the only meaningful way to put a dollar figure on token spend.
//
// Cache multipliers are relative to the model's input price:
//   read     0.1x
//   write 5m 1.25x
//   write 1h 2x
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

/**
 * Introductory rates that expire. Claude Sonnet 5 launched at $2/$10 per MTok
 * through 2026-08-31, reverting to $3/$15 after. Costing a message uses the rate
 * in force at the message's own timestamp, so historical spend stays correct once
 * the promotion lapses.
 */
const SONNET_5_INTRO_ENDS = Date.parse('2026-09-01T00:00:00Z');

const PRICING = {
  'claude-fable-5': { in: 10, out: 50, label: 'Fable 5', tier: 'fable' },
  'claude-mythos-5': { in: 10, out: 50, label: 'Mythos 5', tier: 'fable' },
  // Not in Anthropic's published pricing table at time of writing; priced at
  // the Opus tier and flagged so the UI can mark it as an estimate.
  'claude-opus-5': { in: 5, out: 25, label: 'Opus 5', tier: 'opus', estimated: true },
  'claude-opus-4-8': { in: 5, out: 25, label: 'Opus 4.8', tier: 'opus' },
  'claude-opus-4-7': { in: 5, out: 25, label: 'Opus 4.7', tier: 'opus' },
  'claude-opus-4-6': { in: 5, out: 25, label: 'Opus 4.6', tier: 'opus' },
  'claude-opus-4-5': { in: 5, out: 25, label: 'Opus 4.5', tier: 'opus' },
  'claude-opus-4-1': { in: 15, out: 75, label: 'Opus 4.1', tier: 'opus' },
  'claude-sonnet-5': {
    in: 3,
    out: 15,
    intro: { in: 2, out: 10, until: SONNET_5_INTRO_ENDS },
    label: 'Sonnet 5',
    tier: 'sonnet',
  },
  'claude-sonnet-4-6': { in: 3, out: 15, label: 'Sonnet 4.6', tier: 'sonnet' },
  'claude-sonnet-4-5': { in: 3, out: 15, label: 'Sonnet 4.5', tier: 'sonnet' },
  'claude-sonnet-4-0': { in: 3, out: 15, label: 'Sonnet 4', tier: 'sonnet' },
  'claude-haiku-4-5': { in: 1, out: 5, label: 'Haiku 4.5', tier: 'haiku' },
  'claude-3-haiku': { in: 0.25, out: 1.25, label: 'Haiku 3', tier: 'haiku' },
};

const UNKNOWN = { in: 0, out: 0, label: 'Unknown', tier: 'other', estimated: true };

// Colors mirror the Ledger palette: terracotta for the dominant tier, deep
// terracotta for the premium tier, green for the cheap tier, sand for the rest.
const TIER_COLORS = {
  fable: 'oklch(0.38 0.11 45)',
  opus: 'oklch(0.60 0.13 45)',
  sonnet: 'oklch(0.52 0.09 265)',
  haiku: 'oklch(0.60 0.10 155)',
  other: '#C9BFAE',
};

/**
 * Strip the decorations Claude Code adds to a model id: a `[1m]` context-window
 * marker and a trailing `-YYYYMMDD` snapshot date.
 */
export function normalizeModel(raw) {
  if (!raw) return null;
  let id = String(raw).trim();
  id = id.replace(/\[[^\]]*\]$/, '');
  id = id.replace(/-\d{8}$/, '');
  return id;
}

export function lookupModel(raw) {
  const id = normalizeModel(raw);
  if (!id) return { id: 'unknown', ...UNKNOWN, color: TIER_COLORS.other };
  if (PRICING[id]) {
    const entry = PRICING[id];
    return { id, ...entry, color: TIER_COLORS[entry.tier] };
  }
  // Longest-prefix fallback so a future `claude-opus-4-9` still lands in the
  // right ballpark rather than showing as free.
  const prefix = Object.keys(PRICING)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) {
    const entry = PRICING[prefix];
    return { id, ...entry, estimated: true, color: TIER_COLORS[entry.tier] };
  }
  return { id, ...UNKNOWN, label: prettyFallback(id), color: TIER_COLORS.other };
}

function prettyFallback(id) {
  return id.replace(/^claude-/, '').replace(/-/g, ' ');
}

/**
 * Input/output $/MTok for a model at a given moment, honouring any introductory
 * rate that was in force then.
 */
export function ratesFor(raw, at = Date.now()) {
  const m = lookupModel(raw);
  if (m.intro && at < m.intro.until) {
    return { in: m.intro.in, out: m.intro.out, introApplied: true };
  }
  return { in: m.in, out: m.out, introApplied: false };
}

/**
 * Equivalent API cost in USD for one message's token usage.
 * `at` is the message's timestamp — not now — so a rate change doesn't silently
 * rewrite what past usage would have cost.
 */
export function costOf(usage, raw, at = Date.now()) {
  const r = ratesFor(raw, at);
  if (!r.in && !r.out) return 0;
  const perTok = (dollarsPerMTok) => dollarsPerMTok / 1e6;
  return (
    usage.inputTokens * perTok(r.in) +
    usage.outputTokens * perTok(r.out) +
    usage.cacheRead * perTok(r.in) * CACHE_READ_MULT +
    usage.cacheCreate5m * perTok(r.in) * CACHE_WRITE_5M_MULT +
    usage.cacheCreate1h * perTok(r.in) * CACHE_WRITE_1H_MULT
  );
}

export { PRICING, TIER_COLORS };
