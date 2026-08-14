// Data pipeline for the Overview. Everything the page renders is derived here
// so a figure and its parts are computed once and can never disagree.
//
// Two universes, kept apart on purpose:
//   * provider truth  — /api/usage/history (window levels) and /api/usage/summary
//                       (the proxy warehouse). MEASURED. Prices attach here only.
//   * session corpus  — /api/usage/projects. Carries the project axis, which
//                       provider truth does not have.
// The pool's measured burn is apportioned across the corpus; the corpus never
// produces an absolute of its own.

import { getJSON, query, boundsFor, resolutionFor } from './api.js';
import { localHourKey, localDayKey, parseLocalKey, baseName } from './format.js';
import { costOf } from './prices.js';

export const TOKEN_CLASSES = ['inputUncached', 'inputCacheRead', 'inputCacheWrite', 'outputTotal'];
export const FIT_FLOOR = 0.3;
export const TOP_PROJECTS = 6;
export const WORKTREE_MARKERS = ['/.claude/worktrees/', '/.worktrees/'];
export const UNATTRIBUTED = 'unattributed';
// The floor for a pool that holds no accounts yet. Never a ceiling: every
// provider-keyed derivation reads the pool's own accounts (#411).
export const KNOWN_PROVIDERS = ['claude', 'codex'];

/**
 * Largest-remainder rounding.
 *
 * The decider adds the column up by hand, so the PRINTED figures have to sum to
 * the printed total. A dozen independently rounded values do not.
 */
export function allocateRounded(values, total, places) {
  const factor = Math.pow(10, places);
  const target = Math.round(total * factor);
  const scaled = values.map((value) => Math.max(0, value) * factor);
  const floors = scaled.map((value) => Math.floor(value));
  const order = scaled
    .map((value, index) => ({ index, remainder: value - floors[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  let drift = target - floors.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  while (drift > 0 && order.length) {
    floors[order[cursor % order.length].index] += 1;
    drift -= 1;
    cursor += 1;
  }
  let guard = order.length * 4;
  cursor = order.length - 1;
  while (drift < 0 && order.length && guard > 0) {
    const index = order[((cursor % order.length) + order.length) % order.length].index;
    if (floors[index] > 0) {
      floors[index] -= 1;
      drift += 1;
    }
    cursor -= 1;
    guard -= 1;
  }
  return floors.map((value) => value / factor);
}

/**
 * THE ONE PROJECT DERIVATION, shared by the landing and the drill (issue #386).
 *
 * Every level of this dashboard partitions the same measured pool total, and the
 * decider checks that by hand — so the landing's block for a project and the
 * drill's headline for that project have to be the SAME number, not two numbers
 * computed two ways that happen to agree on this warehouse. They are the same
 * number because they are the same function: this one.
 *
 * Returns a Map keyed by project key (plus '__untraced'), each holding a
 * per-bucket Map of that project's value in the current lens unit.
 */
export function projectValueSeries(model, isCost) {
  const out = new Map();
  for (const entry of model.projects) out.set(entry.key, new Map());
  out.set('__untraced', new Map());

  for (const bucket of model.buckets) {
    const poolBurn = model.pool.byBucket.get(bucket) || 0;
    const untraced = model.pool.untracedByBucket.get(bucket) || 0;
    const bucketTotal = isCost ? (model.cost.byBucket.get(bucket) || 0) : poolBurn;
    const traceableShare = poolBurn > 0 ? Math.max(0, poolBurn - untraced) / poolBurn : 0;
    const traceableTotal = isCost ? bucketTotal * traceableShare : Math.max(0, poolBurn - untraced);

    const corpus = model.corpusByBucket.get(bucket) || 0;
    // With no corpus activity in this bucket there is nothing to apportion to,
    // so the whole bucket is untraceable. Letting the rounding absorb the
    // difference instead would silently hand it to an arbitrary project.
    const traceable = corpus > 0 ? traceableTotal : 0;
    const residual = Math.max(0, bucketTotal - traceable);
    const exact = model.projects.map((entry) => (
      corpus > 0 ? traceable * ((entry.byBucket.get(bucket) || 0) / corpus) : 0
    ));
    const rounded = allocateRounded(exact.concat([residual]), bucketTotal, isCost ? 2 : 4);
    model.projects.forEach((entry, index) => {
      if (rounded[index] > 0) out.get(entry.key).set(bucket, rounded[index]);
    });
    if (rounded[rounded.length - 1] > 0) out.get('__untraced').set(bucket, rounded[rounded.length - 1]);
  }
  return out;
}

/** Sum a per-bucket map over the current selection. */
export function sumOver(map, buckets, selection) {
  if (!map) return 0;
  let total = 0;
  for (const bucket of buckets) {
    if (selection && (bucket < selection.from || bucket > selection.to)) continue;
    total += map.get(bucket) || 0;
  }
  return total;
}

export function bucketsIn(buckets, selection) {
  if (!selection) return buckets;
  return buckets.filter((bucket) => bucket >= selection.from && bucket <= selection.to);
}

const sumAll = (map) => {
  let total = 0;
  for (const [, value] of map || []) total += value;
  return total;
};

/**
 * THE BLOCKS FOR A DIMENSION THE CORPUS DOES NOT CARRY — accounts, providers
 * (issue #411).
 *
 * Both are MEASURED rather than apportioned: the pool's own per-account rises in
 * the subscriptions lens, the warehouse's own per-provider prices in the cost
 * lens. Both partition exactly the same per-bucket totals projectValueSeries
 * partitions, so switching the dimension can never change the section's total.
 *
 * The single exception is per-account COST: the warehouse prices per MODEL, not
 * per account, so an account takes its provider's measured cost in the share of
 * that provider's measured tokens it actually sent. Cost landing under no
 * resolvable account is never handed to one — it stays in `residual`, the same
 * way untraceable pool burn stays out of the project blocks.
 *
 * Returns { rows: [{ key, name, provider, values }], residual } where every
 * `values` is a per-bucket Map in the current lens unit.
 */
export function dimensionSeries(model, isCost, dimension) {
  const rows = [];
  if (dimension === 'providers') {
    // Whatever providers the data carries — never a fixed pair, so a third
    // provider appears here without a code change.
    const source = isCost ? model.cost.byProviderBucket : model.pool.byProviderBucket;
    for (const [name, values] of source) rows.push({ key: name, name, provider: name, values });
  } else {
    for (const account of model.pool.accounts) {
      rows.push({
        key: String(account.accountId),
        name: account.label || String(account.accountId),
        provider: account.provider,
        values: isCost ? new Map() : (account.byBucket || new Map()),
      });
    }
    if (isCost) {
      const groups = new Map();
      for (const row of rows) {
        if (!groups.has(row.provider)) groups.set(row.provider, []);
        groups.get(row.provider).push(row);
      }
      const tokens = new Map(model.pool.accounts.map(
        (account) => [String(account.accountId), account.tokensByBucket || new Map()],
      ));
      for (const [provider, byBucket] of model.cost.byProviderBucket) {
        const group = groups.get(provider) || [];
        for (const [bucket, value] of byBucket) {
          let denominator = 0;
          for (const row of group) denominator += tokens.get(row.key).get(bucket) || 0;
          if (!(denominator > 0)) continue; // nothing resolvable here — residual
          for (const row of group) {
            const share = tokens.get(row.key).get(bucket) || 0;
            if (share > 0) row.values.set(bucket, value * (share / denominator));
          }
        }
      }
    }
  }

  // ONE largest-remainder pass per bucket, against the SAME per-bucket total
  // projectValueSeries rounds to — which is what makes the section's headline
  // figure identical whichever dimension is on the map. Whatever the rows do not
  // account for becomes the residual block rather than being absorbed into one.
  const residual = new Map();
  const rounded = rows.map(() => new Map());
  for (const bucket of model.buckets) {
    const total = (isCost ? model.cost.byBucket.get(bucket) : model.pool.byBucket.get(bucket)) || 0;
    const exact = rows.map((row) => row.values.get(bucket) || 0);
    const rest = Math.max(0, total - exact.reduce((sum, value) => sum + value, 0));
    const shares = allocateRounded(exact.concat([rest]), total, isCost ? 2 : 4);
    rows.forEach((row, index) => {
      if (shares[index] > 0) rounded[index].set(bucket, shares[index]);
    });
    if (shares[shares.length - 1] > 0) residual.set(bucket, shares[shares.length - 1]);
  }
  rows.forEach((row, index) => { row.values = rounded[index]; });
  // Ranked on the FULL range, like the project ranks, so brushing a day never
  // repaints the survivors.
  rows.sort((a, b) => sumAll(b.values) - sumAll(a.values) || String(a.name).localeCompare(String(b.name)));
  return { rows, residual };
}

/**
 * The half-open ISO bounds a chart selection stands for, so the drill can ask
 * the warehouse for exactly the slice the reader brushed rather than filtering
 * whole-session totals after the fact.
 */
export function boundsForSelection(model, selection) {
  if (!selection) return { since: model.since, until: model.until };
  const parse = (key) => parseLocalKey(key) || new Date(model.since);
  const start = parse(selection.from);
  const end = parse(selection.to);
  if (model.resolution === 'hour') end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);
  return { since: start.toISOString(), until: end.toISOString() };
}

// ---- project identity ------------------------------------------------------

export function foldCwd(cwd) {
  if (!cwd) return { parent: null, worktree: null, sub: null };
  for (const marker of WORKTREE_MARKERS) {
    const at = cwd.indexOf(marker);
    if (at === -1) continue;
    const rest = cwd.slice(at + marker.length).split('/').filter(Boolean);
    return { parent: cwd.slice(0, at), worktree: rest[0] || null, sub: rest.slice(1).join('/') || null };
  }
  return { parent: cwd, worktree: null, sub: null };
}

// ModelDeck's own automation directories, which are not projects anyone works
// in — the decider caught 'claude-renewal' rendering as a project of its own.
export const INTERNAL_MARKERS = ['/ModelDeck/claude-renewal', '/ModelDeck/claude-profiles'];
export const INTERNAL_KEY = 'modeldeck-internal';
export const INTERNAL_NAME = 'ModelDeck internals';

export function isInternalPath(path) {
  const text = String(path || '');
  return INTERNAL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Where the internal directories land. They fold into the modeldeck checkout
 * when the range holds one, and otherwise carry one honest label of their own —
 * so no machine-specific path is written into this page.
 */
export function buildKeyResolver(parents) {
  const target = [...parents]
    .filter((key) => !isInternalPath(key) && baseName(key).toLowerCase() === 'modeldeck')
    .sort()[0] || INTERNAL_KEY;
  return (key) => (isInternalPath(key) ? target : key);
}

export function projectKeyOf(row, resolve = (key) => key) {
  if (row.unattributed) return UNATTRIBUTED;
  const folded = foldCwd(row.key);
  const parent = folded.parent;
  if (!parent) return UNATTRIBUTED;
  return resolve(parent);
}

// ---- provider truth: window levels and measured burn -----------------------

const isSpendScope = (scope) => String(scope || '').toLowerCase().includes('spend');
const isWeeklyScope = (scope) => String(scope || '').toLowerCase().includes('weekly') && !isSpendScope(scope);

export function accountWindows(state, provider) {
  const accounts = (state.accounts || [])
    .filter((account) => account.enabled && (!provider || account.provider === provider));
  const usage = state.usage || [];
  const rows = accounts.map((account) => {
    const weekly = usage.filter((row) => (
      row.accountId === account.id && isWeeklyScope(row.scope) && row.usedPercent != null
    ));
    // Worst LEVEL wins; a tie breaks toward the account-wide 'weekly' scope
    // rather than array order (minutes after a reset every scope reads 0%).
    let binding = null;
    for (const row of weekly) {
      if (!binding) { binding = row; continue; }
      const difference = Number(row.usedPercent) - Number(binding.usedPercent);
      if (difference > 0) binding = row;
      else if (difference === 0 && row.scope === 'weekly') binding = row;
    }
    return {
      accountId: account.id,
      label: account.label,
      provider: account.provider,
      binding,
      weeklyScopeNames: weekly.map((row) => row.scope),
      // EVERY weekly limit, not only the binding one. The landing needs the
      // worst level and nothing else; the headroom detail page (charter d2) is
      // where a reader asks which limit is the one that is nearly out, and the
      // burn timeline's limit toggle (#370: "Fable weekly" vs "All weekly") is
      // a choice between exactly these.
      weekly: weekly.map((row) => ({
        scope: row.scope,
        usedPercent: Number(row.usedPercent),
        resetsAt: row.resetsAt || null,
      })).sort((a, b) => b.usedPercent - a.usedPercent || String(a.scope).localeCompare(String(b.scope))),
    };
  });
  rows.sort((a, b) => {
    const left = a.binding ? Number(a.binding.usedPercent) : -1;
    const right = b.binding ? Number(b.binding.usedPercent) : -1;
    return right - left || String(a.label).localeCompare(String(b.label));
  });
  return rows;
}

/**
 * One account's measured burn: the sum of the RISES in "% of subscription used".
 * A drop is a reset, not negative burn, so the post-reset level counts as fresh.
 */
export function burnedSeries(history) {
  const byHour = new Map();
  let percent = 0;
  if (!history || !Array.isArray(history.rows)) return { subscriptions: 0, byHour };
  const series = [...history.rows].reverse(); // the endpoint returns newest-first
  let previous = null;
  for (const row of series) {
    const peak = row.maxUsedPercent != null ? row.maxUsedPercent
      : row.usedPercent != null ? row.usedPercent : row.lastUsedPercent;
    const end = row.lastUsedPercent != null ? row.lastUsedPercent
      : row.usedPercent != null ? row.usedPercent : null;
    if (peak == null || end == null) continue;
    if (previous == null) { previous = end; continue; }
    let rise = peak >= previous ? peak - previous : peak;
    if (end < peak) rise += end; // a reset inside this bucket, then fresh burn
    previous = end;
    if (!(rise > 0)) continue;
    percent += rise;
    const at = new Date(row.bucketStart || row.observedAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = localHourKey(at);
    byHour.set(key, (byHour.get(key) || 0) + rise);
  }
  return { subscriptions: percent / 100, byHour };
}

function poolWeights(estimate) {
  let best = null;
  for (const account of (estimate && estimate.accounts) || []) {
    const fit = (account.fits || []).find((entry) => entry.scope === 'weekly');
    if (!fit || !fit.weights || fit.fitQuality == null) continue;
    if (fit.fitQuality < FIT_FLOOR) continue;
    if (!best || fit.fitQuality > best.fitQuality) {
      best = { weights: fit.weights, fitQuality: fit.fitQuality, label: account.accountLabel };
    }
  }
  return best;
}

// ---- time buckets ----------------------------------------------------------

export function enumerateBuckets(since, until, resolution) {
  const keys = [];
  const start = new Date(since);
  const end = new Date(until);
  if (resolution === 'hour') {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
    while (cursor <= end) {
      keys.push(localHourKey(cursor));
      cursor.setHours(cursor.getHours() + 1);
    }
  } else {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cursor <= end) {
      keys.push(localDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return keys;
}

const toBucket = (hourKey, resolution) => (resolution === 'hour' ? hourKey : hourKey.slice(0, 10));

function addTo(map, key, value) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + value);
}

// ---- the load --------------------------------------------------------------

export async function loadModel({ rangeKey, scope }) {
  const { since, until } = boundsFor(rangeKey);
  const resolution = resolutionFor(rangeKey);
  const provider = scope || null;
  const base = { since, until };

  const [burn, state, estimate] = await Promise.all([
    getJSON('/api/usage/projects?' + query({ ...base, limit: 200, bucket: 'hour', provider })),
    getJSON('/api/state').catch(() => ({ accounts: [], usage: [] })),
    getJSON('/api/usage/estimate?' + query(base)).catch(() => null),
  ]);

  const buckets = enumerateBuckets(since, until, resolution);
  const bucketSet = new Set(buckets);
  // One resolver for every path this range mentions, so the projects table, the
  // per-bucket series and the movers baseline fold identically.
  const resolveKey = buildKeyResolver(
    (burn.projects || []).map((row) => foldCwd(row.key).parent).filter(Boolean),
  );

  // ---- corpus: projects, folded, with a per-bucket token series ----
  const projects = new Map();
  const ensure = (key, row) => {
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        path: key === UNATTRIBUTED || key === INTERNAL_KEY ? null : key,
        name: key === UNATTRIBUTED ? 'Not traceable to a project'
          : key === INTERNAL_KEY ? INTERNAL_NAME : baseName(key),
        unattributed: key === UNATTRIBUTED,
        tokens: 0,
        requests: 0,
        flows: { inputUncached: 0, inputCacheRead: 0, inputCacheWrite: 0, outputTotal: 0 },
        byBucket: new Map(),
        providers: new Set(),
      });
    }
    const entry = projects.get(key);
    if (row) for (const name of row.providers || []) entry.providers.add(name);
    return entry;
  };

  for (const row of burn.projects || []) {
    const key = projectKeyOf(row, resolveKey);
    const entry = ensure(key, row);
    entry.tokens += row.totalTokens || 0;
    entry.requests += row.requests || 0;
    for (const name of TOKEN_CLASSES) entry.flows[name] += (row.tokenFlows && row.tokenFlows[name]) || 0;
  }

  const corpusByBucket = new Map();
  for (const point of burn.series || []) {
    const key = projectKeyOf(point, resolveKey);
    const entry = projects.get(key);
    const bucket = toBucket(point.bucket, resolution);
    if (!bucketSet.has(bucket)) continue;
    if (entry) addTo(entry.byBucket, bucket, point.totalTokens || 0);
    addTo(corpusByBucket, bucket, point.totalTokens || 0);
  }

  // Hour-grain corpus activity, for the untraced test (which is a TIME question).
  const corpusByHour = new Map();
  for (const point of burn.series || []) addTo(corpusByHour, point.bucket, point.totalTokens || 0);

  // ---- provider truth: measured burn per account ----
  const groupBy = resolution === 'hour' ? 'hour' : 'local_day';
  const groupField = resolution === 'hour' ? 'hour' : 'localDay';
  const windows = accountWindows(state, provider);
  const burned = await Promise.all(windows.map(async (entry) => {
    // The account's OWN measured tokens per bucket (issue #411). The pool
    // measures burn per account but the warehouse prices per model, so this is
    // what lets the cost lens split by account without inventing a figure.
    const usage = await getJSON('/api/usage/summary?' + query({
      ...base, groupBy, accountId: entry.accountId,
    })).catch(() => null);
    const tokensByBucket = new Map();
    for (const group of (usage && usage.groups) || []) {
      const bucket = group[groupField];
      if (bucketSet.has(bucket)) addTo(tokensByBucket, bucket, group.total || 0);
    }
    const scopes = entry.weeklyScopeNames.length
      ? entry.weeklyScopeNames
      : (entry.binding ? [entry.binding.scope] : []);
    if (!scopes.length) {
      return { ...entry, subscriptions: 0, byHour: new Map(), tokensByBucket, scope: null, scopes: [] };
    }
    const measured = await Promise.all(scopes.map(async (name) => {
      const history = await getJSON('/api/usage/history?' + query({
        accountId: entry.accountId, scope: name, ...base, bucket: 'hour',
      })).catch(() => null);
      return { scope: name, ...burnedSeries(history) };
    }));
    // Nested weekly limits describe the SAME requests from different angles, so
    // they are never summed — the largest movement is the binding one.
    let best = null;
    for (const candidate of measured) if (!best || candidate.subscriptions > best.subscriptions) best = candidate;
    // `scopes` keeps every limit's own measured series. The landing and the
    // apportionment only ever read `best` — a nested limit describes the SAME
    // requests, so summing them would double-count — but the burn timeline lets
    // the reader choose which limit he is asking about (#370).
    return {
      ...entry,
      subscriptions: best.subscriptions,
      byHour: best.byHour,
      tokensByBucket,
      scope: best.scope,
      scopes: measured,
    };
  }));

  // ---- the anchor: measured total, apportioned across the corpus ----
  const burnByBucket = new Map();
  const burnByProviderBucket = new Map();
  const riseByHour = new Map();
  let poolTotal = 0;
  for (const account of burned) {
    poolTotal += account.subscriptions;
    if (!burnByProviderBucket.has(account.provider)) burnByProviderBucket.set(account.provider, new Map());
    const providerMap = burnByProviderBucket.get(account.provider);
    // The account's own per-bucket burn, folded off the SAME rises the pool
    // total is built from — so the accounts dimension partitions it exactly.
    account.byBucket = new Map();
    for (const [hour, value] of account.byHour) {
      addTo(riseByHour, hour, value);
      const bucket = toBucket(hour, resolution);
      if (!bucketSet.has(bucket)) continue;
      addTo(burnByBucket, bucket, value / 100);
      addTo(providerMap, bucket, value / 100);
      addTo(account.byBucket, bucket, value / 100);
    }
  }

  // The only burn that cannot be traced: hours in which the pool's usage rose
  // while not one ingested session was running anywhere.
  let untracedPercent = 0;
  let untracedHours = 0;
  const untracedByBucket = new Map();
  for (const [hour, value] of riseByHour) {
    if ((corpusByHour.get(hour) || 0) > 0) continue;
    untracedPercent += value;
    untracedHours += 1;
    const bucket = toBucket(hour, resolution);
    if (bucketSet.has(bucket)) addTo(untracedByBucket, bucket, value / 100);
  }
  const untraced = untracedPercent / 100;
  const traceable = Math.max(0, poolTotal - untraced);

  // Weighted flow decides each project's share of the traceable total.
  const vector = poolWeights(estimate);
  const list = [...projects.values()];

  // Two different paths can share a leaf name — two 'Insight Website' checkouts
  // under different parents, say. Where that happens the leaf is not an
  // identity, and two rows reading the same with different numbers is exactly
  // the kind of thing that makes a reader distrust the whole page. Those
  // entries, and only those, carry one level of parent.
  const byName = new Map();
  for (const entry of list) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const parts = String(entry.path || '').split('/').filter(Boolean);
      if (parts.length >= 2) entry.name = parts[parts.length - 2] + '/' + parts[parts.length - 1];
    }
  }
  const weights = new Map();
  let denominator = 0;
  for (const entry of list) {
    let weight = 0;
    if (vector) {
      for (const name of TOKEN_CLASSES) weight += (entry.flows[name] || 0) * vector.weights[name];
    } else {
      weight = entry.tokens;
    }
    weights.set(entry.key, weight);
    denominator += weight;
  }
  const exact = list.map((entry) => (denominator ? traceable * (weights.get(entry.key) / denominator) : 0));
  const rounded = allocateRounded(exact.concat([untraced]), poolTotal, 2);
  list.forEach((entry, index) => {
    entry.subscriptions = rounded[index];
    entry.weight = weights.get(entry.key);
  });
  const untracedShown = rounded[rounded.length - 1];
  const totalShown = Math.round(poolTotal * 100) / 100;

  list.sort((a, b) => b.subscriptions - a.subscriptions || b.tokens - a.tokens || a.key.localeCompare(b.key));
  list.forEach((entry, index) => { entry.rank = index; });

  // ---- provider truth: measured cost ----
  // Which providers to price is read off the pool's own accounts, not a fixed
  // pair (#411): a provider added to the pool shows up here without a code
  // change. KNOWN_PROVIDERS is only the floor for a pool with no accounts yet.
  const present = [...new Set(windows.map((entry) => entry.provider).filter(Boolean))].sort();
  const cost = await loadCost({
    base, resolution, bucketSet, buckets,
    providers: provider ? [provider] : (present.length ? present : KNOWN_PROVIDERS),
  });

  // ---- the movers baseline: the same corpus, over the window BEFORE this one ----
  const baseline = await loadBaseline({ since, provider, resolveKey });

  return {
    rangeKey, resolution, scope, since, until, buckets, baseline,
    projects: list,
    corpusByBucket,
    pool: {
      total: totalShown,
      traceable: Math.round((totalShown - untracedShown) * 100) / 100,
      untraced: untracedShown,
      untracedHours,
      untracedByBucket,
      byBucket: burnByBucket,
      byProviderBucket: burnByProviderBucket,
      accounts: burned,
      windows,
      vector,
    },
    cost,
    reconciliation: burn.reconciliation || null,
  };
}

/**
 * The trailing baseline the movers strip compares against, made COVERAGE-AWARE.
 *
 * The same corpus query, over the window immediately BEFORE the selected range,
 * capped at BASELINE_WINDOW_DAYS. Three honesty rules:
 *
 *   * The window is whatever the warehouse actually holds — the caller is told
 *     its first and last day and prints them, so "+3.1× vs its 30-day norm"
 *     never claims a month of history the data does not have.
 *   * The denominator is ELAPSED days, not days the project was active. A
 *     project that ran one furious day in thirty was, averaged over that month,
 *     quiet — and that is exactly the comparison a "what changed" row makes.
 *   * Elapsed days are only honest while the ingestion actually
 *     covers them. This warehouse's continuous coverage begins partway through
 *     a 30-day window, behind which sit a few isolated backfill days with weeks
 *     of nothing between them. Counting those empty weeks as "quiet" divides
 *     every project's baseline pace by a window it was never measured over, and
 *     the strip fills with +40× rows that are artefacts of when ingestion
 *     started. So the baseline is clamped to the CONTINUOUS coverage: walking
 *     back from the newest covered day, coverage ends at the first gap longer
 *     than COVERAGE_GAP_DAYS. Days before that are dropped from BOTH sides —
 *     the tokens and the denominator — and the caller is told it was clamped so
 *     the strip can say so.
 */
export const BASELINE_WINDOW_DAYS = 30;
export const COVERAGE_GAP_DAYS = 2;

async function loadBaseline({ since, provider, resolveKey }) {
  const end = new Date(since);
  if (Number.isNaN(end.getTime())) return null;
  const start = new Date(end.getTime() - BASELINE_WINDOW_DAYS * 24 * 3600 * 1000);
  const data = await getJSON('/api/usage/projects?' + query({
    since: start.toISOString(), until: end.toISOString(),
    limit: 200, bucket: 'local_day', provider,
  })).catch(() => null);
  if (!data) return null;

  const points = [];
  const days = new Set();
  for (const point of data.series || []) {
    const tokens = point.totalTokens || 0;
    if (!(tokens > 0)) continue;
    const day = String(point.bucket).slice(0, 10);
    days.add(day);
    points.push({ day, key: projectKeyOf(point, resolveKey), tokens });
  }
  if (!days.size) return null;

  // Continuous coverage, walked back from the newest covered day.
  const sorted = [...days].sort();
  const lastDay = sorted[sorted.length - 1];
  let coverageFrom = lastDay;
  for (let index = sorted.length - 1; index > 0; index -= 1) {
    const current = parseLocalKey(sorted[index]);
    const previous = parseLocalKey(sorted[index - 1]);
    if (!current || !previous) break;
    const gap = Math.round((current - previous) / (24 * 3600 * 1000));
    if (gap > COVERAGE_GAP_DAYS) break;
    coverageFrom = sorted[index - 1];
  }
  const coverageStart = parseLocalKey(coverageFrom);
  if (!coverageStart) return null;

  // The denominator runs to the END of the baseline window (the slice's own
  // start), not to the last covered day: days between the last session and the
  // slice are genuinely quiet days, and dropping them would overstate the pace.
  const elapsed = Math.max(1, Math.round((end - coverageStart) / (24 * 3600 * 1000)));
  const windowFirstDay = localDayKey(start);
  const clamped = coverageFrom > windowFirstDay;

  const tokensByProject = new Map();
  for (const point of points) {
    if (point.day < coverageFrom) continue;
    tokensByProject.set(point.key, (tokensByProject.get(point.key) || 0) + point.tokens);
  }
  return {
    days: elapsed,
    firstDay: coverageFrom,
    lastDay,
    windowDays: BASELINE_WINDOW_DAYS,
    windowFirstDay,
    clamped,
    tokensByProject,
  };
}

/**
 * API-$ equivalents. Priced from MEASURED provider-truth tokens only (the proxy
 * warehouse), per the amendment rule 3 — fitted per-project estimates never get
 * an independent dollar figure.
 *
 * Everything the cost lens shows comes out of ONE table: each model priced on
 * its own measured flows, per time bucket. The day total, the provider split,
 * the model table and the per-model series are all sums of that table, so a day
 * cannot say \$300 while the model rows under it say \$278.
 */
async function loadCost({ base, resolution, bucketSet, buckets, providers = KNOWN_PROVIDERS }) {
  const groupBy = resolution === 'hour' ? 'hour' : 'local_day';
  const field = resolution === 'hour' ? 'hour' : 'localDay';

  // Which models are present, and their range totals (for the request counts).
  const present = [];
  await Promise.all(providers.map(async (name) => {
    const data = await getJSON('/api/usage/summary?' + query({ ...base, groupBy: 'model', provider: name })).catch(() => null);
    for (const group of (data && data.groups) || []) {
      present.push({ provider: name, model: group.model || '', requests: group.requests || 0 });
    }
  }));

  // One call per model gives that model's own flows per bucket, which price
  // exactly rather than through a blended provider rate.
  const models = await Promise.all(present.map(async (entry) => {
    const data = await getJSON('/api/usage/summary?' + query({
      ...base, groupBy, provider: entry.provider, model: entry.model,
    })).catch(() => null);
    const byBucket = new Map();
    const tokensByBucket = new Map();
    let usd = 0;
    let tokens = 0;
    let via = null;
    let priced = true;
    for (const group of (data && data.groups) || []) {
      const bucket = group[field];
      if (!bucketSet.has(bucket)) continue;
      const cost = costOf(entry.model, group);
      via = cost.via;
      priced = cost.priced;
      if (!(cost.usd > 0) && !(group.total > 0)) continue;
      byBucket.set(bucket, (byBucket.get(bucket) || 0) + cost.usd);
      tokensByBucket.set(bucket, (tokensByBucket.get(bucket) || 0) + (group.total || 0));
      usd += cost.usd;
      tokens += group.total || 0;
    }
    return {
      model: entry.model || '(unnamed)',
      provider: entry.provider,
      requests: entry.requests,
      usd, tokens, via, priced, byBucket, tokensByBucket,
    };
  }));

  const byBucket = new Map();
  const byProviderBucket = new Map();
  const tokensByBucket = new Map();
  let total = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  for (const entry of models) {
    total += entry.usd;
    if (entry.priced) pricedTokens += entry.tokens; else unpricedTokens += entry.tokens;
    if (!byProviderBucket.has(entry.provider)) byProviderBucket.set(entry.provider, new Map());
    const providerMap = byProviderBucket.get(entry.provider);
    for (const [bucket, value] of entry.byBucket) {
      addTo(byBucket, bucket, value);
      addTo(providerMap, bucket, value);
    }
    for (const [bucket, value] of entry.tokensByBucket) addTo(tokensByBucket, bucket, value);
  }

  models.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  void buckets;
  return {
    total: Math.round(total * 100) / 100,
    models,
    byBucket,
    byProviderBucket,
    tokensByBucket,
    pricedTokens,
    unpricedTokens,
  };
}

export { parseLocalKey };
