// Issue #346: the project-burn reader, its route, and the honesty rules the
// view is built on. Contracts under test:
//   - issue #365's exact .claude/worktrees/<name> cwd folds into its parent
//     checkout without changing the token universe or widening an explicit
//     worktree-path filter;
//   - burn is grouped by the session's cwd across BOTH providers, and every
//     ingested token in the range lands in exactly one row: attributed
//     projects, the explicit 'unattributed' bucket, or the remainder of a
//     clipped list — never dropped;
//   - the response carries the proxy warehouse's own totals for the identical
//     bounds (straight from usageSummary), because those rows cannot be
//     attributed to a project per request (FINDINGS-336.md);
//   - transcript rows are keyed by (session_id, profile_slug) TOGETHER, so the
//     same session id under two profiles is two sessions in two projects;
//   - the drill-down is the session leaderboard narrowed to one project;
//   - every parameter is validated in the reader's established style and
//     surfaces as a 400 on the route, and the whole route is invisible while
//     usageAnalyticsEnabled is off;
//   - the estimate model the view consumes always reports a fit or a REASON,
//     never a bare number (decision 13).
// Placeholder identities and synthetic paths only — never real account data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store, PROJECT_BURN_UNATTRIBUTED } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { usageEstimateReport } from '../src/usage-estimate.mjs';

const PORT = 43346;
const TOKEN = 'project-burn-placeholder-token';
const RANGE = { since: '2026-08-01T00:00:00.000Z', until: '2026-08-02T00:00:00.000Z' };

function transcriptRequest({
  key, sessionId, profileSlug = 'profile-one', model = 'claude-placeholder',
  observedAt, input = 0, cacheCreate = 0, cacheRead = 0, output = 0,
}) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug,
    messageId: key,
    recordUuid: null,
    model,
    effort: null,
    observedAt,
    inputTokens: input,
    cacheCreationInputTokens: cacheCreate,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0,
    cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: false,
    agentId: null,
  };
}

function fixture(t, { usageAnalyticsEnabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-project-burn-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  if (!usageAnalyticsEnabled) store.saveSettings({ usageAnalyticsEnabled: false });
  const service = { projectsRoot: root, startAutoRefresh() {}, stopAutoRefresh() {} };
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: PORT,
    mutationToken: TOKEN,
    // A path that cannot exist: no test here reads the developer's manifest.
    laneManifestPath: path.join(root, 'absent-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store, root };
}

// Two projects on the Claude side (one of them ALSO used by Codex), one
// session with no recorded cwd, and — deliberately — the same session id under
// two different profiles, pointing at two different projects.
function seed(store) {
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder Claude One',
    identity: 'placeholder-one@example.com',
    profileRef: '/placeholder/profiles/profile-one',
  });
  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: 'sess-shared', profileSlug: 'profile-one', machine: 'placeholder-machine',
        cwd: '/placeholder/projects/alpha', gitBranch: 'main',
        firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-01T11:00:00.000Z',
      },
      // SAME session id, DIFFERENT profile, DIFFERENT project. Anything that
      // joins on session_id alone folds these two together.
      {
        sessionId: 'sess-shared', profileSlug: 'profile-two', machine: 'placeholder-machine',
        cwd: '/placeholder/projects/beta', gitBranch: 'lane/placeholder',
        firstAt: '2026-08-01T10:30:00.000Z', lastAt: '2026-08-01T10:45:00.000Z',
      },
      {
        sessionId: 'sess-nowhere', profileSlug: 'profile-one', machine: 'placeholder-machine',
        cwd: null, gitBranch: null,
        firstAt: '2026-08-01T12:00:00.000Z', lastAt: '2026-08-01T12:10:00.000Z',
      },
    ],
    requests: [
      transcriptRequest({
        key: 'alpha-1', sessionId: 'sess-shared', profileSlug: 'profile-one',
        observedAt: '2026-08-01T10:05:00.000Z', input: 100, cacheCreate: 50, cacheRead: 1000, output: 200,
      }),
      transcriptRequest({
        key: 'alpha-2', sessionId: 'sess-shared', profileSlug: 'profile-one',
        observedAt: '2026-08-01T10:55:00.000Z', input: 10, cacheCreate: 0, cacheRead: 2000, output: 90,
      }),
      // Same dedupe key as alpha-1 but a different profile: a genuinely
      // different request in a genuinely different project.
      transcriptRequest({
        key: 'alpha-1', sessionId: 'sess-shared', profileSlug: 'profile-two',
        observedAt: '2026-08-01T10:35:00.000Z', input: 5, cacheCreate: 0, cacheRead: 100, output: 20,
      }),
      transcriptRequest({
        key: 'nowhere-1', sessionId: 'sess-nowhere', profileSlug: 'profile-one',
        observedAt: '2026-08-01T12:05:00.000Z', input: 7, cacheCreate: 0, cacheRead: 0, output: 3,
      }),
    ],
  });
  store.ingestCodexSession(
    {
      sessionId: 'codex-one', profileSlug: 'codex-profile', machine: 'placeholder-machine',
      cwd: '/placeholder/projects/alpha', gitBranch: 'main',
      firstTimestamp: '2026-08-01T13:00:00.000Z', lastTimestamp: '2026-08-01T14:00:00.000Z',
      archived: false,
    },
    [{
      turnIndex: 0, turnId: 'turn-0', model: 'gpt-placeholder-sol', reasoningEffort: 'medium',
      inputTokens: 300, cachedInputTokens: 700, cacheWriteInputTokens: 0,
      outputTokens: 150, reasoningOutputTokens: 90, totalTokens: 1150,
      timestamp: '2026-08-01T13:10:00.000Z',
    }],
  );
  return { account };
}

const WORKTREE_PARENT = '/placeholder/deep/projects/parent-repo';
const WORKTREE_ONE = `${WORKTREE_PARENT}/.claude/worktrees/lane-one`;
const WORKTREE_TWO = `${WORKTREE_PARENT}/.claude/worktrees/lane-two`;
const CLAUDE_NON_WORKTREE = '/placeholder/deep/projects/no-fold/.claude/foo';

function seedWorktreeProjects(store) {
  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: 'sess-parent', profileSlug: 'profile-parent', machine: 'placeholder-machine',
        cwd: WORKTREE_PARENT, gitBranch: 'main',
        firstAt: '2026-08-01T09:00:00.000Z', lastAt: '2026-08-01T09:10:00.000Z',
      },
      {
        sessionId: 'sess-worktree-one', profileSlug: 'profile-worktree', machine: 'placeholder-machine',
        cwd: WORKTREE_ONE, gitBranch: 'lane/one',
        firstAt: '2026-08-01T09:20:00.000Z', lastAt: '2026-08-01T09:30:00.000Z',
      },
      {
        sessionId: 'sess-ordinary-claude-path', profileSlug: 'profile-ordinary', machine: 'placeholder-machine',
        cwd: CLAUDE_NON_WORKTREE, gitBranch: 'main',
        firstAt: '2026-08-01T09:40:00.000Z', lastAt: '2026-08-01T09:50:00.000Z',
      },
      {
        sessionId: 'sess-worktree-nowhere', profileSlug: 'profile-nowhere', machine: 'placeholder-machine',
        cwd: null, gitBranch: null,
        firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-01T10:10:00.000Z',
      },
    ],
    requests: [
      transcriptRequest({
        key: 'parent-request', sessionId: 'sess-parent', profileSlug: 'profile-parent',
        observedAt: '2026-08-01T09:05:00.000Z', input: 100,
      }),
      transcriptRequest({
        key: 'worktree-one-request', sessionId: 'sess-worktree-one', profileSlug: 'profile-worktree',
        observedAt: '2026-08-01T09:25:00.000Z', input: 200,
      }),
      transcriptRequest({
        key: 'ordinary-claude-path-request', sessionId: 'sess-ordinary-claude-path', profileSlug: 'profile-ordinary',
        observedAt: '2026-08-01T09:45:00.000Z', input: 40,
      }),
      transcriptRequest({
        key: 'worktree-nowhere-request', sessionId: 'sess-worktree-nowhere', profileSlug: 'profile-nowhere',
        observedAt: '2026-08-01T10:05:00.000Z', input: 50,
      }),
    ],
  });
  store.ingestCodexSession(
    {
      sessionId: 'codex-worktree-two', profileSlug: 'codex-worktree', machine: 'placeholder-machine',
      cwd: WORKTREE_TWO, gitBranch: 'lane/two',
      firstTimestamp: '2026-08-01T09:30:00.000Z', lastTimestamp: '2026-08-01T09:40:00.000Z',
      archived: false,
    },
    [{
      turnIndex: 0, turnId: 'worktree-turn', model: 'gpt-placeholder-sol', reasoningEffort: 'high',
      inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 100, reasoningOutputTokens: 20, totalTokens: 300,
      timestamp: '2026-08-01T09:35:00.000Z',
    }],
  );
}

async function request(app, route, { host = `127.0.0.1:${PORT}` } = {}) {
  const req = Readable.from([]);
  Object.assign(req, { socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: route, headers: { host } });
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

function keyed(burn) {
  return new Map(burn.projects.map((project) => [project.key, project]));
}

test('burn is grouped by project across both providers, with git branch as detail', (t) => {
  const { store } = fixture(t);
  seed(store);
  const burn = store.projectBurn(RANGE);
  const projects = keyed(burn);

  assert.deepEqual([...projects.keys()].sort(), [
    '/placeholder/projects/alpha',
    '/placeholder/projects/beta',
    PROJECT_BURN_UNATTRIBUTED,
  ]);

  // alpha: two Claude requests (1350 + 2100) plus one Codex turn (1150).
  const alpha = projects.get('/placeholder/projects/alpha');
  assert.equal(alpha.totalTokens, 1350 + 2100 + 1150);
  assert.equal(alpha.requests, 3);
  assert.equal(alpha.sessions, 2);
  assert.deepEqual(alpha.providers, ['claude', 'codex']);
  assert.equal(alpha.unattributed, false);
  // Branch is secondary detail on the row, not the project identity.
  assert.deepEqual(alpha.branches.map((branch) => [branch.provider, branch.gitBranch]), [
    ['claude', 'main'],
    ['codex', 'main'],
  ]);
  // Reasoning tokens exist only on the Codex side; Claude transcripts record
  // no split, so the figure is a stated 0 there rather than an inferred one.
  assert.equal(alpha.reasoningTokens, 90);

  // The estimate model's feature vector rides on every row and every account.
  assert.deepEqual(alpha.tokenFlows, {
    inputUncached: 110 + 300,
    inputCacheRead: 3000 + 700,
    inputCacheWrite: 50 + 0,
    outputTotal: 290 + 150,
  });
  assert.equal(alpha.inputTokens, 110 + 3000 + 50 + 300 + 700);

  // The Claude profile slug resolves to the account that owns that profile
  // directory; the Codex profile is on no account and says so with null.
  const claudeSide = alpha.accounts.find((entry) => entry.provider === 'claude');
  const codexSide = alpha.accounts.find((entry) => entry.provider === 'codex');
  assert.equal(claudeSide.accountLabel, 'Placeholder Claude One');
  assert.equal(codexSide.accountId, null);
  assert.equal(codexSide.accountLabel, null);
});

test('an exact worktree cwd folds into its parent project and keeps the worktree as detail', (t) => {
  const { store } = fixture(t);
  seedWorktreeProjects(store);

  const burn = store.projectBurn({ ...RANGE, project: WORKTREE_ONE, bucket: 'hour' });
  assert.deepEqual(burn.projects.map((project) => project.key), [WORKTREE_PARENT]);
  assert.equal(burn.projects[0].project, WORKTREE_PARENT);
  assert.equal(burn.projects[0].totalTokens, 200);
  assert.deepEqual(
    burn.projects[0].branches.map((branch) => [branch.gitBranch, branch.worktree]),
    [['lane/one', 'lane-one']],
  );
  assert.deepEqual([...new Set(burn.series.map((point) => point.key))], [WORKTREE_PARENT]);
  assert.equal(burn.series.reduce((sum, point) => sum + point.totalTokens, 0), 200);

  const [session] = burn.sessions.sessions;
  assert.equal(session.cwd, WORKTREE_ONE);
  assert.equal(session.project, WORKTREE_PARENT);
  assert.equal(session.worktree, 'lane-one');
});

test('the parent checkout and two worktrees aggregate into one project row', (t) => {
  const { store } = fixture(t);
  seedWorktreeProjects(store);

  const burn = store.projectBurn({ ...RANGE, bucket: 'hour' });
  const parent = keyed(burn).get(WORKTREE_PARENT);
  assert.equal(parent.totalTokens, 100 + 200 + 300);
  assert.equal(parent.requests, 3);
  assert.equal(parent.sessions, 3);
  assert.deepEqual(parent.providers, ['claude', 'codex']);
  assert.deepEqual(
    parent.branches.map((branch) => branch.worktree).filter(Boolean).sort(),
    ['lane-one', 'lane-two'],
  );
  assert.equal(
    burn.series.filter((point) => point.key === WORKTREE_PARENT)
      .reduce((sum, point) => sum + point.totalTokens, 0),
    parent.totalTokens,
  );
});

test('a path that merely contains .claude does not fold', (t) => {
  const { store } = fixture(t);
  seedWorktreeProjects(store);

  const ordinary = keyed(store.projectBurn(RANGE)).get(CLAUDE_NON_WORKTREE);
  assert.equal(ordinary.project, CLAUDE_NON_WORKTREE);
  assert.equal(ordinary.totalTokens, 40);
  assert.deepEqual(ordinary.branches.map((branch) => branch.worktree), [null]);
});

test('the parent project session filter includes worktrees while an explicit worktree stays narrow', (t) => {
  const { store } = fixture(t);
  seedWorktreeProjects(store);

  const parent = store.usageSessions({ ...RANGE, project: WORKTREE_PARENT });
  assert.deepEqual(
    parent.sessions.map((session) => session.sessionId).sort(),
    ['codex-worktree-two', 'sess-parent', 'sess-worktree-one'],
  );
  assert.equal(store.projectBurn({ ...RANGE, project: WORKTREE_PARENT }).projects[0].totalTokens, 600);

  const worktree = store.usageSessions({ ...RANGE, project: WORKTREE_TWO });
  assert.deepEqual(worktree.sessions.map((session) => session.sessionId), ['codex-worktree-two']);
  assert.equal(worktree.sessions[0].project, WORKTREE_PARENT);
  assert.equal(worktree.sessions[0].worktree, 'lane-two');
});

// The field has a SECOND checkout convention (<repo>/.worktrees/<name>) and
// session cwds nested below a worktree root; both must fold like the
// .claude/worktrees layout does.
test('the bare .worktrees convention and nested worktree cwds fold into the parent too', (t) => {
  const { store } = fixture(t);
  const BARE_PARENT = '/placeholder/deep/projects/bare-repo';
  const BARE_WORKTREE = `${BARE_PARENT}/.worktrees/issue-88-fix`;
  const NESTED_CWD = `${WORKTREE_PARENT}/.claude/worktrees/lane-nested/plugin`;
  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: 'sess-bare', profileSlug: 'profile-one', machine: 'placeholder-machine',
        cwd: BARE_WORKTREE, gitBranch: 'lane/bare',
        firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-01T11:00:00.000Z',
        title: 'Bare worktree session', titleSource: 'custom-title',
      },
      {
        sessionId: 'sess-nested', profileSlug: 'profile-one', machine: 'placeholder-machine',
        cwd: NESTED_CWD, gitBranch: 'lane/nested',
        firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-01T11:00:00.000Z',
        title: 'Nested cwd session', titleSource: 'custom-title',
      },
    ],
    requests: [
      transcriptRequest({
        key: 'bare-request', sessionId: 'sess-bare',
        observedAt: '2026-08-01T10:30:00.000Z', input: 70,
      }),
      transcriptRequest({
        key: 'nested-request', sessionId: 'sess-nested',
        observedAt: '2026-08-01T10:30:00.000Z', input: 80,
      }),
    ],
    subagents: [],
    skills: [],
  });

  const burn = store.projectBurn({ ...RANGE, bucket: 'hour' });
  const bare = keyed(burn).get(BARE_PARENT);
  assert.equal(bare.totalTokens, 70);
  assert.deepEqual(bare.branches.map((branch) => branch.worktree), ['issue-88-fix']);
  const nested = keyed(burn).get(WORKTREE_PARENT);
  assert.equal(nested.totalTokens, 80);
  assert.deepEqual(nested.branches.map((branch) => branch.worktree), ['lane-nested/plugin']);
  assert.deepEqual([...new Set(burn.series.map((point) => point.key))].sort(), [BARE_PARENT, WORKTREE_PARENT]);

  // The parent filter reaches both shapes; an explicit worktree path narrows
  // to that checkout including cwds nested below it.
  assert.deepEqual(
    store.usageSessions({ ...RANGE, project: BARE_PARENT }).sessions.map((s) => s.sessionId),
    ['sess-bare'],
  );
  assert.deepEqual(
    store.usageSessions({ ...RANGE, project: WORKTREE_PARENT }).sessions.map((s) => s.sessionId),
    ['sess-nested'],
  );
  assert.deepEqual(
    store.usageSessions({ ...RANGE, project: `${WORKTREE_PARENT}/.claude/worktrees/lane-nested` })
      .sessions.map((s) => s.sessionId),
    ['sess-nested'],
  );
});

test('folding preserves attributed, unattributed, listed, remainder, and total reconciliation', (t) => {
  const { store } = fixture(t);
  seedWorktreeProjects(store);

  const burn = store.projectBurn({ ...RANGE, limit: 1 });
  assert.deepEqual(burn.projects.map((project) => project.key), [WORKTREE_PARENT]);
  assert.equal(burn.projects[0].totalTokens, 600);
  assert.equal(burn.remainder.projects, 2);
  assert.equal(burn.remainder.totalTokens, 40 + 50);
  assert.equal(burn.totals.totalTokens, 600 + 40 + 50);
  assert.equal(
    burn.reconciliation.attributed.totalTokens + burn.reconciliation.unattributed.totalTokens,
    burn.totals.totalTokens,
  );
  assert.equal(burn.reconciliation.sessionTotals.totalTokens, burn.totals.totalTokens);
  assert.equal(
    burn.projects.reduce((sum, project) => sum + project.totalTokens, 0) + burn.remainder.totalTokens,
    burn.totals.totalTokens,
  );
});

test('traffic with no attributable cwd lands in the unattributed bucket, never dropped', (t) => {
  const { store } = fixture(t);
  seed(store);
  const burn = store.projectBurn(RANGE);
  const bucket = keyed(burn).get(PROJECT_BURN_UNATTRIBUTED);

  assert.equal(bucket.unattributed, true);
  assert.equal(bucket.project, null);
  assert.equal(bucket.requests, 1);
  assert.equal(bucket.totalTokens, 10);

  // Attributed + unattributed is the whole universe the reader measured.
  const totals = burn.totals;
  assert.equal(
    burn.reconciliation.attributed.totalTokens + burn.reconciliation.unattributed.totalTokens,
    totals.totalTokens,
  );
  assert.equal(burn.reconciliation.unattributed.totalTokens, 10);
  assert.equal(burn.reconciliation.sessionTotals.totalTokens, totals.totalTokens);

  // And the listed rows sum to exactly those totals.
  const summed = burn.projects.reduce((sum, project) => sum + project.totalTokens, 0);
  assert.equal(summed, totals.totalTokens);
  assert.equal(burn.truncated, false);
  assert.equal(burn.remainder, null);
});

test('the reader reports the proxy warehouse totals for the same bounds beside its own', (t) => {
  const { store } = fixture(t);
  seed(store);
  // Proxy-observed traffic for the same window. It carries no project and (per
  // FINDINGS-336.md) cannot be joined to a session per request, so it must be
  // REPORTED, never silently folded into a project or silently dropped.
  store.ingestRequestUsage([{
    requestId: 'proxy-1',
    machine: 'placeholder-machine',
    observedAt: '2026-08-01T10:06:00.000Z',
    source: 'placeholder-one@example.com',
    provider: 'claude',
    model: 'claude-placeholder',
    reasoningEffort: null,
    endpoint: '/v1/placeholder',
    userAgentClass: 'claude-code',
    failed: false,
    statusCode: 200,
    latencyMs: 10,
    ttftMs: 1,
    inputUncached: 100,
    inputCacheRead: 1000,
    inputCacheWrite: 50,
    outputTotal: 200,
    outputReasoning: 0,
    total: 1350,
  }]);

  for (const provider of [null, 'claude', 'codex']) {
    const burn = store.projectBurn({ ...RANGE, provider });
    const summary = store.usageSummary({ ...RANGE, provider });
    assert.deepEqual(
      burn.reconciliation.warehouse,
      { ...summary.totals },
      'warehouse block equals usageSummary totals for provider ' + provider,
    );
    // Still self-consistent under a provider filter.
    assert.equal(
      burn.projects.reduce((sum, project) => sum + project.totalTokens, 0),
      burn.totals.totalTokens,
    );
  }

  const burn = store.projectBurn(RANGE);
  assert.equal(burn.reconciliation.requestLevelJoinAvailable, false);
  assert.match(burn.reconciliation.note, /carries no project/);
  // The two universes are stated separately: the warehouse row is not part of
  // any project total.
  assert.equal(burn.reconciliation.warehouse.total, 1350);
  assert.notEqual(burn.reconciliation.warehouse.total, burn.totals.totalTokens);
});

test('one session id under two profiles is two sessions in two projects', (t) => {
  const { store } = fixture(t);
  seed(store);
  const burn = store.projectBurn(RANGE);
  const projects = keyed(burn);

  const alpha = projects.get('/placeholder/projects/alpha');
  const beta = projects.get('/placeholder/projects/beta');
  // Both rows carry the session id 'sess-shared', under different profiles.
  assert.equal(beta.requests, 1);
  assert.equal(beta.totalTokens, 125);
  assert.deepEqual(beta.accounts.map((entry) => entry.profileSlug), ['profile-two']);
  assert.deepEqual(alpha.accounts.filter((entry) => entry.provider === 'claude')
    .map((entry) => entry.profileSlug), ['profile-one']);
  // Session counts are per (session_id, profile_slug), so the shared id counts
  // once in each project rather than once overall or twice in one.
  assert.equal(beta.sessions, 1);
  assert.equal(alpha.accounts.find((entry) => entry.provider === 'claude').sessions, 1);

  // The drill-down inherits the same composite key.
  const drill = store.projectBurn({ ...RANGE, project: '/placeholder/projects/beta' });
  assert.deepEqual(
    drill.sessions.sessions.map((session) => [session.sessionId, session.profileSlug]),
    [['sess-shared', 'profile-two']],
  );
});

test('the drill-down is the session leaderboard narrowed to one project', (t) => {
  const { store } = fixture(t);
  seed(store);

  const alpha = store.projectBurn({ ...RANGE, project: '/placeholder/projects/alpha' });
  assert.equal(alpha.project, '/placeholder/projects/alpha');
  assert.deepEqual(
    alpha.sessions.sessions.map((session) => [session.provider, session.sessionId]).sort(),
    [['claude', 'sess-shared'], ['codex', 'codex-one']].sort(),
  );
  // The narrowed read agrees with the same query on the sessions reader.
  const direct = store.usageSessions({ ...RANGE, project: '/placeholder/projects/alpha' });
  assert.deepEqual(
    alpha.sessions.sessions.map((session) => session.totalTokens),
    direct.sessions.map((session) => session.totalTokens),
  );
  // And the project row itself is only that project.
  assert.deepEqual(alpha.projects.map((project) => project.key), ['/placeholder/projects/alpha']);

  // The unattributed bucket drills down like any other project key.
  const nowhere = store.projectBurn({ ...RANGE, project: PROJECT_BURN_UNATTRIBUTED });
  assert.deepEqual(nowhere.projects.map((project) => project.key), [PROJECT_BURN_UNATTRIBUTED]);
  assert.deepEqual(
    nowhere.sessions.sessions.map((session) => session.sessionId),
    ['sess-nowhere'],
  );

  // Without a project, there is no drill-down payload at all.
  assert.equal(store.projectBurn(RANGE).sessions, null);
});

test('a clipped project list reports its remainder instead of dropping tokens', (t) => {
  const { store } = fixture(t);
  seed(store);
  const burn = store.projectBurn({ ...RANGE, limit: 1 });

  assert.equal(burn.projects.length, 1);
  assert.equal(burn.truncated, true);
  assert.equal(burn.remainder.projects, 2);
  assert.equal(
    burn.projects[0].totalTokens + burn.remainder.totalTokens,
    burn.totals.totalTokens,
  );
});

test('per-project burn over time buckets in local wall-clock keys', (t) => {
  const { store } = fixture(t);
  seed(store);
  const burn = store.projectBurn({ ...RANGE, bucket: 'local_day' });
  assert.equal(burn.bucket, 'local_day');
  assert.equal(Array.isArray(burn.series), true);

  // Every series row belongs to a project the leaderboard also lists, and the
  // per-project series sums to that project's total.
  const byProject = new Map();
  for (const point of burn.series) {
    assert.match(point.bucket, /^\d{4}-\d{2}-\d{2}$/);
    byProject.set(point.key, (byProject.get(point.key) || 0) + point.totalTokens);
  }
  for (const project of burn.projects) {
    assert.equal(byProject.get(project.key), project.totalTokens, project.key + ' series reconciles');
  }

  const hourly = store.projectBurn({ ...RANGE, bucket: 'hour' });
  for (const point of hourly.series) assert.match(point.bucket, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
  assert.equal(store.projectBurn(RANGE).series, null);
});

test('the provider filter narrows both halves of the response together', (t) => {
  const { store } = fixture(t);
  seed(store);

  const claude = store.projectBurn({ ...RANGE, provider: 'claude' });
  assert.deepEqual(claude.projects.map((project) => project.providers).flat(), ['claude', 'claude', 'claude']);
  assert.equal(claude.totals.totalTokens, 1350 + 2100 + 125 + 10);

  const codex = store.projectBurn({ ...RANGE, provider: 'codex' });
  assert.deepEqual(codex.projects.map((project) => project.key), ['/placeholder/projects/alpha']);
  assert.equal(codex.totals.totalTokens, 1150);
});

test('the half-open range excludes the upper bound exactly like every other reader', (t) => {
  const { store } = fixture(t);
  seed(store);
  const upToCodex = store.projectBurn({
    since: '2026-08-01T00:00:00.000Z', until: '2026-08-01T13:10:00.000Z',
  });
  assert.equal(upToCodex.range.endExclusive, true);
  // The Codex turn sits exactly on the upper bound, so it is excluded.
  assert.equal(keyed(upToCodex).get('/placeholder/projects/alpha').totalTokens, 1350 + 2100);

  const inclusive = store.projectBurn({
    since: '2026-08-01T00:00:00.000Z', until: '2026-08-01T13:10:00.001Z',
  });
  assert.equal(keyed(inclusive).get('/placeholder/projects/alpha').totalTokens, 1350 + 2100 + 1150);
});

test('every project burn parameter is validated in the reader style', (t) => {
  const { store } = fixture(t);
  seed(store);

  assert.throws(() => store.projectBurn({ since: '2026-08-01' }), /project burn since must be a canonical ISO timestamp/);
  assert.throws(() => store.projectBurn({ until: 'not-a-time' }), /project burn until must be a canonical ISO timestamp/);
  assert.throws(
    () => store.projectBurn({ since: RANGE.until, until: RANGE.since }),
    /project burn since must be earlier than until/,
  );
  assert.throws(() => store.projectBurn({ provider: 'anthropic' }), /project burn provider must be claude or codex/);
  assert.throws(() => store.projectBurn({ provider: '   ' }), /project burn provider must be a non-empty string/);
  assert.throws(() => store.projectBurn({ project: '   ' }), /project burn project must be a non-empty string/);
  assert.throws(() => store.projectBurn({ bucket: 'week' }), /project burn bucket must be local_day or hour/);
  assert.throws(() => store.projectBurn({ limit: 0 }), /project burn limit must be an integer between 1 and 200/);
  assert.throws(() => store.projectBurn({ limit: 201 }), /project burn limit must be an integer between 1 and 200/);
  assert.throws(() => store.projectBurn({ limit: 2.5 }), /project burn limit must be an integer between 1 and 200/);
  // An absent limit is the default, not an error.
  assert.equal(store.projectBurn({ limit: null }).limit, 25);
  assert.equal(store.projectBurn({ limit: '' }).limit, 25);
  // A project nobody used is an empty list, not a throw.
  const missing = store.projectBurn({ ...RANGE, project: '/placeholder/projects/absent' });
  assert.deepEqual(missing.projects, []);
  assert.equal(missing.totals.totalTokens, 0);
  assert.deepEqual(missing.sessions.sessions, []);
});

test('GET /api/usage/projects serves the reader and surfaces its errors as 400s', async (t) => {
  const data = fixture(t);
  seed(data.store);

  const ok = await request(data.app, '/api/usage/projects?' + new URLSearchParams({
    since: RANGE.since, until: RANGE.until,
  }));
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.projects.length, 3);
  assert.equal(body.totals.totalTokens, 1350 + 2100 + 1150 + 125 + 10);
  assert.equal(body.sessions, null);
  assert.equal(body.reconciliation.requestLevelJoinAvailable, false);

  const drill = await request(data.app, '/api/usage/projects?' + new URLSearchParams({
    since: RANGE.since, until: RANGE.until, project: '/placeholder/projects/alpha', bucket: 'local_day',
  }));
  assert.equal(drill.status, 200);
  const drilled = JSON.parse(drill.body);
  assert.equal(drilled.sessions.sessions.length, 2);
  // Drill-down sessions travel through the same lane tagging the session
  // explorer applies (no manifest here, so every row is explicitly untagged).
  assert.deepEqual([...new Set(drilled.sessions.sessions.map((session) => session.lane))], [null]);
  assert.equal(drilled.series.length > 0, true);

  for (const [query, message] of [
    ['provider=gemini', 'project burn provider must be claude or codex'],
    ['project=', 'project burn project must be a non-empty string'],
    ['bucket=fortnight', 'project burn bucket must be local_day or hour'],
    ['limit=0', 'project burn limit must be an integer between 1 and 200'],
    ['since=2026-08-01', 'project burn since must be a canonical ISO timestamp'],
  ]) {
    const bad = await request(data.app, '/api/usage/projects?' + query);
    assert.equal(bad.status, 400, query);
    assert.deepEqual(JSON.parse(bad.body), { error: message });
  }
});

test('GET /api/usage/projects is invisible while the analytics flag is off', async (t) => {
  const data = fixture(t, { usageAnalyticsEnabled: false });
  seed(data.store);

  const unknown = await request(data.app, '/api/route-that-never-existed');
  for (const route of [
    '/api/usage/projects',
    '/api/usage/projects?since=' + RANGE.since + '&until=' + RANGE.until,
    // Even a request that WOULD be a 400 must be indistinguishable.
    '/api/usage/projects?provider=gemini',
  ]) {
    const result = await request(data.app, route);
    assert.equal(result.status, 404);
    assert.deepEqual(result, unknown);
  }

  // Flipping the flag on opens it in the same process.
  data.store.saveSettings({ usageAnalyticsEnabled: true });
  const opened = await request(data.app, '/api/usage/projects');
  assert.equal(opened.status, 200);
});

test('decision 13: pool fits are exposed only for measured-total apportionment', async (t) => {
  const data = fixture(t);
  seed(data.store);

  // The field state today: no snapshots have been fitted, so every scope must
  // report a REASON. A null estimate with no reason would let the view print a
  // bare number or a blank cell.
  const report = usageEstimateReport(data.store, RANGE);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.pools.length, 1);
  assert.deepEqual(report.pools[0].fits.map((fit) => fit.scope), ['weekly', '5-hour']);
  for (const account of report.accounts) {
    assert.deepEqual(account.fits.map((fit) => fit.scope), ['weekly', '5-hour']);
    for (const fit of account.fits) {
      assert.equal(fit.weights, null);
      assert.equal(typeof fit.reason, 'string');
      assert.notEqual(fit.reason, '');
      assert.equal(fit.fitQuality, null);
      assert.equal(typeof fit.identifiability, 'string');
    }
    assert.equal(account.estimates, null);
  }

  // The route the view actually calls agrees.
  const response = await request(data.app, '/api/usage/estimate?' + new URLSearchParams({
    since: RANGE.since, until: RANGE.until,
  }));
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.accounts[0].fits.every((fit) => fit.weights == null && fit.reason), true);
  assert.equal(payload.pools[0].fits.every((fit) => fit.weights == null && fit.reason), true);

  // The project rows carry the per-account token flows the view multiplies by
  // those weights, so an estimate is never derived from a mixed-account total.
  const burn = data.store.projectBurn(RANGE);
  for (const project of burn.projects) {
    for (const account of project.accounts) {
      assert.deepEqual(Object.keys(account.tokenFlows).sort(), [
        'inputCacheRead', 'inputCacheWrite', 'inputUncached', 'outputTotal',
      ]);
    }
    const summedFlows = project.accounts.reduce(
      (sum, account) => sum + account.tokenFlows.inputUncached + account.tokenFlows.inputCacheRead
        + account.tokenFlows.inputCacheWrite + account.tokenFlows.outputTotal,
      0,
    );
    assert.equal(
      summedFlows,
      project.tokenFlows.inputUncached + project.tokenFlows.inputCacheRead
        + project.tokenFlows.inputCacheWrite + project.tokenFlows.outputTotal,
    );
  }
});
