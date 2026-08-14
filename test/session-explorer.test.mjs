// Issue #347: the session/task explorer reader, its route, and the lane-issue
// tagging heuristic. Contracts under test:
//   - one leaderboard across BOTH providers, matching a direct warehouse query;
//   - a subagent's tokens are counted ONCE (its requests are already inside the
//     session total, so the transcript rollup is never added on top);
//   - skills aggregate per session; the detail read returns the subagent tree,
//     the skill events and the context-size trend;
//   - lane tags come from paired launched/exited manifest records, are always
//     marked heuristic, and say when they are ambiguous;
//   - every query parameter is validated in the reader's established style and
//     surfaces as a 400 on the route.
// Placeholder identities and synthetic ids only — never real account data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { parseLaneRuns, readLaneRuns, laneTagForSession, tagSessionsWithLaneRuns } from '../src/lane-manifest.mjs';

const PORT = 43347;
const TOKEN = 'session-explorer-placeholder-token';

function transcriptRequest({
  key, sessionId, profileSlug = 'profile-one', model = 'claude-placeholder', effort = null,
  observedAt, input = 0, cacheCreate = 0, cacheRead = 0, output = 0, agentId = null,
}) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug,
    messageId: key,
    recordUuid: null,
    model,
    effort,
    observedAt,
    inputTokens: input,
    cacheCreationInputTokens: cacheCreate,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0,
    cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: agentId != null,
    agentId,
  };
}

function fixture(t, { laneManifestPath, usageAnalyticsEnabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-sessions-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  // Issue #359 gates the whole /api/usage/ prefix behind the kill switch.
  // 0.4.6 defaults on; the flag-off contract has its own test below.
  if (!usageAnalyticsEnabled) store.saveSettings({ usageAnalyticsEnabled: false });
  const service = { projectsRoot: root, startAutoRefresh() {}, stopAutoRefresh() {} };
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: PORT,
    mutationToken: TOKEN,
    // Default to a path that cannot exist, so a test that does not opt into
    // lane tagging can never read the developer's own manifest.
    laneManifestPath: laneManifestPath || path.join(root, 'absent-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store, root };
}

// One Claude session with a subagent and two skills, one Codex session with two
// turns, plus a second smaller Claude session on another profile.
function seed(store) {
  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: 'sess-big',
        profileSlug: 'profile-one',
        machine: 'placeholder-machine',
        cwd: '/placeholder/projects/alpha',
        gitBranch: 'lane/placeholder',
        firstAt: '2026-08-01T10:00:00.000Z',
        lastAt: '2026-08-01T12:00:00.000Z',
        title: 'Placeholder session title',
        titleSource: 'custom-title',
      },
      {
        sessionId: 'sess-small',
        profileSlug: 'profile-two',
        machine: 'placeholder-machine',
        cwd: '/placeholder/projects/beta',
        gitBranch: 'main',
        firstAt: '2026-08-01T09:00:00.000Z',
        lastAt: '2026-08-01T09:30:00.000Z',
        title: 'Second placeholder session',
        titleSource: 'last-prompt',
      },
    ],
    requests: [
      transcriptRequest({
        key: 'big-1', sessionId: 'sess-big', observedAt: '2026-08-01T10:00:00.000Z',
        input: 100, cacheCreate: 50, cacheRead: 1000, output: 200,
      }),
      transcriptRequest({
        key: 'big-2', sessionId: 'sess-big', observedAt: '2026-08-01T11:00:00.000Z',
        input: 10, cacheCreate: 0, cacheRead: 2000, output: 90,
      }),
      // The subagent's OWN requests, already part of the session.
      transcriptRequest({
        key: 'big-agent-1', sessionId: 'sess-big', observedAt: '2026-08-01T11:30:00.000Z',
        input: 5, cacheCreate: 0, cacheRead: 500, output: 45, agentId: 'agent-a',
      }),
      transcriptRequest({
        key: 'small-1', sessionId: 'sess-small', profileSlug: 'profile-two',
        observedAt: '2026-08-01T09:10:00.000Z', input: 10, cacheRead: 100, output: 20,
      }),
    ],
    subagents: [{
      agentId: 'agent-a',
      sessionId: 'sess-big',
      profileSlug: 'profile-one',
      agentType: 'Explore',
      resolvedModel: 'claude-placeholder',
      // The transcript's own rollup of the same work. Adding this to the
      // session total is the ~2× inflation trap; the reader must not.
      totalTokens: 550,
      toolStatsJson: JSON.stringify({ totalToolUseCount: 4 }),
      durationMs: 42000,
      observedAt: '2026-08-01T11:31:00.000Z',
    }],
    skills: [
      { eventKey: 'skill-1', sessionId: 'sess-big', profileSlug: 'profile-one', skill: 'dataviz', commandName: null, observedAt: '2026-08-01T10:05:00.000Z' },
      { eventKey: 'skill-2', sessionId: 'sess-big', profileSlug: 'profile-one', skill: 'dataviz', commandName: null, observedAt: '2026-08-01T10:25:00.000Z' },
      { eventKey: 'skill-3', sessionId: 'sess-big', profileSlug: 'profile-one', skill: 'implement', commandName: null, observedAt: '2026-08-01T10:45:00.000Z' },
      { eventKey: 'cmd-1', sessionId: 'sess-big', profileSlug: 'profile-one', skill: null, commandName: 'review', observedAt: '2026-08-01T11:45:00.000Z' },
    ],
  });

  store.ingestCodexSession(
    {
      sessionId: 'codex-one',
      profileSlug: 'codex-profile',
      machine: 'placeholder-machine',
      cwd: '/placeholder/projects/alpha',
      gitBranch: 'lane/placeholder',
      firstTimestamp: '2026-08-01T13:00:00.000Z',
      lastTimestamp: '2026-08-01T14:00:00.000Z',
      archived: false,
    },
    [
      {
        turnIndex: 0, turnId: 'turn-0', model: 'gpt-placeholder-sol', reasoningEffort: 'medium',
        inputTokens: 300, cachedInputTokens: 700, cacheWriteInputTokens: 0,
        outputTokens: 150, reasoningOutputTokens: 90, totalTokens: 1150,
        timestamp: '2026-08-01T13:10:00.000Z',
      },
      {
        turnIndex: 1, turnId: 'turn-1', model: 'gpt-placeholder-sol', reasoningEffort: 'medium',
        inputTokens: 100, cachedInputTokens: 900, cacheWriteInputTokens: 0,
        outputTokens: 60, reasoningOutputTokens: 20, totalTokens: 1060,
        timestamp: '2026-08-01T13:50:00.000Z',
      },
    ],
  );
}

async function request(app, route, { host = `127.0.0.1:${PORT}` } = {}) {
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: route, headers: { host } });
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(value, nextHeaders) { status = value; headers = nextHeaders; },
    end(value) { payload = value == null ? null : String(value); },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, headers, body: payload };
}

const RANGE = { since: '2026-08-01T00:00:00.000Z', until: '2026-08-02T00:00:00.000Z' };

test('the leaderboard ranks sessions from BOTH providers and matches a direct warehouse query', (t) => {
  const { store } = fixture(t);
  seed(store);
  const result = store.usageSessions(RANGE);

  assert.deepEqual(result.sessions.map((session) => [session.provider, session.sessionId, session.totalTokens]), [
    ['codex', 'codex-one', 2210],
    ['claude', 'sess-big', 4000],
    ['claude', 'sess-small', 130],
  ].sort((a, b) => b[2] - a[2]));

  // Ranked by tokens, biggest burner first, across providers.
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ['sess-big', 'codex-one', 'sess-small'],
  );

  // Every row reconciles with a direct query over the same bounds.
  const claudeDirect = store.db.prepare(`
    SELECT COUNT(*) AS requests,
           SUM(input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens) AS total,
           SUM(output_tokens) AS output
    FROM transcript_requests
    WHERE session_id = 'sess-big' AND profile_slug = 'profile-one'
      AND observed_at >= ? AND observed_at < ?
  `).get(RANGE.since, RANGE.until);
  const big = result.sessions.find((session) => session.sessionId === 'sess-big');
  assert.equal(big.totalTokens, Number(claudeDirect.total));
  assert.equal(big.outputTokens, Number(claudeDirect.output));
  assert.equal(big.requests, Number(claudeDirect.requests));

  const codexDirect = store.db.prepare(`
    SELECT COUNT(*) AS turns, SUM(total_tokens) AS total, SUM(output_tokens) AS output
    FROM codex_turns WHERE session_id = 'codex-one' AND timestamp >= ? AND timestamp < ?
  `).get(RANGE.since, RANGE.until);
  const codex = result.sessions.find((session) => session.provider === 'codex');
  assert.equal(codex.totalTokens, Number(codexDirect.total));
  assert.equal(codex.outputTokens, Number(codexDirect.output));
  assert.equal(codex.requests, Number(codexDirect.turns));

  // Transcript titles are shown where present; Codex rollouts carry none.
  assert.equal(big.title, 'Placeholder session title');
  assert.equal(big.titleSource, 'custom-title');
  assert.equal(codex.title, null);
  assert.equal(codex.cwd, '/placeholder/projects/alpha');
  assert.equal(codex.gitBranch, 'lane/placeholder');
  assert.equal(codex.archived, false);
});

test('subagent tokens are counted once: a share of the session total, never added to it', (t) => {
  const { store } = fixture(t);
  seed(store);
  const big = store.usageSessions(RANGE).sessions.find((session) => session.sessionId === 'sess-big');

  // 1350 + 2100 + 550 = 4000, with the subagent's 550 counted exactly once.
  assert.equal(big.totalTokens, 4000);
  assert.equal(big.subagents, 1);
  assert.equal(big.subagentTokens, 550);
  assert.equal(big.subagentTokens < big.totalTokens, true);

  // The transcript rollup reports the same 550. If the reader had added it,
  // the session would read 4550 — this is the inflation guard.
  const rollup = store.db.prepare(
    'SELECT total_tokens FROM transcript_subagents WHERE agent_id = ? AND profile_slug = ?',
  ).get('agent-a', 'profile-one');
  assert.equal(Number(rollup.total_tokens), 550);
  assert.notEqual(big.totalTokens, 4000 + Number(rollup.total_tokens));

  // The detail read reports the rollup beside the measured sum, not instead.
  const detail = store.usageSessionDetail({ sessionId: 'sess-big', profile: 'profile-one' });
  assert.equal(detail.subagents.length, 1);
  assert.equal(detail.subagents[0].agentType, 'Explore');
  assert.equal(detail.subagents[0].totalTokens, 550);
  assert.equal(detail.subagents[0].rollupTotalTokens, 550);
  assert.equal(detail.subagents[0].requests, 1);
  assert.equal(detail.session.totalTokens, 4000);
});

test('skills aggregate per session and the detail read returns their events', (t) => {
  const { store } = fixture(t);
  seed(store);
  const big = store.usageSessions(RANGE).sessions.find((session) => session.sessionId === 'sess-big');
  // Names, most-used first, each named once however many times it was invoked.
  assert.deepEqual(big.skills, ['dataviz', 'implement']);
  assert.deepEqual(big.commands, ['review']);

  const detail = store.usageSessionDetail({ sessionId: 'sess-big', profile: 'profile-one' });
  assert.deepEqual(detail.skills.map((skill) => [skill.skill, skill.commandName, skill.events]), [
    ['dataviz', null, 2],
    ['implement', null, 1],
    [null, 'review', 1],
  ]);
  assert.equal(detail.skills[0].firstAt, '2026-08-01T10:05:00.000Z');
  assert.equal(detail.skills[0].lastAt, '2026-08-01T10:25:00.000Z');

  // A Codex session has no skill or subagent instrumentation: empty is a fact.
  const codex = store.usageSessionDetail({ sessionId: 'codex-one', profile: 'codex-profile' });
  assert.deepEqual(codex.skills, []);
  assert.deepEqual(codex.subagents, []);
  assert.equal(codex.session.provider, 'codex');
});

test('the context-size signal is the average input per request, and the trend is per request', (t) => {
  const { store } = fixture(t);
  seed(store);
  const big = store.usageSessions(RANGE).sessions.find((session) => session.sessionId === 'sess-big');
  // (1150 + 2010 + 505) / 3 requests.
  assert.equal(big.inputTokens, 3665);
  assert.equal(big.avgInputTokens, Math.round(3665 / 3));

  const detail = store.usageSessionDetail({ sessionId: 'sess-big', profile: 'profile-one' });
  assert.deepEqual(detail.contextTrend.map((point) => point.inputTokens), [1150, 2010, 505]);
  assert.deepEqual(detail.contextTrend.map((point) => point.agentId), [null, null, 'agent-a']);
  assert.equal(detail.truncated, false);

  const codex = store.usageSessionDetail({ sessionId: 'codex-one', profile: 'codex-profile' });
  assert.deepEqual(codex.contextTrend.map((point) => point.inputTokens), [1000, 1000]);
});

test('range, provider and account filters narrow the leaderboard', (t) => {
  const { store } = fixture(t);
  seed(store);

  assert.deepEqual(
    store.usageSessions({ ...RANGE, provider: 'claude' }).sessions.map((session) => session.sessionId),
    ['sess-big', 'sess-small'],
  );
  assert.deepEqual(
    store.usageSessions({ ...RANGE, provider: 'codex' }).sessions.map((session) => session.sessionId),
    ['codex-one'],
  );

  // A narrower window keeps only the in-range requests, and the aggregates
  // shrink with it rather than reporting the session's whole life.
  const narrow = store.usageSessions({
    since: '2026-08-01T10:30:00.000Z', until: '2026-08-01T13:30:00.000Z',
  });
  const big = narrow.sessions.find((session) => session.sessionId === 'sess-big');
  assert.equal(big.requests, 2);
  assert.equal(big.totalTokens, 2100 + 550);
  assert.equal(narrow.sessions.find((session) => session.provider === 'codex').requests, 1);
  assert.equal(narrow.sessions.some((session) => session.sessionId === 'sess-small'), false);

  // The account filter resolves through the account's profile REF basename.
  const account = store.saveAccount({
    provider: 'claude', label: 'Placeholder Profile One',
    identity: 'placeholder-one@example.com', profileRef: '/placeholder/profiles/profile-one',
  });
  const scoped = store.usageSessions({ ...RANGE, accountId: account.id });
  assert.deepEqual(scoped.sessions.map((session) => session.sessionId), ['sess-big']);
  assert.equal(scoped.sessions[0].accountId, account.id);
  assert.equal(scoped.sessions[0].accountLabel, 'Placeholder Profile One');
  // An account whose profile ref names no ingested profile selects nothing
  // rather than silently widening to every session.
  const other = store.saveAccount({
    provider: 'claude', label: 'Placeholder Elsewhere',
    identity: 'placeholder-two@example.com', profileRef: '/placeholder/profiles/not-ingested',
  });
  assert.deepEqual(store.usageSessions({ ...RANGE, accountId: other.id }).sessions, []);

  // The slug filter is scoped to the account's OWN provider: a Claude account
  // whose profile directory basename collides with an unrelated codex profile
  // slug must not pull that codex profile's sessions into its leaderboard.
  const colliding = store.saveAccount({
    provider: 'claude', label: 'Placeholder Colliding',
    identity: 'placeholder-three@example.com', profileRef: '/placeholder/profiles/codex-profile',
  });
  assert.deepEqual(store.usageSessions({ ...RANGE, accountId: colliding.id }).sessions, []);
});

test('a profile slug present under BOTH providers stays split by the account provider', (t) => {
  const { store, root } = fixture(t);
  seed(store);

  // This is the real machine's shape: the SAME profile slug exists under both
  // claude-profiles and ~/.codex-profiles (e.g. 'insight', 'lend-management'),
  // so a slug alone can never identify a provider. Give the Codex rollout the
  // Claude session's slug and both halves of the leaderboard now answer to it.
  store.ingestCodexSession(
    {
      sessionId: 'codex-same-slug',
      profileSlug: 'profile-one',
      machine: 'placeholder-machine',
      cwd: '/placeholder/projects/alpha',
      firstTimestamp: '2026-08-01T15:00:00.000Z',
      lastTimestamp: '2026-08-01T15:30:00.000Z',
      archived: false,
    },
    [{
      turnIndex: 0, turnId: 'same-slug-turn-0', model: 'gpt-placeholder-sol', reasoningEffort: 'high',
      inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0,
      outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 1050,
      timestamp: '2026-08-01T15:10:00.000Z',
    }],
  );
  // Unfiltered, both sessions are on the leaderboard under the same slug.
  const unfiltered = store.usageSessions(RANGE).sessions
    .filter((session) => session.profileSlug === 'profile-one');
  assert.deepEqual(
    unfiltered.map((session) => [session.provider, session.sessionId]).sort(),
    [['claude', 'sess-big'], ['codex', 'codex-same-slug']],
  );

  // Filtering by the CLAUDE account on that slug returns transcript sessions
  // only — the identically-slugged Codex rollout is not that account's traffic
  // and must not be counted against it (it would also carry accountId null).
  const claudeAccount = store.saveAccount({
    provider: 'claude', label: 'Placeholder Shared Slug Claude',
    identity: 'shared-claude@example.com', profileRef: '/placeholder/claude-profiles/profile-one',
  });
  const claudeScoped = store.usageSessions({ ...RANGE, accountId: claudeAccount.id });
  assert.deepEqual(claudeScoped.sessions.map((session) => session.provider), ['claude']);
  assert.deepEqual(claudeScoped.sessions.map((session) => session.sessionId), ['sess-big']);
  assert.equal(claudeScoped.sessions.every((session) => session.accountId === claudeAccount.id), true);

  // And the mirror case: the Codex account on the same slug sees only the
  // rollout, never the transcript session.
  // A Codex account is validated against a real CODEX_HOME, so the colliding
  // profile directory exists inside the test's throwaway root — deliberately
  // sharing its basename with the Claude profile above.
  const codexProfileRef = path.join(root, 'codex-profiles', 'profile-one');
  fs.mkdirSync(codexProfileRef, { recursive: true, mode: 0o700 });
  const codexAccount = store.saveAccount({
    provider: 'codex', label: 'Placeholder Shared Slug Codex',
    identity: 'shared-codex@example.com', profileRef: codexProfileRef,
  });
  const codexScoped = store.usageSessions({ ...RANGE, accountId: codexAccount.id });
  assert.deepEqual(codexScoped.sessions.map((session) => session.provider), ['codex']);
  assert.deepEqual(codexScoped.sessions.map((session) => session.sessionId), ['codex-same-slug']);

  // A provider filter that contradicts the account's provider yields nothing
  // rather than falling back to the bare slug.
  assert.deepEqual(
    store.usageSessions({ ...RANGE, accountId: claudeAccount.id, provider: 'codex' }).sessions,
    [],
  );
});

test('the limit caps the list and the response says when it clipped', (t) => {
  const { store } = fixture(t);
  seed(store);
  const capped = store.usageSessions({ ...RANGE, limit: 2 });
  assert.equal(capped.sessions.length, 2);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.sessions.map((session) => session.sessionId), ['sess-big', 'codex-one']);
  assert.equal(store.usageSessions({ ...RANGE, limit: 25 }).truncated, false);
});

// ---- lane-issue tagging (heuristic) ---------------------------------------

const MANIFEST_LINES = [
  { issue: 347, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'medium', phase: 'launched', pid: 111, log: '/logs/issue-347-a.log', ts: '2026-08-01T13:00:00Z' },
  { issue: 347, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'medium', phase: 'exited', pid: 111, log: '/logs/issue-347-a.log', ts: '2026-08-01T14:00:00Z', exit: 0 },
  // A run that never recorded an exit: its window is capped, and any tag it
  // produces is ambiguous by construction.
  { issue: 999, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'high', phase: 'launched', pid: 222, log: '/logs/issue-999-a.log', ts: '2026-08-03T09:00:00Z' },
  // A Claude-runner lane, which can never explain a Codex session.
  { issue: 500, runner: 'claude', model: 'fable', effort: 'high', phase: 'launched', pid: 333, log: '/logs/issue-500-a.log', ts: '2026-08-01T13:15:00Z' },
  { issue: 500, runner: 'claude', model: 'fable', effort: 'high', phase: 'exited', pid: 333, log: '/logs/issue-500-a.log', ts: '2026-08-01T13:45:00Z', exit: 0 },
];

function writeManifest(root, lines = MANIFEST_LINES) {
  const manifestPath = path.join(root, 'manifest.jsonl');
  fs.writeFileSync(manifestPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return manifestPath;
}

test('lane runs pair launched/exited records and survive junk lines', (t) => {
  const { root } = fixture(t);
  const runs = readLaneRuns(writeManifest(root));
  assert.deepEqual(runs.map((run) => [run.issue, run.startedAt, run.endedAt]), [
    [347, '2026-08-01T13:00:00.000Z', '2026-08-01T14:00:00.000Z'],
    [999, '2026-08-03T09:00:00.000Z', null],
    [500, '2026-08-01T13:15:00.000Z', '2026-08-01T13:45:00.000Z'],
  ]);

  // Enrichment must never fail a read: a missing file and a corrupt line are
  // both survivable.
  assert.deepEqual(readLaneRuns(path.join(root, 'no-such-manifest.jsonl')), []);
  assert.deepEqual(parseLaneRuns('not json\n{"phase":"exited","pid":9,"ts":"2026-08-01T00:00:00Z"}\n'), []);
  assert.deepEqual(parseLaneRuns(''), []);
});

test('lane tagging matches provider, time window and model/effort — always marked heuristic', (t) => {
  const { store, root } = fixture(t);
  seed(store);
  const runs = readLaneRuns(writeManifest(root));
  const sessions = tagSessionsWithLaneRuns(store.usageSessions(RANGE).sessions, runs);

  const codex = sessions.find((session) => session.provider === 'codex');
  assert.equal(codex.lane.issue, 347);
  assert.equal(codex.lane.heuristic, true, 'a manifest tag is never stated as fact');
  assert.equal(codex.lane.ambiguous, false);
  assert.equal(codex.lane.modelMatch, true);
  assert.equal(codex.lane.effortMatch, true);
  assert.equal(codex.lane.candidates, 1);

  // The Claude-runner lane overlapping the same window never claims a Codex
  // session, and the Claude sessions do not match a lane whose model they
  // never ran.
  for (const session of sessions.filter((row) => row.provider === 'claude')) {
    assert.equal(session.lane, null);
  }

  // An uncorroborated overlap is tagged but flagged ambiguous.
  const openRunSession = {
    provider: 'codex', firstAt: '2026-08-03T10:00:00.000Z', lastAt: '2026-08-03T11:00:00.000Z',
    models: ['gpt-placeholder-sol'], efforts: ['medium'],
  };
  const openTag = laneTagForSession(openRunSession, runs);
  assert.equal(openTag.issue, 999);
  assert.equal(openTag.heuristic, true);
  assert.equal(openTag.ambiguous, true, 'a run with no recorded exit is an ambiguous window');
  assert.equal(openTag.effortMatch, false);

  // Two lanes for different issues overlapping one session: still tagged, but
  // the ambiguity and the candidate issues travel with the tag.
  const overlapping = parseLaneRuns([
    { issue: 10, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'medium', phase: 'launched', pid: 1, log: '/logs/a.log', ts: '2026-08-01T13:00:00Z' },
    { issue: 10, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'medium', phase: 'exited', pid: 1, log: '/logs/a.log', ts: '2026-08-01T14:00:00Z' },
    { issue: 11, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'medium', phase: 'launched', pid: 2, log: '/logs/b.log', ts: '2026-08-01T13:05:00Z' },
    { issue: 11, runner: 'codex', model: 'gpt-placeholder-sol', effort: 'medium', phase: 'exited', pid: 2, log: '/logs/b.log', ts: '2026-08-01T13:55:00Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  const ambiguous = laneTagForSession(
    store.usageSessions({ ...RANGE, provider: 'codex' }).sessions[0], overlapping,
  );
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.candidates, 2);
  assert.deepEqual(ambiguous.candidateIssues, [10, 11]);

  // No manifest at all: rows come back untagged, never unlabelled-as-tagged.
  assert.equal(tagSessionsWithLaneRuns(store.usageSessions(RANGE).sessions, [])[0].lane, null);
});

// ---- route ----------------------------------------------------------------

test('GET /api/usage/sessions serves the leaderboard with lane tags attached', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-sessions-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = writeManifest(root);
  const data = fixture(t, { laneManifestPath: manifestPath });
  seed(data.store);

  const result = await request(data.app, '/api/usage/sessions?'
    + new URLSearchParams({ since: RANGE.since, until: RANGE.until }).toString());
  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'application/json; charset=utf-8');
  const payload = JSON.parse(result.body);
  assert.equal(payload.mode, 'leaderboard');
  assert.deepEqual(payload.sessions.map((session) => session.sessionId), ['sess-big', 'codex-one', 'sess-small']);
  assert.equal(payload.sessions.find((session) => session.provider === 'codex').lane.issue, 347);
  assert.equal(payload.sessions.find((session) => session.provider === 'codex').lane.heuristic, true);
  assert.equal(payload.truncated, false);

  const filtered = await request(data.app, '/api/usage/sessions?provider=codex&limit=1');
  assert.equal(filtered.status, 200);
  const filteredPayload = JSON.parse(filtered.body);
  assert.equal(filteredPayload.sessions.length, 1);
  assert.equal(filteredPayload.sessions[0].provider, 'codex');
});

test('GET /api/usage/sessions?sessionId= serves the detail read', async (t) => {
  const data = fixture(t);
  seed(data.store);
  const result = await request(data.app, '/api/usage/sessions?sessionId=sess-big&profile=profile-one');
  assert.equal(result.status, 200);
  const payload = JSON.parse(result.body);
  assert.equal(payload.mode, 'detail');
  assert.equal(payload.session.sessionId, 'sess-big');
  assert.equal(payload.session.totalTokens, 4000);
  assert.equal(payload.subagents.length, 1);
  assert.equal(payload.skills.length, 3);
  assert.equal(payload.contextTrend.length, 3);
  // An unknown session is an empty detail, not an error or a wrong session.
  const missing = await request(data.app, '/api/usage/sessions?sessionId=nope&profile=profile-one');
  assert.equal(missing.status, 200);
  assert.equal(JSON.parse(missing.body).session, null);
});

test('session explorer parameters are validated like every other reader param', async (t) => {
  const data = fixture(t);
  seed(data.store);

  assert.throws(() => data.store.usageSessions({ provider: 'anthropic' }), /usage sessions provider must be claude or codex/);
  assert.throws(() => data.store.usageSessions({ accountId: '   ' }), /usage sessions accountId must be a non-empty string/);
  assert.throws(() => data.store.usageSessions({ since: '2026-08-01' }), /usage sessions since must be a canonical ISO timestamp/);
  assert.throws(
    () => data.store.usageSessions({ since: RANGE.until, until: RANGE.since }),
    /usage sessions since must be earlier than until/,
  );
  assert.throws(() => data.store.usageSessions({ limit: 0 }), /usage sessions limit must be an integer between 1 and 200/);
  assert.throws(() => data.store.usageSessions({ limit: 201 }), /usage sessions limit must be an integer between 1 and 200/);
  assert.throws(() => data.store.usageSessions({ limit: 'many' }), /usage sessions limit must be an integer between 1 and 200/);
  assert.throws(() => data.store.usageSessionDetail({ sessionId: 'sess-big' }), /usage sessions profile is required/);

  const badProvider = await request(data.app, '/api/usage/sessions?provider=gemini');
  assert.equal(badProvider.status, 400);
  assert.deepEqual(JSON.parse(badProvider.body), { error: 'usage sessions provider must be claude or codex' });

  const badLimit = await request(data.app, '/api/usage/sessions?limit=999');
  assert.equal(badLimit.status, 400);
  assert.deepEqual(JSON.parse(badLimit.body), { error: 'usage sessions limit must be an integer between 1 and 200' });

  const badDetail = await request(data.app, '/api/usage/sessions?sessionId=sess-big');
  assert.equal(badDetail.status, 400);
  assert.deepEqual(JSON.parse(badDetail.body), { error: 'usage sessions profile is required' });

  // Same Host gate as every other route.
  const rejected = await request(data.app, '/api/usage/sessions', { host: 'attacker.example' });
  assert.equal(rejected.status, 403);
  assert.deepEqual(JSON.parse(rejected.body), { error: 'unexpected host header' });
});

test('GET /api/usage/sessions is 404 while the analytics flag is off (issue #359 gate)', async (t) => {
  const data = fixture(t, { usageAnalyticsEnabled: false });
  seed(data.store);

  // Byte-identical to a route that never existed: status, headers and body.
  const unknown = await request(data.app, '/api/route-that-never-existed');
  for (const route of [
    '/api/usage/sessions',
    '/api/usage/sessions?since=' + RANGE.since + '&until=' + RANGE.until,
    '/api/usage/sessions?sessionId=sess-big&profile=profile-one',
    // An invalid parameter must not leak a 400 validation message either —
    // while the flag is off the gate answers before the reader is reached.
    '/api/usage/sessions?provider=gemini',
  ]) {
    const result = await request(data.app, route);
    assert.equal(result.status, 404);
    assert.deepEqual(result, unknown);
  }

  // Turning the flag on opens the same route in the same process.
  data.store.saveSettings({ usageAnalyticsEnabled: true });
  const opened = await request(data.app, '/api/usage/sessions');
  assert.equal(opened.status, 200);
  assert.equal(JSON.parse(opened.body).mode, 'leaderboard');

  // And turning it back off closes it again.
  data.store.saveSettings({ usageAnalyticsEnabled: false });
  assert.equal((await request(data.app, '/api/usage/sessions')).status, 404);
});
