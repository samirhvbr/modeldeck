import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import { bootPage, waitFor } from '../dashboard/test-support/index.mjs';
import {
  COLD_CACHE_CHURN,
  COLD_CACHE_CHURN_THRESHOLDS,
  DIAGNOSTIC_DETECTORS,
  coldCacheChurnDetector,
  findingId,
  readDiagnosticCorpus,
  runDiagnostician,
} from '../src/diagnostician.mjs';
import { RETRY_STORM } from '../src/rate-pathologies.mjs';

const fixture = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/diagnostician-corpus.json', import.meta.url)),
  'utf8',
));

// The page's pinned clock (bootPage `now`): every render test here seeds
// fixed 2026-08-17 fixtures, so the page must not query a wall-clock window
// they age out of.
const PAGE_NOW = '2026-08-18T12:00:00.000Z';

function seedSession(store, session) {
  if (session.provider === 'claude') {
    store.ingestTranscriptBatch({
      sessions: [{
        sessionId: session.sessionId,
        profileSlug: session.profileSlug,
        machine: 'machine-placeholder',
        cwd: '/workspace/placeholder',
        firstAt: session.points[0].at,
        lastAt: session.points.at(-1).at,
      }],
      requests: session.points.map((point, index) => ({
        dedupeKey: `${session.sessionId}:${session.agentId || 'main'}:${index}`,
        requestId: null,
        sessionId: session.sessionId,
        profileSlug: session.profileSlug,
        messageId: `message-placeholder-${index}`,
        recordUuid: null,
        model: 'claude-placeholder',
        effort: null,
        observedAt: point.at,
        inputTokens: point.uncached,
        cacheCreationInputTokens: point.cacheWrite || 0,
        cacheReadInputTokens: point.cached,
        outputTokens: 100,
        cacheCreationEphemeral5mInputTokens: 0,
        cacheCreationEphemeral1hInputTokens: 0,
        isSidechain: Boolean(session.agentId),
        agentId: session.agentId || null,
      })),
    });
    return;
  }

  store.ingestCodexSession({
    sessionId: session.sessionId,
    profileSlug: session.profileSlug,
    machine: 'machine-placeholder',
    cwd: '/workspace/placeholder',
    firstTimestamp: session.points[0].at,
    lastTimestamp: session.points.at(-1).at,
    archived: false,
  }, session.points.map((point, index) => ({
    turnIndex: index,
    turnId: `turn-placeholder-${index}`,
    model: 'gpt-placeholder',
    reasoningEffort: 'medium',
    inputTokens: point.uncached + point.cached,
    cachedInputTokens: point.cached,
    cacheWriteInputTokens: point.cacheWrite || 0,
    outputTokens: 100,
    reasoningOutputTokens: 20,
    totalTokens: point.uncached + point.cached + 100,
    timestamp: point.at,
  })));
}

async function requestJson(app, url, port = 43496) {
  const request = Object.assign(Readable.from([]), {
    method: 'GET',
    url,
    headers: { host: `127.0.0.1:${port}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let payload;
  const response = {
    writeHead(value) { status = value; },
    end(value) { payload = JSON.parse(String(value)); },
  };
  await app.server.listeners('request')[0](request, response);
  return { status, payload };
}

function seedFinding(store, sessions, { id = 'finding-dashboard-placeholder' } = {}) {
  store.syncFindings(COLD_CACHE_CHURN, [{
    id,
    scopeKey: id,
    corpusFingerprint: `${id}-corpus`,
    evidence: {
      affectedSessions: sessions.filter(Boolean).length,
      estimatedExcessUncachedTokens: sessions.filter(Boolean).reduce(
        (sum, session) => sum + Number(session.estimatedExcessUncachedTokens || 0),
        0,
      ),
      fix: 'keep check-ins under the cache TTL',
      sessions,
    },
  }], { detectedAt: '2026-08-17T23:00:00.000Z' });
}

function receiptSession(overrides = {}) {
  return {
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'session-placeholder',
    requestCount: 4,
    firstAt: '2026-08-17T20:00:00.000Z',
    lastAt: '2026-08-17T20:15:00.000Z',
    medianCadenceSeconds: 300,
    uncachedInputTokens: 330000,
    cacheReadTokens: 1500,
    estimatedExcessUncachedTokens: 316000,
    ...overrides,
  };
}

test('fixture corpus produces one cold-cache finding with measured evidence and suppresses an unchanged rescan', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  fixture.sessions.forEach((session) => seedSession(store, session));
  const logs = [];

  const first = await runDiagnostician({
    store,
    logger: (message) => logs.push(message),
    detectedAt: '2026-08-17T23:00:00.000Z',
  });
  assert.deepEqual(first, {
    detectors: DIAGNOSTIC_DETECTORS.length,
    findings: 1,
    inserted: 1,
    updated: 0,
    resolved: 0,
    unchanged: 0,
  });

  const [finding] = store.listFindings();
  assert.equal(finding.pathologyKind, COLD_CACHE_CHURN);
  assert.equal(finding.revision, 1);
  assert.equal(finding.suppressionKey, `${finding.id}:1`);
  assert.deepEqual(finding.evidence, {
    affectedSessions: 1,
    estimatedExcessUncachedTokens: 316000,
    fix: 'keep check-ins under the cache TTL',
    sessions: [{
      provider: 'claude',
      profileSlug: 'claude-profile-placeholder',
      sessionId: 'churn-session-placeholder',
      requestCount: 4,
      firstAt: '2026-08-17T20:00:00.000Z',
      lastAt: '2026-08-17T20:15:00.000Z',
      medianCadenceSeconds: 300,
      baselineUncachedInputTokens: 3000,
      baselineCacheReadTokens: 97000,
      baselineCacheReadShare: 0.97,
      uncachedInputTokens: 330000,
      cacheReadTokens: 1500,
      cacheReadShare: 0.004525,
      averageUncachedIncreaseTokens: 107000,
      estimatedExcessUncachedTokens: 316000,
    }],
  });

  const second = await runDiagnostician({
    store,
    logger: (message) => logs.push(message),
    detectedAt: '2026-08-17T23:15:00.000Z',
  });
  assert.deepEqual(second, {
    detectors: DIAGNOSTIC_DETECTORS.length,
    findings: 1,
    inserted: 0,
    updated: 0,
    resolved: 0,
    unchanged: 1,
  });
  assert.equal(store.listFindings().length, 1, 'the same corpus cannot create a second finding');
  assert.equal(store.listFindings()[0].revision, 1, 'the suppression revision does not advance');
  assert.equal(store.listFindings()[0].lastChangedAt, '2026-08-17T23:00:00.000Z');

  const changed = structuredClone(fixture.sessions[0]);
  changed.points.push({
    at: '2026-08-17T20:20:00.000Z',
    uncached: 120000,
    cached: 0,
  });
  seedSession(store, changed);
  const third = await runDiagnostician({
    store,
    logger: (message) => logs.push(message),
    detectedAt: '2026-08-17T23:30:00.000Z',
  });
  assert.deepEqual(third, {
    detectors: DIAGNOSTIC_DETECTORS.length,
    findings: 1,
    inserted: 0,
    updated: 1,
    resolved: 0,
    unchanged: 0,
  });
  assert.equal(store.listFindings().length, 1, 'changed evidence updates the stable finding row');
  assert.equal(store.listFindings()[0].revision, 2, 'a corpus change re-arms the finding');
  assert.equal(store.listFindings()[0].suppressionKey, `${finding.id}:2`);
  assert.equal(store.listFindings()[0].lastChangedAt, '2026-08-17T23:30:00.000Z');
  assert.equal(store.listFindings()[0].evidence.estimatedExcessUncachedTokens, 431500);

  assert.equal(
    logs.length,
    DIAGNOSTIC_DETECTORS.length * 3,
    'every detector logs its thresholds on every scan, including a suppressed scan',
  );
  const coldCacheLogs = logs.filter((message) => message.includes(`detector=${COLD_CACHE_CHURN}`));
  assert.equal(coldCacheLogs.length, 3);
  for (const message of coldCacheLogs) {
    for (const [name, value] of Object.entries(COLD_CACHE_CHURN_THRESHOLDS)) {
      assert.match(message, new RegExp(`"${name}":${value}`), `${name} is not silent`);
    }
  }
});

test('Codex cached_input_tokens versus input_tokens produces the same churn signature', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedSession(store, fixture.codexChurn);

  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });
  const [finding] = store.listFindings();
  assert.equal(finding.evidence.sessions[0].provider, 'codex');
  assert.equal(finding.evidence.sessions[0].uncachedInputTokens, 330000);
  assert.equal(finding.evidence.sessions[0].estimatedExcessUncachedTokens, 316000);
});

test('Claude cache-creation tokens carry the uncached balloon after a warm cache collapses', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedSession(store, {
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'cache-rebuild-session-placeholder',
    points: [
      { at: '2026-08-17T19:00:00.000Z', uncached: 3000, cached: 97000 },
      { at: '2026-08-17T19:05:00.000Z', uncached: 1000, cached: 0, cacheWrite: 104000 },
      { at: '2026-08-17T19:10:00.000Z', uncached: 1000, cached: 0, cacheWrite: 109000 },
      { at: '2026-08-17T19:15:00.000Z', uncached: 1000, cached: 0, cacheWrite: 114000 },
    ],
  });

  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });

  const [finding] = store.listFindings();
  assert.ok(finding, 'cache rebuilds are uncached input, not a separate non-signal');
  assert.equal(finding.evidence.sessions[0].uncachedInputTokens, 330000);
  assert.equal(finding.evidence.sessions[0].estimatedExcessUncachedTokens, 315000);
});

test('repeated large Claude cache recreations prove churn without a prior warm turn', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedSession(store, {
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'all-rebuild-session-placeholder',
    points: [0, 5, 10, 15].map((minute, index) => ({
      at: `2026-08-17T17:${String(minute).padStart(2, '0')}:00.000Z`,
      uncached: 1000,
      cached: 0,
      cacheWrite: 100000 + index * 5000,
    })),
  });

  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });

  const [finding] = store.listFindings();
  assert.ok(finding, 'rebuilding the whole prompt cache every five minutes is direct miss evidence');
  assert.equal(finding.evidence.sessions[0].cacheWriteTokens, 330000);
  assert.equal(finding.evidence.sessions[0].uncachedInputTokens, 333000);
  assert.equal(finding.evidence.sessions[0].estimatedExcessUncachedTokens, 318000);
});

test('regular requests that were never warm do not claim a cache-read collapse', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedSession(store, {
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'always-uncached-session-placeholder',
    points: [0, 5, 10, 15].map((minute) => ({
      at: `2026-08-17T18:${String(minute).padStart(2, '0')}:00.000Z`,
      uncached: 30000,
      cached: 0,
    })),
  });

  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });

  assert.deepEqual(store.listFindings(), []);
});

test('Claude sidechain requests cannot break or resolve a parent-session finding', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedSession(store, fixture.sessions[0]);
  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });
  const original = store.listFindings()[0];

  seedSession(store, {
    provider: 'claude',
    profileSlug: fixture.sessions[0].profileSlug,
    sessionId: fixture.sessions[0].sessionId,
    agentId: 'agent-placeholder',
    points: [{ at: '2026-08-17T20:07:00.000Z', uncached: 500, cached: 500 }],
  });
  const rescan = await runDiagnostician({
    store,
    logger() {},
    detectedAt: '2026-08-17T23:15:00.000Z',
  });

  assert.equal(rescan.findings, 1);
  assert.equal(rescan.unchanged, 1);
  assert.equal(store.listFindings()[0].active, true);
  assert.equal(store.listFindings()[0].revision, original.revision);
});

test('TRIPWIRE: NULL-agent Claude sidechains are skipped instead of merged into a false cadence stream', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessionId = 'unknown-sidechains-placeholder';
  const profileSlug = 'claude-profile-placeholder';
  const points = [
    { at: '2026-08-17T20:00:00.000Z', uncached: 3000, cached: 97000 },
    { at: '2026-08-17T20:05:00.000Z', uncached: 110000, cached: 500 },
    { at: '2026-08-17T20:10:00.000Z', uncached: 110000, cached: 500 },
    { at: '2026-08-17T20:15:00.000Z', uncached: 110000, cached: 500 },
  ];
  store.ingestTranscriptBatch({
    sessions: [{
      sessionId,
      profileSlug,
      machine: 'machine-placeholder',
      cwd: '/workspace/placeholder',
      firstAt: points[0].at,
      lastAt: points.at(-1).at,
    }],
    requests: points.map((point, index) => ({
      dedupeKey: `${sessionId}:unknown-sidechain:${index}`,
      sessionId,
      profileSlug,
      messageId: `unknown-sidechain-message-placeholder-${index}`,
      model: 'claude-placeholder',
      observedAt: point.at,
      inputTokens: point.uncached,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: point.cached,
      outputTokens: 100,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      isSidechain: true,
      agentId: null,
    })),
  });
  const logs = [];

  const summary = await runDiagnostician({
    store,
    logger: (message) => logs.push(message),
    detectedAt: '2026-08-17T23:00:00.000Z',
  });

  assert.equal(summary.findings, 0);
  assert.deepEqual(store.listFindings(), []);
  assert.ok(logs.some((message) => (
    message.includes('sidechain-missing-agent-id') && message.includes('rows=4')
  )), 'the honest skip count is logged');
});

test('TRIPWIRE: diagnostic corpus reads cap each provider in yielding batches and log omitted rows', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const points = Array.from({ length: 6 }, (_, index) => ({
    at: new Date(Date.parse('2026-08-17T20:00:00.000Z') + index * 60_000).toISOString(),
    uncached: 1000 + index,
    cached: 2000 + index,
  }));
  seedSession(store, {
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'bounded-claude-session-placeholder',
    points,
  });
  seedSession(store, {
    provider: 'codex',
    profileSlug: 'codex-profile-placeholder',
    sessionId: 'bounded-codex-session-placeholder',
    points,
  });
  const logs = [];
  let yields = 0;

  const corpus = await readDiagnosticCorpus(store, {
    maximumRowsPerProvider: 4,
    batchSize: 2,
    logger: (message) => logs.push(message),
    yieldToServeLoop: async () => { yields += 1; },
  });

  assert.deepEqual(corpus.sessions.map((session) => ({
    provider: session.provider,
    points: session.points.length,
  })), [
    { provider: 'claude', points: 4 },
    { provider: 'codex', points: 4 },
  ]);
  assert.equal(yields, 2, 'each provider yields between its two full batches');
  assert.ok(logs.some((message) => (
    message.includes('provider=claude') && message.includes('included=4') && message.includes('omitted=2')
  )));
  assert.ok(logs.some((message) => (
    message.includes('provider=codex') && message.includes('included=4') && message.includes('omitted=2')
  )));
});

test('regular-cadence detector work stays bounded for a long session', () => {
  const points = Array.from({ length: 400 }, (_, index) => ({
    key: String(index),
    at: new Date(Date.parse('2026-08-15T00:00:00.000Z') + index * 300000).toISOString(),
    uncached: index === 0 ? 3000 : 100000,
    cached: index === 0 ? 97000 : 0,
    cacheWrite: 0,
    totalInput: 100000,
  }));
  const started = performance.now();

  const findings = coldCacheChurnDetector.detect({
    sessions: [{
      provider: 'claude',
      profileSlug: 'claude-profile-placeholder',
      sessionId: 'long-session-placeholder',
      corpusFingerprint: 'long-session-fingerprint-placeholder',
      points,
    }],
  });
  const elapsedMs = performance.now() - started;

  assert.equal(findings.length, 1);
  assert.ok(elapsedMs < 100, `400 requests blocked the event loop for ${Math.round(elapsedMs)}ms`);
});

test('unchanged corpus refreshes evidence without re-arming the suppression revision', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const candidate = (evidence) => ({
    id: 'finding-evidence-placeholder',
    scopeKey: 'scope-placeholder',
    corpusFingerprint: 'corpus-placeholder',
    evidence,
  });
  store.syncFindings('pathology-placeholder', [candidate({ schema: 1 })], {
    detectedAt: '2026-08-17T22:00:00.000Z',
  });

  const summary = store.syncFindings('pathology-placeholder', [candidate({ schema: 2 })], {
    detectedAt: '2026-08-17T22:15:00.000Z',
  });

  const [finding] = store.listFindings();
  assert.equal(summary.unchanged, 1);
  assert.equal(finding.revision, 1, 'presentation-only evidence migration cannot re-nag');
  assert.equal(finding.lastChangedAt, '2026-08-17T22:00:00.000Z');
  assert.deepEqual(finding.evidence, { schema: 2 });
});

test('GET /api/usage/findings lists the stored receipt and suppression revision', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  fixture.sessions.forEach((session) => seedSession(store, session));
  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });
  const port = 43496;
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port,
    mutationToken: 'diagnostician-token-placeholder',
  });
  const request = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/api/usage/findings',
    headers: { host: `127.0.0.1:${port}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let payload;
  const response = {
    writeHead(value) { status = value; },
    end(value) { payload = JSON.parse(String(value)); },
  };

  await app.server.listeners('request')[0](request, response);

  const id = findingId(COLD_CACHE_CHURN, 'all-affected-sessions');
  assert.equal(status, 200);
  assert.equal(payload.findings.length, 1);
  assert.deepEqual({
    id: payload.findings[0].id,
    pathologyKind: payload.findings[0].pathologyKind,
    revision: payload.findings[0].revision,
    suppressionKey: payload.findings[0].suppressionKey,
    active: payload.findings[0].active,
    firstDetectedAt: payload.findings[0].firstDetectedAt,
    lastChangedAt: payload.findings[0].lastChangedAt,
    resolvedAt: payload.findings[0].resolvedAt,
    affectedSessions: payload.findings[0].evidence.affectedSessions,
    excess: payload.findings[0].evidence.estimatedExcessUncachedTokens,
    fix: payload.findings[0].evidence.fix,
  }, {
    id,
    pathologyKind: COLD_CACHE_CHURN,
    revision: 1,
    suppressionKey: `${id}:1`,
    active: true,
    firstDetectedAt: '2026-08-17T23:00:00.000Z',
    lastChangedAt: '2026-08-17T23:00:00.000Z',
    resolvedAt: null,
    affectedSessions: 1,
    excess: 316000,
    fix: 'keep check-ins under the cache TTL',
  });
});

test('GET /api/usage/findings scopes receipts to provider and time filters', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  fixture.sessions.forEach((session) => seedSession(store, session));
  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port: 43498,
    mutationToken: 'diagnostician-filter-token-placeholder',
  });

  const matching = await requestJson(
    app,
    '/api/usage/findings?provider=claude&since=2026-08-17T19:00:00.000Z&until=2026-08-17T21:00:00.000Z',
    43498,
  );
  const wrongProvider = await requestJson(
    app,
    '/api/usage/findings?provider=codex&since=2026-08-17T19:00:00.000Z&until=2026-08-17T21:00:00.000Z',
    43498,
  );
  const wrongTime = await requestJson(
    app,
    '/api/usage/findings?provider=claude&since=2026-08-18T19:00:00.000Z&until=2026-08-18T21:00:00.000Z',
    43498,
  );

  assert.equal(matching.status, 200);
  assert.equal(matching.payload.findings.length, 1);
  assert.equal(matching.payload.findings[0].evidence.affectedSessions, 1);
  assert.deepEqual(wrongProvider.payload.findings, []);
  assert.deepEqual(wrongTime.payload.findings, []);
});

test('dashboard renders one minimal finding row and clicks through to its receipt', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  fixture.sessions.forEach((session) => seedSession(store, session));
  await runDiagnostician({ store, logger() {}, detectedAt: '2026-08-17T23:00:00.000Z' });
  const port = 43497;
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port,
    mutationToken: 'diagnostician-dashboard-token-placeholder',
  });
  const dom = bootPage(DASHBOARD_APP_HTML, app, { host: `127.0.0.1:${port}`, now: PAGE_NOW });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  await waitFor(() => page.querySelector('.finding-row'), 'the finding row to render', { timeoutMs: 750 });
  const rows = page.querySelectorAll('.finding-row');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Cold-cache churn/);
  assert.match(rows[0].textContent, /1 session/);
  assert.match(rows[0].textContent, /316K excess uncached/);
  assert.equal(rows[0].getAttribute('aria-expanded'), 'false');
  assert.equal(page.querySelector('.finding-receipt'), null, 'evidence stays behind the drill');

  rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => page.querySelector('.finding-receipt'), 'the receipt to open');
  const receipt = page.querySelector('.finding-receipt');
  assert.equal(rows[0].getAttribute('aria-expanded'), 'true');
  assert.match(receipt.textContent, /keep check-ins under the cache TTL/);
  assert.match(receipt.textContent, /Claude/);
  assert.match(receipt.textContent, /claude-profile-placeholder/);
  assert.match(receipt.textContent, /churn-session-placeholder/);
  assert.equal(
    receipt.querySelector('.finding-session-name').getAttribute('title'),
    'Claude · claude-profile-placeholder · churn-session-placeholder',
  );
  assert.match(receipt.textContent, /5 min cadence/);
  assert.match(receipt.textContent, /330K uncached · 1.5K cache reads · 316K excess/);
});

test('TRIPWIRE: dashboard rate receipt names the measured window and tokens burned', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncFindings(RETRY_STORM, [{
    id: 'finding-rate-dashboard-placeholder',
    scopeKey: 'rate-dashboard-placeholder',
    corpusFingerprint: 'rate-dashboard-corpus-placeholder',
    evidence: {
      affectedSessions: 1,
      tokensBurned: 30_000,
      fix: 'wait for the rate-limit window instead of retrying immediately',
      sessions: [{
        provider: 'claude',
        profileSlug: 'claude-profile-placeholder',
        sessionId: 'rate-dashboard-session-placeholder',
        requestCount: 3,
        firstAt: '2026-08-17T20:05:02.000Z',
        lastAt: '2026-08-17T20:05:06.000Z',
        medianCadenceSeconds: 2,
        tokensBurned: 30_000,
        uncachedInputTokens: 3_000,
        cacheReadTokens: 27_000,
        outputTokens: 0,
        signalGrade: 'wire',
        rateLimitFailures: 3,
      }],
    },
  }], { detectedAt: '2026-08-17T23:00:00.000Z' });
  const port = 43502;
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port,
    mutationToken: 'rate-dashboard-token-placeholder',
  });
  const dom = bootPage(DASHBOARD_APP_HTML, app, { host: `127.0.0.1:${port}`, now: PAGE_NOW });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  const row = await waitFor(() => page.querySelector('.finding-row'), 'the rate finding row');
  assert.match(row.textContent, /Retry storm/);
  assert.match(row.textContent, /30K burned/);
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const receipt = await waitFor(() => page.querySelector('.finding-receipt'), 'the rate receipt');
  assert.deepEqual(
    [...receipt.querySelectorAll('time')].map((element) => element.getAttribute('datetime')),
    ['2026-08-17T20:05:02.000Z', '2026-08-17T20:05:06.000Z'],
  );
  assert.match(receipt.textContent, /30K burned/);
  assert.doesNotMatch(receipt.textContent, /0 excess/);
  assert.match(page.querySelector('.findings-head').textContent, /ingested receipts/);
});

test('dashboard distinguishes an unavailable findings endpoint from a clean corpus', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port: 43499,
    mutationToken: 'diagnostician-error-token-placeholder',
  });
  const handler = app.server.listeners('request')[0];
  const failingApp = {
    server: {
      listeners() {
        return [async (request, response) => {
          if (String(request.url).startsWith('/api/usage/findings')) {
            response.writeHead(500);
            response.end(JSON.stringify({ error: 'placeholder failure' }));
            return;
          }
          await handler(request, response);
        }];
      },
    },
  };
  const dom = bootPage(DASHBOARD_APP_HTML, failingApp, { host: '127.0.0.1:43499' });
  t.after(() => dom.window.close());

  await waitFor(
    () => dom.window.document.body.textContent.includes('Burn receipts unavailable'),
    'the findings failure to remain visible',
    { timeoutMs: 750 },
  );
});

test('dashboard receipt ignores malformed sessions and distinguishes profile identities', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedFinding(store, [
    null,
    receiptSession({ profileSlug: 'claude-profile-a', sessionId: 'shared-session-placeholder' }),
    receiptSession({ profileSlug: 'claude-profile-b', sessionId: 'shared-session-placeholder' }),
  ]);
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port: 43500,
    mutationToken: 'diagnostician-malformed-token-placeholder',
  });
  const dom = bootPage(DASHBOARD_APP_HTML, app, { host: '127.0.0.1:43500', now: PAGE_NOW });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  const row = await waitFor(() => page.querySelector('.finding-row'), 'the finding row');
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const receipt = await waitFor(() => page.querySelector('.finding-receipt'), 'the resilient receipt');

  assert.equal(page.querySelectorAll('.finding-session').length, 2);
  assert.match(receipt.textContent, /Claude · claude-profile-a · shared-session-placeholder/);
  assert.match(receipt.textContent, /Claude · claude-profile-b · shared-session-placeholder/);
});

test('dashboard receipt progressively reveals large affected-session lists', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedFinding(store, Array.from({ length: 30 }, (_, index) => receiptSession({
    sessionId: `session-placeholder-${index}`,
  })));
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port: 43501,
    mutationToken: 'diagnostician-progressive-token-placeholder',
  });
  const dom = bootPage(DASHBOARD_APP_HTML, app, { host: '127.0.0.1:43501', now: PAGE_NOW });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  const row = await waitFor(() => page.querySelector('.finding-row'), 'the finding row');
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const reveal = await waitFor(
    () => [...page.querySelectorAll('button')].find((button) => /Show 10 more sessions/.test(button.textContent)),
    'the progressive reveal control',
  );
  assert.equal(page.querySelectorAll('.finding-session').length, 20);

  reveal.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => page.querySelectorAll('.finding-session').length === 30, 'all requested sessions');
});

test('dashboard finding disclosure keeps a valid control relationship and readable note', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  seedFinding(store, [receiptSession()]);
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port: 43502,
    mutationToken: 'diagnostician-accessibility-token-placeholder',
  });
  const dom = bootPage(DASHBOARD_APP_HTML, app, { host: '127.0.0.1:43502', now: PAGE_NOW });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  const row = await waitFor(() => page.querySelector('.finding-row'), 'the finding row');
  assert.equal(row.hasAttribute('aria-controls'), false, 'collapsed controls cannot point to a missing node');
  assert.equal(
    dom.window.getComputedStyle(page.querySelector('.findings-head .card-note')).color,
    'var(--text-secondary)',
  );
  assert.equal(
    dom.window.getComputedStyle(page.documentElement).getPropertyValue('--text-secondary').trim(),
    '#52514e',
  );

  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const receipt = await waitFor(() => page.querySelector('.finding-receipt'), 'the receipt');
  assert.equal(row.getAttribute('aria-controls'), receipt.id);
});
