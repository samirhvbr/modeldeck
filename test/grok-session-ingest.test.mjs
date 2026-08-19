import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import {
  DIAGNOSTIC_DETECTORS,
  readDiagnosticCorpus,
  runDetectors,
} from '../src/diagnostician.mjs';
import { ingestGrokSessions } from '../src/grok-session-ingest.mjs';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'grok-sessions',
);
const fixtureFile = path.join(
  fixtureRoot,
  'workspace-placeholder',
  'session-grok-placeholder',
  'updates.jsonl',
);

test('Grok updates ingest into the corpus with replay state and drift provenance', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const warnings = [];
  const before = fs.statSync(fixtureFile);

  const first = await ingestGrokSessions({
    store,
    sessionsRoot: fixtureRoot,
    machine: 'placeholder-machine',
    warn: (message) => warnings.push(message),
  });

  assert.equal(first.files, 1);
  assert.equal(first.filesSkipped, 0);
  assert.equal(first.sessions, 1);
  assert.equal(first.turns, 4);
  assert.equal(first.modelUsageRows, 5);
  assert.equal(first.warnings.malformedLines, 1);
  assert.ok(first.warnings.schemaDriftFields >= 5);
  assert.match(warnings.join('\n'), /updates\.jsonl line 3/);

  const session = store.db.prepare('SELECT * FROM grok_sessions').get();
  assert.deepEqual({
    sessionId: session.session_id,
    cwdKey: session.cwd_key,
    cwd: session.cwd,
    machine: session.machine,
    firstTimestamp: session.first_timestamp,
    lastTimestamp: session.last_timestamp,
  }, {
    sessionId: 'session-grok-placeholder',
    cwdKey: 'workspace-placeholder',
    cwd: '/workspace/placeholder',
    machine: 'placeholder-machine',
    firstTimestamp: '2026-08-18T10:00:00.000Z',
    lastTimestamp: '2026-08-18T10:15:00.000Z',
  });

  const turns = store.db.prepare('SELECT * FROM grok_turns ORDER BY turn_index').all();
  assert.equal(turns.length, 4);
  assert.deepEqual({
    turnId: turns[1].turn_id,
    input: turns[1].input_tokens,
    output: turns[1].output_tokens,
    total: turns[1].total_tokens,
    cachedRead: turns[1].cached_read_tokens,
    cacheCreation: turns[1].cache_creation_tokens,
    reasoning: turns[1].reasoning_tokens,
    modelCalls: turns[1].model_calls,
    duration: turns[1].api_duration_ms,
    costTicks: turns[1].cost_usd_ticks,
    numTurns: turns[1].num_turns,
  }, {
    turnId: 'grok-turn-placeholder-2',
    input: 310000,
    output: 1100,
    total: 311100,
    cachedRead: 260000,
    cacheCreation: 1000,
    reasoning: 320,
    modelCalls: 2,
    duration: 1100,
    costTicks: 102000000,
    numTurns: 2,
  });

  const models = store.db.prepare(`
    SELECT model, input_tokens, output_tokens, cached_read_tokens, cost_usd_ticks
    FROM grok_model_usage
    WHERE turn_id = 'grok-turn-placeholder-2'
    ORDER BY model
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(models, [
    {
      model: 'grok-placeholder-a',
      input_tokens: 200000,
      output_tokens: 700,
      cached_read_tokens: 170000,
      cost_usd_ticks: 65000000,
    },
    {
      model: 'grok-placeholder-b',
      input_tokens: 110000,
      output_tokens: 400,
      cached_read_tokens: 90000,
      cost_usd_ticks: 37000000,
    },
  ]);

  const drifted = turns.at(-1);
  const provenance = JSON.parse(drifted.provenance_json);
  assert.equal(provenance.parser, 'grok-updates');
  assert.equal(provenance.parserVersion, 1);
  assert.equal(provenance.source.line, 6);
  assert.ok(provenance.unknownFields.includes('futureEnvelopeField'));
  assert.ok(provenance.unknownFields.includes('turn_completed.futureTurnField'));
  assert.ok(provenance.unknownFields.includes('turn_completed.usage.futureUsageField'));
  assert.ok(provenance.unknownFields.includes('turn_completed.usage.modelUsage.grok-placeholder-a.futureModelField'));
  assert.ok(provenance.invalidFields.includes('turn_completed.usage.apiDurationMs'));
  assert.equal(JSON.parse(drifted.source_json).futureEnvelopeField, 'envelope-drift-placeholder');

  const after = fs.statSync(fixtureFile);
  assert.deepEqual(
    { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino },
    { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino },
    'read-only ingest leaves the Grok source untouched',
  );

  const second = await ingestGrokSessions({
    store,
    sessionsRoot: fixtureRoot,
    machine: 'placeholder-machine',
  });
  assert.equal(second.filesSkipped, 1);
  assert.equal(second.sessions, 0);
  assert.equal(second.turns, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM grok_turns').get().count, 4);

  store.db.prepare(`
    UPDATE ingest_file_state SET parser_version = 0 WHERE path = ?
  `).run(fixtureFile);
  const reparsed = await ingestGrokSessions({
    store,
    sessionsRoot: fixtureRoot,
    machine: 'placeholder-machine',
  });
  assert.equal(reparsed.filesSkipped, 0, 'a parser-version bump replays an unchanged source');
  assert.equal(reparsed.sessions, 1);
  assert.deepEqual(
    { ...store.db.prepare('SELECT parser, parser_version FROM ingest_file_state WHERE path = ?').get(fixtureFile) },
    { parser: 'grok-updates', parser_version: 1 },
  );
});

test('Grok corpus rows reach the generic context views and registered diagnostician detectors', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  await ingestGrokSessions({
    store,
    sessionsRoot: fixtureRoot,
    machine: 'placeholder-machine',
  });

  const leaderboard = store.usageSessions({ provider: 'grok' });
  assert.equal(leaderboard.sessions.length, 1);
  assert.deepEqual({
    provider: leaderboard.sessions[0].provider,
    sessionId: leaderboard.sessions[0].sessionId,
    requests: leaderboard.sessions[0].requests,
    inputTokens: leaderboard.sessions[0].inputTokens,
    outputTokens: leaderboard.sessions[0].outputTokens,
    models: leaderboard.sessions[0].models,
  }, {
    provider: 'grok',
    sessionId: 'session-grok-placeholder',
    requests: 4,
    inputTokens: 1260000,
    outputTokens: 4600,
    models: ['grok-placeholder-a', 'grok-placeholder-b'],
  });

  const detail = store.usageSessionDetail({
    provider: 'grok',
    profile: 'workspace-placeholder',
    sessionId: 'session-grok-placeholder',
  });
  assert.deepEqual(detail.contextTrend.map((point) => point.inputTokens), [
    300000,
    310000,
    320000,
    330000,
  ]);

  const anatomy = store.sessionAnatomy({
    provider: 'grok',
    profile: 'workspace-placeholder',
    sessionId: 'session-grok-placeholder',
  });
  assert.equal(anatomy.supports.unit, 'turn');
  assert.equal(anatomy.totals.contextSum, 1260000);
  assert.equal(anatomy.totals.inputUncached, 197000);
  assert.equal(anatomy.totals.inputCacheRead, 1060000);
  assert.equal(anatomy.totals.inputCacheWrite, 3000);
  assert.equal(anatomy.totals.output, 4600);
  assert.equal(anatomy.totals.reportedTokens, 1264600);

  const corpus = await readDiagnosticCorpus(store, { logger() {} });
  const diagnosticTurn = corpus.sessions
    .find((session) => session.provider === 'grok')
    .points.find((point) => point.key === 'grok-turn-placeholder-2');
  const anatomyTurn = anatomy.timeline.buckets
    .find((bucket) => bucket.requests === 1 && bucket.inputCacheWrite === 1000);
  assert.deepEqual({
    uncached: diagnosticTurn.uncached,
    cacheWrite: diagnosticTurn.cacheWrite,
    cached: diagnosticTurn.cached,
    totalInput: diagnosticTurn.totalInput,
  }, {
    uncached: anatomyTurn.inputUncached,
    cacheWrite: anatomyTurn.inputCacheWrite,
    cached: anatomyTurn.inputCacheRead,
    totalInput: anatomyTurn.contextSum,
  }, 'diagnostician and session anatomy split inclusive Grok input the same way');

  const projectBurn = store.projectBurn({ project: '/workspace/placeholder' });
  assert.deepEqual(
    projectBurn.sessions.sessions,
    [],
    'corpus-only Grok sessions cannot receive Claude/Codex wire-attributed burn',
  );

  const scan = await runDetectors({ store, logger() {} });
  assert.equal(scan.detectors, DIAGNOSTIC_DETECTORS.length);
  const grokReceipts = store.listFindings().filter((finding) => (
    finding.evidence.provider === 'grok'
      || finding.evidence.sessions?.some((session) => session.provider === 'grok')
  ));
  assert.ok(grokReceipts.length > 0, 'the shared detector set emits a receipt from Grok corpus rows');
});
