// Detectors — the two additions that look at the data and say
// something, rather than just drawing it.
//
// Both are deliberately conservative: they render nothing at all when they have
// nothing to say, and neither one ever prints an absolute that has to reconcile
// with the figure set on the page (the cache badge prints a rate, the movers
// strip prints a ratio). That keeps the sum-exactness invariant untouched.

// ---- cache health ----------------------------------------------------------
//
// The metric is UNCACHED INPUT TOKENS PER REQUEST. In a workload that re-sends
// the same context every turn — which is every agent loop here — prompt caching
// should drive this to near zero: the context is written once and read back.
// A project sitting in the thousands is paying full freight for context it
// already paid for.
//
// Thresholds are ABSOLUTE, not relative to the other projects. A project can be
// 20× the median and still be trivially cheap (48 tokens a request is nothing);
// what matters is whether the number is large enough to be real money and real
// window burn. The observed spread on this warehouse: most projects sit at 2–50
// uncached input tokens per request, one sits near 9,800.

export const CACHE_RED = 2000;
export const CACHE_AMBER = 300;
export const CACHE_MIN_REQUESTS = 25; // below this the rate is noise, not a signal

export function cacheHealth(entry) {
  const requests = Number(entry && entry.requests) || 0;
  const flows = (entry && entry.flows) || {};
  const uncached = Number(flows.inputUncached) || 0;
  const read = Number(flows.inputCacheRead) || 0;
  const write = Number(flows.inputCacheWrite) || 0;
  const input = uncached + read + write;
  if (!requests || requests < CACHE_MIN_REQUESTS || !input) {
    return { level: 'unknown', perRequest: 0, readShare: 0, requests, uncached, read, write };
  }
  const perRequest = uncached / requests;
  const level = perRequest >= CACHE_RED ? 'red' : perRequest >= CACHE_AMBER ? 'amber' : 'ok';
  return { level, perRequest, readShare: read / input, requests, uncached, read, write };
}

/**
 * Whether a caching reading is worth flagging. One predicate, so a card cannot
 * decide it differently from the headline above it or from the note below it —
 * and so the "caching weak" wording is unreachable for a healthy entity at the
 * call site, rather than only because Badge declines to render an 'ok' level.
 */
export function cacheFlagged(health) {
  return !!health && (health.level === 'red' || health.level === 'amber');
}

/**
 * The cohort's own typical rate, for the drill's "everything else runs at" line.
 * Median of the projects the detector calls healthy, so one broken project
 * cannot drag the comparison it is being measured against.
 */
export function cacheCohort(entries) {
  const rates = entries
    .map((entry) => cacheHealth(entry))
    .filter((health) => health.level === 'ok')
    .map((health) => health.perRequest)
    .sort((a, b) => a - b);
  if (!rates.length) return null;
  const middle = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[middle] : (rates[middle - 1] + rates[middle]) / 2;
}

// ---- movers ----------------------------------------------------------------
//
// "What changed": projects burning at ≥ MOVER_FACTOR× the pace they held over
// the trailing window before the selected slice.
//
// Measured on CORPUS TOKENS PER DAY on both sides, because that is the axis the
// project dimension lives on and the only one that exists before the selected
// range was loaded. It is a ratio of like to like, and the strip prints only the
// ratio — never a subscriptions or dollar figure that would owe the page a sum.
//
// Pace, not total, so a 1-day selection can be compared against a 30-day
// baseline honestly. The baseline denominator is ELAPSED days in the window, not
// active days: a project that ran one furious day in thirty was, on average over
// that month, quiet.

export const MOVER_FACTOR = 2;
export const MOVER_MIN_SHARE = 0.01; // 1% of the slice, or it is not worth a row
export const MOVER_MIN_BASELINE_DAYS = 3;

/**
 * rows      : [{ entry, tokens }] for the current slice
 * sliceDays : elapsed days in the current selection
 * baseline  : { days, firstDay, lastDay, tokensByProject: Map }
 */
export function movers({ rows, sliceDays, baseline }) {
  if (!baseline || !(baseline.days >= MOVER_MIN_BASELINE_DAYS) || !(sliceDays > 0)) return [];
  const sliceTotal = rows.reduce((sum, row) => sum + (row.tokens || 0), 0);
  if (!sliceTotal) return [];
  const out = [];
  for (const row of rows) {
    const tokens = row.tokens || 0;
    if (!tokens) continue;
    if (tokens / sliceTotal < MOVER_MIN_SHARE) continue;
    const slicePace = tokens / sliceDays;
    const before = baseline.tokensByProject.get(row.entry.key) || 0;
    const basePace = before / baseline.days;
    if (!basePace) {
      // A ZERO BASELINE IS ONLY EVIDENCE WHEN THE WINDOW WAS COVERED. With the
      // baseline clamped to where continuous ingestion
      // starts, "nothing before this" cannot be told apart from "not ingested
      // yet" — and every project that began after ingestion did reads as new,
      // which is how the strip filled with five rows that said nothing about
      // what changed. Under a clamped baseline the strip reports only measured
      // ratios; under a fully covered one, a new project is genuinely new.
      if (baseline.clamped) continue;
      out.push({ entry: row.entry, ratio: Infinity, isNew: true, tokens, slicePace, basePace });
      continue;
    }
    const ratio = slicePace / basePace;
    if (ratio < MOVER_FACTOR) continue;
    out.push({ entry: row.entry, ratio, isNew: false, tokens, slicePace, basePace });
  }
  // Loudest first; a brand-new project outranks any finite multiple, and ties
  // between new projects break on volume rather than on map order.
  out.sort((a, b) => (b.ratio - a.ratio) || (b.tokens - a.tokens));
  return out.slice(0, 5);
}

// ---- the "why" term --------------------------------------------------------
//
// The session-anatomy page answers one question in one sentence: what, in this
// session, actually spent the tokens. The sentence is not written — it is
// SELECTED, by the largest term in the session's own token classes, so it can
// never flatter the data or say the same thing about every session.
//
// The four normalized token classes are disjoint and partition the measured
// token flow exactly. Claude records these as separate fields. Codex reports
// cached_input_tokens as a subset of input_tokens, so the backend maps fresh
// input to input_tokens - cached_input_tokens and keeps cache writes additive:
//
//   contextRead   cached input                 context re-processed
//   contextWrite  cache-write input            context written into cache
//   freshInput    input excluding cache reads  context never cached at all
//   output        output                       what the model generated
//
// so the largest is a fact about where the tokens went, not a judgement. Two
// facts travel with it and are what make the sentence actionable rather than
// merely true: the REQUEST COUNT and the AVERAGE CONTEXT those requests carried
// (the product of the two is the context burn), and the SUBAGENT SHARE, which
// says whether the spending happened in the main loop or in lanes it launched.

export const WHY_TERMS = {
  contextRead: 'context re-reading',
  contextWrite: 'cache writes',
  freshInput: 'uncached input',
  output: 'output',
};

export function whyTerm(totals) {
  if (!totals || !(totals.tokens > 0) || !(totals.requests > 0)) return null;
  const classes = [
    { term: 'contextRead', tokens: totals.inputCacheRead || 0 },
    { term: 'contextWrite', tokens: totals.inputCacheWrite || 0 },
    { term: 'freshInput', tokens: totals.inputUncached || 0 },
    { term: 'output', tokens: totals.output || 0 },
  ];
  let leader = classes[0];
  for (const entry of classes) if (entry.tokens > leader.tokens) leader = entry;
  const laneTokens = totals.laneTokens || 0;
  return {
    term: leader.term,
    label: WHY_TERMS[leader.term],
    tokens: leader.tokens,
    share: leader.tokens / totals.tokens,
    requests: totals.requests,
    avgContext: (totals.contextSum || 0) / totals.requests,
    maxContext: totals.contextMax || 0,
    laneShare: laneTokens / totals.tokens,
    laneTokens,
    lanes: totals.lanes || 0,
    // The runners-up, so the ⓘ can show the selection rather than assert it.
    ranked: classes.slice().sort((a, b) => b.tokens - a.tokens)
      .map((entry) => ({ ...entry, label: WHY_TERMS[entry.term], share: entry.tokens / totals.tokens })),
  };
}

export function formatMultiple(ratio) {
  if (!Number.isFinite(ratio)) return 'new';
  return '+' + (ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)) + '×';
}
