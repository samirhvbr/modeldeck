import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingestCodexRollouts, parseCodexRolloutFile } from '../src/codex-rollout-ingest.mjs';
import { Store } from '../src/db.mjs';
import { parseArgs, usageText } from '../scripts/ingest-codex-rollouts.mjs';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-profiles');
const rolloutCaseRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-rollout-cases');

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
  assert.equal(second.sessionsUpdated, 2);
  assert.equal(second.turnsInserted, 0);
  assert.equal(second.turnsUpdated, 3);
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
    { turnId: 'external-import-turn-1', totalTokens: 50 },
    { turnId: 'external-import-turn-2', totalTokens: 26 },
  ]);
});

test('Codex token_count prefers valid last usage and falls back to cumulative diffs', async () => {
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
    { input: 40, cached: 21, cacheWrite: 3, output: 10, reasoning: 4, total: 50 },
    { input: 20, cached: 10, cacheWrite: 1, output: 6, reasoning: 2, total: 26 },
  ], 'valid last usage wins over cumulative totals; absent or malformed last usage uses the cumulative difference');
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
