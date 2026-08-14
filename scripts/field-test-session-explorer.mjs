// Throwaway field-test harness for issue #347: boots the daemon HTTP app on a
// scratch database seeded with PLACEHOLDER Claude transcript sessions, Codex
// rollout sessions, and a synthetic lane manifest, with the usage-analytics
// flag on, so the session explorer can be clicked in a browser. Never touches
// the real ModelDeck database or the real lane manifest. Not part of npm test.
//
// Extends the scripts/field-test-burn-timeline.mjs pattern with a seeded-daemon
// CHECK: before printing the URL it calls its own /api/usage/sessions through
// the request pipeline and prints what the view will show, so an empty page is
// immediately distinguishable from a broken view.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

const PORT = Number(process.env.FIELD_PORT || 43397);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-field-347-'));
const store = new Store(path.join(root, 'modeldeck.sqlite'));
store.saveSettings({ usageAnalyticsEnabled: true });

const now = Date.now();
const at = (hoursAgo, minutes = 0) => new Date(now - hoursAgo * 3600 * 1000 + minutes * 60000).toISOString();

// Deterministic (seeded LCG), no real data.
let seed = 20260810;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// Codex accounts are validated against a real CODEX_HOME directory, so the
// scratch profile directories exist inside the throwaway root.
for (const directory of [
  path.join(root, 'claude-profiles', 'placeholder-profile-one'),
  path.join(root, 'codex-profiles', 'placeholder-codex-one'),
]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const accounts = [
  store.saveAccount({
    provider: 'claude', label: 'Placeholder Claude One',
    identity: 'placeholder-one@example.com',
    profileRef: path.join(root, 'claude-profiles', 'placeholder-profile-one'),
  }),
  store.saveAccount({
    provider: 'codex', label: 'Placeholder Codex One',
    identity: 'placeholder-codex@example.com',
    profileRef: path.join(root, 'codex-profiles', 'placeholder-codex-one'),
  }),
];

const SKILLS = ['dataviz', 'implement', 'adversarial-review', 'diagnose', 'handoff'];
const AGENT_TYPES = ['Explore', 'general-purpose', 'Plan', 'claude'];
const PROJECTS = [
  ['/placeholder/projects/alpha', 'lane/placeholder-alpha'],
  ['/placeholder/projects/beta', 'main'],
  ['/placeholder/projects/gamma', 'lane/placeholder-gamma'],
];

const sessions = [];
const requests = [];
const subagents = [];
const skills = [];
for (let index = 0; index < 9; index += 1) {
  const sessionId = 'placeholder-session-' + String(index + 1).padStart(2, '0');
  const project = PROJECTS[index % PROJECTS.length];
  const startedHoursAgo = 4 + index * 6;
  sessions.push({
    sessionId,
    profileSlug: 'placeholder-profile-one',
    machine: 'placeholder-machine',
    cwd: project[0],
    gitBranch: project[1],
    entrypoint: 'cli',
    clientVersion: '0.0.0-placeholder',
    firstAt: at(startedHoursAgo),
    lastAt: at(startedHoursAgo - 2),
    title: 'Placeholder session ' + (index + 1) + ' — ' + project[0].split('/').pop(),
    titleSource: index % 3 === 0 ? 'custom-title' : 'last-prompt',
  });

  // A growing context across the session, which is what the trend chart shows.
  const turns = 6 + Math.round(rand() * 18);
  let context = 20000 + Math.round(rand() * 30000);
  for (let turn = 0; turn < turns; turn += 1) {
    context += Math.round(4000 + rand() * 12000);
    requests.push({
      dedupeKey: 'message:' + sessionId + ':' + turn,
      requestId: null,
      sessionId,
      profileSlug: 'placeholder-profile-one',
      messageId: 'msg-' + sessionId + '-' + turn,
      recordUuid: null,
      model: rand() < 0.75 ? 'claude-placeholder-workhorse' : 'claude-placeholder-small',
      effort: null,
      observedAt: at(startedHoursAgo, turn * 7),
      inputTokens: Math.round(context * 0.04),
      cacheCreationInputTokens: Math.round(context * 0.06),
      cacheReadInputTokens: Math.round(context * 0.9),
      outputTokens: Math.round(400 + rand() * 3000),
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      isSidechain: false,
      agentId: null,
    });
  }

  // Every third session ran subagents. Their requests are rows in the SAME
  // session — the leaderboard must count them exactly once.
  if (index % 3 === 0) {
    const agentCount = 1 + Math.round(rand() * 2);
    for (let agent = 0; agent < agentCount; agent += 1) {
      const agentId = sessionId + '-agent-' + (agent + 1);
      let agentTokens = 0;
      const agentRequests = 2 + Math.round(rand() * 4);
      for (let turn = 0; turn < agentRequests; turn += 1) {
        const agentContext = 15000 + Math.round(rand() * 40000);
        const output = Math.round(300 + rand() * 1500);
        agentTokens += agentContext + output;
        requests.push({
          dedupeKey: 'message:' + agentId + ':' + turn,
          requestId: null,
          sessionId,
          profileSlug: 'placeholder-profile-one',
          messageId: 'msg-' + agentId + '-' + turn,
          recordUuid: null,
          model: 'claude-placeholder-small',
          effort: null,
          observedAt: at(startedHoursAgo, 30 + turn * 3),
          inputTokens: Math.round(agentContext * 0.05),
          cacheCreationInputTokens: Math.round(agentContext * 0.05),
          cacheReadInputTokens: Math.round(agentContext * 0.9),
          outputTokens: output,
          cacheCreationEphemeral5mInputTokens: 0,
          cacheCreationEphemeral1hInputTokens: 0,
          isSidechain: true,
          agentId,
        });
      }
      subagents.push({
        agentId,
        sessionId,
        profileSlug: 'placeholder-profile-one',
        agentType: AGENT_TYPES[(index + agent) % AGENT_TYPES.length],
        resolvedModel: 'claude-placeholder-small',
        totalTokens: agentTokens,
        toolStatsJson: JSON.stringify({ totalToolUseCount: 3 + Math.round(rand() * 20) }),
        durationMs: Math.round(30000 + rand() * 400000),
        observedAt: at(startedHoursAgo, 45),
      });
    }
  }

  const skillCount = Math.round(rand() * 3);
  for (let event = 0; event < skillCount; event += 1) {
    skills.push({
      eventKey: 'skill:' + sessionId + ':' + event,
      sessionId,
      profileSlug: 'placeholder-profile-one',
      skill: SKILLS[Math.floor(rand() * SKILLS.length)],
      commandName: null,
      observedAt: at(startedHoursAgo, 10 + event * 5),
    });
  }
}
store.ingestTranscriptBatch({ sessions, requests, subagents, skills });

// Codex rollouts, some of them inside a lane window so the heuristic tag has
// something to find, and one outside every window so "—" is visible too.
const laneRuns = [];
for (let index = 0; index < 5; index += 1) {
  const sessionId = 'placeholder-codex-' + String(index + 1).padStart(2, '0');
  const startedHoursAgo = 6 + index * 9;
  const turns = [];
  const turnCount = 4 + Math.round(rand() * 10);
  for (let turn = 0; turn < turnCount; turn += 1) {
    const input = 30000 + Math.round(rand() * 90000);
    const output = Math.round(500 + rand() * 4000);
    turns.push({
      turnIndex: turn,
      turnId: sessionId + '-turn-' + turn,
      model: 'gpt-placeholder-sol',
      reasoningEffort: index % 2 === 0 ? 'medium' : 'high',
      inputTokens: Math.round(input * 0.1),
      cachedInputTokens: Math.round(input * 0.9),
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: Math.round(output * 0.5),
      totalTokens: input + output,
      durationMs: Math.round(4000 + rand() * 60000),
      timeToFirstTokenMs: Math.round(200 + rand() * 3000),
      timestamp: at(startedHoursAgo, turn * 5),
    });
  }
  store.ingestCodexSession({
    sessionId,
    profileSlug: 'placeholder-codex-one',
    machine: 'placeholder-machine',
    cwd: PROJECTS[index % PROJECTS.length][0],
    originator: 'codex_cli_rs',
    source: 'sessions',
    cliVersion: '0.0.0-placeholder',
    gitBranch: PROJECTS[index % PROJECTS.length][1],
    gitRepo: 'placeholder/repo',
    gitCommit: 'deadbeef',
    firstTimestamp: at(startedHoursAgo),
    lastTimestamp: at(startedHoursAgo, turnCount * 5),
    archived: index === 4,
  }, turns);

  // Four of the five sit inside a lane run; the last one deliberately does not.
  if (index < 4) {
    const issue = 340 + index;
    laneRuns.push({
      issue, runner: 'codex', model: 'gpt-placeholder-sol',
      effort: index % 2 === 0 ? 'medium' : 'high',
      phase: 'launched', pid: 1000 + index,
      log: '/placeholder/logs/issue-' + issue + '.log',
      ts: at(startedHoursAgo, -5),
    });
    // One run is left unclosed on purpose, so an AMBIGUOUS tag is on screen.
    if (index !== 2) {
      laneRuns.push({
        issue, runner: 'codex', model: 'gpt-placeholder-sol',
        effort: index % 2 === 0 ? 'medium' : 'high',
        phase: 'exited', pid: 1000 + index,
        log: '/placeholder/logs/issue-' + issue + '.log',
        ts: at(startedHoursAgo, turnCount * 5 + 5), exit: 0,
      });
    }
  }
}
const laneManifestPath = path.join(root, 'lane-manifest.jsonl');
fs.writeFileSync(laneManifestPath, laneRuns.map((run) => JSON.stringify(run)).join('\n') + '\n');

// Window snapshots so the Account headroom tab still has something to draw.
for (const account of accounts) {
  for (let step = 0; step < 24; step += 1) {
    store.recordUsage(account.id, {
      scope: '5-hour',
      source: 'field-placeholder',
      usedPercent: Math.min(99, 15 + step * 2.5 + rand() * 4),
      observedAt: new Date(now - step * 1800 * 1000).toISOString(),
      resetsAt: new Date(now + 3 * 3600 * 1000).toISOString(),
    });
  }
}

const service = {
  projectsRoot: root,
  startAutoRefresh() {},
  stopAutoRefresh() {},
  async state() {
    return { accounts: accounts.map((account) => ({ ...account, enabled: true })), usage: store.latestUsage() };
  },
};
const app = createApp({
  store, service, host: '127.0.0.1', port: PORT,
  mutationToken: 'field-placeholder-token',
  laneManifestPath,
});

// Seeded-daemon check: drive the route the view will call and report what it
// returns, so "empty page" and "broken view" can never be confused.
async function probe(route) {
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: route, headers: { host: '127.0.0.1:' + PORT } });
  let payload;
  await app.server.listeners('request')[0](req, {
    writeHead() {},
    end(value) { payload = value == null ? null : String(value); },
  });
  return JSON.parse(payload);
}

const until = new Date(now + 60000).toISOString();
const since = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
const leaderboard = await probe('/api/usage/sessions?' + new URLSearchParams({ since, until, limit: '25' }));
const tagged = leaderboard.sessions.filter((session) => session.lane);
const withSubagents = leaderboard.sessions.filter((session) => session.subagents > 0);
const top = leaderboard.sessions[0];
const detail = top
  ? await probe('/api/usage/sessions?' + new URLSearchParams({
    sessionId: top.sessionId, profile: top.profileSlug, provider: top.provider,
  }))
  : { subagents: [], skills: [], contextTrend: [] };

console.log('seeded check:');
console.log('  sessions        : ' + leaderboard.sessions.length
  + ' (' + leaderboard.sessions.filter((session) => session.provider === 'claude').length + ' claude, '
  + leaderboard.sessions.filter((session) => session.provider === 'codex').length + ' codex)');
console.log('  top session     : ' + (top
  ? (top.title || top.sessionId) + ' — ' + top.totalTokens.toLocaleString()
    + ' tokens over ' + top.requests + ' requests'
  : 'NONE — the leaderboard came back empty'));
console.log('  lane-tagged     : ' + tagged.length + ' ('
  + tagged.filter((session) => session.lane.ambiguous).length + ' ambiguous) — issues '
  + ([...new Set(tagged.map((session) => '#' + session.lane.issue))].join(' ') || 'none'));
console.log('  with subagents  : ' + withSubagents.length
  + ' (subagent tokens are a SHARE of the row total, never added)');
console.log('  detail read     : ' + detail.subagents.length + ' subagents, '
  + detail.skills.length + ' skill rows, ' + detail.contextTrend.length + ' trend points');

app.listen(() => {
  console.log('');
  console.log('field test on http://127.0.0.1:' + PORT + '/dashboard  (db: ' + root + ')');
  console.log('click: Session explorer tab → sort select → a Detail button → Data table');
});
