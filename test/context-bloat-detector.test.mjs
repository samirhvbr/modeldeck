import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootPage, waitFor } from '../dashboard/test-support/index.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import { Store } from '../src/db.mjs';
import {
  DIAGNOSTIC_DETECTORS,
  runDetectors,
} from '../src/diagnostician.mjs';
import {
  CONTEXT_BLOAT,
  CONTEXT_BLOAT_THRESHOLDS,
  contextBloatDetector,
} from '../src/detectors/context-bloat.mjs';
import { createApp } from '../src/server.mjs';

const fixture = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/context-bloat-corpus.json', import.meta.url)),
  'utf8',
));

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
        dedupeKey: `${session.sessionId}:main:${index}`,
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
        isSidechain: false,
        agentId: null,
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
    totalTokens: point.uncached + point.cached + (point.cacheWrite || 0) + 100,
    timestamp: point.at,
  })));
}

function findingFor(findings, provider) {
  return findings.find((finding) => finding.evidence.provider === provider);
}

test('bloated sessions alone produce provider-scoped receipts with measured week volume math', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  fixture.sessions.forEach((session) => seedSession(store, session));
  const logs = [];

  const first = await runDetectors({
    store,
    detectors: [contextBloatDetector],
    logger: (message) => logs.push(message),
    detectedAt: '2026-08-17T23:00:00.000Z',
  });

  assert.deepEqual(first, {
    detectors: 1,
    findings: 2,
    inserted: 2,
    updated: 0,
    resolved: 0,
    unchanged: 0,
  });
  const findings = store.listFindings();
  assert.deepEqual(
    findings
      .map((finding) => [finding.evidence.provider, finding.id])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['claude', 'finding-3f560392be24f26d24c35caf'],
      ['codex', 'finding-95d8c2ff489f49cf1c4e34c2'],
    ],
    'shared findingId preserves the persisted fixture identities',
  );
  assert.deepEqual(
    findings.flatMap((finding) => finding.evidence.sessions.map((session) => session.sessionId)).sort(),
    ['claude-bloated-session-placeholder', 'codex-bloated-session-placeholder'],
    'normal sessions contribute to the denominator but never become affected sessions',
  );

  const claude = findingFor(findings, 'claude');
  assert.deepEqual({
    affectedSessions: claude.evidence.affectedSessions,
    turnCount: claude.evidence.turnCount,
    avgInputTokens: claude.evidence.avgInputTokens,
    inputTokens: claude.evidence.inputTokens,
    providerWeekInputTokens: claude.evidence.providerWeekInputTokens,
    inputShareOfWeek: claude.evidence.inputShareOfWeek,
  }, {
    affectedSessions: 1,
    turnCount: 4,
    avgInputTokens: 330000,
    inputTokens: 1320000,
    providerWeekInputTokens: 1500000,
    inputShareOfWeek: 0.88,
  });
  assert.deepEqual({
    medianInputTokens: claude.evidence.sessions[0].medianInputTokens,
    peakInputTokens: claude.evidence.sessions[0].peakInputTokens,
    uncachedInputTokens: claude.evidence.sessions[0].uncachedInputTokens,
    cacheReadTokens: claude.evidence.sessions[0].cacheReadTokens,
    cacheWriteTokens: claude.evidence.sessions[0].cacheWriteTokens,
  }, {
    medianInputTokens: 330000,
    peakInputTokens: 360000,
    uncachedInputTokens: 130000,
    cacheReadTokens: 1190000,
    cacheWriteTokens: 10000,
  });

  const codex = findingFor(findings, 'codex');
  assert.deepEqual({
    avgInputTokens: codex.evidence.avgInputTokens,
    inputTokens: codex.evidence.inputTokens,
    providerWeekInputTokens: codex.evidence.providerWeekInputTokens,
    inputShareOfWeek: codex.evidence.inputShareOfWeek,
  }, {
    avgInputTokens: 300000,
    inputTokens: 1200000,
    providerWeekInputTokens: 1560000,
    inputShareOfWeek: 0.769231,
  });
  assert.deepEqual({
    medianInputTokens: codex.evidence.sessions[0].medianInputTokens,
    peakInputTokens: codex.evidence.sessions[0].peakInputTokens,
    uncachedInputTokens: codex.evidence.sessions[0].uncachedInputTokens,
    cacheReadTokens: codex.evidence.sessions[0].cacheReadTokens,
    cacheWriteTokens: codex.evidence.sessions[0].cacheWriteTokens,
  }, {
    medianInputTokens: 300000,
    peakInputTokens: 360000,
    uncachedInputTokens: 150000,
    cacheReadTokens: 1050000,
    cacheWriteTokens: 40000,
  });
  assert.equal(codex.evidence.basis, 'inferred from the measured turn distribution');
  assert.doesNotMatch(JSON.stringify(codex.evidence), /configured (context )?window/i);
  const detectorLogs = logs.filter((message) => message.includes(`detector=${CONTEXT_BLOAT}`));
  assert.equal(detectorLogs.length, 1);
  for (const [name, value] of Object.entries(CONTEXT_BLOAT_THRESHOLDS)) {
    assert.match(detectorLogs[0], new RegExp(`"${name}":${JSON.stringify(value)}`), `${name} is not silent`);
  }

  const second = await runDetectors({
    store,
    detectors: [contextBloatDetector],
    logger() {},
    detectedAt: '2026-08-17T23:15:00.000Z',
  });
  assert.deepEqual(second, {
    detectors: 1,
    findings: 2,
    inserted: 0,
    updated: 0,
    resolved: 0,
    unchanged: 2,
  });
  assert.deepEqual(store.listFindings().map((finding) => finding.revision), [1, 1]);
});

test('the long-context billing callout is Codex-only and uses a strict greater-than 272K boundary', () => {
  const findings = contextBloatDetector.detect({ sessions: fixture.sessions });
  const claude = findingFor(findings, 'claude');
  const codex = findingFor(findings, 'codex');

  assert.equal(claude.evidence.longContextMultiplier, undefined, 'large Claude turns are not Codex billing evidence');
  assert.deepEqual(codex.evidence.longContextMultiplier, {
    thresholdInputTokens: 272000,
    turnCount: 3,
    inputTokens: 960000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
    appliesToWholeRequest: true,
  });

  const [atBoundary] = contextBloatDetector.detect({
    sessions: [fixture.codexAtMultiplierBoundary],
  });
  assert.ok(atBoundary, '272K turns still meet the independent context-bloat threshold');
  assert.equal(atBoundary.evidence.longContextMultiplier, undefined, '272K exactly is not above 272K');
});

test('the detector derives Session Explorer average input from contextTrend turns', () => {
  const source = fixture.sessions.find((session) => session.sessionId === 'claude-bloated-session-placeholder');
  const [finding] = contextBloatDetector.detect({
    sessions: [{
      provider: source.provider,
      profileSlug: source.profileSlug,
      sessionId: source.sessionId,
      avgInputTokens: 1,
      contextTrend: source.points.map((point) => ({
        observedAt: point.at,
        inputTokens: point.uncached + point.cached + (point.cacheWrite || 0),
        cacheReadTokens: point.cached,
        cacheWriteTokens: point.cacheWrite || 0,
      })),
    }],
  });

  assert.equal(finding.evidence.avgInputTokens, 330000, 'computed turn evidence wins over the session summary');
  assert.equal(finding.evidence.sessions[0].medianInputTokens, 330000);
});

test('missing totalInput follows the diagnostician point convention without double-counting cache writes', () => {
  const [finding] = contextBloatDetector.detect({
    sessions: [{
      provider: 'claude',
      profileSlug: 'claude-profile-placeholder',
      sessionId: 'claude-point-convention-placeholder',
      points: Array.from({ length: 4 }, (_, index) => ({
        at: `2026-08-17T18:${String(index * 5).padStart(2, '0')}:00.000Z`,
        uncached: 60000,
        cached: 100000,
        cacheWrite: 10000,
      })),
    }],
  });

  assert.equal(finding.evidence.avgInputTokens, 160000);
  assert.deepEqual({
    inputTokens: finding.evidence.sessions[0].inputTokens,
    uncachedInputTokens: finding.evidence.sessions[0].uncachedInputTokens,
    cacheReadTokens: finding.evidence.sessions[0].cacheReadTokens,
    cacheWriteTokens: finding.evidence.sessions[0].cacheWriteTokens,
  }, {
    inputTokens: 640000,
    uncachedInputTokens: 240000,
    cacheReadTokens: 400000,
    cacheWriteTokens: 40000,
  });
});

test('context bloat is registered on the existing diagnostician detector seam', () => {
  assert.equal(
    DIAGNOSTIC_DETECTORS.filter((detector) => detector.kind === CONTEXT_BLOAT).length,
    1,
  );
});

test('dashboard names measured context bloat, shows week share, and drills into the Codex multiplier receipt', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const codex = findingFor(contextBloatDetector.detect({ sessions: fixture.sessions }), 'codex');
  store.syncFindings(CONTEXT_BLOAT, [codex], { detectedAt: '2026-08-17T23:00:00.000Z' });
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port: 43503,
    mutationToken: 'context-bloat-dashboard-token-placeholder',
  });
  const route = encodeURIComponent(JSON.stringify({ level: 'overview', rangeKey: '7d', scope: 'codex' }));
  const dom = bootPage(DASHBOARD_APP_HTML, app, {
    host: '127.0.0.1:43503',
    hash: `#route=${route}`,
    // Pin the page clock beside the fixture's fixed dates, or the 7-day
    // window walks past them and the row stops rendering.
    now: '2026-08-18T12:00:00.000Z',
  });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  const row = await waitFor(() => page.querySelector('.finding-row'), 'the context-bloat row');
  assert.match(row.textContent, /Context bloat/);
  assert.match(row.textContent, /300K avg input/);
  assert.match(row.textContent, /76\.9% of measured week/);

  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const receipt = await waitFor(() => page.querySelector('.finding-receipt'), 'the context-bloat receipt');
  assert.match(receipt.textContent, /start a fresh session when accumulated context no longer helps the task/i);
  assert.match(receipt.textContent, /inferred from the measured turn distribution/i);
  assert.doesNotMatch(receipt.textContent, /configured (context )?window/i);
  assert.match(receipt.textContent, /4 turns · 300K avg input · 1\.2M input · 76\.9% of measured week/);
  assert.match(receipt.textContent, /3 turns above 272K input/);
  assert.match(receipt.textContent, /whole request billed at 2× input \/ 1\.5× output/);
  assert.doesNotMatch(receipt.textContent, /cadence/);
});
