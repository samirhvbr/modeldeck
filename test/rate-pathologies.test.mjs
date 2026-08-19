import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import {
  DIAGNOSTIC_DETECTORS,
  readDiagnosticCorpus,
  scopeFindings,
} from '../src/diagnostician.mjs';
import {
  RATE_PATHOLOGY_DETECTORS,
  RETRY_STORM,
  SWARM_BURST,
  retryStormDetector,
  swarmBurstDetector,
} from '../src/rate-pathologies.mjs';

const fixture = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/rate-pathologies-corpus.json', import.meta.url)),
  'utf8',
));

function detect(session) {
  return RATE_PATHOLOGY_DETECTORS.flatMap((detector) => (
    detector.detect({ sessions: [session] }).map((finding) => ({
      kind: detector.kind,
      finding,
    }))
  ));
}

test('rate detector output stays byte-identical for the established fixtures', () => {
  const expectedHashes = {
    retryStorm: '6b58fabe0b626e71f27555bd2431de467fb2519de14f7493e3c7f72c68668327',
    swarmBurst: '9f639b04bee90965af6a9d76613b9d647fc7328a9fde556c9b12785e4faa13e3',
    healthyBusy: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  };

  for (const [name, expectedHash] of Object.entries(expectedHashes)) {
    const outputBytes = JSON.stringify(detect(fixture[name]));
    assert.equal(
      crypto.createHash('sha256').update(outputBytes).digest('hex'),
      expectedHash,
      `${name} detector output changed`,
    );
  }
});

test('storm, burst, and healthy-busy fixtures produce findings only for the pathologies', () => {
  const storm = detect(fixture.retryStorm);
  const burst = detect(fixture.swarmBurst);
  const healthy = detect(fixture.healthyBusy);

  assert.deepEqual(storm.map(({ kind }) => kind), [RETRY_STORM]);
  assert.deepEqual(burst.map(({ kind }) => kind), [SWARM_BURST]);
  assert.deepEqual(healthy, [], 'a consistently busy session establishes a busy baseline');

  assert.equal(storm[0].finding.evidence.tokensBurned, 30_000);
  assert.deepEqual({
    firstAt: storm[0].finding.evidence.sessions[0].firstAt,
    lastAt: storm[0].finding.evidence.sessions[0].lastAt,
    requestCount: storm[0].finding.evidence.sessions[0].requestCount,
    tokensBurned: storm[0].finding.evidence.sessions[0].tokensBurned,
    rateLimitFailures: storm[0].finding.evidence.sessions[0].rateLimitFailures,
    signalGrade: storm[0].finding.evidence.sessions[0].signalGrade,
  }, {
    firstAt: '2026-08-18T08:05:02.000Z',
    lastAt: '2026-08-18T08:05:06.000Z',
    requestCount: 3,
    tokensBurned: 30_000,
    rateLimitFailures: 3,
    signalGrade: 'wire',
  });

  assert.equal(burst[0].finding.evidence.tokensBurned, 1_620_000);
  assert.deepEqual({
    firstAt: burst[0].finding.evidence.sessions[0].firstAt,
    lastAt: burst[0].finding.evidence.sessions[0].lastAt,
    requestCount: burst[0].finding.evidence.sessions[0].requestCount,
    tokensBurned: burst[0].finding.evidence.sessions[0].tokensBurned,
    requestRateMultiple: burst[0].finding.evidence.sessions[0].requestRateMultiple,
  }, {
    firstAt: '2026-08-18T09:05:02.000Z',
    lastAt: '2026-08-18T09:05:12.000Z',
    requestCount: 6,
    tokensBurned: 1_620_000,
    requestRateMultiple: 30,
  });
});

test('failure-shaped corpus turns are the fallback, but an explicit wire success wins', () => {
  const corpusOnly = structuredClone(fixture.retryStorm);
  for (const point of corpusOnly.points) {
    delete point.failed;
    delete point.statusCode;
  }
  const [fallback] = retryStormDetector.detect({ sessions: [corpusOnly] });
  assert.equal(fallback.evidence.sessions[0].signalGrade, 'corpus');
  assert.equal(fallback.evidence.sessions[0].tokensBurned, 30_000);

  const wireSuccess = structuredClone(fixture.retryStorm);
  wireSuccess.points[7].failed = false;
  wireSuccess.points[7].statusCode = 200;
  assert.deepEqual(retryStormDetector.detect({ sessions: [wireSuccess] }), []);
});

test('TRIPWIRE: sibling agent streams fold into their parent session for swarm rate', () => {
  const source = fixture.swarmBurst;
  const identity = {
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'multi-agent-swarm-session-placeholder',
  };
  const sessions = [{
    ...identity,
    corpusFingerprint: 'multi-agent-main-corpus-placeholder',
    points: source.points.slice(0, 6),
  }, ...source.points.slice(6).map((point, index) => ({
    ...identity,
    agentId: `agent-placeholder-${index}`,
    corpusFingerprint: `multi-agent-${index}-corpus-placeholder`,
    points: [point],
  }))];

  const [finding] = swarmBurstDetector.detect({ sessions });
  assert.equal(finding.evidence.affectedSessions, 1);
  assert.equal(finding.evidence.sessions[0].tokensBurned, 1_620_000);
  assert.equal(Object.hasOwn(finding.evidence.sessions[0], 'agentId'), false);
});

test('TRIPWIRE: simultaneous distinct requests remain in storm and swarm windows', () => {
  const storm = structuredClone(fixture.retryStorm);
  for (const point of storm.points.slice(6)) point.at = '2026-08-18T08:05:02.000Z';
  const burst = structuredClone(fixture.swarmBurst);
  for (const point of burst.points.slice(6)) point.at = '2026-08-18T09:05:02.000Z';

  assert.equal(retryStormDetector.detect({ sessions: [storm] }).length, 1);
  assert.equal(swarmBurstDetector.detect({ sessions: [burst] }).length, 1);
});

test('TRIPWIRE: concurrent session start does not hide a later retry storm', () => {
  const [finding] = retryStormDetector.detect({
    sessions: [fixture.concurrentStartRetryStorm],
  });

  assert.equal(finding.evidence.sessions[0].firstAt, '2026-08-18T11:05:02.000Z');
  assert.equal(finding.evidence.sessions[0].requestCount, 3);
  assert.equal(finding.evidence.sessions[0].rateLimitFailures, 3);

  const swarm = structuredClone(fixture.concurrentStartRetryStorm);
  swarm.sessionId = 'concurrent-start-swarm-burst-session-placeholder';
  swarm.points = swarm.points.slice(0, 8).concat(Array.from({ length: 6 }, (_, index) => ({
    key: `concurrent-burst-${index}`,
    at: new Date(Date.parse('2026-08-18T11:05:02.000Z') + index * 2_000).toISOString(),
    uncached: 100_000,
    cached: 150_000,
    cacheWrite: 0,
    output: 20_000,
    totalInput: 250_000,
    tokens: 270_000,
  })));
  const [burstFinding] = swarmBurstDetector.detect({ sessions: [swarm] });
  assert.equal(burstFinding.evidence.sessions[0].requestCount, 6);
  assert.equal(burstFinding.evidence.sessions[0].tokensBurned, 1_620_000);
});

test('TRIPWIRE: provider-scoped rate receipts recompute their measured token cost', () => {
  const findings = [{
    id: 'finding-rate-scope-placeholder',
    evidence: {
      affectedSessions: 2,
      tokensBurned: 100_000,
      sessions: [{
        provider: 'claude',
        profileSlug: 'claude-profile-placeholder',
        sessionId: 'claude-rate-session-placeholder',
        firstAt: '2026-08-18T08:00:00.000Z',
        lastAt: '2026-08-18T08:00:04.000Z',
        tokensBurned: 10_000,
      }, {
        provider: 'codex',
        profileSlug: 'codex-profile-placeholder',
        sessionId: 'codex-rate-session-placeholder',
        firstAt: '2026-08-18T09:00:00.000Z',
        lastAt: '2026-08-18T09:00:04.000Z',
        tokensBurned: 90_000,
      }],
    },
  }];

  const [scoped] = scopeFindings(findings, { provider: 'claude' });
  assert.equal(scoped.evidence.tokensBurned, 10_000);
  assert.equal(Object.hasOwn(scoped.evidence, 'estimatedExcessUncachedTokens'), false);
});

test('TRIPWIRE: proxy-only 429 failures join the one session whose baseline they follow', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessionId = 'proxy-only-storm-session-placeholder';
  const profileSlug = 'claude-profile-placeholder';
  const baselineAt = Date.parse('2026-08-18T12:00:00.000Z');
  const baseline = Array.from({ length: 6 }, (_, index) => ({
    at: new Date(baselineAt + index * 60_000).toISOString(),
    index,
  }));
  store.ingestTranscriptBatch({
    sessions: [{
      sessionId,
      profileSlug,
      machine: 'machine-placeholder',
      cwd: '/workspace/placeholder',
      firstAt: baseline[0].at,
      lastAt: baseline.at(-1).at,
    }],
    requests: baseline.map(({ at, index }) => ({
      dedupeKey: `${sessionId}:baseline:${index}`,
      requestId: null,
      sessionId,
      profileSlug,
      messageId: `baseline-message-placeholder-${index}`,
      recordUuid: null,
      model: 'claude-placeholder',
      effort: null,
      observedAt: at,
      inputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 9_000,
      outputTokens: 2_000,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      isSidechain: false,
      agentId: null,
    })),
  });
  store.ingestRequestUsage([2, 4, 6].map((seconds, index) => ({
    requestId: `proxy-only-request-placeholder-${index}`,
    machine: 'machine-placeholder',
    observedAt: new Date(baselineAt + 300_000 + seconds * 1_000).toISOString(),
    source: 'identity-placeholder@example.invalid',
    provider: 'claude',
    model: 'claude-placeholder',
    alias: null,
    reasoningEffort: null,
    endpoint: '/v1/messages',
    userAgentClass: 'claude-code',
    failed: true,
    statusCode: 429,
    latencyMs: 10,
    ttftMs: null,
    inputUncached: 1_000,
    inputCacheRead: 9_000,
    inputCacheWrite: 0,
    outputTotal: 0,
    outputReasoning: 0,
    total: 10_000,
  })));

  const corpus = await readDiagnosticCorpus(store, { logger() {} });
  assert.equal(corpus.wireFailures.length, 3);
  const [finding] = retryStormDetector.detect(corpus);
  assert.equal(finding.evidence.sessions[0].sessionId, sessionId);
  assert.equal(finding.evidence.sessions[0].tokensBurned, 30_000);
  assert.equal(finding.evidence.sessions[0].signalGrade, 'wire');

  const ambiguousSession = structuredClone(corpus.sessions[0]);
  ambiguousSession.sessionId = 'second-proxy-storm-candidate-placeholder';
  assert.deepEqual(retryStormDetector.detect({
    ...corpus,
    sessions: [...corpus.sessions, ambiguousSession],
  }), [], 'an unattributed wire failure cannot choose between two matching sessions');
});

test('the tracer decorates a joined corpus turn with preferred wire outcome and token cost', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const requestId = 'wire-request-placeholder';
  const observedAt = '2026-08-18T11:00:00.000Z';
  store.ingestTranscriptBatch({
    sessions: [{
      sessionId: 'wire-session-placeholder',
      profileSlug: 'claude-profile-placeholder',
      machine: 'machine-placeholder',
      cwd: '/workspace/placeholder',
      firstAt: observedAt,
      lastAt: observedAt,
    }],
    requests: [{
      dedupeKey: `request:${requestId}`,
      requestId,
      sessionId: 'wire-session-placeholder',
      profileSlug: 'claude-profile-placeholder',
      messageId: 'wire-message-placeholder',
      recordUuid: null,
      model: 'claude-placeholder',
      effort: null,
      observedAt,
      inputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 9_000,
      outputTokens: 2_000,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      isSidechain: false,
      agentId: null,
    }],
  });
  store.ingestRequestUsage([{
    requestId,
    machine: 'machine-placeholder',
    observedAt,
    source: 'identity-placeholder@example.invalid',
    provider: 'claude',
    model: 'claude-placeholder',
    alias: null,
    reasoningEffort: null,
    endpoint: '/v1/messages',
    userAgentClass: 'claude-code',
    failed: true,
    statusCode: 429,
    latencyMs: 10,
    ttftMs: null,
    inputUncached: 1_000,
    inputCacheRead: 9_000,
    inputCacheWrite: 0,
    outputTotal: 0,
    outputReasoning: 0,
    total: 10_000,
  }]);

  const corpus = await readDiagnosticCorpus(store, { logger() {} });
  assert.deepEqual({
    failed: corpus.sessions[0].points[0].failed,
    statusCode: corpus.sessions[0].points[0].statusCode,
    output: corpus.sessions[0].points[0].output,
    tokens: corpus.sessions[0].points[0].tokens,
  }, {
    failed: true,
    statusCode: 429,
    output: 2_000,
    tokens: 10_000,
  });
  const legacyPoint = {
    key: `request:${requestId}`,
    at: observedAt,
    uncached: 1_000,
    cached: 9_000,
    cacheWrite: 0,
    totalInput: 10_000,
  };
  const legacyFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    provider: 'claude',
    profileSlug: 'claude-profile-placeholder',
    sessionId: 'wire-session-placeholder',
    points: [legacyPoint],
  })).digest('hex');
  assert.equal(
    corpus.sessions[0].corpusFingerprint,
    legacyFingerprint,
    'adding rate fields cannot re-arm an unchanged pre-rate finding',
  );
});

test('rate detectors are registered through the shared diagnostician interface', () => {
  assert.deepEqual(
    DIAGNOSTIC_DETECTORS.filter(({ kind }) => [RETRY_STORM, SWARM_BURST].includes(kind)),
    RATE_PATHOLOGY_DETECTORS,
  );
});
