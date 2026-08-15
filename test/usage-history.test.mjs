import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store, USAGE_HISTORY_RAW_LIMIT } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

const PORT = 43339;
const TOKEN = 'usage-history-placeholder-token';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-history-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  const first = store.saveAccount({
    provider: 'claude',
    label: 'History Placeholder A',
    identity: 'history-a@example.invalid',
    profileRef: path.join(root, 'claude-placeholder-a'),
  });
  const second = store.saveAccount({
    provider: 'claude',
    label: 'History Placeholder B',
    identity: 'history-b@example.invalid',
    profileRef: path.join(root, 'claude-placeholder-b'),
  });
  const service = {
    projectsRoot: root,
    startAutoRefresh() {},
    stopAutoRefresh() {},
  };
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: PORT,
    mutationToken: TOKEN,
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store, first, second };
}

function snapshot(store, accountId, scope, observedAt, usedPercent, resetsAt = null) {
  store.recordUsage(accountId, {
    scope,
    observedAt,
    usedPercent,
    resetsAt,
    source: 'usage-history-fixture',
    detail: { fixture: 'placeholder' },
  });
}

async function request(app, route, { host = `127.0.0.1:${PORT}` } = {}) {
  const req = Readable.from([]);
  Object.assign(req, {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'GET',
    url: route,
    headers: { host },
  });
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(value, nextHeaders) {
      status = value;
      headers = nextHeaders;
    },
    end(value) {
      payload = value == null || value === '' ? null : JSON.parse(String(value));
    },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, headers, body: payload };
}

test('usage history filters an inclusive range and computes UTC hour/day buckets', (t) => {
  const data = fixture(t);
  const reset0 = '2026-08-09T06:00:00.000Z';
  const reset1 = '2026-08-09T07:00:00.000Z';
  const reset2 = '2026-08-09T08:00:00.000Z';
  const reset3 = '2026-08-09T09:00:00.000Z';
  const rows = [
    ['2026-08-08T22:59:59.999Z', 1, reset0],
    ['2026-08-08T23:00:00.000Z', 5, reset0],
    ['2026-08-09T01:30:00+02:00', 12, reset0],
    ['2026-08-08T23:45:00.000Z', 15, reset0],
    ['2026-08-09T00:00:00.000Z', 10, reset1],
    ['2026-08-09T00:15:00.000Z', null, null],
    ['2026-08-09T00:30:00.000Z', 30, reset1],
    ['2026-08-09T00:45:00.000Z', 20, reset2],
    ['2026-08-09T00:45:00.000Z', 25, reset2],
    ['2026-08-09T01:05:00.000Z', 50, reset2],
    ['2026-08-09T02:00:00Z', 60, reset3],
    ['2026-08-09T03:00:00.001+01:00', 70, reset3],
  ];
  for (const [observedAt, usedPercent, resetsAt] of rows) {
    snapshot(data.store, data.first.id, 'weekly', observedAt, usedPercent, resetsAt);
  }
  snapshot(data.store, data.first.id, '5-hour', '2026-08-09T00:30:00.000Z', 99, reset1);
  snapshot(data.store, data.first.id, 'unavailable', '2026-08-09T00:10:00.000Z', null, null);
  snapshot(data.store, data.first.id, 'unavailable', '2026-08-09T00:20:00.000Z', null, reset1);
  snapshot(data.store, data.second.id, 'weekly', '2026-08-09T00:30:00.000Z', 88, reset1);

  const input = {
    accountId: data.first.id,
    scope: 'weekly',
    since: '2026-08-08T16:00:00-07:00',
    until: '2026-08-09T02:00:00Z',
  };
  const raw = data.store.usageHistory(input);
  assert.deepEqual({
    accountId: raw.accountId,
    scope: raw.scope,
    since: raw.since,
    until: raw.until,
    bucket: raw.bucket,
    truncated: raw.truncated,
  }, {
    accountId: data.first.id,
    scope: 'weekly',
    since: '2026-08-08T23:00:00.000Z',
    until: '2026-08-09T02:00:00.000Z',
    bucket: 'raw',
    truncated: false,
  });
  assert.deepEqual(raw.rows.map((row) => row.usedPercent), [60, 50, 25, 20, 30, null, 10, 15, 12, 5]);
  assert.equal(raw.rows[0].observedAt, '2026-08-09T02:00:00Z', 'a no-milliseconds row is included at until');
  assert.equal(raw.rows[0].remainingPercent, 40);
  assert.equal(raw.rows[5].remainingPercent, null);
  assert.deepEqual(raw.rows[0].detail, { fixture: 'placeholder' });

  const hourly = data.store.usageHistory({ ...input, bucket: 'hour' });
  assert.equal(hourly.truncated, false);
  assert.deepEqual(hourly.rows, [
    { bucketStart: '2026-08-09T02:00:00.000Z', lastUsedPercent: 60, minUsedPercent: 60, maxUsedPercent: 60, resetsAtValues: [reset3] },
    { bucketStart: '2026-08-09T01:00:00.000Z', lastUsedPercent: 50, minUsedPercent: 50, maxUsedPercent: 50, resetsAtValues: [reset2] },
    { bucketStart: '2026-08-09T00:00:00.000Z', lastUsedPercent: 25, minUsedPercent: 10, maxUsedPercent: 30, resetsAtValues: [reset1, reset2] },
    { bucketStart: '2026-08-08T23:00:00.000Z', lastUsedPercent: 15, minUsedPercent: 5, maxUsedPercent: 15, resetsAtValues: [reset0] },
  ]);

  const daily = data.store.usageHistory({ ...input, bucket: 'day' });
  assert.deepEqual(daily.rows, [
    { bucketStart: '2026-08-09T00:00:00.000Z', lastUsedPercent: 60, minUsedPercent: 10, maxUsedPercent: 60, resetsAtValues: [reset1, reset2, reset3] },
    { bucketStart: '2026-08-08T00:00:00.000Z', lastUsedPercent: 15, minUsedPercent: 5, maxUsedPercent: 15, resetsAtValues: [reset0] },
  ]);

  const unavailable = data.store.usageHistory({ ...input, scope: 'unavailable', bucket: 'hour' });
  assert.deepEqual(unavailable.rows, [
    { bucketStart: '2026-08-09T00:00:00.000Z', lastUsedPercent: null, minUsedPercent: null, maxUsedPercent: null, resetsAtValues: [reset1] },
  ]);
});

test('raw usage history caps newest rows and reports whether older matches were truncated', (t) => {
  const data = fixture(t);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  data.store.db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index <= USAGE_HISTORY_RAW_LIMIT; index += 1) {
      snapshot(
        data.store,
        data.first.id,
        'weekly',
        new Date(start + index).toISOString(),
        index,
      );
    }
    data.store.db.exec('COMMIT');
  } catch (error) {
    data.store.db.exec('ROLLBACK');
    throw error;
  }

  const result = data.store.usageHistory({
    accountId: data.first.id,
    scope: 'weekly',
    since: new Date(start).toISOString(),
    until: new Date(start + USAGE_HISTORY_RAW_LIMIT).toISOString(),
  });
  assert.equal(result.rows.length, USAGE_HISTORY_RAW_LIMIT);
  assert.equal(result.truncated, true);
  assert.equal(result.rows[0].usedPercent, USAGE_HISTORY_RAW_LIMIT);
  assert.equal(result.rows.at(-1).usedPercent, 1, 'the cap omits the oldest matching row');

  const exactLimit = data.store.usageHistory({
    accountId: data.first.id,
    scope: 'weekly',
    since: new Date(start).toISOString(),
    until: new Date(start + USAGE_HISTORY_RAW_LIMIT - 1).toISOString(),
  });
  assert.equal(exactLimit.rows.length, USAGE_HISTORY_RAW_LIMIT);
  assert.equal(exactLimit.truncated, false);
  assert.equal(exactLimit.rows.at(-1).usedPercent, 0);
});

test('GET /api/usage/history is Host-gated and validates query parameters', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageAnalyticsEnabled: true });
  snapshot(
    data.store,
    data.first.id,
    'weekly',
    '2026-08-09T01:00:00.000Z',
    42,
    '2026-08-10T00:00:00.000Z',
  );
  const query = new URLSearchParams({
    accountId: data.first.id,
    scope: 'weekly',
    since: '2026-08-09T00:00:00Z',
    until: '2026-08-09T02:00:00Z',
  });
  const route = `/api/usage/history?${query}`;

  const allowed = await request(data.app, route);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['Cache-Control'], 'no-store');
  assert.equal(allowed.body.bucket, 'raw');
  assert.deepEqual(allowed.body.rows.map((row) => row.usedPercent), [42]);

  const rejected = await request(data.app, route, { host: 'attacker.example' });
  assert.equal(rejected.status, 403);
  assert.deepEqual(rejected.body, { error: 'unexpected host header' });

  const valid = {
    accountId: data.first.id,
    scope: 'weekly',
    since: '2026-08-09T00:00:00Z',
    until: '2026-08-09T02:00:00Z',
  };
  const invalidQueries = [
    [{ ...valid, accountId: '' }, /accountId is required/],
    [{ ...valid, scope: '' }, /scope is required/],
    [{ ...valid, scope: '\0weekly' }, /scope is invalid/],
    [{ ...valid, since: '2026-02-30T00:00:00Z' }, /since must be an ISO timestamp/],
    [{ ...valid, until: 'not-a-date' }, /until must be an ISO timestamp/],
    [{ ...valid, since: '2026-08-10T00:00:00Z' }, /since must not be after until/],
    [{ ...valid, bucket: 'minute' }, /bucket must be raw, hour, or day/],
    [{ ...valid, bucket: '' }, /bucket must be raw, hour, or day/],
  ];
  for (const [params, errorPattern] of invalidQueries) {
    const result = await request(data.app, `/api/usage/history?${new URLSearchParams(params)}`);
    assert.equal(result.status, 400);
    assert.match(result.body.error, errorPattern);
  }
});
