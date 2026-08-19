import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { exhaustionForecastReport } from '../src/usage-analytics.mjs';

const NOW = '2026-08-01T04:00:00.000Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-exhaustion-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  store.saveSettings({ usageAnalyticsEnabled: true });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

function account(store, suffix) {
  return store.saveAccount({
    provider: 'claude',
    label: `Placeholder ${suffix}`,
    identity: `placeholder-${suffix.toLowerCase()}@example.invalid`,
    profileRef: `/placeholder/profiles/${suffix.toLowerCase()}`,
  });
}

function snapshot(store, accountId, observedAt, usedPercent, resetsAt) {
  store.recordUsage(accountId, {
    scope: 'weekly', observedAt, usedPercent, resetsAt,
    source: 'exhaustion-forecast-placeholder',
  });
}

async function get(app, route) {
  const req = Readable.from([]);
  Object.assign(req, {
    socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: route,
    headers: { host: '127.0.0.1:43497' },
  });
  let status;
  let payload;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = String(value); },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, payload: JSON.parse(payload) };
}

test('steady burn forecasts the account dry time and the pool worst case', (t) => {
  const { store } = fixture(t);
  const row = account(store, 'Steady');
  for (const [observedAt, usedPercent] of [
    ['2026-08-01T01:00:00.000Z', 20],
    ['2026-08-01T02:00:00.000Z', 30],
    ['2026-08-01T03:00:00.000Z', 40],
    [NOW, 50],
  ]) snapshot(store, row.id, observedAt, usedPercent, '2026-08-01T12:00:00.000Z');

  const report = exhaustionForecastReport(store, { now: NOW });

  assert.equal(report.estimateLabel, 'Estimate');
  assert.deepEqual(report.basisWindow, {
    source: 'usage_snapshots',
    label: 'trailing 3 hours',
    since: '2026-08-01T01:00:00.000Z',
    until: NOW,
    hours: 3,
    minimumSpanMinutes: 30,
  });
  assert.equal(report.accounts[0].status, 'forecast');
  assert.equal(report.accounts[0].burnRatePercentPerHour, 10);
  assert.equal(report.accounts[0].dryAt, '2026-08-01T09:00:00.000Z');
  assert.equal(report.accounts[0].carryover, null);
  assert.equal(report.pool.worstCase.accountId, row.id);
  assert.equal(report.pool.worstCase.dryAt, '2026-08-01T09:00:00.000Z');
});

test('a short reset cadence returns no forecast when refills outrun the measured burn', (t) => {
  const { store } = fixture(t);
  const row = account(store, 'Reset');
  snapshot(store, row.id, '2026-08-01T01:00:00.000Z', 80, '2026-08-01T02:00:00.000Z');
  snapshot(store, row.id, '2026-08-01T02:00:00.000Z', 0, '2026-08-01T06:00:00.000Z');
  snapshot(store, row.id, '2026-08-01T03:00:00.000Z', 10, '2026-08-01T06:00:00.000Z');
  snapshot(store, row.id, NOW, 20, '2026-08-01T06:00:00.000Z');

  const forecast = exhaustionForecastReport(store, { now: NOW }).accounts[0];

  assert.equal(forecast.burnRatePercentPerHour, 10,
    'the interval that crossed the reset contributes neither burn nor elapsed time');
  assert.equal(forecast.status, 'no-forecast');
  assert.equal(forecast.dryAt, null);
  assert.equal(forecast.carryover, null);
  assert.equal(forecast.reason, 'At the measured pace this account refills before it runs dry.');
});

test('a long observed reset cadence permits a reachable carryover forecast', (t) => {
  const { store } = fixture(t);
  const row = account(store, 'Long Reset');
  snapshot(store, row.id, '2026-08-01T01:00:00.000Z', 80, '2026-07-31T18:00:00.000Z');
  snapshot(store, row.id, '2026-08-01T02:00:00.000Z', 0, '2026-08-01T06:00:00.000Z');
  snapshot(store, row.id, '2026-08-01T03:00:00.000Z', 10, '2026-08-01T06:00:00.000Z');
  snapshot(store, row.id, NOW, 20, '2026-08-01T06:00:00.000Z');

  const forecast = exhaustionForecastReport(store, { now: NOW }).accounts[0];

  assert.equal(forecast.status, 'forecast');
  assert.equal(forecast.dryAt, '2026-08-01T16:00:00.000Z');
  assert.deepEqual(forecast.carryover, {
    assumed: true,
    resetAt: '2026-08-01T06:00:00.000Z',
    note: 'Assumes the measured burn rate carries over after this reset.',
  });
});

test('carryover states when reset cadence is unobserved', (t) => {
  const { store } = fixture(t);
  const row = account(store, 'Unknown Reset');
  for (const [observedAt, usedPercent] of [
    ['2026-08-01T01:00:00.000Z', 20],
    ['2026-08-01T02:00:00.000Z', 30],
    ['2026-08-01T03:00:00.000Z', 40],
    [NOW, 50],
  ]) snapshot(store, row.id, observedAt, usedPercent, '2026-08-01T06:00:00.000Z');

  const forecast = exhaustionForecastReport(store, { now: NOW }).accounts[0];

  assert.equal(forecast.status, 'forecast');
  assert.equal(forecast.dryAt, '2026-08-01T16:00:00.000Z');
  assert.deepEqual(forecast.carryover, {
    assumed: true,
    resetAt: '2026-08-01T06:00:00.000Z',
    note: 'Assumes the measured burn rate carries over after this reset; the reset cadence is unobserved, so this estimate assumes no earlier refill.',
  });
});

test('zero and unknown burn return honest no-forecast rows', (t) => {
  const { store } = fixture(t);
  const zero = account(store, 'Zero');
  const unknown = account(store, 'Unknown');
  for (const observedAt of [
    '2026-08-01T01:00:00.000Z', '2026-08-01T02:00:00.000Z',
    '2026-08-01T03:00:00.000Z', NOW,
  ]) snapshot(store, zero.id, observedAt, 25, '2026-08-01T12:00:00.000Z');
  snapshot(store, unknown.id, NOW, 25, '2026-08-01T12:00:00.000Z');

  const report = exhaustionForecastReport(store, { now: NOW });
  const byId = new Map(report.accounts.map((row) => [row.accountId, row]));

  assert.deepEqual(
    [byId.get(zero.id).status, byId.get(zero.id).dryAt, byId.get(zero.id).burnRatePercentPerHour],
    ['no-forecast', null, null],
  );
  assert.match(byId.get(zero.id).reason, /no burn measured/i);
  assert.deepEqual(
    [byId.get(unknown.id).status, byId.get(unknown.id).dryAt, byId.get(unknown.id).burnRatePercentPerHour],
    ['no-forecast', null, null],
  );
  assert.match(byId.get(unknown.id).reason, /not enough recent observations/i);
  assert.deepEqual(report.pool, { status: 'no-forecast', worstCase: null });
  assert.equal(JSON.stringify(report).includes('Infinity'), false);
});

test('GET /api/usage/exhaustion-forecast carries the estimate label and basis window', async (t) => {
  const { root, store } = fixture(t);
  const service = { projectsRoot: root, startAutoRefresh() {}, stopAutoRefresh() {} };
  const app = createApp({
    store, service, host: '127.0.0.1', port: 43497,
    mutationToken: 'exhaustion-forecast-placeholder-token',
  });

  const response = await get(app, '/api/usage/exhaustion-forecast');

  assert.equal(response.status, 200);
  assert.equal(response.payload.estimateLabel, 'Estimate');
  assert.equal(response.payload.basisWindow.source, 'usage_snapshots');
  assert.equal(response.payload.basisWindow.label, 'trailing 3 hours');
  assert.equal(response.payload.basisWindow.hours, 3);
  assert.equal(response.payload.basisWindow.minimumSpanMinutes, 30);
});
