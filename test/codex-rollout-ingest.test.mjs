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

  await t.test('shrunk file re-ingests from scratch without rewriting unchanged rows', async () => {
    const lines = fs.readFileSync(archivedFile, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(archivedFile, `${lines.slice(0, -1).join('\n')}\n`);
    bumpMtime(archivedFile);

    const summary = await ingestCodexRollouts({
      store,
      profilesRoot,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 1);
    assert.equal(summary.sessions, 1, 'the shrunk file was parsed instead of skipped');
    assert.equal(summary.turns, 1);
    assert.equal(summary.sessionsUpdated, 0);
    assert.equal(summary.turnsUpdated, 0);
  });

  await t.test('a same-size same-mtime replacement at the same path still re-ingests (inode changed)', async () => {
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
