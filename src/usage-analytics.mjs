import fs from 'node:fs';
import pinnedPriceSnapshot from '../data/litellm-prices-2026-08-11.json' with { type: 'json' };
import { tagSessionsWithLaneRuns } from './lane-manifest.mjs';
import { apportionMeasuredTotal, CLAUDE_POOL_ID, MIN_FIT_QUALITY } from './usage-estimate.mjs';

const PRICE_LABEL = '* if billed at full API rate';
const TOKEN_CLASSES = ['inputUncached', 'inputCacheRead', 'inputCacheWrite', 'outputTotal'];
const ACTIVITY_BUCKETS = [
  { key: 'lane', label: 'Build lanes' },
  { key: 'review', label: 'Reviews' },
  { key: 'orchestration', label: 'Orchestration' },
  { key: 'design', label: 'Prototypes & design' },
  { key: 'other', label: 'Other' },
];

function canonicalBound(value, label, subject) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`${subject} ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function rangeOf(since, until, subject) {
  since = canonicalBound(since, 'since', subject);
  until = canonicalBound(until, 'until', subject);
  if (since >= until) throw new Error(`${subject} since must be earlier than until`);
  return { since, until, endExclusive: true };
}

function fitFromStore(store, scope) {
  const row = store.db.prepare('SELECT * FROM usage_estimate_fits WHERE pool_id = ? AND scope = ?')
    .get(CLAUDE_POOL_ID, scope);
  if (!row || row.reason != null) return { weights: null, fitQuality: row?.fit_quality ?? null };
  return {
    weights: {
      inputUncached: Number(row.input_uncached_weight),
      inputCacheRead: Number(row.input_cache_read_weight),
      inputCacheWrite: Number(row.input_cache_write_weight),
      outputTotal: Number(row.output_total_weight),
    },
    fitQuality: Number(row.fit_quality),
  };
}

const RESET_MARKER_TOLERANCE_MS = 5 * 60 * 1000;

function resetMarkerChanged(previous, current) {
  if (previous == null || current == null) return previous !== current;
  const before = Date.parse(previous);
  const after = Date.parse(current);
  if (Number.isFinite(before) && Number.isFinite(after)) return Math.abs(after - before) > RESET_MARKER_TOLERANCE_MS;
  return previous !== current;
}

function localHourKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

function burnedSeries(rows) {
  let previous = null;
  let burned = 0;
  const byHour = new Map();
  for (const row of rows) {
    const value = row.used_percent == null ? null : Number(row.used_percent);
    if (value == null || !Number.isFinite(value)) continue;
    if (previous != null) {
      const movement = value < previous.value || resetMarkerChanged(previous.resetsAt, row.resets_at)
        ? value
        : value - previous.value;
      burned += movement;
      const hour = localHourKey(row.observed_at);
      if (movement > 0 && hour) byHour.set(hour, (byHour.get(hour) || 0) + movement / 100);
    }
    previous = { value, resetsAt: row.resets_at };
  }
  return { percent: burned, byHour };
}

function measuredPoolBurn(store, { since, until, scope }) {
  const accounts = store.listAccounts().filter((account) => account.provider === 'claude');
  const scopeRows = store.db.prepare(`
    SELECT DISTINCT scope FROM usage_snapshots
    WHERE account_id = ? AND stale = 0 AND used_percent IS NOT NULL
      AND julianday(observed_at) < julianday(?)
  `);
  const history = store.db.prepare(`
    SELECT account_id, scope, used_percent, resets_at, observed_at, id
    FROM usage_snapshots
    WHERE account_id = ? AND scope = ? AND stale = 0 AND used_percent IS NOT NULL
      AND (
        julianday(observed_at) >= julianday(?)
        OR id = (
          SELECT anchor.id FROM usage_snapshots anchor
          WHERE anchor.account_id = ? AND anchor.scope = ?
            AND anchor.stale = 0 AND anchor.used_percent IS NOT NULL
            AND julianday(anchor.observed_at) < julianday(?)
          ORDER BY julianday(anchor.observed_at) DESC, anchor.id DESC
          LIMIT 1
        )
      )
      AND julianday(observed_at) < julianday(?)
    ORDER BY julianday(observed_at), id
  `);
  const burnedByAccount = new Map();
  for (const account of accounts) {
    const candidates = scopeRows.all(account.id, until).map((row) => row.scope).filter((name) => (
      scope === 'weekly'
        ? String(name).toLowerCase().includes('weekly') && !String(name).toLowerCase().includes('spend')
        : name === scope
    ));
    let binding = { scope: null, percent: 0, byHour: new Map() };
    for (const candidate of candidates) {
      const rows = history.all(account.id, candidate, since, account.id, candidate, since, until);
      const burned = burnedSeries(rows);
      if (burned.percent > binding.percent || (burned.percent === binding.percent && candidate === scope)) {
        binding = { scope: candidate, ...burned };
      }
    }
    burnedByAccount.set(account.id, binding);
  }
  const byHour = new Map();
  for (const binding of burnedByAccount.values()) {
    for (const [hour, subscriptions] of binding.byHour) {
      byHour.set(hour, (byHour.get(hour) || 0) + subscriptions);
    }
  }
  return {
    subscriptions: [...burnedByAccount.values()].reduce((sum, binding) => sum + binding.percent, 0) / 100,
    byHour,
    accounts: [...burnedByAccount].map(([accountId, binding]) => ({
      accountId,
      scope: binding.scope,
      subscriptions: binding.percent / 100,
    })),
  };
}

function flowIsZero(flow) {
  return TOKEN_CLASSES.every((key) => !(Number(flow?.[key]) > 0));
}

function tokenScore(flow, weights = null) {
  return TOKEN_CLASSES.reduce((sum, key) => sum + Number(flow?.[key] || 0) * (weights?.[key] ?? 1), 0);
}

function exactAllocations(values, total, precision) {
  const scale = 10 ** precision;
  const totalUnits = Math.round(total * scale);
  const denominator = values.reduce((sum, item) => sum + item.value, 0);
  const raw = values.map((item) => denominator > 0 ? totalUnits * item.value / denominator : 0);
  const units = raw.map(Math.floor);
  const remainder = totalUnits - units.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - units[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) units[order[index % order.length].index] += 1;
  return values.map((item, index) => ({
    id: item.id,
    units: units[index],
    value: units[index] / scale,
    printed: (units[index] / scale).toFixed(precision),
  }));
}

function attributionAllocations(items, measuredTotal, untraced, fit, precision) {
  let fitted = fit.weights != null && fit.fitQuality != null && fit.fitQuality >= MIN_FIT_QUALITY;
  let method = fitted ? 'fitted-token-share' : 'token-share-fallback';
  let scores = items.map((item) => tokenScore(item.tokenFlows, fitted ? fit.weights : null));
  let scoreTotal = scores.reduce((sum, score) => sum + score, 0);
  if (fitted && scoreTotal === 0) {
    fitted = false;
    method = 'token-share-fallback';
    scores = items.map((item) => tokenScore(item.tokenFlows));
    scoreTotal = scores.reduce((sum, score) => sum + score, 0);
  }
  const traceable = Math.max(0, measuredTotal - untraced);
  const exact = items.map((item, index) => ({
    id: item.id,
    value: scoreTotal > 0 ? traceable * scores[index] / scoreTotal : 0,
  }));
  if (untraced > 0) exact.push({ id: '__untraced', value: untraced });
  return { method, fitQuality: fit.fitQuality, allocations: exactAllocations(exact, measuredTotal, precision) };
}

export function attributionReport(store, { since, until, scope = 'weekly', precision = 2 } = {}) {
  const range = rangeOf(since, until, 'usage attribution');
  if (!['weekly', '5-hour'].includes(scope)) throw new Error('usage attribution scope must be weekly or 5-hour');
  const measured = measuredPoolBurn(store, { since, until, scope });
  const burn = store.projectBurn({ since, until, provider: 'claude', limit: 200, bucket: 'hour' });
  const items = burn.projects.map((project) => ({ id: project.key, tokenFlows: project.tokenFlows }));
  if (burn.remainder) items.push({ id: '__remainder', tokenFlows: burn.remainder.tokenFlows });
  const corpusHours = new Set((burn.series || []).filter((point) => point.totalTokens > 0).map((point) => point.bucket));
  let untraced = 0;
  for (const [hour, subscriptions] of measured.byHour) {
    if (!corpusHours.has(hour)) untraced += subscriptions;
  }
  const traceable = Math.max(0, measured.subscriptions - untraced);
  if (traceable > 0 && (!items.length || items.every((item) => flowIsZero(item.tokenFlows)))) untraced = measured.subscriptions;
  const fit = fitFromStore(store, scope);
  const apportioned = attributionAllocations(items, measured.subscriptions, untraced, fit, precision);
  const printedTotal = Math.round(measured.subscriptions * 10 ** precision) / 10 ** precision;
  const accountAllocation = apportionMeasuredTotal(
    measured.accounts.map((account) => ({
      id: account.accountId,
      tokenFlows: { inputUncached: account.subscriptions },
    })),
    measured.subscriptions,
    null,
    { precision },
  );
  const projectById = new Map(burn.projects.map((project) => [project.key, project]));
  return {
    range,
    pool: { poolId: CLAUDE_POOL_ID, provider: 'claude', scope },
    measured: {
      source: 'provider utilization windows', unit: 'subscriptions', total: printedTotal,
      totalUnits: Math.round(measured.subscriptions * 10 ** precision),
      untraced: apportioned.allocations.find((allocation) => allocation.id === '__untraced')?.value || 0,
      accounts: accountAllocation.allocations.map((account) => ({
        accountId: account.id,
        scope: measured.accounts.find((measuredAccount) => measuredAccount.accountId === account.id)?.scope ?? null,
        subscriptions: account.value,
        printed: account.printed,
      })),
    },
    derivation: {
      method: apportioned.method,
      fitQuality: apportioned.fitQuality,
      minimumFitQuality: MIN_FIT_QUALITY,
      rounding: `largest-remainder-${precision}-decimal`,
      note: 'One measured pool total is apportioned once; project figures are not independently estimated.',
    },
    projects: apportioned.allocations.map((allocation) => ({
      key: allocation.id,
      project: projectById.get(allocation.id)?.project ?? null,
      unattributed: projectById.get(allocation.id)?.unattributed ?? false,
      untraced: allocation.id === '__untraced',
      units: allocation.units,
      subscriptions: allocation.value,
      printed: allocation.printed,
      tokenFlows: projectById.get(allocation.id)?.tokenFlows ?? null,
      derivation: allocation.id === '__untraced'
        ? 'measured utilization in hours with no recorded session corpus'
        : 'measured traceable total × this project pooled-token share, rounded by measured-total largest remainder',
    })),
  };
}

function classifyActivity(session, agentTypes = []) {
  const title = String(session.title || '').toLowerCase();
  const branch = String(session.gitBranch || '').toLowerCase();
  const cwd = String(session.cwd || '').toLowerCase();
  const signals = [...(session.skills || []), ...(session.commands || []), ...agentTypes].map((value) => String(value).toLowerCase());
  const has = (pattern) => signals.some((value) => pattern.test(value));
  if (has(/review|critic|skeptic/) || /\breview\b/.test(title)) return { key: 'review', why: 'review signal in a skill, subagent type, or title' };
  if (/orchestrat|lane wave|lane watch/.test(title) || has(/orchestrat|coordinate|handoff/) || /orchestrat/.test(branch + cwd)) {
    return { key: 'orchestration', why: 'orchestration signal in a skill, path, branch, subagent type, or title' };
  }
  if (session.lane || has(/implement|build/) || (/lane\/|codex\/|claude\//.test(branch) && /worktrees/.test(cwd))) {
    return { key: 'lane', why: session.lane ? 'matched a lane-manifest run' : 'build-lane signal in session metadata' };
  }
  if (has(/prototype|frontend-design|dataviz|grilling|decision-map|research/) || /prototype|design|grill/.test(title + branch)) {
    return { key: 'design', why: 'prototype or design signal in a skill, branch, subagent type, or title' };
  }
  return { key: 'other', why: 'no heuristic activity signal matched' };
}

export function activityBreakdownReport(store, { since, until, provider = null, project = null, laneRuns = [] } = {}) {
  const range = rangeOf(since, until, 'activity breakdown');
  if (provider != null && !['claude', 'codex'].includes(provider)) throw new Error('activity breakdown provider must be claude or codex');
  const leaderboard = store.usageSessions({ since, until, provider, project, limit: 200 });
  const sessions = leaderboard.sessions;
  const tagged = tagSessionsWithLaneRuns(sessions, laneRuns);
  const subagentTypes = store.subagentTypesForSessions(sessions
    .filter((session) => session.provider === 'claude')
    .map((session) => ({ sessionId: session.sessionId, profileSlug: session.profileSlug })));
  const buckets = new Map(ACTIVITY_BUCKETS.map((bucket) => [bucket.key, { ...bucket, sessions: 0, tokens: 0 }]));
  const rows = tagged.map((session) => {
    const agentTypes = subagentTypes.get(`${session.sessionId}\u001f${session.profileSlug}`) || [];
    const activity = classifyActivity(session, agentTypes);
    const bucket = buckets.get(activity.key);
    bucket.sessions += 1;
    bucket.tokens += session.totalTokens;
    return { sessionId: session.sessionId, profileSlug: session.profileSlug, provider: session.provider, activity: activity.key, why: activity.why, tokens: session.totalTokens };
  });
  return {
    range, provider, project,
    heuristic: true,
    method: 'ordered-signals-v1',
    note: 'Heuristic classification from lane manifest, skill events, subagent types, branches, paths, and titles; real activity markers are not recorded yet.',
    buckets: [...buckets.values()],
    sessions: rows,
    truncated: leaderboard.truncated,
  };
}

function loadPrices(overridePath) {
  const pinned = pinnedPriceSnapshot;
  if (!overridePath) return { ...pinned, overridePath: null };
  const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
  return {
    ...pinned,
    models: { ...pinned.models, ...(override.models || {}) },
    aliases: { ...pinned.aliases, ...(override.aliases || {}) },
    overridePath,
  };
}

function pricedFlow(prices, model, flow) {
  const resolved = prices.models[model] ? model : prices.aliases[model];
  const rate = prices.models[resolved];
  if (!rate) return { usd: 0, priced: false, via: null };
  return {
    usd: flow.inputUncached * rate.input + flow.inputCacheRead * rate.cacheRead
      + flow.inputCacheWrite * rate.cacheWrite + flow.outputTotal * rate.output,
    priced: true,
    via: resolved === model ? null : resolved,
  };
}

export function costReport(store, { since, until, provider = null, precision = 4, priceOverridePath = process.env.MODELDECK_PRICE_OVERRIDE_FILE } = {}) {
  const range = rangeOf(since, until, 'usage cost');
  if (provider != null && !['claude', 'codex'].includes(provider)) throw new Error('usage cost provider must be claude or codex');
  const prices = loadPrices(priceOverridePath);
  const summaries = (provider ? [provider] : ['claude', 'codex']).map((name) => ({
    provider: name,
    summary: store.usageSummary({ since, until, provider: name, groupBy: 'model' }),
  }));
  const models = summaries.flatMap(({ provider: modelProvider, summary }) => summary.groups.map((group) => {
    const cost = pricedFlow(prices, group.model, group);
    return { model: group.model, provider: modelProvider, tokens: group.total, ...cost };
  }));
  const rawTotal = models.reduce((sum, model) => sum + model.usd, 0);
  const modelAllocation = apportionMeasuredTotal(models.map((model, index) => ({
    id: String(index), tokenFlows: { inputUncached: model.usd },
  })), rawTotal, null, { precision });
  const printedModels = models.map((model, index) => ({
    ...model,
    units: modelAllocation.allocations[index].units,
    usd: modelAllocation.allocations[index].value,
    printed: modelAllocation.allocations[index].printed,
  }));
  const burn = store.projectBurn({ since, until, provider, limit: 200 });
  const projectItems = burn.projects.map((project) => ({ id: project.key, tokenFlows: project.tokenFlows }));
  if (burn.remainder) projectItems.push({ id: '__remainder', tokenFlows: burn.remainder.tokenFlows });
  if (rawTotal > 0 && (!projectItems.length || projectItems.every((item) => flowIsZero(item.tokenFlows)))) {
    projectItems.splice(0, projectItems.length, { id: 'unattributed', tokenFlows: { inputUncached: 1 } });
  }
  const allocation = apportionMeasuredTotal(projectItems, rawTotal, null, { precision });
  return {
    range, provider,
    label: PRICE_LABEL,
    measured: true,
    source: 'request_usage provider-truth token classes',
    pricing: { source: prices.source, snapshotDate: prices.snapshotDate, overrideFile: prices.overridePath != null },
    totalUsd: allocation.total,
    totalUnits: allocation.totalUnits,
    printed: allocation.totalPrinted,
    models: printedModels,
    projects: allocation.allocations.map((item) => ({
      key: item.id, units: item.units, usd: item.value, printed: item.printed,
    })),
    derivation: { method: 'measured-model-cost-then-project-token-share', rounding: `largest-remainder-${precision}-decimal` },
    coverage: {
      pricedTokens: printedModels.filter((model) => model.priced).reduce((sum, model) => sum + model.tokens, 0),
      unpricedTokens: printedModels.filter((model) => !model.priced).reduce((sum, model) => sum + model.tokens, 0),
    },
  };
}
