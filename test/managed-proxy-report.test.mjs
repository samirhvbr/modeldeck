// Issue #432 — the app reports only lifecycle transitions the daemon cannot
// observe itself. This is additive, memory-only state: old apps omit it and a
// restarted daemon forgets it until the next report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { ModelDeckService } from '../src/service.mjs';

const PORT = 43281;
const TOKEN = 'managed-proxy-report-placeholder-token';
const REPORTED_AT = '2026-08-14T20:45:57.123Z';
const RECEIVED_AT = '2026-08-14T20:45:58.000Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-managed-proxy-report-'));
  const store = new Store(':memory:');
  const serviceOptions = {
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    detectForeignUsageConsumers: async () => ({ checked: true, consumers: [], probe: 'ok' }),
    now: () => Date.parse(RECEIVED_AT),
  };
  const service = new ModelDeckService(store, serviceOptions);
  const app = createApp({ store, service, host: '127.0.0.1', port: PORT, mutationToken: TOKEN });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root, service, serviceOptions, store };
}

async function request(app, route, { authenticated = true, body, method = 'POST', headers = {} } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  Object.assign(req, {
    socket: { remoteAddress: '127.0.0.1' },
    method,
    url: route,
    headers: {
      host: `127.0.0.1:${PORT}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(authenticated ? {
        'x-modeldeck-token': TOKEN,
        cookie: `modeldeck_session=${TOKEN}`,
      } : {}),
      ...headers,
    },
  });
  let status;
  let responseBody;
  const res = {
    writeHead(value) { status = value; },
    end(value) { responseBody = value ? JSON.parse(String(value)) : null; },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, body: responseBody };
}

function validReport(overrides = {}) {
  return {
    managed: true,
    phase: 'started',
    pid: 2468,
    restartCount: 0,
    appVersion: '1.0.0',
    reportedAt: REPORTED_AT,
    ...overrides,
  };
}

test('POST /api/managed-proxy/report is token-gated before it mutates state', async (t) => {
  const { app, service } = fixture(t);
  const result = await request(app, '/api/managed-proxy/report', {
    authenticated: false,
    body: validReport(),
  });
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: 'mutation token or origin rejected' });
  assert.equal(Object.hasOwn((await service.state()).managedProxy, 'appReport'), false);
});

// CodeRabbit (PR #440): the gate demands header AND cookie — a partial
// credential must fail the same way, and must not mutate state.
test('POST /api/managed-proxy/report rejects partial credentials (header-only, cookie-only)', async (t) => {
  const { app, service } = fixture(t);
  for (const headers of [
    { 'x-modeldeck-token': TOKEN },
    { cookie: `modeldeck_session=${TOKEN}` },
  ]) {
    const result = await request(app, '/api/managed-proxy/report', {
      authenticated: false,
      headers,
      body: validReport(),
    });
    assert.equal(result.status, 403);
    assert.equal(Object.hasOwn((await service.state()).managedProxy, 'appReport'), false);
  }
});

test('POST /api/managed-proxy/report rejects malformed known fields', async (t) => {
  const { app } = fixture(t);
  const invalidReports = [
    null,
    [],
    {},
    validReport({ managed: 'yes' }),
    validReport({ phase: '' }),
    validReport({ pid: 1.5 }),
    validReport({ pid: 0 }),
    validReport({ restartCount: -1 }),
    validReport({ restartCount: 1.5 }),
    validReport({ appVersion: 100 }),
    validReport({ reportedAt: 'not-a-date' }),
    validReport({ reportedAt: '2026-02-30T00:00:00Z' }),
    validReport({ reportedAt: '2026-08-14T20:45:57+15:00' }),
  ];
  for (const body of invalidReports) {
    const result = await request(app, '/api/managed-proxy/report', { body });
    assert.equal(result.status, 400, JSON.stringify(body));
  }
});

test('TRIPWIRE managed-proxy-app-report-absent — /api/state NEVER carries appReport before the first report', async (t) => {
  const { app } = fixture(t);
  const before = await request(app, '/api/state', { method: 'GET' });
  assert.equal(before.status, 200);
  assert.equal(Object.hasOwn(before.body.managedProxy, 'appReport'), false);

  const report = validReport();
  const accepted = await request(app, '/api/managed-proxy/report', { body: report });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.appReport, { ...report, receivedAt: RECEIVED_AT });

  const after = await request(app, '/api/state', { method: 'GET' });
  assert.deepEqual(after.body.managedProxy.appReport, { ...report, receivedAt: RECEIVED_AT });
});

test('a daemon restart forgets the in-memory app report', async (t) => {
  const { app, serviceOptions, store } = fixture(t);
  const accepted = await request(app, '/api/managed-proxy/report', { body: validReport() });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const restartedService = new ModelDeckService(store, serviceOptions);
  const restartedApp = createApp({
    store,
    service: restartedService,
    host: '127.0.0.1',
    port: PORT,
    mutationToken: TOKEN,
  });
  const state = await request(restartedApp, '/api/state', { method: 'GET' });
  assert.equal(Object.hasOwn(state.body.managedProxy, 'appReport'), false);
});

test('unknown fields from a newer app are ignored rather than echoed', async (t) => {
  const { app } = fixture(t);
  const report = validReport({ pid: null, restartCount: null, appVersion: null });
  const result = await request(app, '/api/managed-proxy/report', {
    body: { ...report, futureLifecycleDetail: { value: 'placeholder' } },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.appReport, { ...report, receivedAt: RECEIVED_AT });
  assert.equal(Object.hasOwn(result.body.appReport, 'futureLifecycleDetail'), false);
});
