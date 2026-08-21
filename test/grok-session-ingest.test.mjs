import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

function bumpMtime(file) {
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2_000));
}

function completedTurn(turnId, second, {
  inputTokens = second,
  model = 'grok-placeholder',
  cwd = '/workspace/placeholder',
} = {}) {
  return {
    timestamp: `2026-08-18T10:00:${String(second).padStart(2, '0')}.000Z`,
    type: 'turn_completed',
    turnId,
    cwd,
    usage: {
      inputTokens,
      outputTokens: 1,
      totalTokens: inputTokens + 1,
      modelUsage: {
        [model]: {
          inputTokens,
          outputTokens: 1,
          totalTokens: inputTokens + 1,
        },
      },
    },
  };
}

function writeGrokSession(root, cwdKey, sessionId, records) {
  const directory = path.join(root, cwdKey, sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'updates.jsonl');
  fs.writeFileSync(file, records.length
    ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    : '');
  return file;
}

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

test('TRIPWIRE #480: canceling a Grok replay cannot roll back unrelated writes', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  store.beginGrokReconcile([{
    sessionId: 'session-placeholder',
    profileSlug: 'profile-placeholder',
  }]);
  store.saveSettings({ layout: 'single-column' });
  store.cancelGrokReconcile();

  assert.equal(
    store.getSettings().layout,
    'single-column',
    'Grok reconcile staging never owns an unrelated write on the shared Store connection',
  );
});

test('TRIPWIRE #480: Grok shrink removes derived rows and leaves unrelated sessions untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-shrink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const shrinkingFile = writeGrokSession(root, 'profile-placeholder-a', 'session-placeholder-a', [
    completedTurn('turn-placeholder-a1', 1),
    completedTurn('turn-placeholder-a2', 2),
  ]);
  writeGrokSession(root, 'profile-placeholder-b', 'session-placeholder-b', [
    completedTurn('turn-placeholder-b1', 3),
  ]);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  fs.writeFileSync(shrinkingFile, `${JSON.stringify(completedTurn('turn-placeholder-a1', 1))}\n`);
  bumpMtime(shrinkingFile);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM grok_turns WHERE session_id = 'session-placeholder-a' ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['turn-placeholder-a1'],
    'the turn beyond the new end of the Grok file is removed',
  );
  assert.equal(
    store.db.prepare(`
      SELECT COUNT(*) AS count FROM grok_model_usage WHERE session_id = 'session-placeholder-a'
    `).get().count,
    1,
    'model-usage rows derived from the vanished turn are removed too',
  );
  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM grok_turns WHERE session_id = 'session-placeholder-b' ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['turn-placeholder-b1'],
    'the unrelated Grok session is untouched',
  );
});

test('TRIPWIRE #480: a padded same-size Grok rewrite reconciles fewer records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-same-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = writeGrokSession(root, 'profile-placeholder', 'session-placeholder', [
    completedTurn('turn-placeholder-one', 1),
    completedTurn('turn-placeholder-two', 2),
  ]);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  const originalSize = fs.statSync(file).size;
  const replacement = JSON.stringify(completedTurn('turn-placeholder-rewritten', 3, { inputTokens: 9 }));
  assert.ok(Buffer.byteLength(`${replacement}\n`) < originalSize);
  fs.writeFileSync(file, `${replacement}${' '.repeat(originalSize - Buffer.byteLength(`${replacement}\n`))}\n`);
  bumpMtime(file);
  assert.equal(fs.statSync(file).size, originalSize);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id, input_tokens FROM grok_turns
      WHERE session_id = 'session-placeholder' ORDER BY turn_index
    `).all().map((row) => ({ turnId: row.turn_id, inputTokens: row.input_tokens })),
    [{ turnId: 'turn-placeholder-rewritten', inputTokens: 9 }],
    'same-byte-size rewrites replace the old Grok turn set instead of leaving a phantom tail',
  );
});

test('TRIPWIRE #480: fewer Grok records reconcile even when the file grows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-fewer-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = writeGrokSession(root, 'profile-placeholder', 'session-placeholder', [
    completedTurn('turn-placeholder-one', 1),
    completedTurn('turn-placeholder-two', 2),
  ]);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  const originalSize = fs.statSync(file).size;
  const record = JSON.stringify(completedTurn('turn-placeholder-grown-rewrite', 3));
  fs.writeFileSync(file, `${record}${' '.repeat(originalSize + 100)}\n`);
  bumpMtime(file);
  assert.ok(fs.statSync(file).size > originalSize);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`SELECT turn_id FROM grok_turns ORDER BY turn_index`).all().map((row) => row.turn_id),
    ['turn-placeholder-grown-rewrite'],
  );
});

test('TRIPWIRE #480: an inode-replaced Grok file reconciles its vanished tail', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-inode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = writeGrokSession(root, 'profile-placeholder', 'session-placeholder', [
    completedTurn('turn-placeholder-one', 1),
    completedTurn('turn-placeholder-two', 2),
  ]);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  const original = fs.statSync(file);
  const record = JSON.stringify(completedTurn('turn-placeholder-replaced', 3));
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, `${record}${' '.repeat(original.size - Buffer.byteLength(`${record}\n`))}\n`);
  fs.utimesSync(replacement, original.atime, original.mtime);
  fs.renameSync(replacement, file);
  assert.notEqual(fs.statSync(file).ino, original.ino);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`SELECT turn_id FROM grok_turns ORDER BY turn_index`).all().map((row) => row.turn_id),
    ['turn-placeholder-replaced'],
  );
});

test('TRIPWIRE #480: an unstable Grok shrink stays pending until a stable reconcile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = completedTurn('turn-placeholder-one', 1);
  const second = completedTurn('turn-placeholder-two', 2);
  const file = writeGrokSession(root, 'profile-placeholder', 'session-placeholder', [first, second]);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  fs.writeFileSync(file, `${JSON.stringify(first)}\n`);
  bumpMtime(file);

  const beginGrokReconcile = store.beginGrokReconcile.bind(store);
  let changedDuringReplay = false;
  store.beginGrokReconcile = (sessions) => {
    beginGrokReconcile(sessions);
    if (!changedDuringReplay) {
      changedDuringReplay = true;
      fs.appendFileSync(file, `${JSON.stringify(completedTurn('turn-placeholder-late', 3))}\n`);
      bumpMtime(file);
    }
  };
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  store.beginGrokReconcile = beginGrokReconcile;

  assert.deepEqual(
    store.db.prepare(`SELECT turn_id FROM grok_turns ORDER BY turn_index`).all().map((row) => row.turn_id),
    ['turn-placeholder-one', 'turn-placeholder-two'],
    'an unstable replay does not publish its transient snapshot',
  );
  assert.equal(store.getIngestFileState(file).reconcilePending, true);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`SELECT turn_id FROM grok_turns ORDER BY turn_index`).all().map((row) => row.turn_id),
    ['turn-placeholder-one', 'turn-placeholder-late'],
  );
  assert.equal(store.getIngestFileState(file).reconcilePending, false);
});

test('TRIPWIRE #558: Grok reconciliation merges one session across cwd keys after a source shrinks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-cross-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sharedSessionId = 'session-shared-placeholder';
  const shrinkingFile = writeGrokSession(root, 'cwd-placeholder-a', sharedSessionId, [
    completedTurn('turn-placeholder-a1', 1),
    completedTurn('turn-placeholder-a2', 2),
    completedTurn('turn-placeholder-a3', 3),
  ]);
  writeGrokSession(root, 'cwd-placeholder-b', sharedSessionId, [
    completedTurn('turn-placeholder-b1', 4),
    completedTurn('turn-placeholder-b2', 5),
  ]);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  fs.writeFileSync(shrinkingFile, `${JSON.stringify(completedTurn('turn-placeholder-a1', 1))}\n`);
  bumpMtime(shrinkingFile);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM grok_turns
      WHERE session_id = ? ORDER BY turn_index
    `).all(sharedSessionId).map((row) => row.turn_id),
    ['turn-placeholder-a1', 'turn-placeholder-b1', 'turn-placeholder-b2'],
    'vanished turns are removed while records from the other cwd replay survive',
  );
});

test('TRIPWIRE #558: Grok reconcile keeps cwd from a lower-ranked replay source', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-reconcile-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessionId = 'session-cwd-placeholder';
  const higherRankedFile = writeGrokSession(root, 'cwd-placeholder-a', sessionId, [
    completedTurn('turn-placeholder-a1', 1, { cwd: null }),
    completedTurn('turn-placeholder-a2', 2, { cwd: null }),
    completedTurn('turn-placeholder-a3', 3, { cwd: null }),
    completedTurn('turn-placeholder-a4', 4, { cwd: null }),
  ]);
  writeGrokSession(root, 'cwd-placeholder-b', sessionId, [
    completedTurn('turn-placeholder-b1', 5),
    completedTurn('turn-placeholder-b2', 6),
  ]);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  fs.writeFileSync(higherRankedFile, [
    completedTurn('turn-placeholder-a1', 1, { cwd: null }),
    completedTurn('turn-placeholder-a2', 2, { cwd: null }),
    completedTurn('turn-placeholder-a3', 3, { cwd: null }),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  bumpMtime(higherRankedFile);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });

  assert.equal(
    store.db.prepare('SELECT cwd FROM grok_sessions WHERE session_id = ?').get(sessionId).cwd,
    '/workspace/placeholder',
    'reconcile preserves cwd from another source when the highest-ranked replay has none',
  );
});

test('TRIPWIRE #558: a relocated then shrunk Grok session reconciles from its new path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-relocated-shrink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessionId = 'session-relocated-placeholder';
  const first = completedTurn('turn-placeholder-one', 1);
  const oldFile = writeGrokSession(root, 'cwd-placeholder-old', sessionId, [
    first,
    completedTurn('turn-placeholder-two', 2),
    completedTurn('turn-placeholder-three', 3),
  ]);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });

  const newCwd = path.join(root, 'cwd-placeholder-new');
  fs.renameSync(path.dirname(path.dirname(oldFile)), newCwd);
  const newFile = path.join(newCwd, sessionId, 'updates.jsonl');
  fs.writeFileSync(newFile, `${JSON.stringify(first)}\n`);
  bumpMtime(newFile);

  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM grok_turns
      WHERE session_id = ? ORDER BY turn_index
    `).all(sessionId).map((row) => row.turn_id),
    ['turn-placeholder-one'],
    'the missing state at the new path still replaces the stale longer replay',
  );
});

test('TRIPWIRE #480: upgrade skips unchanged legacy Grok files and lazily backfills one changed file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const changedFile = writeGrokSession(root, 'profile-placeholder', 'session-placeholder-a', [
    completedTurn('turn-placeholder-a', 1),
  ]);
  const unchangedFile = writeGrokSession(root, 'profile-placeholder', 'session-placeholder-b', [
    completedTurn('turn-placeholder-b', 2),
  ]);
  await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  store.db.exec('UPDATE ingest_file_state SET session_id = NULL, record_count = NULL');

  const unchanged = await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  assert.equal(unchanged.filesSkipped, 2);
  assert.ok(store.db.prepare('SELECT session_id, record_count FROM ingest_file_state').all()
    .every((state) => state.session_id == null && state.record_count == null));

  bumpMtime(changedFile);
  const changed = await ingestGrokSessions({ store, sessionsRoot: root, machine: 'placeholder-machine' });
  assert.equal(changed.filesSkipped, 1, 'only the naturally changed legacy Grok file is parsed');
  assert.deepEqual(
    {
      sessionId: store.getIngestFileState(changedFile).sessionId,
      recordCount: store.getIngestFileState(changedFile).recordCount,
    },
    { sessionId: 'session-placeholder-a', recordCount: 1 },
  );
  assert.equal(store.getIngestFileState(unchangedFile).sessionId, null);
  assert.equal(store.getIngestFileState(unchangedFile).recordCount, null);
});

test('TRIPWIRE #480: a zero-byte unknowable Grok file warns once and stays handled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-grok-zero-byte-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = writeGrokSession(root, 'profile-placeholder', 'session-placeholder', []);
  const warnings = [];

  await ingestGrokSessions({
    store,
    sessionsRoot: root,
    warn: (message) => warnings.push(message),
  });
  const second = await ingestGrokSessions({
    store,
    sessionsRoot: root,
    warn: (message) => warnings.push(message),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /empty Grok updates without session provenance/);
  assert.equal(second.filesSkipped, 1);
  assert.deepEqual(
    {
      sessionId: store.getIngestFileState(file).sessionId,
      recordCount: store.getIngestFileState(file).recordCount,
    },
    { sessionId: null, recordCount: 0 },
  );
});
