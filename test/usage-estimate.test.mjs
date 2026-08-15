import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import {
  CLAUDE_POOL_ID,
  ESTIMATE_METHOD,
  IDENTIFIABILITY_RATIO_FLOOR,
  MIN_FIT_QUALITY,
  MIN_USABLE_INTERVALS,
  TOKEN_CLASSES,
  apportionMeasuredTotal,
  buildPoolUsageEstimateIntervals,
  buildUsageEstimateIntervals,
  fitUsageEstimateIntervals,
  refitUsageEstimates,
  solveNonNegativeLeastSquares,
  usageEstimateReport,
} from '../src/usage-estimate.mjs';
import { parseArgs, usageText } from '../scripts/refit-usage-estimates.mjs';

const PORT = 43480;

function saveClaudeAccount(store, suffix) {
  return store.saveAccount({
    provider: 'claude',
    label: `Estimate Placeholder ${suffix}`,
    identity: `estimate-${suffix.toLowerCase()}@example.invalid`,
    profileRef: `claude-estimate-placeholder-${suffix.toLowerCase()}`,
  });
}

function requestRecord(account, requestId, observedAt, flows) {
  const [inputUncached, inputCacheRead, inputCacheWrite, outputTotal] = flows;
  return {
    requestId,
    machine: 'studio-placeholder',
    observedAt,
    source: account.identity,
    provider: 'claude',
    model: 'claude-estimate-placeholder-model',
    alias: null,
    reasoningEffort: null,
    endpoint: '/v1/messages',
    userAgentClass: 'claude-code',
    failed: false,
    statusCode: 200,
    latencyMs: 10,
    ttftMs: 2,
    inputUncached,
    inputCacheRead,
    inputCacheWrite,
    outputTotal,
    outputReasoning: 0,
    total: inputUncached + inputCacheRead + inputCacheWrite + outputTotal,
  };
}

function recordSnapshot(store, accountId, scope, observedAt, usedPercent, resetsAt) {
  store.recordUsage(accountId, {
    scope,
    observedAt,
    usedPercent,
    resetsAt,
    source: 'estimate-provider-placeholder',
    detail: { fixture: 'placeholder' },
  });
}

const SYNTHETIC_FLOWS = [
  [10, 0, 0, 0],
  [0, 20, 0, 0],
  [0, 0, 8, 0],
  [0, 0, 0, 6],
  [4, 12, 2, 1],
  [15, 3, 7, 2],
  [2, 25, 1, 8],
  [9, 4, 11, 5],
  [6, 18, 5, 9],
  [12, 7, 9, 3],
  [3, 11, 14, 7],
  [14, 2, 4, 10],
];
const TRUE_WEIGHTS = [0.04, 0.01, 0.025, 0.06];

function seedKnownSeries(store, suffix = 'Known') {
  const account = saveClaudeAccount(store, suffix);
  const start = Date.parse('2026-08-01T00:00:00.000Z');
  const reset = '2026-08-20T00:00:00.000Z';
  let usedPercent = 3;
  recordSnapshot(store, account.id, 'weekly', new Date(start).toISOString(), usedPercent, reset);
  const requests = [];
  SYNTHETIC_FLOWS.forEach((flows, index) => {
    const movement = flows.reduce((sum, value, column) => sum + value * TRUE_WEIGHTS[column], 0);
    usedPercent += movement;
    requests.push(requestRecord(
      account,
      `estimate-known-request-${suffix.toLowerCase()}-${index}`,
      new Date(start + index * 60 * 60 * 1_000 + 30 * 60 * 1_000).toISOString(),
      flows,
    ));
    // Real snapshots recompute resets_at each poll, so it jitters by sub-second
    // amounts within one window; the fit must tolerate that shape.
    const jitteredReset = new Date(Date.parse(reset) + ((index * 337) % 901) - 450).toISOString();
    recordSnapshot(
      store,
      account.id,
      'weekly',
      new Date(start + (index + 1) * 60 * 60 * 1_000).toISOString(),
      usedPercent,
      jitteredReset,
    );
  });
  store.ingestRequestUsage(requests);
  return account;
}

function seedKnownPoolSeries(store) {
  const accounts = [saveClaudeAccount(store, 'PoolOne'), saveClaudeAccount(store, 'PoolTwo')];
  const start = Date.parse('2026-08-01T00:00:00.000Z');
  const reset = '2026-08-20T00:00:00.000Z';
  const used = [2, 7];
  accounts.forEach((account, index) => {
    recordSnapshot(store, account.id, 'weekly', new Date(start + index * 1_000).toISOString(), used[index], reset);
  });
  const requests = [];
  SYNTHETIC_FLOWS.forEach((flows, intervalIndex) => {
    const movement = flows.reduce((sum, value, column) => sum + value * TRUE_WEIGHTS[column], 0);
    // The profile holding the transcript intentionally alternates, while the
    // utilization movement lands on the other account. Only pool grain can
    // recover the stable relationship.
    const transcriptAccount = accounts[intervalIndex % accounts.length];
    requests.push(requestRecord(
      transcriptAccount,
      `estimate-pool-request-${intervalIndex}`,
      new Date(start + intervalIndex * 60 * 60 * 1_000 + 30 * 60 * 1_000).toISOString(),
      flows,
    ));
    used[(intervalIndex + 1) % accounts.length] += movement;
    accounts.forEach((account, accountIndex) => {
      recordSnapshot(
        store,
        account.id,
        'weekly',
        new Date(start + (intervalIndex + 1) * 60 * 60 * 1_000 + accountIndex * 1_000).toISOString(),
        used[accountIndex],
        new Date(Date.parse(reset) + intervalIndex * 100).toISOString(),
      );
    });
  });
  store.ingestRequestUsage(requests);
  return accounts;
}

function assertFitMetadata(payload) {
  assert.equal(Object.hasOwn(payload, 'fitQuality'), true);
  assert.equal(Object.hasOwn(payload, 'identifiability'), true);
  assert.equal(Object.hasOwn(payload, 'conditionRatio'), true);
  assert.equal(Object.hasOwn(payload, 'intervalsUsed'), true);
  assert.equal(Object.hasOwn(payload, 'method'), true);
  assert.equal(typeof payload.method, 'string');
}

test('small active-set NNLS remains stable for correlated cache-heavy token classes', () => {
  const weights = [0.000001, 0.0000002, 0.000004, 0.00008];
  const features = Array.from({ length: 400 }, (_, index) => {
    const input = 100_000 + (index % 97);
    return [
      input,
      input * 9 + (index % 17),
      input * 0.2 + (index % 31),
      500 + (index % 101),
    ];
  });
  const targets = features.map((row) => row.reduce(
    (sum, value, column) => sum + value * weights[column],
    0,
  ));
  const fitted = solveNonNegativeLeastSquares(features, targets);
  assert.equal(fitted.converged, true);
  assert.ok(fitted.conditionRatio >= IDENTIFIABILITY_RATIO_FLOOR);
  fitted.weights.forEach((weight, index) => {
    assert.ok(weight >= 0);
    assert.ok(Math.abs(weight - weights[index]) < 1e-10);
  });
});

test('collinear cache classes are not published as a perfect identifiable fit', () => {
  const trueWeights = [1e-7, 2e-7, 6e-7, 4e-7];
  const features = Array.from({ length: MIN_USABLE_INTERVALS }, (_, index) => {
    const cacheRead = 1_000_000 + index * 731_111;
    return [
      100_000 + index * 93_719,
      cacheRead,
      cacheRead * 0.3,
      250_000 + ((index * 341_231) % 1_900_000),
    ];
  });
  const intervals = features.map((row) => ({
    features: row,
    observedMovement: row.reduce((sum, value, column) => sum + value * trueWeights[column], 0),
  }));

  const fit = fitUsageEstimateIntervals(intervals);
  assert.equal(fit.weights, null);
  assert.equal(fit.fitQuality, null);
  assert.equal(fit.identifiability, 'ill-conditioned');
  assert.ok(fit.conditionRatio < IDENTIFIABILITY_RATIO_FLOOR);
  assert.match(fit.reason, /design not identifiable/);

  // On the 0.3 training ratio, moving the cache-write weight into cache-read
  // is residual-free. On this held-out 14/15 ratio, that arbitrary but
  // training-perfect attribution underestimates burn by exactly 50%.
  const heldOut = [0, 3_000_000, 2_800_000, 0];
  const arbitraryTrainingEquivalent = [1e-7, 3.8e-7, 0, 4e-7];
  const trueHeldOut = heldOut.reduce((sum, value, column) => sum + value * trueWeights[column], 0);
  const arbitraryHeldOut = heldOut.reduce(
    (sum, value, column) => sum + value * arbitraryTrainingEquivalent[column],
    0,
  );
  assert.ok(Math.abs(arbitraryHeldOut / trueHeldOut - 0.5) < 1e-12);

  const controlFeatures = SYNTHETIC_FLOWS.slice(0, MIN_USABLE_INTERVALS)
    .map((row) => row.map((value) => value * 100_000));
  const controlIntervals = controlFeatures.map((row) => ({
    features: row,
    observedMovement: row.reduce((sum, value, column) => sum + value * trueWeights[column], 0),
  }));
  const control = fitUsageEstimateIntervals(controlIntervals);
  assert.equal(control.reason, null);
  assert.equal(control.identifiability, 'well-conditioned');
  assert.ok(control.conditionRatio >= IDENTIFIABILITY_RATIO_FLOOR);
  assert.ok(control.fitQuality > 0.999999999);
});

test('synthetic pooled provider movements recover one fit despite profile routing mismatch', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const accounts = seedKnownPoolSeries(store);

  const training = buildPoolUsageEstimateIntervals(store, { scope: 'weekly' });
  assert.equal(training.intervals.length, SYNTHETIC_FLOWS.length);
  assert.deepEqual(training.intervals.map((interval) => interval.features), SYNTHETIC_FLOWS);
  training.intervals.forEach((interval, index) => {
    const expected = SYNTHETIC_FLOWS[index].reduce(
      (sum, value, column) => sum + value * TRUE_WEIGHTS[column],
      0,
    );
    assert.ok(Math.abs(interval.observedMovement - expected) < 1e-12);
  });

  const summary = refitUsageEstimates(store, { fittedAt: '2026-08-10T12:00:00.000Z' });
  assert.equal(summary.pools, 1);
  const weekly = summary.results.find((result) => result.poolId === CLAUDE_POOL_ID && result.scope === 'weekly');
  assert.equal(weekly.reason, null);
  assert.equal(weekly.intervalsUsed, SYNTHETIC_FLOWS.length);
  assert.equal(weekly.method, ESTIMATE_METHOD);
  assert.equal(weekly.identifiability, 'well-conditioned');
  assert.ok(weekly.conditionRatio >= IDENTIFIABILITY_RATIO_FLOOR);
  assert.ok(weekly.fitQuality > 0.999999999);
  TOKEN_CLASSES.forEach((tokenClass, index) => {
    assert.ok(
      Math.abs(weekly.weights[tokenClass] - TRUE_WEIGHTS[index]) < 1e-8,
      `${tokenClass} recovered as ${weekly.weights[tokenClass]}`,
    );
  });

  const fiveHour = summary.results.find((result) => result.poolId === CLAUDE_POOL_ID && result.scope === '5-hour');
  assert.equal(fiveHour.weights, null);
  assert.equal(fiveHour.identifiability, 'not-assessed');
  assert.equal(fiveHour.conditionRatio, null);
  assert.equal(fiveHour.intervalsUsed, 0);
  assert.match(fiveHour.reason, /insufficient usable intervals/);

  store.migrate();
  store.migrate();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_estimate_fits').get().count, 2);
  const persisted = store.db.prepare(`
    SELECT input_uncached_weight, fit_quality, identifiability, condition_ratio,
      intervals_used, method, reason
    FROM usage_estimate_fits WHERE pool_id = ? AND scope = 'weekly'
  `).get(CLAUDE_POOL_ID);
  assert.ok(Math.abs(persisted.input_uncached_weight - TRUE_WEIGHTS[0]) < 1e-8);
  assert.ok(persisted.fit_quality > 0.999999999);
  assert.equal(persisted.identifiability, 'well-conditioned');
  assert.ok(persisted.condition_ratio >= IDENTIFIABILITY_RATIO_FLOOR);
  assert.equal(persisted.intervals_used, SYNTHETIC_FLOWS.length);
  assert.equal(persisted.method, ESTIMATE_METHOD);
  assert.equal(persisted.reason, null);

  // A later unusable refit must replace, not silently retain, the old model.
  store.db.prepare('DELETE FROM usage_snapshots WHERE account_id IN (?, ?)').run(...accounts.map((account) => account.id));
  refitUsageEstimates(store, { fittedAt: '2026-08-10T12:30:00.000Z' });
  const unavailable = store.db.prepare(`
    SELECT input_uncached_weight, fit_quality, identifiability, condition_ratio,
      intervals_used, method, reason
    FROM usage_estimate_fits WHERE pool_id = ? AND scope = 'weekly'
  `).get(CLAUDE_POOL_ID);
  assert.equal(unavailable.input_uncached_weight, null);
  assert.equal(unavailable.fit_quality, null);
  assert.equal(unavailable.identifiability, 'not-assessed');
  assert.equal(unavailable.condition_ratio, null);
  assert.equal(unavailable.intervals_used, 0);
  assert.equal(unavailable.method, ESTIMATE_METHOD);
  assert.match(unavailable.reason, /insufficient usable intervals/);
});

test('account-grain fit schema migrates once to an empty pool-grain table', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-estimate-migration-'));
  const dbPath = path.join(root, 'legacy.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initial = new Store(dbPath);
  initial.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    INSERT INTO accounts(
      id, provider, label, profile_ref, created_at, updated_at
    ) VALUES (
      'account-placeholder', 'claude', 'Placeholder', 'profile-placeholder',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    DROP TABLE usage_estimate_fits;
    CREATE TABLE usage_estimate_fits (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      input_uncached_weight REAL, input_cache_read_weight REAL,
      input_cache_write_weight REAL, output_total_weight REAL,
      fit_quality REAL, identifiability TEXT NOT NULL, condition_ratio REAL,
      intervals_used INTEGER NOT NULL, method TEXT NOT NULL, reason TEXT,
      fitted_at TEXT NOT NULL, PRIMARY KEY(account_id, scope)
    );
    INSERT INTO usage_estimate_fits VALUES
      ('account-placeholder', 'weekly', 1, 1, 1, 1, 1,
       'well-conditioned', 1, 8, 'legacy-placeholder', NULL,
       '2026-08-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new Store(dbPath);
  t.after(() => store.close());
  store.migrate();
  const columns = store.db.prepare('PRAGMA table_info(usage_estimate_fits)').all().map((column) => column.name);
  assert.equal(columns.includes('pool_id'), true);
  assert.equal(columns.includes('provider'), true);
  assert.equal(columns.includes('account_id'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_estimate_fits').get().count, 0);
});

test('interval alignment excludes reset-marker changes and utilization decreases', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const account = saveClaudeAccount(store, 'Reset');
  const start = Date.parse('2026-08-02T00:00:00.000Z');
  const resetA = '2026-08-03T00:00:00.000Z';
  const resetB = '2026-08-04T00:00:00.000Z';
  const snapshots = [
    [10, resetA],
    // Sub-second poll jitter on the marker is NOT a reset; the interval counts.
    [11, new Date(Date.parse(resetA) + 400).toISOString()],
    [12, resetB], // Reset marker jumped a full day even though utilization increased.
    [5, resetB], // Utilization decreased even though marker stayed fixed.
    [6, resetB],
  ];
  snapshots.forEach(([usedPercent, resetsAt], index) => {
    recordSnapshot(store, account.id, 'weekly', new Date(start + index * 60 * 60 * 1_000).toISOString(), usedPercent, resetsAt);
  });
  store.ingestRequestUsage(snapshots.slice(1).map((_, index) => requestRecord(
    account,
    `estimate-reset-request-${index}`,
    new Date(start + index * 60 * 60 * 1_000 + 30 * 60 * 1_000).toISOString(),
    [1, 0, 0, 0],
  )));

  const training = buildUsageEstimateIntervals(store, { accountId: account.id, scope: 'weekly' });
  assert.equal(training.resetIntervalsDropped, 2);
  assert.equal(training.intervals.length, 2);
  assert.deepEqual(training.intervals.map((interval) => interval.observedMovement), [1, 1]);
  assert.deepEqual(training.intervals.map((interval) => interval.tokenFlows.inputUncached), [1, 1]);
});

test('#374 boundary: exactly 0.3 uses the fit and 0.299 falls back', () => {
  const items = [
    { id: 'project-alpha', tokenFlows: { inputUncached: 1 } },
    { id: 'project-beta', tokenFlows: { inputUncached: 1 } },
    { id: 'project-gamma', tokenFlows: { inputUncached: 1 } },
  ];
  const fit = {
    weights: { inputUncached: 1, inputCacheRead: 0, inputCacheWrite: 0, outputTotal: 0 },
    fitQuality: MIN_FIT_QUALITY,
  };
  const atFloor = apportionMeasuredTotal(items, 100, fit, { precision: 1 });
  assert.equal(atFloor.method, 'fitted-token-share');
  assert.deepEqual(atFloor.allocations.map((item) => item.printed), ['33.4', '33.3', '33.3']);
  assert.equal(atFloor.allocations.reduce((sum, item) => sum + item.units, 0), atFloor.totalUnits);

  const belowFloor = apportionMeasuredTotal([
    { id: 'project-alpha', tokenFlows: { inputUncached: 1, outputTotal: 9 } },
    { id: 'project-beta', tokenFlows: { inputUncached: 9, outputTotal: 1 } },
  ], 71.3, { ...fit, fitQuality: MIN_FIT_QUALITY - 0.001 }, { precision: 1 });
  assert.equal(belowFloor.method, 'token-share-fallback');
  assert.deepEqual(belowFloor.allocations.map((item) => item.printed), ['35.7', '35.6']);
  assert.equal(belowFloor.allocations.reduce((sum, item) => sum + item.units, 0), belowFloor.totalUnits);
});

test('#367 tripwire: multi-window project shares never exceed 100% of pooled measured truth', () => {
  const measuredPoolTotal = 243.7;
  const weights = { inputUncached: 0.002, inputCacheRead: 0, inputCacheWrite: 0, outputTotal: 0.4 };
  const items = [
    { id: 'project-alpha', tokenFlows: { inputUncached: 9000, outputTotal: 100 } },
    { id: 'project-beta', tokenFlows: { inputUncached: 500, outputTotal: 3000 } },
    { id: 'unattributed', tokenFlows: { inputUncached: 50, outputTotal: 50 } },
  ];

  // The #367 failure regime: raw weight-priced absolutes overflow the
  // measured pool total (the 503%+259%+... week). If this guard ever fails,
  // the fixture has drifted out of the regime and the tripwire is vacuous.
  const rawAbsoluteSum = items.reduce((sum, item) =>
    sum + Object.entries(item.tokenFlows).reduce((s, [k, v]) => s + v * weights[k], 0), 0);
  assert.ok(rawAbsoluteSum > measuredPoolTotal,
    `fixture must reproduce #367: raw absolutes (${rawAbsoluteSum}) must exceed measured total`);

  const apportioned = apportionMeasuredTotal(items, measuredPoolTotal, {
    weights,
    fitQuality: 0.8,
  }, { precision: 1 });

  // Apportionment must neutralize the overflow: rendered figures derive from
  // measured truth, sum exactly to it, and no share exceeds 100% of it. A
  // regression to rendering raw absolutes fails all three.
  assert.equal(apportioned.total, measuredPoolTotal);
  assert.equal(apportioned.allocations.reduce((sum, item) => sum + item.units, 0), apportioned.totalUnits);
  assert.ok(apportioned.allocations.every((item) => item.value <= measuredPoolTotal));
  assert.ok(apportioned.allocations.every((item) => item.value < rawAbsoluteSum));
});

test('insufficient training data yields null range estimates with honesty metadata', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const account = saveClaudeAccount(store, 'Sparse');
  const start = Date.parse('2026-08-03T00:00:00.000Z');
  const reset = '2026-08-10T00:00:00.000Z';
  recordSnapshot(store, account.id, 'weekly', new Date(start).toISOString(), 1, reset);
  const records = [];
  for (let index = 0; index < MIN_USABLE_INTERVALS - 1; index += 1) {
    records.push(requestRecord(
      account,
      `estimate-sparse-request-${index}`,
      new Date(start + index * 60 * 60 * 1_000 + 30 * 60 * 1_000).toISOString(),
      [index + 1, 1, 0, 1],
    ));
    recordSnapshot(
      store,
      account.id,
      'weekly',
      new Date(start + (index + 1) * 60 * 60 * 1_000).toISOString(),
      index + 2,
      reset,
    );
  }
  store.ingestRequestUsage(records);
  refitUsageEstimates(store);

  const report = usageEstimateReport(store, {
    accountId: account.id,
    since: '2026-08-03T00:00:00.000Z',
    until: '2026-08-04T00:00:00.000Z',
  });
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].fits.length, 2);
  assert.equal(report.accounts[0].estimates, null);
  const weekly = report.accounts[0].fits.find((estimate) => estimate.scope === 'weekly');
  assert.equal(weekly.intervalsUsed, MIN_USABLE_INTERVALS - 1);
  assert.equal(weekly.fitQuality, null);
  assert.equal(weekly.identifiability, 'not-assessed');
  assert.equal(weekly.conditionRatio, null);
});

async function routeRequest(app, route, { host = `127.0.0.1:${PORT}` } = {}) {
  const req = Readable.from([]);
  Object.assign(req, { socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: route, headers: { host } });
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(value) {
      payload = value == null || value === '' ? null : JSON.parse(String(value));
    },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, headers, body: payload };
}

test('GET /api/usage/estimate validates filters and labels every estimate payload', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const known = seedKnownSeries(store, 'ApiKnown');
  // /api/usage/* routes are prefix-gated behind the analytics flag (#359).
  store.saveSettings({ usageAnalyticsEnabled: true });
  refitUsageEstimates(store, { fittedAt: '2026-08-10T13:00:00.000Z' });
  const app = createApp({
    store,
    service: {
      projectsRoot: '/tmp/modeldeck-estimate-placeholder',
      startAutoRefresh() {},
      stopAutoRefresh() {},
    },
    host: '127.0.0.1',
    port: PORT,
    mutationToken: 'usage-estimate-placeholder-token',
  });

  const fitsOnly = await routeRequest(app, `/api/usage/estimate?accountId=${encodeURIComponent(known.id)}`);
  assert.equal(fitsOnly.status, 200);
  assert.equal(fitsOnly.body.range, null);
  assert.equal(fitsOnly.body.accounts.length, 1);
  assert.equal(fitsOnly.body.accounts[0].estimates, null);
  fitsOnly.body.accounts[0].fits.forEach(assertFitMetadata);

  const params = new URLSearchParams({
    accountId: known.id,
    since: '2026-08-01T00:00:00.000Z',
    until: '2026-08-01T12:30:00.000Z',
  });
  const ranged = await routeRequest(app, `/api/usage/estimate?${params}`);
  assert.equal(ranged.status, 200);
  assert.equal(ranged.headers['Cache-Control'], 'no-store');
  assert.equal(ranged.body.range.endExclusive, true);
  assert.deepEqual(ranged.body.tokenClasses, TOKEN_CLASSES);
  assert.equal(ranged.body.minimumUsableIntervals, MIN_USABLE_INTERVALS);
  assert.equal(ranged.body.minimumFitQuality, MIN_FIT_QUALITY);
  assert.equal(ranged.body.pools.length, 1);
  assert.equal(ranged.body.pools[0].poolId, CLAUDE_POOL_ID);
  assert.equal(ranged.body.accounts.length, 1);
  assert.deepEqual(ranged.body.accounts[0].tokenFlows, {
    inputUncached: SYNTHETIC_FLOWS.reduce((sum, row) => sum + row[0], 0),
    inputCacheRead: SYNTHETIC_FLOWS.reduce((sum, row) => sum + row[1], 0),
    inputCacheWrite: SYNTHETIC_FLOWS.reduce((sum, row) => sum + row[2], 0),
    outputTotal: SYNTHETIC_FLOWS.reduce((sum, row) => sum + row[3], 0),
  });
  assert.equal(ranged.body.accounts[0].estimates, null);
  assert.equal(ranged.body.accounts[0].fits[0].weights, null);
  assert.match(ranged.body.accounts[0].fits[0].reason, /measured-total apportionment/);
  const poolWeekly = ranged.body.pools[0].fits.find((fit) => fit.scope === 'weekly');
  assert.ok(poolWeekly.fitQuality > 0.999999999);
  TOKEN_CLASSES.forEach((tokenClass, index) => {
    assert.ok(Math.abs(poolWeekly.weights[tokenClass] - TRUE_WEIGHTS[index]) < 1e-8);
  });

  const invalidRoutes = [
    ['/api/usage/estimate?since=2026-08-01T00%3A00%3A00.000Z', /since and until must be provided together/],
    ['/api/usage/estimate?until=2026-08-01T01%3A00%3A00.000Z', /since and until must be provided together/],
    ['/api/usage/estimate?since=2026-08-01T00%3A00%3A00Z&until=2026-08-01T01%3A00%3A00.000Z', /since must be a canonical ISO timestamp/],
    ['/api/usage/estimate?since=2026-08-01T01%3A00%3A00.000Z&until=2026-08-01T01%3A00%3A00.000Z', /since must be earlier than until/],
    ['/api/usage/estimate?accountId=', /accountId must be a non-empty string/],
    ['/api/usage/estimate?accountId=missing-placeholder-account', /accountId must reference a Claude account/],
  ];
  for (const [route, pattern] of invalidRoutes) {
    const result = await routeRequest(app, route);
    assert.equal(result.status, 400);
    assert.match(result.body.error, pattern);
  }

  const hostile = await routeRequest(app, '/api/usage/estimate', { host: 'attacker.example' });
  assert.equal(hostile.status, 403);
  assert.deepEqual(hostile.body, { error: 'unexpected host header' });
});

test('refit CLI parser follows repository script conventions', () => {
  assert.deepEqual(parseArgs(['--db', '/tmp/modeldeck-estimate-placeholder.sqlite']), {
    dbPath: '/tmp/modeldeck-estimate-placeholder.sqlite',
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--db']), /--db requires a value/);
  assert.throws(() => parseArgs(['--account-id', 'account-placeholder']), /unknown argument/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  assert.match(usageText(), /refit-usage-estimates\.mjs/);
});

test('a stale overlapping refit cannot overwrite a newer persisted fit', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const account = seedKnownSeries(store, 'Stale');
  refitUsageEstimates(store, { fittedAt: '2026-08-10T12:00:00.000Z' });
  const fresh = store.db.prepare(
    "SELECT input_uncached_weight, fitted_at FROM usage_estimate_fits WHERE pool_id = ? AND scope = 'weekly'",
  ).get(CLAUDE_POOL_ID);
  assert.equal(fresh.fitted_at, '2026-08-10T12:00:00.000Z');

  // A slower concurrent refit that STARTED earlier persists last with an older
  // fittedAt; the upsert's monotonic guard must reject it.
  refitUsageEstimates(store, { fittedAt: '2026-08-10T11:00:00.000Z' });
  const kept = store.db.prepare(
    "SELECT input_uncached_weight, fitted_at FROM usage_estimate_fits WHERE pool_id = ? AND scope = 'weekly'",
  ).get(CLAUDE_POOL_ID);
  assert.equal(kept.fitted_at, '2026-08-10T12:00:00.000Z');
  assert.equal(kept.input_uncached_weight, fresh.input_uncached_weight);

  // Same-timestamp refits stay idempotent.
  refitUsageEstimates(store, { fittedAt: '2026-08-10T12:00:00.000Z' });
  assert.equal(store.db.prepare(
    "SELECT fitted_at FROM usage_estimate_fits WHERE pool_id = ? AND scope = 'weekly'",
  ).get(CLAUDE_POOL_ID).fitted_at, '2026-08-10T12:00:00.000Z');
});
