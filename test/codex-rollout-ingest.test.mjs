import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingestCodexRollouts, parseCodexRolloutFile } from '../src/codex-rollout-ingest.mjs';
import { Store } from '../src/db.mjs';
import { cacheHealth } from '../dashboard/src/detectors.js';
import { parseArgs, usageText } from '../scripts/ingest-codex-rollouts.mjs';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-profiles');
const rolloutCaseRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-rollout-cases');

function bumpMtime(file) {
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2_000));
}

function codexSessionMeta(sessionId) {
  return {
    timestamp: '2026-08-09T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/placeholder/projects/replay-merge' },
  };
}

function codexTurnRecords({ turnId = null, timestamp, cumulativeTokens }) {
  const turnIdentity = turnId ? { turn_id: turnId } : {};
  const at = (offset) => new Date(Date.parse(timestamp) + offset).toISOString();
  return [
    {
      timestamp: at(0),
      type: 'event_msg',
      payload: { type: 'task_started', ...turnIdentity },
    },
    {
      timestamp: at(100),
      type: 'turn_context',
      payload: { ...turnIdentity },
    },
    {
      timestamp: at(200),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: {
          input_tokens: cumulativeTokens,
          total_tokens: cumulativeTokens,
        } },
      },
    },
    {
      timestamp: at(300),
      type: 'event_msg',
      payload: { type: 'task_complete', ...turnIdentity },
    },
  ];
}

function writeCodexJsonl(file, records, padding = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n${' '.repeat(padding)}\n`);
}

function duplicateCodexSources(t, sessionId, activeRecords, archivedRecords = activeRecords) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-observation-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesRoot = path.join(root, 'profiles');
  const profile = path.join(profilesRoot, 'profile-placeholder');
  const activeFile = path.join(
    profile,
    'sessions',
    '2026',
    '08',
    '09',
    `rollout-placeholder-${sessionId}.jsonl`,
  );
  const archivedFile = path.join(profile, 'archived_sessions', 'replay-copy-placeholder.jsonl');
  writeCodexJsonl(activeFile, activeRecords, 256);
  writeCodexJsonl(archivedFile, archivedRecords);
  return { profilesRoot, activeFile };
}

test('Codex rollout ingest streams nested sessions and flat archives into replay-safe warehouse rows', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const warnings = [];

  const first = await ingestCodexRollouts({
    store,
    profilesRoot: fixtureRoot,
    machine: 'placeholder-machine',
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(first, {
    profiles: 2,
    files: 2,
    filesSkipped: 0,
    sessions: 2,
    turns: 3,
    sessionsInserted: 2,
    sessionsUpdated: 0,
    turnsInserted: 3,
    turnsUpdated: 0,
    warnings: { malformedLines: 1, malformedFiles: 0, unattachedTokenCounts: 0, unreadableDirs: 0 },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /archived-placeholder-session\.jsonl line 5/);
  assert.deepEqual(
    store.db.prepare('SELECT DISTINCT parser, parser_version FROM ingest_file_state').all()
      .map((row) => ({ ...row })),
    [{ parser: 'codex-rollout', parser_version: 1 }],
    'replay state records the Codex rollout parser provenance',
  );

  const sessions = store.db.prepare('SELECT * FROM codex_sessions ORDER BY session_id').all();
  assert.equal(sessions.length, 2, 'the empty profile produces no rows and no error');
  assert.deepEqual({
    sessionId: sessions[0].session_id,
    profileSlug: sessions[0].profile_slug,
    machine: sessions[0].machine,
    cwd: sessions[0].cwd,
    originator: sessions[0].originator,
    source: sessions[0].source,
    cliVersion: sessions[0].cli_version,
    gitBranch: sessions[0].git_branch,
    gitRepo: sessions[0].git_repo,
    gitCommit: sessions[0].git_commit,
    firstTimestamp: sessions[0].first_timestamp,
    lastTimestamp: sessions[0].last_timestamp,
    archived: sessions[0].archived,
  }, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    profileSlug: 'profile-alpha',
    machine: 'placeholder-machine',
    cwd: '/placeholder/projects/active-repo',
    originator: 'codex-cli-placeholder',
    source: 'cli-placeholder',
    cliVersion: '1.2.3-placeholder',
    gitBranch: 'feature/placeholder',
    gitRepo: 'https://example.invalid/placeholder/active-repo.git',
    gitCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    firstTimestamp: '2026-08-09T10:00:00.000Z',
    lastTimestamp: '2026-08-09T10:01:05.000Z',
    archived: 0,
  });
  assert.equal(sessions[1].session_id, '22222222-2222-4222-8222-222222222222');
  assert.equal(sessions[1].archived, 1, 'flat archived_sessions files are marked archived');
  assert.equal(sessions[1].cwd, '/placeholder/projects/archived-repo');

  const activeTurns = store.db.prepare(`
    SELECT * FROM codex_turns WHERE session_id = ? ORDER BY turn_index
  `).all('11111111-1111-4111-8111-111111111111');
  assert.equal(activeTurns.length, 2);
  assert.deepEqual({
    turnId: activeTurns[0].turn_id,
    model: activeTurns[0].model,
    effort: activeTurns[0].reasoning_effort,
    input: activeTurns[0].input_tokens,
    cached: activeTurns[0].cached_input_tokens,
    cacheWrite: activeTurns[0].cache_write_input_tokens,
    output: activeTurns[0].output_tokens,
    reasoning: activeTurns[0].reasoning_output_tokens,
    total: activeTurns[0].total_tokens,
    duration: activeTurns[0].duration_ms,
    ttft: activeTurns[0].time_to_first_token_ms,
    timestamp: activeTurns[0].timestamp,
  }, {
    turnId: 'active-turn-one',
    model: 'gpt-placeholder-a',
    effort: 'high',
    input: 150,
    cached: 90,
    cacheWrite: 8,
    output: 30,
    reasoning: 10,
    total: 180,
    duration: 3000,
    ttft: 250,
    timestamp: '2026-08-09T10:00:01.000Z',
  }, 'multiple cumulative events, including a trailing counter after task_complete, attach to the preceding context');
  assert.deepEqual({
    turnId: activeTurns[1].turn_id,
    model: activeTurns[1].model,
    effort: activeTurns[1].reasoning_effort,
    input: activeTurns[1].input_tokens,
    cached: activeTurns[1].cached_input_tokens,
    cacheWrite: activeTurns[1].cache_write_input_tokens,
    output: activeTurns[1].output_tokens,
    reasoning: activeTurns[1].reasoning_output_tokens,
    total: activeTurns[1].total_tokens,
    duration: activeTurns[1].duration_ms,
    ttft: activeTurns[1].time_to_first_token_ms,
  }, {
    turnId: 'active-turn-two',
    model: 'gpt-placeholder-b',
    effort: 'xhigh',
    input: 60,
    cached: 27,
    cacheWrite: 3,
    output: 29,
    reasoning: 14,
    total: 89,
    duration: 4000,
    ttft: 300,
  }, 'a negative cumulative jump resets every baseline and never stores negatives');

  const archivedTurn = store.db.prepare('SELECT * FROM codex_turns WHERE session_id = ?').get('22222222-2222-4222-8222-222222222222');
  assert.equal(archivedTurn.model, 'gpt-placeholder-archived');
  assert.equal(archivedTurn.reasoning_effort, 'medium');
  assert.equal(archivedTurn.total_tokens, 32, 'valid lines after a malformed line still ingest');
  assert.equal(archivedTurn.duration_ms, 3000, 'duration falls back to task_started/task_complete timestamps');

  const second = await ingestCodexRollouts({
    store,
    profilesRoot: fixtureRoot,
    machine: 'placeholder-machine',
  });
  assert.equal(second.sessionsInserted, 0);
  assert.equal(second.sessionsUpdated, 0);
  assert.equal(second.turnsInserted, 0);
  assert.equal(second.turnsUpdated, 0);
  assert.equal(second.filesSkipped, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM codex_sessions').get().count, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM codex_turns').get().count, 3);

  store.migrate();
  store.migrate();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM codex_sessions').get().count, 2);
  const indexes = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  for (const name of [
    'codex_sessions_profile_last',
    'codex_sessions_git_repo',
    'codex_turns_session_turn_id',
    'codex_turns_timestamp',
    'codex_turns_model_effort',
    'ingest_file_state_session_parser_path',
  ]) assert.equal(indexes.has(name), true);
});

test('TRIPWIRE #476: Codex rollout ingest skips unchanged files and re-parses only appended or shrunk files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-incremental-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const activeFile = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  const archivedFile = path.join(
    profilesRoot,
    'profile-alpha',
    'archived_sessions',
    'archived-placeholder-session.jsonl',
  );

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  await t.test('unchanged second pass performs zero parses and zero row updates', async () => {
    const changesBefore = store.db.prepare('SELECT total_changes() AS count').get().count;
    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.files, 2);
    assert.equal(summary.filesSkipped, 2, 'every enumerated file is skipped before parsing');
    assert.equal(summary.sessions, 0);
    assert.equal(summary.sessionsUpdated, 0);
    assert.equal(summary.turnsUpdated, 0);
    assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  });

  await t.test('TRIPWIRE #480: upgrade skips unchanged legacy Codex files and lazily backfills one changed file', async () => {
    store.db.exec('UPDATE ingest_file_state SET session_id = NULL, record_count = NULL');
    const unchanged = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(unchanged.filesSkipped, 2, 'legacy rows with matching stats skip without parsing');
    assert.equal(unchanged.sessions, 0, 'the first post-upgrade scan parses zero Codex files');
    assert.equal(store.getIngestFileState(activeFile).sessionId, null);
    assert.equal(store.getIngestFileState(activeFile).recordCount, null);
    assert.equal(store.getIngestFileState(archivedFile).sessionId, null);
    assert.equal(store.getIngestFileState(archivedFile).recordCount, null);

    store.db.exec(`
      CREATE TABLE legacy_codex_reconcile_audit(deleted_turn INTEGER NOT NULL);
      CREATE TRIGGER legacy_codex_reconcile_delete
      AFTER DELETE ON codex_turns
      BEGIN
        INSERT INTO legacy_codex_reconcile_audit(deleted_turn) VALUES (1);
      END;
    `);
    bumpMtime(archivedFile);
    const changed = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(changed.filesSkipped, 1);
    assert.equal(changed.sessions, 1, 'only the naturally changed legacy file is parsed');
    assert.equal(
      store.getIngestFileState(archivedFile).sessionId,
      '22222222-2222-4222-8222-222222222222',
      'the natural replay records provenance needed if this non-UUID archive later becomes empty',
    );
    assert.ok(store.getIngestFileState(archivedFile).recordCount > 0);
    assert.equal(store.getIngestFileState(activeFile).sessionId, null);
    assert.equal(store.getIngestFileState(activeFile).recordCount, null);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM legacy_codex_reconcile_audit').get().count,
      0,
      'a same-size legacy change uses size-only shrink detection until provenance is backfilled',
    );
    store.db.exec(`
      DROP TRIGGER legacy_codex_reconcile_delete;
      DROP TABLE legacy_codex_reconcile_audit;
    `);
  });

  await t.test('append plus mtime bump re-parses exactly one file and lands the new turn', async () => {
    const appendedRecords = [
      {
        timestamp: '2026-08-09T10:02:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'active-turn-three-placeholder' },
      },
      {
        timestamp: '2026-08-09T10:02:00.100Z',
        type: 'turn_context',
        payload: { turn_id: 'active-turn-three-placeholder' },
      },
      {
        timestamp: '2026-08-09T10:02:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: {
            input_tokens: 30,
            cached_input_tokens: 10,
            cache_write_input_tokens: 2,
            output_tokens: 12,
            reasoning_output_tokens: 5,
            total_tokens: 42,
          } },
        },
      },
      {
        timestamp: '2026-08-09T10:02:03.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'active-turn-three-placeholder' },
      },
    ];
    fs.appendFileSync(activeFile, `${appendedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
    bumpMtime(activeFile);

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1);
    assert.equal(summary.sessions, 1);
    assert.equal(summary.sessionsUpdated, 1);
    assert.equal(summary.turnsInserted, 1);
    assert.equal(summary.turnsUpdated, 0, 'unchanged turns are not rewritten during the full-file replay');
    assert.equal(
      store.db.prepare('SELECT total_tokens FROM codex_turns WHERE turn_id = ?')
        .get('active-turn-three-placeholder').total_tokens,
      13,
    );
  });

  await t.test('TRIPWIRE #480: shrink replaces shifted turns and leaves unrelated sessions untouched', async () => {
    const lines = fs.readFileSync(activeFile, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(activeFile, `${[lines[0], ...lines.slice(6)].join('\n')}\n`);
    bumpMtime(activeFile);

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1);
    assert.equal(summary.sessions, 1, 'the shrunk file was parsed instead of skipped');
    assert.equal(summary.turns, 2);
    assert.equal(summary.sessionsUpdated, 0);
    assert.equal(summary.turnsUpdated, 0);
    assert.deepEqual(
      store.db.prepare(`
        SELECT turn_id FROM codex_turns
        WHERE session_id = '11111111-1111-4111-8111-111111111111'
        ORDER BY turn_index
      `).all().map((row) => row.turn_id),
      ['active-turn-two', 'active-turn-three-placeholder'],
      'the removed first turn is gone and retained turns shift without a unique-key collision',
    );
    assert.deepEqual(
      store.db.prepare(`
        SELECT turn_id FROM codex_turns
        WHERE session_id = '22222222-2222-4222-8222-222222222222'
      `).all().map((row) => row.turn_id),
      ['archived-turn'],
      'the unrelated archived session is untouched',
    );
  });

  await t.test('TRIPWIRE #480: a zero-byte shrink removes the file session', async () => {
    fs.truncateSync(activeFile, 0);
    bumpMtime(activeFile);

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1);
    assert.equal(summary.warnings.malformedFiles, 0);
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_sessions
        WHERE session_id = '11111111-1111-4111-8111-111111111111'
      `).get().count,
      0,
      'an empty active rollout removes its session and cascading turns',
    );
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_turns
        WHERE session_id = '22222222-2222-4222-8222-222222222222'
      `).get().count,
      1,
      'the unrelated archived session is untouched',
    );
  });

  await t.test('a same-size same-mtime replacement at the same path still re-ingests (inode changed)', async () => {
    bumpMtime(archivedFile);
    const stat = fs.statSync(archivedFile);
    const replacement = `${archivedFile}.replacement`;
    fs.writeFileSync(replacement, fs.readFileSync(archivedFile));
    fs.utimesSync(replacement, stat.atime, stat.mtime);
    fs.renameSync(replacement, archivedFile);
    const replaced = fs.statSync(archivedFile);
    assert.equal(replaced.size, stat.size);
    assert.equal(replaced.mtimeMs, stat.mtimeMs);
    assert.notEqual(replaced.ino, stat.ino, 'the rename produced a new inode');

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1, 'only the untouched file is skipped');
    assert.equal(summary.sessions, 1, 'the replaced file was parsed instead of skipped');
  });

  await t.test('TRIPWIRE PR #513: a parser-version bump replays an unchanged file', async () => {
    store.db.prepare('UPDATE ingest_file_state SET parser_version = 0 WHERE path = ?').run(archivedFile);

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1, 'the file whose stored parser version is stale is not skipped');
    assert.equal(summary.sessions, 1, 'the stale-parser file was re-parsed despite unchanged stats');
    assert.deepEqual(
      { ...store.db.prepare('SELECT parser, parser_version FROM ingest_file_state WHERE path = ?').get(archivedFile) },
      { parser: 'codex-rollout', parser_version: 1 },
      'the replay records the current parser provenance',
    );
  });

  await t.test('TRIPWIRE #480: zero-byte archived files use stored session provenance', async () => {
    fs.truncateSync(archivedFile, 0);
    bumpMtime(archivedFile);

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1);
    assert.equal(summary.warnings.malformedFiles, 0);
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_sessions
        WHERE session_id = '22222222-2222-4222-8222-222222222222'
      `).get().count,
      0,
      'archived names without UUIDs reconcile from the session stored on the prior pass',
    );
  });
});

test('TRIPWIRE #480: an unstable Codex shrink stays pending until a stable reconcile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-shrink-race-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  const originalSize = fs.statSync(file).size;
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, `${lines.slice(0, 6).join('\n')}\n`);
  bumpMtime(file);

  const statSync = fs.statSync;
  let targetStats = 0;
  fs.statSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(file)) {
      targetStats += 1;
      if (targetStats === 2) fs.appendFileSync(file, `${' '.repeat(originalSize + 50)}\n`);
    }
    return statSync(target, ...args);
  };
  try {
    await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  } finally {
    fs.statSync = statSync;
  }

  const pendingState = store.getIngestFileState(file);
  const replayedPrefix = `${lines.slice(0, 6).join('\n')}\n`;
  const paddingLength = pendingState.size - Buffer.byteLength(replayedPrefix) - 1;
  assert.ok(paddingLength > 0);
  fs.writeFileSync(file, `${replayedPrefix}${' '.repeat(paddingLength)}\n`);
  fs.utimesSync(file, new Date(pendingState.mtimeMs), new Date(pendingState.mtimeMs));
  const restoredStat = fs.statSync(file);
  store.db.prepare('UPDATE ingest_file_state SET mtime_ms = ? WHERE path = ?')
    .run(restoredStat.mtimeMs, file);
  const restoredState = store.getIngestFileState(file);
  assert.equal(restoredStat.size, pendingState.size);
  assert.equal(restoredStat.mtimeMs, restoredState.mtimeMs);
  assert.equal(restoredStat.ino, pendingState.ino);

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one'],
    'growth during the first read cannot turn an unfinished shrink into an append-only replay',
  );
});

test('TRIPWIRE #480: a zero-byte active rollout preserves its archived session copy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-duplicate-session-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const activeFile = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  const archivedCopy = path.join(
    profilesRoot,
    'profile-alpha',
    'archived_sessions',
    'archived-active-placeholder.jsonl',
  );
  fs.copyFileSync(activeFile, archivedCopy);

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  fs.truncateSync(activeFile, 0);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one', 'active-turn-two'],
    'truncating one source cannot delete turns that still exist in another source file',
  );
});

test('TRIPWIRE #480: a zero-byte non-UUID legacy Codex file warns once and stays handled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-zero-byte-legacy-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const archivedFile = path.join(
    profilesRoot,
    'profile-alpha',
    'archived_sessions',
    'archived-placeholder-session.jsonl',
  );

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  store.db.prepare(`
    UPDATE ingest_file_state SET session_id = NULL, record_count = NULL WHERE path = ?
  `).run(archivedFile);
  fs.truncateSync(archivedFile, 0);
  bumpMtime(archivedFile);

  const firstWarnings = [];
  const first = await ingestCodexRollouts({
    store,
    profilesRoot,
    machine: 'placeholder-machine',
    warn: (message) => firstWarnings.push(message),
  });
  const secondWarnings = [];
  const second = await ingestCodexRollouts({
    store,
    profilesRoot,
    machine: 'placeholder-machine',
    warn: (message) => secondWarnings.push(message),
  });

  assert.equal(first.warnings.malformedFiles, 0);
  assert.equal(second.warnings.malformedFiles, 0);
  assert.equal(firstWarnings.length, 1, 'the first unknowable empty file emits one warning');
  assert.match(firstWarnings[0], /stale rows may remain/);
  assert.deepEqual(secondWarnings, [], 'the handled empty file emits no warning on its next scan');
  assert.equal(store.getIngestFileState(archivedFile).reconcilePending, false);
});

test('TRIPWIRE #480: duplicate Codex sources reconcile as one session group', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-source-group-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const activeFile = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  const archiveDirectory = path.join(profilesRoot, 'profile-alpha', 'archived_sessions');
  const longCopy = path.join(archiveDirectory, 'a-long-active-copy.jsonl');
  const shortCopy = path.join(archiveDirectory, 'z-short-active-copy.jsonl');
  const lines = fs.readFileSync(activeFile, 'utf8').trimEnd().split('\n');
  fs.copyFileSync(activeFile, longCopy);
  fs.writeFileSync(shortCopy, `${lines.slice(0, 6).join('\n')}\n`);

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  fs.writeFileSync(activeFile, `${lines.slice(0, 6).join('\n')}\n`);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one', 'active-turn-two'],
    'a nonzero shrink cannot remove a turn retained by another source',
  );

  fs.truncateSync(activeFile, 0);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one', 'active-turn-two'],
    'the shorter last-sorted copy cannot overwrite the longer surviving source',
  );
});

test('TRIPWIRE #480: duplicate Codex replay preserves identical anonymous occurrences', async (t) => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const records = [
    codexSessionMeta(sessionId),
    ...codexTurnRecords({
      timestamp: '2026-08-09T10:00:01.000Z',
      cumulativeTokens: 10,
    }),
    ...codexTurnRecords({
      timestamp: '2026-08-09T10:00:01.000Z',
      cumulativeTokens: 20,
    }),
  ];
  const { profilesRoot, activeFile } = duplicateCodexSources(t, sessionId, records);
  const store = new Store(':memory:');
  t.after(() => store.close());

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  writeCodexJsonl(activeFile, records);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id, total_tokens FROM codex_turns
      WHERE session_id = ? ORDER BY turn_index
    `).all(sessionId).map((row) => ({ ...row })),
    [
      { turn_id: null, total_tokens: 10 },
      { turn_id: null, total_tokens: 10 },
    ],
    'equal anonymous turns are separate occurrences, not duplicate observations of one turn',
  );
});

test('TRIPWIRE #480: duplicate Codex replay merges richer snapshots of one anonymous occurrence', async (t) => {
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const activeRecords = [
    codexSessionMeta(sessionId),
    ...codexTurnRecords({
      timestamp: '2026-08-09T10:00:01.000Z',
      cumulativeTokens: 10,
    }),
  ];
  const archivedRecords = [
    codexSessionMeta(sessionId),
    ...codexTurnRecords({
      timestamp: '2026-08-09T10:00:01.000Z',
      cumulativeTokens: 12,
    }),
  ];
  const { profilesRoot, activeFile } = duplicateCodexSources(
    t,
    sessionId,
    activeRecords,
    archivedRecords,
  );
  const store = new Store(':memory:');
  t.after(() => store.close());

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  writeCodexJsonl(activeFile, activeRecords);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id, total_tokens FROM codex_turns
      WHERE session_id = ? ORDER BY turn_index
    `).all(sessionId).map((row) => ({ ...row })),
    [{ turn_id: null, total_tokens: 12 }],
    'the same anonymous occurrence is stored once using its richer observation',
  );
});

test('TRIPWIRE #480: duplicate Codex replay keeps the richer named-turn observation', async (t) => {
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const activeRecords = [
    codexSessionMeta(sessionId),
    ...codexTurnRecords({
      turnId: 'shared-turn-placeholder',
      timestamp: '2026-08-09T10:00:01.000Z',
      cumulativeTokens: 0,
    }),
    ...codexTurnRecords({
      turnId: 'active-only-turn-placeholder',
      timestamp: '2026-08-09T10:00:02.000Z',
      cumulativeTokens: 1,
    }),
  ];
  const archivedRecords = [
    codexSessionMeta(sessionId),
    ...codexTurnRecords({
      turnId: 'shared-turn-placeholder',
      timestamp: '2026-08-09T10:00:01.000Z',
      cumulativeTokens: 10,
    }),
  ];
  const { profilesRoot, activeFile } = duplicateCodexSources(
    t,
    sessionId,
    activeRecords,
    archivedRecords,
  );
  const store = new Store(':memory:');
  t.after(() => store.close());

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  writeCodexJsonl(activeFile, activeRecords);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id, total_tokens FROM codex_turns
      WHERE session_id = ? ORDER BY turn_index
    `).all(sessionId).map((row) => ({ ...row })),
    [
      { turn_id: 'shared-turn-placeholder', total_tokens: 10 },
      { turn_id: 'active-only-turn-placeholder', total_tokens: 1 },
    ],
    'a longer source cannot replace richer shared-turn usage with zeroes',
  );
});

test('TRIPWIRE #480: shifted anonymous Codex observations still merge across sources', async (t) => {
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const firstTurn = codexTurnRecords({
    timestamp: '2026-08-09T10:00:01.000Z',
    cumulativeTokens: 10,
  });
  const secondTurn = codexTurnRecords({
    timestamp: '2026-08-09T10:00:02.000Z',
    cumulativeTokens: 20,
  });
  const fullRecords = [codexSessionMeta(sessionId), ...firstTurn, ...secondTurn];
  const { profilesRoot, activeFile } = duplicateCodexSources(t, sessionId, fullRecords);
  const store = new Store(':memory:');
  t.after(() => store.close());

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  writeCodexJsonl(activeFile, [codexSessionMeta(sessionId), ...secondTurn]);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT timestamp, total_tokens FROM codex_turns
      WHERE session_id = ? ORDER BY timestamp
    `).all(sessionId).map((row) => ({ ...row })),
    [
      { timestamp: '2026-08-09T10:00:01.000Z', total_tokens: 10 },
      { timestamp: '2026-08-09T10:00:02.000Z', total_tokens: 10 },
    ],
    'a shifted snapshot cannot duplicate the row or reinterpret its cumulative usage as a new baseline',
  );
});

test('TRIPWIRE #480: fewer Codex records reconcile even when the file does not lose bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-record-count-shrink-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  const originalSize = fs.statSync(file).size;
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const kept = `${lines.slice(0, 6).join('\n')}\n`;
  fs.writeFileSync(file, `${kept}${' '.repeat(originalSize - Buffer.byteLength(kept))}`);
  bumpMtime(file);
  store.db.prepare('UPDATE ingest_file_state SET parser_version = 0 WHERE path = ?').run(file);

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  assert.equal(fs.statSync(file).size, originalSize);
  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one'],
    'record-count shrink and parser-version replay compose without retaining the removed turn',
  );
  assert.equal(store.getIngestFileState(file).parserVersion, 1);
});

test('TRIPWIRE #480: unstable Codex path repurposing never publishes the transient session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-unstable-repurpose-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesRoot = path.join(root, 'profiles');
  const file = path.join(
    profilesRoot,
    'profile-placeholder',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-placeholder-77777777-7777-4777-8777-777777777777.jsonl',
  );
  const sessionA = '77777777-7777-4777-8777-777777777777';
  const sessionB = '88888888-8888-4888-8888-888888888888';
  const sessionC = '99999999-9999-4999-8999-999999999999';
  const records = (sessionId, timestamp, turnId) => [
    codexSessionMeta(sessionId),
    ...codexTurnRecords({ turnId, timestamp, cumulativeTokens: 10 }),
  ];
  writeCodexJsonl(file, records(sessionA, '2026-08-09T10:00:01.000Z', 'turn-a-placeholder'), 512);
  const store = new Store(':memory:');
  t.after(() => store.close());
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  writeCodexJsonl(file, records(sessionB, '2026-08-09T10:00:02.000Z', 'turn-b-placeholder'));
  bumpMtime(file);
  const sessionBStat = fs.statSync(file);
  const statSync = fs.statSync;
  let targetStats = 0;
  fs.statSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(file)) {
      targetStats += 1;
      if (targetStats === 2) {
        writeCodexJsonl(file, records(sessionC, '2026-08-09T10:00:03.000Z', 'turn-c-placeholder'));
        fs.utimesSync(file, sessionBStat.atime, new Date(sessionBStat.mtimeMs + 2_000));
      }
    }
    return statSync(target, ...args);
  };
  try {
    await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  } finally {
    fs.statSync = statSync;
  }
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare('SELECT session_id FROM codex_sessions ORDER BY session_id').all()
      .map((row) => row.session_id),
    [sessionC],
    'a session parsed from an unstable intermediate snapshot never reaches the warehouse',
  );
});

test('TRIPWIRE #480: zeroing a later Codex copy removes its unique turn in one pass', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-later-zero-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const activeFile = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  const laterCopy = path.join(
    profilesRoot,
    'profile-alpha',
    'archived_sessions',
    'z-active-with-third-turn.jsonl',
  );
  fs.copyFileSync(activeFile, laterCopy);
  fs.appendFileSync(laterCopy, [
    JSON.stringify({
      timestamp: '2026-08-09T10:02:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'archive-only-turn', started_at: '2026-08-09T10:02:01.000Z' },
    }),
    JSON.stringify({
      timestamp: '2026-08-09T10:02:01.100Z',
      type: 'turn_context',
      payload: { turn_id: 'archive-only-turn' },
    }),
    JSON.stringify({
      timestamp: '2026-08-09T10:02:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 230,
            cached_input_tokens: 130,
            cache_write_input_tokens: 12,
            output_tokens: 60,
            reasoning_output_tokens: 25,
            total_tokens: 290,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-08-09T10:02:04.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'archive-only-turn', completed_at: '2026-08-09T10:02:04.000Z' },
    }),
  ].join('\n') + '\n');

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  fs.truncateSync(laterCopy, 0);
  bumpMtime(laterCopy);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one', 'active-turn-two'],
    'a removed turn is gone after the first re-ingest even when its surviving source ran earlier',
  );
});

test('TRIPWIRE #480: Codex reconciliation finds duplicate sources across profiles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-cross-profile-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const activeFile = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  const otherArchive = path.join(profilesRoot, 'profile-zeta', 'archived_sessions');
  fs.mkdirSync(otherArchive, { recursive: true });
  const laterCopy = path.join(otherArchive, 'active-copy-placeholder.jsonl');
  fs.copyFileSync(activeFile, laterCopy);

  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });
  fs.truncateSync(laterCopy, 0);
  bumpMtime(laterCopy);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['active-turn-one', 'active-turn-two'],
    'a globally keyed session survives while any managed profile still contains it',
  );
});

test('TRIPWIRE #480: replacing a Codex path with another session clears stale ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-repurposed-path-'));
  const profilesRoot = path.join(root, 'profiles');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const activeFile = path.join(
    profilesRoot,
    'profile-alpha',
    'sessions',
    '2026',
    '08',
    '09',
    'rollout-2026-08-09T10-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  );
  const archiveDirectory = path.join(profilesRoot, 'profile-alpha', 'archived_sessions');
  const oldSessionCopy = path.join(archiveDirectory, 'repurposed-placeholder.jsonl');
  const otherSessionFile = path.join(archiveDirectory, 'archived-placeholder-session.jsonl');
  fs.copyFileSync(activeFile, oldSessionCopy);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  fs.copyFileSync(otherSessionFile, oldSessionCopy);
  fs.truncateSync(activeFile, 0);
  bumpMtime(activeFile);
  await ingestCodexRollouts({ store, profilesRoot, machine: 'placeholder-machine' });

  assert.equal(
    store.db.prepare(`
      SELECT COUNT(*) AS count FROM codex_sessions
      WHERE session_id = '11111111-1111-4111-8111-111111111111'
    `).get().count,
    0,
    'stale file-state provenance cannot keep a session with no remaining source alive',
  );
  assert.deepEqual(
    store.db.prepare(`
      SELECT turn_id FROM codex_turns
      WHERE session_id = '22222222-2222-4222-8222-222222222222'
      ORDER BY turn_index
    `).all().map((row) => row.turn_id),
    ['archived-turn'],
    'the replacement path is re-attributed to its current session',
  );
});

test('TRIPWIRE codex-cached-input-subset — rollout cache reads are split from input exactly once', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  await ingestCodexRollouts({
    store,
    profilesRoot: fixtureRoot,
    machine: 'placeholder-machine',
  });

  const project = store.projectBurn({
    provider: 'codex',
    project: '/placeholder/projects/active-repo',
  }).projects[0];
  const expectedUncached = (150 - 90) + (60 - 27);
  const expectedRead = 90 + 27;
  const expectedWrite = 8 + 3;
  const expectedInput = expectedUncached + expectedRead + expectedWrite;

  assert.equal(project.inputUncached, expectedUncached);
  assert.deepEqual(project.tokenFlows, {
    inputUncached: expectedUncached,
    inputCacheRead: expectedRead,
    inputCacheWrite: expectedWrite,
    outputTotal: 30 + 29,
  });
  assert.ok(expectedWrite > 0, 'the fixture carries a separate nonzero cache-write flow');
  assert.equal(project.totalTokens, (150 + 60) + (30 + 29), 'Codex reported totals include input and output, not cache writes');
  assert.equal(project.inputTokens, expectedInput);
  assert.equal(cacheHealth({ requests: 25, flows: project.tokenFlows }).readShare, expectedRead / expectedInput);

  const sessions = store.usageSessions({
    provider: 'codex',
    project: '/placeholder/projects/active-repo',
  });
  assert.equal(sessions.sessions[0].inputTokens, expectedInput);

  const detail = store.usageSessionDetail({
    sessionId: '11111111-1111-4111-8111-111111111111',
    profile: 'profile-alpha',
    provider: 'codex',
  });
  assert.deepEqual(detail.contextTrend.map((point) => point.inputTokens), [150 + 8, 60 + 3]);

  const effort = store.modelEffortBurn({
    provider: 'codex',
    project: '/placeholder/projects/active-repo',
  });
  assert.equal(effort.totals.inputTokens, expectedInput);

  const anatomy = store.sessionAnatomy({
    sessionId: '11111111-1111-4111-8111-111111111111',
    profile: 'profile-alpha',
    provider: 'codex',
  });
  assert.equal(anatomy.totals.inputUncached, expectedUncached);
  assert.equal(anatomy.totals.inputCacheRead, expectedRead);
  assert.equal(anatomy.totals.inputCacheWrite, expectedWrite);
  assert.equal(anatomy.totals.contextSum, expectedInput);
});

test('Codex external-import turns retain tokens without turn_context events', async () => {
  const parsed = await parseCodexRolloutFile({
    file: path.join(rolloutCaseRoot, 'external-import-placeholder.jsonl'),
    profileSlug: 'placeholder-profile',
    machine: 'placeholder-machine',
  });

  assert.equal(parsed.unattachedTokenCounts, 0);
  assert.deepEqual(parsed.turns.map((turn) => ({
    turnId: turn.turnId,
    totalTokens: turn.totalTokens,
  })), [
    { turnId: 'external-import-turn-1', totalTokens: 158 },
    { turnId: 'external-import-turn-2', totalTokens: 26 },
  ]);
});

test('Codex token_count uses session-cumulative differences even when last usage disagrees', async () => {
  const parsed = await parseCodexRolloutFile({
    file: path.join(rolloutCaseRoot, 'external-import-placeholder.jsonl'),
    profileSlug: 'placeholder-profile',
    machine: 'placeholder-machine',
  });

  assert.deepEqual(parsed.turns.map((turn) => ({
    input: turn.inputTokens,
    cached: turn.cachedInputTokens,
    cacheWrite: turn.cacheWriteInputTokens,
    output: turn.outputTokens,
    reasoning: turn.reasoningOutputTokens,
    total: turn.totalTokens,
  })), [
    { input: 130, cached: 75, cacheWrite: 7, output: 28, reasoning: 11, total: 158 },
    { input: 20, cached: 10, cacheWrite: 1, output: 6, reasoning: 2, total: 26 },
  ], 'cumulative totals win over contradictory last usage and are differenced across turns');
});

test('TRIPWIRE codex-rollout-session-cumulative-deltas — repeated multi-call counters count once per turn', async () => {
  const parsed = await parseCodexRolloutFile({
    file: path.join(rolloutCaseRoot, 'cumulative-multi-call-placeholder.jsonl'),
    profileSlug: 'placeholder-profile',
    machine: 'placeholder-machine',
  });

  assert.deepEqual(parsed.turns.map((turn) => ({
    input: turn.inputTokens,
    cached: turn.cachedInputTokens,
    output: turn.outputTokens,
    reasoning: turn.reasoningOutputTokens,
    total: turn.totalTokens,
  })), [
    { input: 150, cached: 90, output: 30, reasoning: 10, total: 180 },
    { input: 40, cached: 20, output: 20, reasoning: 10, total: 60 },
  ], 'the unchanged middle emission contributes zero; turn totals are successive session-cumulative differences');
});

test('Codex token_count seeds cumulative differences from preceding fallback-only events', async () => {
  const parsed = await parseCodexRolloutFile({
    file: path.join(rolloutCaseRoot, 'fallback-before-cumulative-placeholder.jsonl'),
    profileSlug: 'placeholder-profile',
    machine: 'placeholder-machine',
  });

  assert.deepEqual(parsed.turns.map((turn) => ({
    turnId: turn.turnId,
    input: turn.inputTokens,
    cached: turn.cachedInputTokens,
    cacheWrite: turn.cacheWriteInputTokens,
    output: turn.outputTokens,
    reasoning: turn.reasoningOutputTokens,
    total: turn.totalTokens,
  })), [
    { turnId: 'fallback-turn-1', input: 12, cached: 5, cacheWrite: 1, output: 3, reasoning: 1, total: 15 },
    { turnId: 'fallback-turn-2', input: 4, cached: 1, cacheWrite: 0, output: 1, reasoning: 1, total: 5 },
  ], 'the first cumulative observation contributes only usage after the estimated fallback baseline');
});

test('Codex token_count without any preceding turn uses one warned session catch-all', async () => {
  const warnings = [];
  const parsed = await parseCodexRolloutFile({
    file: path.join(rolloutCaseRoot, 'session-catch-all-placeholder.jsonl'),
    profileSlug: 'placeholder-profile',
    machine: 'placeholder-machine',
    warn: (message) => warnings.push(message),
  });

  assert.equal(parsed.unattachedTokenCounts, 2);
  assert.equal(warnings.length, 2);
  assert.equal(parsed.turns.length, 1);
  assert.deepEqual({
    turnId: parsed.turns[0].turnId,
    model: parsed.turns[0].model,
    effort: parsed.turns[0].reasoningEffort,
    total: parsed.turns[0].totalTokens,
  }, {
    turnId: null,
    model: null,
    effort: null,
    total: 20,
  });
});

test('Codex rollout CLI exposes overridable roots, database, and machine', () => {
  assert.deepEqual(parseArgs([
    '--profiles-root', '/placeholder/profiles',
    '--db', '/placeholder/modeldeck.sqlite',
    '--machine', 'placeholder-machine',
  ]), {
    profilesRoot: '/placeholder/profiles',
    dbPath: '/placeholder/modeldeck.sqlite',
    machine: 'placeholder-machine',
  });
  assert.match(usageText(), /--profiles-root/);
  assert.throws(() => parseArgs(['--profiles-root']), /requires a value/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
});

test('Codex rollout CLI warns on an unreadable profile and continues with the others', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-rollout-unreadable-'));
  const profilesRoot = path.join(root, 'profiles');
  const unreadableProfile = path.join(profilesRoot, 'profile-unreadable');
  const dbPath = path.join(root, 'modeldeck.sqlite');
  fs.cpSync(fixtureRoot, profilesRoot, { recursive: true });
  fs.mkdirSync(unreadableProfile);
  fs.chmodSync(unreadableProfile, 0o000);
  t.after(() => {
    fs.chmodSync(unreadableProfile, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = spawnSync(process.execPath, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ingest-codex-rollouts.mjs'),
    '--profiles-root', profilesRoot,
    '--db', dbPath,
    '--machine', 'placeholder-machine',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipped unreadable directory .*profile-unreadable/);
  assert.notEqual(result.stdout.trim(), '', 'the CLI prints its exit summary');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.profiles, 3);
  assert.equal(summary.sessions, 2, 'readable profiles still ingest');
  assert.equal(summary.warnings.unreadableDirs, 1);
});
