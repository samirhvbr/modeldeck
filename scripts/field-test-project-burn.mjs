// Throwaway field-test harness for issue #346: boots the daemon HTTP app on a
// scratch database seeded with PLACEHOLDER Claude transcript sessions and Codex
// rollouts across several synthetic projects, with the usage-analytics flag on,
// so the project burn view can be clicked in a browser. Never touches the real
// ModelDeck database, profiles, or lane manifest. Not part of npm test.
//
// Follows scripts/field-test-session-explorer.mjs: seed a scratch DB, probe the
// endpoints the view will call through the request pipeline, print a seeded
// CHECK, then listen. The check runs for an EMPTY leaderboard too — the URL
// line is always reached, so "nothing seeded" can never look like "server
// never started".
//
// Decision 13 is the thing to look at here: ONE placeholder account is seeded
// with enough snapshot/token history to fit a window-burn model, and a second
// is deliberately left unfitted, so both an 'est.' figure with its fit quality
// and an "estimate unavailable — <reason>" row are on screen at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { refitUsageEstimates } from '../src/usage-estimate.mjs';

const PORT = Number(process.env.FIELD_PORT || 43396);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-field-346-'));
const store = new Store(path.join(root, 'modeldeck.sqlite'));
store.saveSettings({ usageAnalyticsEnabled: true });

const now = Date.now();
const at = (hoursAgo, minutes = 0) => new Date(now - hoursAgo * 3600 * 1000 + minutes * 60000).toISOString();

// Deterministic (seeded LCG), no real data.
let seed = 20260811;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// Codex accounts are validated against a real CODEX_HOME directory, so the
// scratch profile directories exist inside the throwaway root.
const PROFILE_DIRS = {
  fitted: path.join(root, 'claude-profiles', 'placeholder-fitted'),
  unfitted: path.join(root, 'claude-profiles', 'placeholder-unfitted'),
  codex: path.join(root, 'codex-profiles', 'placeholder-codex-one'),
};
for (const directory of Object.values(PROFILE_DIRS)) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const fittedAccount = store.saveAccount({
  provider: 'claude',
  label: 'Placeholder Claude (fitted)',
  identity: 'placeholder-fitted@example.com',
  profileRef: PROFILE_DIRS.fitted,
});
const unfittedAccount = store.saveAccount({
  provider: 'claude',
  label: 'Placeholder Claude (no fit)',
  identity: 'placeholder-unfitted@example.com',
  profileRef: PROFILE_DIRS.unfitted,
});
const codexAccount = store.saveAccount({
  provider: 'codex',
  label: 'Placeholder Codex One',
  identity: 'placeholder-codex@example.com',
  profileRef: PROFILE_DIRS.codex,
});
const accounts = [fittedAccount, unfittedAccount, codexAccount];

// Four project identities, including one session family with NO cwd at all so
// the 'unattributed' bucket is visible rather than theoretical.
const PROJECTS = [
  ['/placeholder/projects/alpha', 'lane/placeholder-alpha', 'placeholder-fitted'],
  ['/placeholder/projects/beta', 'main', 'placeholder-fitted'],
  ['/placeholder/projects/gamma', 'lane/placeholder-gamma', 'placeholder-unfitted'],
  [null, null, 'placeholder-fitted'],
];

const sessions = [];
const requests = [];
for (let index = 0; index < 12; index += 1) {
  const project = PROJECTS[index % PROJECTS.length];
  const sessionId = 'placeholder-session-' + String(index + 1).padStart(2, '0');
  const startedHoursAgo = 3 + index * 5;
  sessions.push({
    sessionId,
    profileSlug: project[2],
    machine: 'placeholder-machine',
    cwd: project[0],
    gitBranch: project[1],
    entrypoint: 'cli',
    clientVersion: '0.0.0-placeholder',
    firstAt: at(startedHoursAgo),
    lastAt: at(startedHoursAgo - 1),
    title: 'Placeholder session ' + (index + 1),
    titleSource: 'last-prompt',
  });
  const turns = 5 + Math.round(rand() * 14);
  let context = 20000 + Math.round(rand() * 40000);
  for (let turn = 0; turn < turns; turn += 1) {
    context += Math.round(3000 + rand() * 14000);
    requests.push({
      dedupeKey: 'message:' + sessionId + ':' + turn,
      requestId: null,
      sessionId,
      profileSlug: project[2],
      messageId: 'msg-' + sessionId + '-' + turn,
      recordUuid: null,
      model: rand() < 0.75 ? 'claude-placeholder-workhorse' : 'claude-placeholder-small',
      effort: null,
      observedAt: at(startedHoursAgo, turn * 6),
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
}
store.ingestTranscriptBatch({ sessions, requests });

// Codex rollouts in two of the same projects, so a project row shows both
// providers and the Codex side is visibly unestimated (no fitted model).
for (let index = 0; index < 4; index += 1) {
  const project = PROJECTS[index % 2];
  const sessionId = 'placeholder-codex-' + String(index + 1).padStart(2, '0');
  const startedHoursAgo = 5 + index * 8;
  const turnCount = 4 + Math.round(rand() * 8);
  const turns = [];
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
    cwd: project[0],
    originator: 'codex_cli_rs',
    source: 'sessions',
    cliVersion: '0.0.0-placeholder',
    gitBranch: project[1],
    gitRepo: 'placeholder/repo',
    gitCommit: 'deadbeef',
    firstTimestamp: at(startedHoursAgo),
    lastTimestamp: at(startedHoursAgo, turnCount * 5),
    archived: false,
  }, turns);
}

// ---- Decision 13 fixture -------------------------------------------------
// Snapshots plus proxy-observed requests for ONE account, consistent enough to
// fit: each interval's utilization movement is a fixed linear function of that
// interval's token classes, which is exactly what the model claims to learn.
const WEIGHTS = { uncached: 8e-6, cacheRead: 2e-7, cacheWrite: 3e-6, output: 4e-5 };
const resetsAt = new Date(now + 4 * 3600 * 1000).toISOString();
let usedPercent = 4;
const proxyRecords = [];
for (let step = 24; step >= 0; step -= 1) {
  const observedAt = new Date(now - step * 1800 * 1000).toISOString();
  store.recordUsage(fittedAccount.id, {
    scope: 'weekly',
    source: 'field-placeholder',
    usedPercent: Math.min(99, Number(usedPercent.toFixed(4))),
    observedAt,
    resetsAt,
  });
  store.recordUsage(fittedAccount.id, {
    scope: '5-hour',
    source: 'field-placeholder',
    usedPercent: Math.min(99, Number((usedPercent * 1.5).toFixed(4))),
    observedAt,
    resetsAt,
  });
  if (step === 0) break;
  // The requests that will be attributed to the NEXT interval.
  const flows = {
    uncached: Math.round(2000 + rand() * 30000),
    cacheRead: Math.round(200000 + rand() * 900000),
    cacheWrite: Math.round(1000 + rand() * 20000),
    output: Math.round(500 + rand() * 9000),
  };
  const movement = flows.uncached * WEIGHTS.uncached + flows.cacheRead * WEIGHTS.cacheRead
    + flows.cacheWrite * WEIGHTS.cacheWrite + flows.output * WEIGHTS.output;
  usedPercent += movement;
  proxyRecords.push({
    requestId: 'field-346-' + step,
    machine: 'placeholder-machine',
    observedAt: new Date(now - step * 1800 * 1000 + 60000).toISOString(),
    source: 'placeholder-fitted@example.com',
    provider: 'claude',
    model: 'claude-placeholder-workhorse',
    reasoningEffort: 'high',
    endpoint: '/v1/placeholder',
    userAgentClass: 'claude-code',
    failed: false,
    statusCode: 200,
    latencyMs: 400,
    ttftMs: 90,
    inputUncached: flows.uncached,
    inputCacheRead: flows.cacheRead,
    inputCacheWrite: flows.cacheWrite,
    outputTotal: flows.output,
    outputReasoning: Math.round(flows.output * 0.4),
    total: flows.uncached + flows.cacheRead + flows.cacheWrite + flows.output,
  });
}
store.ingestRequestUsage(proxyRecords);
// The second Claude account gets snapshots but no proxy history, so its fit
// stays unavailable WITH A REASON — the state the field is in today.
for (let step = 6; step >= 0; step -= 1) {
  store.recordUsage(unfittedAccount.id, {
    scope: 'weekly',
    source: 'field-placeholder',
    usedPercent: 10 + step,
    observedAt: new Date(now - step * 1800 * 1000).toISOString(),
    resetsAt,
  });
}
const refit = refitUsageEstimates(store);

const service = {
  projectsRoot: root,
  startAutoRefresh() {},
  stopAutoRefresh() {},
  async state() {
    return { accounts: accounts.map((account) => ({ ...account, enabled: true })), usage: store.latestUsage() };
  },
};
const app = createApp({
  store,
  service,
  host: '127.0.0.1',
  port: PORT,
  mutationToken: 'field-placeholder-token',
  laneManifestPath: path.join(root, 'absent-manifest.jsonl'),
});

// Seeded-daemon check: drive the routes the view will call and report what they
// return, so "empty page" and "broken view" can never be confused.
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
const burn = await probe('/api/usage/projects?' + new URLSearchParams({ since, until, limit: '25' }));
const estimate = await probe('/api/usage/estimate?' + new URLSearchParams({ since, until }));
const projects = burn.projects || [];
const top = projects[0] || null;
// GUARD: every line below tolerates an empty leaderboard, so the URL line at
// the end is always reached (the sibling script's original bug).
const drill = top
  ? await probe('/api/usage/projects?' + new URLSearchParams({
    since, until, project: top.key, bucket: 'local_day',
  }))
  : { projects: [], series: [], sessions: { sessions: [] } };

const unattributed = projects.find((project) => project.unattributed) || null;
const fits = (estimate.accounts || []).flatMap((account) => (account.fits || []).map((fit) => ({
  label: account.accountLabel,
  scope: fit.scope,
  available: fit.weights != null,
  quality: fit.fitQuality,
  identifiability: fit.identifiability,
  reason: fit.reason,
})));

console.log('seeded check:');
console.log('  projects        : ' + projects.length
  + ' (' + projects.filter((project) => !project.unattributed).length + ' attributed, '
  + (unattributed ? '1 unattributed' : 'NO unattributed bucket') + ')');
console.log('  top project     : ' + (top
  ? (top.project || 'unattributed') + ' — ' + top.totalTokens.toLocaleString()
    + ' tokens over ' + top.sessions + ' sessions'
  : 'NONE — the project leaderboard came back empty'));
console.log('  unattributed    : ' + (unattributed
  ? unattributed.totalTokens.toLocaleString() + ' tokens over ' + unattributed.sessions + ' session(s)'
  : 'none seeded'));
const reconciliation = burn.reconciliation;
const reconciled = reconciliation.attributed.totalTokens + reconciliation.unattributed.totalTokens
  === reconciliation.sessionTotals.totalTokens;
if (!reconciled) process.exitCode = 1;
console.log('  reconciliation  : ' + (reconciled ? 'PASS — ' : 'FAIL — ')
  + 'attributed ' + reconciliation.attributed.totalTokens.toLocaleString()
  + ' + unattributed ' + reconciliation.unattributed.totalTokens.toLocaleString()
  + ' = ' + reconciliation.sessionTotals.totalTokens.toLocaleString()
  + ' · proxy warehouse (unattributable, reported only) '
  + reconciliation.warehouse.total.toLocaleString());
console.log('  drill-down      : ' + (drill.series || []).length + ' time buckets, '
  + ((drill.sessions && drill.sessions.sessions) || []).length + ' sessions');
console.log('  estimate model  : ' + refit.fitted + ' fitted / ' + refit.unavailable + ' unavailable');
for (const fit of fits) {
  console.log('    - ' + fit.label + ' / ' + fit.scope + ': ' + (fit.available
    ? 'ESTIMATE available (fit ' + (Math.round(fit.quality * 100) / 100) + ', ' + fit.identifiability + ')'
    : 'unavailable — ' + fit.reason));
}

app.listen(() => {
  console.log('');
  console.log('field test on http://127.0.0.1:' + PORT + '/dashboard  (db: ' + root + ')');
  console.log('click: Project burn tab → check each row\'s "Est. % of weekly window" cell carries');
  console.log('       either an est. label WITH fit quality, or a stated reason (never a bare number)');
  console.log('       → Provider select (Claude / Codex) → a row\'s Sessions button (burn over time,');
  console.log('       estimates, session list) → Data table → the Unattributed row');
});
