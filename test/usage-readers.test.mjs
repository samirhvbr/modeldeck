import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { activityBreakdownReport, attributionReport, costReport } from '../src/usage-analytics.mjs';

const RANGE = { since: '2026-08-01T00:00:00.000Z', until: '2026-08-02T00:00:00.000Z' };

function requestRow({ id, at, model = 'claude-sonnet-4-6', input = 0, read = 0, write = 0, output = 0 }) {
  return {
    requestId: id, machine: 'placeholder-machine', observedAt: at,
    source: 'placeholder@example.com', provider: 'claude', model, alias: null,
    reasoningEffort: 'high', endpoint: '/v1/placeholder', userAgentClass: 'claude-code',
    failed: false, statusCode: 200, latencyMs: 1, ttftMs: 1,
    inputUncached: input, inputCacheRead: read, inputCacheWrite: write,
    outputTotal: output, outputReasoning: 0, total: input + read + write + output,
  };
}

function transcriptRequest({ key, sessionId, profileSlug = 'profile-placeholder', at, input, read = 0, write = 0, output = 0, agentId = null }) {
  return {
    dedupeKey: key, requestId: null, sessionId, profileSlug, messageId: key, recordUuid: null,
    model: 'claude-placeholder', effort: 'high', observedAt: at, inputTokens: input,
    cacheCreationInputTokens: write, cacheReadInputTokens: read, outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: agentId != null, agentId,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-readers-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  store.saveSettings({ usageAnalyticsEnabled: true });
  const account = store.saveAccount({
    provider: 'claude', label: 'Placeholder account', identity: 'placeholder@example.com',
    profileRef: '/placeholder/profiles/profile-placeholder',
  });
  store.recordUsage(account.id, { scope: 'weekly', usedPercent: 0, observedAt: '2026-07-31T23:55:00.000Z', source: 'fixture' });
  store.recordUsage(account.id, { scope: 'weekly', usedPercent: 10, observedAt: '2026-08-01T01:15:00.000Z', source: 'fixture' });
  store.recordUsage(account.id, { scope: 'weekly', usedPercent: 33.33, observedAt: '2026-08-01T03:15:00.000Z', source: 'fixture' });
  store.db.prepare(`
    INSERT INTO usage_estimate_fits VALUES
      ('claude', 'claude', 'weekly', 2, 1, 1, 1, 0.29, 'well-conditioned', 1, 8,
       'nnls-active-set-v1', NULL, '2026-08-01T19:00:00.000Z')
  `).run();
  store.ingestTranscriptBatch({
    sessions: [
      { sessionId: 'build-session', profileSlug: 'profile-placeholder', machine: 'placeholder-machine', cwd: '/placeholder/projects/alpha', gitBranch: 'lane/alpha', firstAt: '2026-08-01T01:00:00.000Z', lastAt: '2026-08-01T02:00:00.000Z', title: 'Implement placeholder endpoint', titleSource: 'custom-title' },
      { sessionId: 'review-session', profileSlug: 'profile-placeholder', machine: 'placeholder-machine', cwd: '/placeholder/projects/beta', gitBranch: 'main', firstAt: '2026-08-01T03:00:00.000Z', lastAt: '2026-08-01T04:00:00.000Z', title: 'Review placeholder change', titleSource: 'custom-title' },
    ],
    requests: [
      transcriptRequest({ key: 'build-1', sessionId: 'build-session', at: '2026-08-01T01:10:00.000Z', input: 3, read: 1, output: 1 }),
      transcriptRequest({ key: 'build-2', sessionId: 'build-session', at: '2026-08-01T01:20:00.000Z', input: 2, read: 1, output: 1, agentId: 'agent-placeholder' }),
      transcriptRequest({ key: 'review-1', sessionId: 'review-session', at: '2026-08-01T03:10:00.000Z', input: 1, read: 1, output: 1 }),
    ],
    subagents: [{ agentId: 'agent-placeholder', sessionId: 'build-session', profileSlug: 'profile-placeholder', agentType: 'build', resolvedModel: 'claude-placeholder', totalTokens: 4, toolStatsJson: null, durationMs: 1000, observedAt: '2026-08-01T01:20:00.000Z' }],
    skills: [{ eventKey: 'review-skill', sessionId: 'review-session', profileSlug: 'profile-placeholder', skill: 'code-review', commandName: null, observedAt: '2026-08-01T03:05:00.000Z' }],
  });
  store.ingestRequestUsage([
    requestRow({ id: 'measured-one', at: '2026-08-01T01:10:00.000Z', input: 1000, read: 2000, output: 500 }),
    requestRow({ id: 'measured-two', at: '2026-08-01T03:10:00.000Z', input: 300, read: 100, write: 50, output: 100 }),
  ]);
  const service = { projectsRoot: root, startAutoRefresh() {}, stopAutoRefresh() {} };
  const app = createApp({ store, service, host: '127.0.0.1', port: 43484, mutationToken: 'placeholder-token', laneManifestPath: path.join(root, 'missing.jsonl') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, app };
}

async function get(app, route) {
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: route, headers: { host: '127.0.0.1:43484' } });
  let status;
  let payload;
  const res = { writeHead(value) { status = value; }, end(value) { payload = String(value); } };
  await app.server.listeners('request')[0](req, res);
  return { status, payload: JSON.parse(payload) };
}

test('new usage routes stay invisible while the analytics flag is off', async (t) => {
  const { store, app } = fixture(t);
  store.saveSettings({ usageAnalyticsEnabled: false });
  for (const route of [
    '/api/usage/attribution',
    '/api/usage/activity-breakdown',
    '/api/usage/cost',
    '/api/usage/session-anatomy',
  ]) {
    const response = await get(app, route);
    assert.deepEqual(response, { status: 404, payload: { error: 'not found' } });
  }
});

test('new usage routes surface reader validation as JSON 400 responses', async (t) => {
  const { app } = fixture(t);
  const query = new URLSearchParams(RANGE).toString();
  const cases = [
    [`/api/usage/attribution?${query}&scope=monthly`, /scope must be weekly or 5-hour/],
    [`/api/usage/activity-breakdown?${query}&provider=other`, /provider must be claude or codex/],
    [`/api/usage/cost?since=nope&until=${encodeURIComponent(RANGE.until)}`, /since must be a canonical ISO timestamp/],
    ['/api/usage/session-anatomy?profile=profile-placeholder&provider=claude', /sessionId is required/],
  ];
  for (const [route, message] of cases) {
    const response = await get(app, route);
    assert.equal(response.status, 400, route);
    assert.match(response.payload.error, message, route);
  }
});

test('TRIPWIRE attribution-one-derivation: below-floor fit falls back and largest remainder preserves the measured sum', (t) => {
  const { store } = fixture(t);
  const report = attributionReport(store, RANGE);
  assert.equal(report.measured.total, 0.33);
  assert.equal(report.derivation.method, 'token-share-fallback');
  assert.equal(report.derivation.fitQuality, 0.29);
  assert.equal(report.projects.reduce((sum, project) => sum + project.subscriptions, 0), report.measured.total);
  assert.equal(report.projects.reduce((sum, project) => sum + project.units, 0), report.measured.totalUnits);
  assert.equal(report.projects.every((project) => (
    project.untraced
      ? project.derivation.includes('no recorded session corpus')
      : project.derivation.includes('measured traceable total')
  )), true);
});

test('measured burn with no session corpus remains an explicit untraced exact-sum row', (t) => {
  const { store } = fixture(t);
  const accountId = store.listAccounts().find((account) => account.provider === 'claude').id;
  store.recordUsage(accountId, { scope: 'weekly', usedPercent: 50, observedAt: '2026-08-01T05:15:00.000Z', source: 'fixture' });
  const report = attributionReport(store, RANGE);
  const untraced = report.projects.find((project) => project.untraced);
  assert.equal(report.measured.total, 0.5);
  assert.equal(untraced.subscriptions, 0.17);
  assert.equal(report.projects.reduce((sum, project) => sum + project.subscriptions, 0), report.measured.total);
});

test('weekly attribution chooses the binding nested weekly movement and never sums overlapping limits', (t) => {
  const { store } = fixture(t);
  const accountId = store.listAccounts().find((account) => account.provider === 'claude').id;
  store.recordUsage(accountId, { scope: 'Placeholder model weekly', usedPercent: 0, observedAt: '2026-07-31T23:50:00.000Z', source: 'fixture' });
  store.recordUsage(accountId, { scope: 'Placeholder model weekly', usedPercent: 50, observedAt: '2026-08-01T20:00:00.000Z', source: 'fixture' });
  const report = attributionReport(store, RANGE);
  assert.equal(report.measured.total, 0.5, '50% binding movement wins; 33.33% account-wide movement is not added');
  assert.equal(report.measured.accounts[0].scope, 'Placeholder model weekly');
});

test('attribution range compares historical offset timestamps as instants', (t) => {
  const { store } = fixture(t);
  const accountId = store.listAccounts().find((account) => account.provider === 'claude').id;
  store.db.prepare('DELETE FROM usage_snapshots WHERE account_id = ?').run(accountId);
  store.recordUsage(accountId, { scope: 'weekly', usedPercent: 10, observedAt: '2026-07-31T16:55:00-07:00', source: 'fixture' });
  store.recordUsage(accountId, { scope: 'weekly', usedPercent: 30, observedAt: '2026-08-01T00:15:00-07:00', source: 'fixture' });
  const report = attributionReport(store, RANGE);
  assert.equal(report.measured.total, 0.2);
});

test('measured burn keeps the one pre-range snapshot as its anchor', (t) => {
  const { store } = fixture(t);
  const accountId = store.listAccounts().find((account) => account.provider === 'claude').id;
  store.db.prepare('DELETE FROM usage_snapshots WHERE account_id = ?').run(accountId);
  store.recordUsage(accountId, { scope: 'weekly', usedPercent: 40, observedAt: '2026-07-01T00:00:00.000Z', source: 'fixture' });
  store.recordUsage(accountId, { scope: 'weekly', usedPercent: 60, observedAt: '2026-08-01T01:00:00.000Z', source: 'fixture' });
  const report = attributionReport(store, RANGE);
  assert.equal(report.measured.total, 0.2);
});

test('TRIPWIRE activity-total-preservation: heuristic buckets label every session and preserve token totals', (t) => {
  const { store } = fixture(t);
  const batchRead = store.subagentTypesForSessions.bind(store);
  let batchReads = 0;
  store.subagentTypesForSessions = (pairs) => { batchReads += 1; return batchRead(pairs); };
  store.usageSessionDetail = () => { throw new Error('activity breakdown must batch subagent types'); };
  const report = activityBreakdownReport(store, RANGE);
  assert.equal(batchReads, 1);
  assert.equal(report.heuristic, true);
  assert.match(report.note, /Heuristic classification/);
  assert.equal(report.sessions.length, 2);
  assert.equal(report.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 12);
  assert.equal(report.sessions.find((session) => session.sessionId === 'review-session').activity, 'review');
  assert.equal(report.sessions.find((session) => session.sessionId === 'build-session').activity, 'lane');
});

test('activity breakdown narrows to the requested project for the drill consumer', (t) => {
  const { store } = fixture(t);
  const report = activityBreakdownReport(store, { ...RANGE, project: '/placeholder/projects/alpha' });
  assert.equal(report.project, '/placeholder/projects/alpha');
  assert.deepEqual(report.sessions.map((session) => session.sessionId), ['build-session']);
  assert.equal(report.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 9);
});

test('TRIPWIRE cost-provider-truth-only: API dollars use measured request tokens and project shares sum exactly', (t) => {
  const { store } = fixture(t);
  const report = costReport(store, RANGE);
  assert.equal(report.label, '* if billed at full API rate');
  assert.equal(report.source, 'request_usage provider-truth token classes');
  assert.equal(report.pricing.snapshotDate, '2026-08-11');
  assert.equal(report.projects.reduce((sum, project) => sum + project.usd, 0), report.totalUsd);
  assert.equal(report.models.reduce((sum, model) => sum + model.usd, 0), report.totalUsd);
  assert.equal(report.projects.reduce((sum, project) => sum + project.units, 0), report.totalUnits);
  assert.equal(report.models.reduce((sum, model) => sum + model.units, 0), report.totalUnits);
  assert.equal(report.coverage.pricedTokens, 4050);
  assert.equal(report.coverage.unpricedTokens, 0);
  assert.equal(report.derivation.rounding, 'largest-remainder-4-decimal');
  assert.equal(report.printed, report.totalUsd.toFixed(4));
  assert.equal(report.projects.every((project) => project.printed.length >= 4 && project.printed.at(-5) === '.'), true);
});

test('cost report default precision preserves a small real spend', (t) => {
  const { store } = fixture(t);
  store.db.prepare('DELETE FROM request_usage').run();
  store.ingestRequestUsage([
    requestRow({ id: 'small-spend', at: '2026-08-01T01:10:00.000Z', input: 20 }),
  ]);
  const report = costReport(store, RANGE);
  assert.equal(report.printed, '0.0001');
  assert.notEqual(report.printed, '0.0000');
  assert.equal(report.projects.reduce((sum, project) => sum + project.units, 0), report.totalUnits);
});

test('price override replaces one pinned model row without a runtime fetch', (t) => {
  const { store } = fixture(t);
  const overridePath = path.join(os.tmpdir(), `modeldeck-prices-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(overridePath, JSON.stringify({
    models: { 'claude-sonnet-4-6': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  }));
  t.after(() => fs.rmSync(overridePath, { force: true }));
  const report = costReport(store, { ...RANGE, priceOverridePath: overridePath });
  assert.equal(report.pricing.overrideFile, true);
  assert.equal(report.totalUsd, 0);
});

test('TRIPWIRE anatomy-four-cuts: Claude timeline and composition each equal totals', (t) => {
  const { store } = fixture(t);
  const anatomy = store.sessionAnatomy({ sessionId: 'build-session', profile: 'profile-placeholder', provider: 'claude' });
  assert.equal(anatomy.timeline.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), anatomy.totals.tokens);
  assert.equal(anatomy.composition.reduce((sum, part) => sum + part.tokens, 0), anatomy.totals.tokens);
  assert.equal(anatomy.totals.mainTokens + anatomy.totals.laneTokens, anatomy.totals.tokens);
  assert.equal(anatomy.events.launches.length, 1);
});

test('session anatomy bounds subagent rollups and reports the omitted total', (t) => {
  const { store } = fixture(t);
  const insert = store.db.prepare(`
    INSERT INTO transcript_subagents(
      agent_id, session_id, profile_slug, agent_type, resolved_model, total_tokens,
      tool_stats_json, duration_ms, observed_at
    ) VALUES (?, 'build-session', 'profile-placeholder', 'build', 'claude-placeholder', 0, NULL, 1, ?)
  `);
  for (let index = 0; index < 500; index += 1) {
    insert.run(`bounded-agent-${index}`, `2026-08-01T01:${String(index % 60).padStart(2, '0')}:00.000Z`);
  }
  const anatomy = store.sessionAnatomy({ sessionId: 'build-session', profile: 'profile-placeholder', provider: 'claude' });
  assert.equal(anatomy.compositionTruncated, true);
  assert.equal(anatomy.compositionTotal, 502);
  assert.equal(anatomy.composition.length, 501);
});

test('session anatomy clamps a multi-year timeline to maxBuckets', (t) => {
  const { store } = fixture(t);
  store.ingestTranscriptBatch({
    sessions: [{
      sessionId: 'multi-year', profileSlug: 'profile-placeholder', machine: 'placeholder-machine',
      cwd: '/placeholder/projects/alpha', gitBranch: 'lane/multi-year',
      firstAt: '2020-01-01T12:00:00.000Z', lastAt: '2026-01-01T12:01:00.000Z',
      title: 'Long placeholder session', titleSource: 'custom-title',
    }],
    requests: [
      transcriptRequest({ key: 'multi-year-first', sessionId: 'multi-year', at: '2020-01-01T12:00:00.000Z', input: 1 }),
      transcriptRequest({ key: 'multi-year-last', sessionId: 'multi-year', at: '2026-01-01T12:01:00.000Z', input: 1 }),
    ],
    subagents: [], skills: [],
  });
  const anatomy = store.sessionAnatomy({ sessionId: 'multi-year', profile: 'profile-placeholder', provider: 'claude' });
  assert.ok(anatomy.timeline.buckets.length <= 72, `expected at most 72 buckets, got ${anatomy.timeline.buckets.length}`);
});

test('session anatomy ignores skill events outside the request span when forming timeline buckets', (t) => {
  const { store } = fixture(t);
  const before = store.sessionAnatomy({ sessionId: 'build-session', profile: 'profile-placeholder', provider: 'claude' });
  store.db.prepare(`
    INSERT INTO transcript_skill_events(event_key, session_id, profile_slug, skill, command_name, observed_at)
    VALUES ('early-skill', 'build-session', 'profile-placeholder', 'research', NULL, '2026-07-01T00:00:00.000Z')
  `).run();
  const after = store.sessionAnatomy({ sessionId: 'build-session', profile: 'profile-placeholder', provider: 'claude' });
  assert.deepEqual(after.timeline.buckets.map((bucket) => bucket.index), before.timeline.buckets.map((bucket) => bucket.index));
  assert.equal(after.timeline.buckets.reduce((sum, bucket) => sum + bucket.skills, 0), 0);
});

test('session anatomy canonicalizes firstAt from the stored request timestamp', (t) => {
  const { store } = fixture(t);
  store.db.prepare(`
    UPDATE transcript_requests SET observed_at = '2026-07-31T18:10:00-07:00'
    WHERE dedupe_key = 'build-1' AND profile_slug = 'profile-placeholder'
  `).run();
  const anatomy = store.sessionAnatomy({ sessionId: 'build-session', profile: 'profile-placeholder', provider: 'claude' });
  assert.equal(anatomy.totals.firstAt, '2026-08-01T01:10:00.000Z');
});

test('TRIPWIRE anatomy-codex-honesty: Codex degrades to turns, timeline, curve, and cache composition', (t) => {
  const { store } = fixture(t);
  store.ingestCodexSession({
    sessionId: 'codex-placeholder', profileSlug: 'codex-placeholder', machine: 'placeholder-machine',
    cwd: '/placeholder/projects/alpha', gitBranch: 'lane/codex',
    firstTimestamp: '2026-08-01T05:00:00.000Z', lastTimestamp: '2026-08-01T06:00:00.000Z', archived: false,
  }, [{ turnIndex: 0, turnId: 'turn-placeholder', model: 'gpt-5.6-sol', reasoningEffort: 'high', inputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 99, timestamp: '2026-08-01T05:30:00.000Z' }]);
  const anatomy = store.sessionAnatomy({ sessionId: 'codex-placeholder', profile: 'codex-placeholder', provider: 'codex' });
  assert.equal(anatomy.supports.unit, 'turn');
  assert.equal(anatomy.supports.composition, false);
  assert.equal(anatomy.supports.skillEvents, false);
  assert.equal(anatomy.supports.cacheRate, false);
  assert.match(anatomy.supports.note, /no subagent or skill records/);
  assert.equal(anatomy.timeline.buckets[0].tokens, 35);
  assert.equal(anatomy.totals.reportedTokens, 99);
  assert.equal(anatomy.curve.length, 1);
});

test('all four supported endpoints return their reader payloads', async (t) => {
  const { app } = fixture(t);
  const query = new URLSearchParams(RANGE).toString();
  for (const [route, key] of [
    [`/api/usage/attribution?${query}`, 'measured'],
    [`/api/usage/activity-breakdown?${query}`, 'heuristic'],
    [`/api/usage/cost?${query}`, 'label'],
    ['/api/usage/session-anatomy?sessionId=build-session&profile=profile-placeholder&provider=claude', 'timeline'],
  ]) {
    const response = await get(app, route);
    assert.equal(response.status, 200, route);
    assert.equal(Object.hasOwn(response.payload, key), true, route);
  }
});
