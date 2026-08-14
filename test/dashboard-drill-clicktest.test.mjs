// Issue #386 — the project drill and the session anatomy page, CLICK-TESTED in
// a real DOM against the REAL daemon readers (the fetch stub calls the app's own
// request listener), so these clicks also prove the drill's queries pass slice
// 2's parameter validation.
//
// THE NAMED TRIPWIRES of this slice, each held on the drawn page rather than on
// the source. Two came with the build; three were added for the review findings
// on PR #393, so each of those fixes has a check that would catch it coming back.
//
//   TRIPWIRE 1 — 'the drill headline is the landing's own figure, and every
//   block under it sums to that headline under every dimension'. The failure it
//   guards is the one the decider checks by hand: a drill that recomputes a
//   project's burn its own way prints a number the block he clicked did not,
//   and a dimension switch that re-rounds each block independently prints a
//   column that does not add up. VERIFIED TO FAIL by (a) replacing
//   ProjectDrill's projectTotal with its own token-share sum instead of
//   model.js's projectValueSeries — 0.29 != 0.19 — and (b) rounding the map's
//   blocks independently instead of largest-remainder — 0.20 vs 0.19.
//
//   TRIPWIRE 2 — 'the anatomy page partitions the session figure the drill
//   printed'. The timeline columns and the composition blocks each sum to that
//   one figure. VERIFIED TO FAIL by rounding the composition blocks
//   independently (Math.round per block) instead of largest-remainder to the
//   session's printed value — 0.13 vs 0.14.
//
//   TRIPWIRE stale-route — 'a drill entry from another range is not a level to
//   return to'. Changing the range replaces the entry the reader is ON, never
//   the ones behind or in front of it, and a route is nothing but keys that name
//   nothing under a different range. VERIFIED TO FAIL by having useRoute's
//   popstate accept any stored route regardless of its stamp.
//
//   TRIPWIRE rail-alignment — 'the event rail starts where the plot columns
//   start'. Held against the grid recharts actually drew, not against the
//   constant the component hoped it used. VERIFIED TO FAIL by restoring the
//   label-beside-the-inset layout (52px label + 8px gap + a PLOT_LEFT padding on
//   the track), which put every glyph 60px right of its bucket.
//
//   TRIPWIRE cache-badge-verdict — 'a healthy entity carries no caching badge'.
//   This one holds an OUTCOME, not a single line: with the call-site gate
//   removed the suite stays green, because ui.jsx's Badge independently refuses
//   any level that is not red or amber. That is why the finding was latent
//   rather than live, and why the check is written against what the page shows —
//   it fails only if BOTH guards go, which is the state that would actually tell
//   the decider his best-cached project is broken.
//
// Placeholder identities and synthetic paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import {
  bootPage, installDom, installFetch, loadModule, waitFor,
} from '../dashboard/test-support/index.mjs';

const DASHBOARD_SRC = fileURLToPath(new URL('../dashboard/src', import.meta.url));
const PORT = 43387;
const TOKEN = 'drill-clicktest-placeholder-token';
const CLAUDE_PROJECT = '/placeholder/projects/alpha';
const CODEX_PROJECT = '/placeholder/projects/beta';
const CLAUDE_PROFILE = 'placeholder-claude-profile';
const CODEX_PROFILE = 'placeholder-codex-profile';
const LANE_SESSION = 'placeholder-lane-session';
const REVIEW_SESSION = 'placeholder-review-session';
const DESIGN_SESSION = 'placeholder-design-session';
const CODEX_SESSION = 'placeholder-codex-session';

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function transcriptRequest({
  key, sessionId, observedAt, input, output, agentId = null, model = 'claude-opus-5',
}) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug: CLAUDE_PROFILE,
    messageId: key,
    recordUuid: null,
    model,
    effort: null,
    observedAt,
    inputTokens: input,
    cacheCreationInputTokens: Math.round(input / 2),
    cacheReadInputTokens: input * 10,
    outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0,
    cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: agentId != null,
    agentId,
  };
}

function proxyRecord({ requestId, observedAt, provider, model, source, total }) {
  return {
    requestId,
    machine: 'placeholder-machine',
    observedAt,
    source,
    provider,
    model,
    reasoningEffort: 'high',
    endpoint: '/v1/placeholder',
    userAgentClass: provider === 'claude' ? 'claude-code' : 'codex',
    failed: false,
    statusCode: 200,
    latencyMs: 10,
    ttftMs: 1,
    inputUncached: Math.round(total * 0.1),
    inputCacheRead: Math.round(total * 0.7),
    inputCacheWrite: 0,
    outputTotal: Math.round(total * 0.2),
    outputReasoning: 0,
    total,
  };
}

/**
 * One project with TWO sessions that classify differently (a lane-branch session
 * in a worktree and a review session), one of them with subagent runs and skill
 * events so the anatomy page has a composition, a rail and lanes to draw; plus a
 * Codex project whose rollout records turns and nothing else, which is the
 * honest-degradation case.
 */
function seed(store, root) {
  const codexHome = path.join(root, 'codex-placeholder-home');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexHome, 0o700);
  const claude = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder Claude One',
    identity: 'placeholder-claude@example.invalid',
    profileRef: path.join(root, 'claude-placeholder-home'),
  });
  const codex = store.saveAccount({
    provider: 'codex',
    label: 'Placeholder Codex One',
    identity: 'placeholder-codex@example.invalid',
    profileRef: codexHome,
  });
  /*
   * The pool levels are chosen so BOTH halves of tripwire 1 can actually go.
   *
   *   * Claude rises to 29% over the range, but 10 of those points land at
   *     -12h, an hour in which NO session ran anywhere — so 0.10 is untraceable
   *     and the project's own figure is 0.19, not the pool's 0.29. A drill that
   *     apportions the pool total by a naive whole-range token share prints
   *     0.29 and the tripwire sees it.
   *   * 0.19 split three ways by this fixture's token shares is a set that
   *     rounds UP to 0.20 if each block is rounded on its own, so the single
   *     largest-remainder pass is load-bearing too.
   */
  const claudeLevels = [[30, 10], [26, 20], [12, 30], [2, 39]];
  const codexLevels = [[30, 5], [26, 9], [2, 15]];
  for (const [account, levels] of [[claude, claudeLevels], [codex, codexLevels]]) {
    for (const [hours, usedPercent] of levels) {
      store.recordUsage(account.id, {
        scope: 'weekly',
        observedAt: hoursAgo(hours),
        usedPercent,
        resetsAt: hoursAgo(-48),
        source: 'drill-clicktest-fixture',
        detail: { fixture: 'placeholder' },
      });
    }
  }

  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: LANE_SESSION,
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        // A worktree child of the project, on a lane-shaped branch: it folds
        // into the parent project AND classifies as a build lane.
        cwd: CLAUDE_PROJECT + '/.claude/worktrees/placeholder-lane',
        gitBranch: 'lane/placeholder',
        firstAt: hoursAgo(26),
        lastAt: hoursAgo(2),
        title: 'Placeholder lane session',
        titleSource: 'last-prompt',
      },
      {
        sessionId: REVIEW_SESSION,
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        cwd: CLAUDE_PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(26),
        lastAt: hoursAgo(3),
        title: 'Placeholder review session',
        titleSource: 'last-prompt',
      },
      {
        sessionId: DESIGN_SESSION,
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        cwd: CLAUDE_PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(25),
        lastAt: hoursAgo(4),
        title: 'Placeholder prototype session',
        titleSource: 'last-prompt',
      },
    ],
    requests: [
      transcriptRequest({
        key: 'lane-main-1', sessionId: LANE_SESSION, observedAt: hoursAgo(26),
        input: 4000, output: 900,
      }),
      transcriptRequest({
        key: 'lane-main-2', sessionId: LANE_SESSION, observedAt: hoursAgo(2),
        input: 9000, output: 1800,
      }),
      // Two subagent runs, so composition has a main block and two lane blocks.
      transcriptRequest({
        key: 'lane-agent-a', sessionId: LANE_SESSION, observedAt: hoursAgo(25),
        input: 3000, output: 600, agentId: 'placeholder-agent-a',
      }),
      transcriptRequest({
        key: 'lane-agent-b', sessionId: LANE_SESSION, observedAt: hoursAgo(24),
        input: 1500, output: 300, agentId: 'placeholder-agent-b',
      }),
      transcriptRequest({
        key: 'review-1', sessionId: REVIEW_SESSION, observedAt: hoursAgo(26),
        input: 2000, output: 500, model: 'claude-sonnet-5',
      }),
      transcriptRequest({
        key: 'review-2', sessionId: REVIEW_SESSION, observedAt: hoursAgo(3),
        input: 2500, output: 700, model: 'claude-sonnet-5',
      }),
      transcriptRequest({
        key: 'design-1', sessionId: DESIGN_SESSION, observedAt: hoursAgo(25),
        input: 1200, output: 400, model: 'claude-sonnet-5',
      }),
      transcriptRequest({
        key: 'design-2', sessionId: DESIGN_SESSION, observedAt: hoursAgo(4),
        input: 800, output: 250, model: 'claude-sonnet-5',
      }),
    ],
    subagents: [
      {
        agentId: 'placeholder-agent-a', sessionId: LANE_SESSION, profileSlug: CLAUDE_PROFILE,
        agentType: 'placeholder-agent-type', resolvedModel: 'claude-opus-5',
        totalTokens: 33600, durationMs: 60000, observedAt: hoursAgo(25),
      },
      // No agent_type recorded — the page must number it rather than invent one.
      {
        agentId: 'placeholder-agent-b', sessionId: LANE_SESSION, profileSlug: CLAUDE_PROFILE,
        agentType: null, resolvedModel: 'claude-opus-5',
        totalTokens: 16800, durationMs: 30000, observedAt: hoursAgo(24),
      },
    ],
    skills: [
      {
        eventKey: 'skill-1', sessionId: LANE_SESSION, profileSlug: CLAUDE_PROFILE,
        skill: 'implement', commandName: null, observedAt: hoursAgo(25),
      },
      {
        eventKey: 'skill-2', sessionId: REVIEW_SESSION, profileSlug: CLAUDE_PROFILE,
        skill: 'adversarial-review', commandName: null, observedAt: hoursAgo(4),
      },
      {
        eventKey: 'skill-3', sessionId: DESIGN_SESSION, profileSlug: CLAUDE_PROFILE,
        skill: 'prototype', commandName: null, observedAt: hoursAgo(25),
      },
    ],
  });

  store.ingestCodexSession(
    {
      sessionId: CODEX_SESSION,
      profileSlug: CODEX_PROFILE,
      machine: 'placeholder-machine',
      cwd: CODEX_PROJECT,
      gitBranch: 'main',
      firstTimestamp: hoursAgo(26),
      lastTimestamp: hoursAgo(2),
      archived: false,
    },
    // Enough turns to clear the caching detector's own request floor, so the
    // Codex cache card actually renders and can be checked for the verdict it
    // must NOT carry.
    Array.from({ length: 30 }, (unused, turnIndex) => ({
      turnIndex,
      turnId: 'turn-' + turnIndex,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      inputTokens: 3000 + turnIndex * 100,
      cachedInputTokens: 6000 + turnIndex * 200,
      cacheWriteInputTokens: 0,
      outputTokens: 900 + turnIndex * 10,
      reasoningOutputTokens: 300,
      totalTokens: 9900 + turnIndex * 310,
      // Distinct instants: a curve whose points share a timestamp is not a
      // curve, and recharts keys its ticks on the value.
      timestamp: hoursAgo(turnIndex < 15 ? 26 - turnIndex / 20 : 3 - (turnIndex - 15) / 20),
    })),
  );

  store.ingestRequestUsage([
    proxyRecord({
      requestId: 'proxy-claude-1', observedAt: hoursAgo(26), provider: 'claude',
      model: 'claude-opus-5', source: 'placeholder-claude@example.invalid', total: 40000,
    }),
    proxyRecord({
      requestId: 'proxy-claude-2', observedAt: hoursAgo(2), provider: 'claude',
      model: 'claude-opus-5', source: 'placeholder-claude@example.invalid', total: 90000,
    }),
    proxyRecord({
      requestId: 'proxy-codex-1', observedAt: hoursAgo(2), provider: 'codex',
      model: 'gpt-5.6-sol', source: 'placeholder-codex-source-hash', total: 25000,
    }),
  ]);
  return { claude, codex };
}

/**
 * A session whose prompt caching is HEALTHY: enough requests to clear the
 * detector's floor, and almost no uncached input per request because the context
 * is written once and read back.
 *
 * Seeded only for the badge test, and into its own project, because the figures
 * every other test here checks are tuned to the token shares above — a healthy
 * session added to `alpha` would move them.
 */
const HEALTHY_PROJECT = '/placeholder/projects/cached';
const HEALTHY_SESSION = 'placeholder-healthy-session';

function seedHealthySession(store) {
  store.ingestTranscriptBatch({
    sessions: [{
      sessionId: HEALTHY_SESSION,
      profileSlug: CLAUDE_PROFILE,
      machine: 'placeholder-machine',
      cwd: HEALTHY_PROJECT,
      gitBranch: 'main',
      firstAt: hoursAgo(20),
      lastAt: hoursAgo(6),
      title: 'Placeholder well-cached session',
      titleSource: 'last-prompt',
    }],
    requests: Array.from({ length: 30 }, (unused, index) => ({
      dedupeKey: 'healthy-' + index,
      requestId: null,
      sessionId: HEALTHY_SESSION,
      profileSlug: CLAUDE_PROFILE,
      messageId: 'healthy-' + index,
      recordUuid: null,
      model: 'claude-opus-5',
      effort: null,
      observedAt: hoursAgo(20 - index / 4),
      // 40 uncached input tokens a request — two orders of magnitude under the
      // amber line — against a context that is read back from cache every turn.
      inputTokens: 40,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 30000,
      outputTokens: 300,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      isSidechain: false,
      agentId: null,
    })),
  });
}

function fixture(t, { healthySession = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-drill-click-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  store.saveSettings({ usageAnalyticsEnabled: true });
  const accounts = seed(store, root);
  if (healthySession) seedHealthySession(store);
  const service = {
    projectsRoot: root,
    startAutoRefresh() {},
    stopAutoRefresh() {},
    async state() { return store.state(); },
  };
  const app = createApp({
    store, service, host: '127.0.0.1', port: PORT, mutationToken: TOKEN,
    laneManifestPath: path.join(root, 'absent-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store, accounts };
}

async function landing(t, options) {
  const data = fixture(t, options);
  const dom = installDom({ width: 1040, height: 340 });
  installFetch(data.app, { host: `127.0.0.1:${PORT}` });
  const harness = await loadModule('test-support/mount.jsx');
  const root = harness.mountApp(document.getElementById('root'));
  t.after(() => {
    root.unmount();
    dom.window.close();
  });
  await waitFor(() => document.querySelector('.hero-figure'), 'the headline to load');
  await waitFor(() => document.querySelectorAll('.treemap .block').length > 0, 'the treemap to tile');
  await waitFor(
    () => document.querySelectorAll('.recharts-bar path[fill="transparent"]').length > 0,
    'the chart to draw its per-bucket hit targets',
  );
  return { ...data, dom };
}

/** Click the button whose trimmed text is exactly `label`. */
async function clickLabel(label, until, what, scope = () => document) {
  const target = [...scope().querySelectorAll('button')]
    .find((node) => node.textContent.trim() === label);
  assert.ok(target, 'a button labelled ' + JSON.stringify(label) + ' exists');
  target.click();
  if (until) await waitFor(until, what || 'the page to answer ' + JSON.stringify(label));
  return target;
}

/** Click the treemap block whose name is exactly `name`. */
async function clickBlock(name, until, what, scope = () => document) {
  const target = [...scope().querySelectorAll('.treemap .block')]
    .find((node) => node.querySelector('.block-name-text').textContent.trim() === name);
  assert.ok(target, 'a block named ' + JSON.stringify(name) + ' exists');
  target.click();
  if (until) await waitFor(until, what || 'the block ' + JSON.stringify(name) + ' to open');
  return target;
}

const crumbs = (doc = document) => [...doc.querySelectorAll('.crumbs > *')]
  .map((node) => node.textContent.trim()).filter((text) => text && text !== '›');

/** The label of the currently selected option in a named Segmented control. */
function pressed(label, doc = document) {
  const group = doc.querySelector('.segmented[aria-label="' + label + '"]');
  const on = group && [...group.querySelectorAll('button')]
    .find((node) => node.getAttribute('aria-pressed') === 'true');
  return on ? on.textContent.trim() : null;
}

const blockValues = (doc = document) => [...doc.querySelectorAll('.treemap .block')]
  .map((node) => Number(node.querySelector('.block-value').textContent.replace(/[$,]/g, '')));

const heroValue = (doc = document) => Number(
  doc.querySelector('.hero-figure').textContent.replace(/[^0-9.]/g, ''),
);

async function openAlphaDrill(t) {
  const data = await landing(t);
  const landingValue = Number([...document.querySelectorAll('.treemap .block')]
    .find((node) => node.querySelector('.block-name-text').textContent.trim() === 'alpha')
    .querySelector('.block-value').textContent.replace(/[$,]/g, ''));
  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the alpha drill to open');
  await waitFor(() => document.querySelectorAll('.treemap .block').length > 0, 'the activity map to tile');
  return { ...data, landingValue };
}

// ---------------------------------------------------------------------------

test('TRIPWIRE 1 — the drill headline is the landing figure, and every dimension sums to it', async (t) => {
  const { landingValue } = await openAlphaDrill(t);

  // The number the reader clicked is the number he lands on. These are the same
  // derivation (model.js projectValueSeries), not two that agree today.
  assert.equal(heroValue(), landingValue);

  for (const dimension of ['Activity', 'Model', 'Skill']) {
    if (dimension !== 'Activity') {
      // Wait for the SWITCH to report itself selected, not merely for blocks to
      // exist — blocks already exist before the click, so a dimension change
      // that never happened would be checked against the previous cut's map and
      // pass without testing this dimension at all.
      await clickLabel(dimension, () => pressed('Breakdown dimension') === dimension,
        'the ' + dimension + ' cut to become the selected one');
    }
    assert.equal(pressed('Breakdown dimension'), dimension, 'the drill is on the ' + dimension + ' cut');
    const values = blockValues();
    assert.ok(values.length > 0, dimension + ': the cut has blocks');
    const sum = values.reduce((total, value) => total + value, 0);
    assert.ok(
      Math.abs(sum - heroValue()) < 0.005,
      dimension + ': blocks sum to the headline (' + sum + ' vs ' + heroValue() + ')',
    );
  }
});

test('the drill leads with the activity treemap, then when, then sessions — no walls of text', async (t) => {
  await openAlphaDrill(t);
  const page = document.querySelector('.page');

  // Document order (amendment d11: inside a project he thinks in activity, not
  // sessions). The treemap comes FIRST, the when-chart under it, sessions last.
  const order = [...page.querySelectorAll('.hero, .treemap, .chart-wrap, .bars')]
    .map((node) => node.className.split(' ')[0]);
  assert.deepEqual(order, ['hero', 'treemap', 'chart-wrap', 'bars']);

  // The unit is subscriptions, and no rendered figure surface says 'window'.
  assert.match(page.textContent, /weekly subscriptions/);
  const surfaces = [...page.querySelectorAll('.hero, .card')].map((node) => node.textContent).join(' ');
  assert.equal(/\bwindows?\b/i.test(surfaces), false, 'no rendered figure surface says "window"');

  // The activity classifier is slice 2's, and its labels are on the blocks.
  const names = [...page.querySelectorAll('.treemap .block .block-name-text')]
    .map((node) => node.textContent.trim());
  assert.ok(names.includes('Build lanes'), names.join(' | '));

  // The when-chart carries no click affordance, because nothing below it scopes
  // to a bucket — it must not promise one.
  assert.equal(page.querySelectorAll('.chart-hint').length, 0);

  // Every session row is an activatable block with its own figure, not a table
  // row of squished columns (#373 verdict 2/3).
  const rows = [...page.querySelectorAll('.session-row')];
  assert.ok(rows.length >= 2, 'both sessions are listed');
  for (const row of rows) {
    assert.equal(row.tagName, 'BUTTON');
    assert.match(row.querySelector('.session-value').textContent, /\d/);
  }
});

test('a dimension block filters the sessions beneath it, and the crumb walks back out', async (t) => {
  await openAlphaDrill(t);
  const rowCount = () => document.querySelectorAll('.session-row').length;
  const all = rowCount();
  assert.ok(all >= 2);

  await clickBlock('Build lanes', () => crumbs().includes('Build lanes'), 'the activity level to open');
  assert.ok(rowCount() < all, 'the sessions are filtered to that activity');
  const filtered = [...document.querySelectorAll('.session-row .session-name')]
    .map((node) => node.textContent.trim());
  assert.deepEqual(filtered, ['Placeholder lane session']);

  // …and the crumb above it walks back to the whole project.
  await clickLabel('alpha', () => rowCount() === all, 'the project level to come back');
  assert.equal(crumbs().at(-1), 'alpha');
});

test('TRIPWIRE stale-route — a drill entry from another range is not a level to return to', async (t) => {
  // CodeRabbit, PR #393: changing the range REPLACES the current entry with the
  // overview, but the drill entries already pushed under the old range stay in
  // the stack. A route is nothing but keys — a bucket key, a project key, a
  // session key — and restored under a different range those keys name nothing:
  // the drill would bound its request to a slice outside the loaded window and
  // render an empty page over a headline that still looks authoritative.
  const data = await landing(t);
  const { window } = data.dom;

  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the drill to open');
  await waitFor(() => document.querySelectorAll('.session-row').length > 0, 'its sessions to list');

  // Step back to the landing, so the drill entry is now in the FORWARD stack.
  window.history.back();
  await waitFor(() => crumbs().length === 1, 'the landing to come back');

  // Change the range. This replaces the entry the reader is on — it cannot
  // reach the one in front of it.
  await clickLabel('30 days', () => pressed('Time range') === '30 days', 'the 30-day range to load');
  await waitFor(() => document.querySelectorAll('.treemap .block').length > 0, 'the 30-day landing to tile');

  // Forward, onto the stale drill entry.
  window.history.forward();
  await waitFor(() => pressed('Time range') === '30 days', 'the range to still be 30 days');
  // Give the restore a beat to land, then hold the outcome.
  await new Promise((resolve) => { setTimeout(resolve, 60); });

  assert.deepEqual(crumbs(), ['Overview'], 'the stale drill entry lands on the overview');
  assert.equal(document.querySelectorAll('.session-row').length, 0, 'no drill page is rendered');
  assert.equal(document.querySelectorAll('.card.error').length, 0, 'and nothing errored');
  // The entry itself was rewritten, so pressing forward again does not repeat
  // the trip through a route that cannot be honoured.
  assert.equal(window.history.state.route.level, 'overview');
  assert.equal(window.history.state.route.rangeKey, '30d');
});

test('filters carry through the drill and back: lens, provider scope and the chart selection', async (t) => {
  const data = await landing(t);
  const { window } = data.dom;

  // Scope the landing to the most recent day — the one the fixture's sessions
  // actually ran in — then open a project with that selection in hand.
  const hit = [...document.querySelectorAll('.recharts-bar path[fill="transparent"]')].at(-1);
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /scoped to /.test(
    [...document.querySelectorAll('.card')]
      .find((node) => node.querySelector('.card-title')?.textContent.startsWith('Projects'))
      .querySelector('.card-note').textContent,
  ), 'the landing to scope to the clicked day');

  await clickLabel('Cost', () => document.querySelector('.hero-figure').textContent.startsWith('$'),
    'the cost lens');

  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the drill to open');
  // The lens carried in: the drill is denominated in API-$ with its caveat.
  assert.match(document.querySelector('.hero-figure').textContent, /^\$/);
  assert.match(document.querySelector('.hero-sub').textContent, /\* if billed at full API rate/);
  // …and so did the time selection: the drill says which slice it is showing.
  const sub = document.querySelector('.hero-sub').textContent;
  assert.ok(/of the pool ·/.test(sub), 'the drill names the carried slice: ' + sub);

  // BROWSER BACK, which is what a reader's hand reaches for first.
  window.history.back();
  await waitFor(() => crumbs().length === 1, 'the landing to come back');
  // Everything the reader set is still set: the lens, and the selection.
  assert.match(document.querySelector('.hero-figure').textContent, /^\$/);
  await waitFor(() => /scoped to /.test(
    [...document.querySelectorAll('.card')]
      .find((node) => node.querySelector('.card-title')?.textContent.startsWith('Projects'))
      .querySelector('.card-note').textContent,
  ), 'the chart selection to come back with it');

  // The provider scope is App state and never rode the route at all, so it
  // survives the round-trip untouched.
  assert.equal(
    [...document.querySelectorAll('.segmented button')]
      .find((node) => node.getAttribute('aria-pressed') === 'true' && node.textContent.includes('Claude'))
      != null,
    true,
    'the provider scope is unchanged',
  );
});

test('TRIPWIRE 2 — the anatomy page partitions the session figure the drill printed', async (t) => {
  await openAlphaDrill(t);

  const row = [...document.querySelectorAll('.session-row')]
    .find((node) => node.querySelector('.session-name').textContent.trim() === 'Placeholder lane session');
  const printed = Number(row.querySelector('.session-value').textContent.replace(/[$,]/g, ''));
  row.click();
  await waitFor(() => crumbs().includes('Placeholder lane session'), 'the anatomy page to open');
  await waitFor(() => document.querySelectorAll('.treemap .block').length > 0, 'the composition to tile');

  // The headline IS the figure the level above printed — handed down, not
  // recomputed.
  assert.equal(heroValue(), printed);

  // Both pictures partition it.
  const blocks = blockValues().reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(blocks - printed) < 0.005, 'composition blocks sum to it (' + blocks + ')');

  const columns = [...document.querySelectorAll('.recharts-bar')]
    .filter((layer) => [...layer.querySelectorAll('path')]
      .some((mark) => mark.getAttribute('fill') !== 'transparent'));
  assert.ok(columns.length >= 1, 'the timeline drew its stack');

  // The computed sentence is chosen from the token classes, not written: this
  // fixture re-reads ten times what it sends fresh, so it must say so.
  const sentence = document.querySelector('.why-sentence').textContent;
  assert.match(sentence, /context re-reading, not output\./);
  assert.match(sentence, /average context/);

  // A lane with no recorded agent_type is numbered, never invented.
  const names = [...document.querySelectorAll('.treemap .block .block-name-text')]
    .map((node) => node.textContent.trim());
  assert.ok(names.includes('Main loop'), names.join(' | '));
  assert.ok(names.includes('placeholder-agent-type'), names.join(' | '));
  assert.ok(names.some((name) => /^Lane \d+$/.test(name)), names.join(' | '));

  // The event rail is aligned to the timeline's own buckets, one cell each.
  const rail = document.querySelector('.rail-track');
  assert.ok(rail, 'the lane/skill rail is drawn for a Claude session');
  assert.match(rail.getAttribute('style'), /repeat\(\d+, 1fr\)/);
});

test('TRIPWIRE rail-alignment — the event rail starts where the plot columns start', async (t) => {
  // CodeRabbit, PR #393: the rail's label sat BESIDE the plot inset instead of
  // occupying it, so a 52px label plus an 8px gap plus a PLOT_LEFT padding put
  // every glyph 60px right of the bucket it described. Nothing about that is
  // visible in a screenshot of a busy session, and DailyChart's own comment says
  // a rail one bucket out of step is worse than no rail — so the geometry is
  // held here, against the chart's own axis rather than against a constant.
  await openAlphaDrill(t);
  const row = [...document.querySelectorAll('.session-row')]
    .find((node) => node.querySelector('.session-name').textContent.trim() === 'Placeholder lane session');
  row.click();
  await waitFor(() => document.querySelector('.rail-track'), 'the event rail to draw');

  const { PLOT_LEFT, PLOT_RIGHT } = await loadModule('src/DailyChart.jsx');
  // Scope to the timeline card — the context curve below it draws a plot too.
  const card = [...document.querySelectorAll('.card')]
    .find((node) => node.querySelector('.card-title')?.textContent.startsWith('Inside the session'));
  const label = card.querySelector('.rail-label');
  const track = card.querySelector('.rail-track');

  // The plot's real drawn extent, off the grid recharts actually laid out —
  // which is the thing the rail has to line up with, not the constant we hoped
  // it would use.
  const gridLine = card.querySelector('.recharts-cartesian-grid-horizontal line');
  assert.ok(gridLine, 'the timeline drew its plot grid');
  const plotLeft = Number(gridLine.getAttribute('x1'));
  const plotRight = Number(gridLine.getAttribute('x2'));
  const surface = Number(card.querySelector('.recharts-surface').getAttribute('width'));

  // 1. The label IS the left inset — the rail's first column therefore begins at
  //    the plot's first column, not 60px to the right of it.
  assert.equal(label.style.width, plotLeft + 'px', 'the rail label occupies the plot inset exactly');
  // 2. …and the track adds no second inset on top of it.
  assert.equal(track.style.paddingLeft, '', 'the rail track adds no inset of its own');
  // 3. The right edge lines up the same way.
  assert.equal(track.style.paddingRight, surface - plotRight + 'px', 'the rail ends where the plot ends');
  // The constants the component reasons with are the ones recharts drew.
  assert.equal(plotLeft, PLOT_LEFT);
  assert.equal(surface - plotRight, PLOT_RIGHT);
  // 3. The row contributes no gap between the two, which would shift the track
  //    right by exactly the gap. jsdom performs no layout and loads no
  //    stylesheet, so this one is held on the rule itself — it is a CSS fact,
  //    and the alternative is not holding it at all.
  const css = fs.readFileSync(path.join(DASHBOARD_SRC, 'theme.css'), 'utf8');
  const rule = /\.rail\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'theme.css declares a .rail row');
  const gap = /(?:^|;)\s*gap\s*:\s*([^;]+)/.exec(rule[1]);
  assert.ok(gap, '.rail states its gap rather than leaving it to a default');
  assert.equal(parseFloat(gap[1]), 0, '.rail adds no gap beside the plot inset');
  // …and the label takes no width from the sheet either, so the inline one from
  // PLOT_LEFT is the only thing deciding it.
  const labelRule = /\.rail-label\s*\{([^}]*)\}/.exec(css);
  assert.ok(labelRule, 'theme.css declares .rail-label');
  assert.equal(/(?:^|;)\s*width\s*:/.test(labelRule[1]), false, '.rail-label takes its width from PLOT_LEFT');
});

test('TRIPWIRE cache-badge-verdict — a healthy entity carries no caching badge', async (t) => {
  // CodeRabbit, PR #393: both cache cards rendered the Badge whenever the metric
  // was measurable, and the label ternary under it falls through to "caching
  // weak" for a HEALTHY entity. It was suppressed only by Badge's own red/amber
  // early return — a correct outcome resting on a decision in another file, and
  // one line's edit away from telling the decider his best-cached project is
  // broken. The gate is now at the call site; this holds it there.
  await landing(t, { healthySession: true });
  await clickBlock('cached', () => crumbs().includes('cached'), 'the well-cached project to open');
  await waitFor(() => document.querySelectorAll('.session-row').length > 0, 'its sessions to list');

  const cardFor = (doc) => [...doc.querySelectorAll('.card')]
    .find((node) => node.querySelector('.card-title')?.textContent.startsWith('Prompt caching'));

  // The PROJECT card: the rate is measurable and healthy, so it renders with its
  // numbers and no verdict of any kind.
  const project = cardFor(document);
  assert.ok(project, 'the project cache card renders for a measurable rate');
  assert.equal(project.querySelectorAll('.badge').length, 0, 'and carries no badge');
  assert.equal(/caching (weak|broken)/.test(document.querySelector('.page').textContent), false);
  assert.equal(document.querySelectorAll('.hero .badge').length, 0, 'nor does the headline');

  // …and the SESSION card, one level down, says the same.
  document.querySelector('.session-row').click();
  await waitFor(() => document.querySelector('.why-sentence'), 'the anatomy page to open');
  const session = cardFor(document);
  assert.ok(session, 'the session cache card renders too');
  assert.equal(session.querySelectorAll('.badge').length, 0, 'with no badge');
  assert.equal(/caching (weak|broken)/.test(document.querySelector('.page').textContent), false);
  // The note under it is for broken caching only, and must not appear here.
  assert.equal(document.querySelectorAll('.note').length, 0);
});

test('a Codex session degrades honestly: turns, no lanes, no skills, no cache verdict', async (t) => {
  await landing(t);
  await clickLabel('Combined', () => [...document.querySelectorAll('.treemap .block .block-name-text')]
    .some((node) => node.textContent.trim() === 'beta'), 'the Codex project to join the map');

  await clickBlock('beta', () => crumbs().includes('beta'), 'the beta drill to open');
  await waitFor(() => document.querySelectorAll('.session-row').length > 0, 'its sessions to list');
  document.querySelector('.session-row').click();
  await waitFor(() => document.querySelector('.why-sentence'), 'the Codex anatomy page to open');

  const page = document.querySelector('.page');
  // The provider's OWN word for what it counts. 'request' must appear nowhere a
  // turn is being counted, because the two rates are not comparable.
  assert.match(page.textContent, /\bturns?\b/);
  assert.match(
    [...page.querySelectorAll('.card-title')].map((node) => node.textContent).join(' '),
    /Context per turn/,
  );

  // What a rollout does not record, the page says rather than draws.
  const stats = [...page.querySelectorAll('.stat')]
    .map((node) => node.textContent).join(' | ');
  assert.match(stats, /Subagent lanes.*not recorded/);
  assert.match(page.textContent, /Codex rollouts record no subagent runs/);
  assert.match(page.textContent, /Codex rollouts record no skill or subagent events/);
  assert.equal(page.querySelectorAll('.rail-track').length, 0, 'no event rail is drawn');

  // The per-request caching thresholds carry NO verdict on a turn…
  const cache = [...page.querySelectorAll('.card')]
    .find((node) => node.querySelector('.card-title')?.textContent.startsWith('Prompt caching'));
  assert.ok(cache, 'the cache card is still rendered');
  assert.equal(cache.querySelectorAll('.badge').length, 0, 'and carries no badge');
  assert.match(cache.textContent, /no threshold applies to a turn/);
  // …and the rate is labelled per turn, not per request.
  assert.match(cache.textContent, /Uncached input \/ turn/);
});

test('the BUILT page the daemon serves drills all the way to a session anatomy', async (t) => {
  // Everything above renders dashboard/src. This one runs the compiled bytes:
  // a bundle that throws on load draws an empty page in a real browser and
  // passes every source-level test in this file.
  const data = fixture(t);
  const dom = bootPage(DASHBOARD_APP_HTML, data.app, { host: `127.0.0.1:${PORT}` });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  await waitFor(() => page.querySelectorAll('.treemap .block').length > 0, 'the built landing to tile');
  const block = [...page.querySelectorAll('.treemap .block')]
    .find((node) => node.querySelector('.block-name-text').textContent.trim() === 'alpha');
  assert.ok(block, 'the built page tiles the project');
  block.click();
  await waitFor(() => crumbs(page).includes('alpha'), 'the built drill to open');
  await waitFor(() => page.querySelectorAll('.session-row').length > 0, 'the built drill to list sessions');

  const row = [...page.querySelectorAll('.session-row')]
    .find((node) => node.querySelector('.session-name').textContent.trim() === 'Placeholder lane session');
  row.click();
  await waitFor(() => page.querySelector('.why-sentence'), 'the built anatomy page to draw');
  assert.match(page.querySelector('.hero-figure').textContent, /^\d+\.\d{2}/);
  assert.equal(page.querySelectorAll('.card.error').length, 0, 'and no load error anywhere in the drill');
});

/*
 * Issue #408 — the return affordances, on the drawn page. The stylesheet half
 * of this (TRIPWIRE drillnav-block-absolute) lives in
 * test/dashboard-drill-nav.test.mjs; these two hold the behaviour a reader has
 * in his hands: what the controls say, where one click lands, and that they
 * are gone at the top.
 */

const puck = (doc = document) => doc.querySelector('.zoomout-puck');
const pill = (doc = document) => doc.querySelector('.uppill');
const puckName = (doc = document) => {
  const node = puck(doc);
  return node ? node.querySelector('.zoomout-puck-name').textContent.trim() : null;
};
const pillName = (doc = document) => {
  const node = pill(doc);
  return node ? node.querySelector('.uppill-name').textContent.trim() : null;
};

test('TRIPWIRE drillnav-one-level — the puck and the pill name the crumb above and step up one level a click', async (t) => {
  await openAlphaDrill(t);

  // Both controls agree with the trail, always: the parent is the crumb
  // immediately left of the current one. If they ever disagree, the crumbs are
  // truth — so they are compared against the crumbs, not against a constant.
  const above = () => crumbs().at(-2);
  assert.deepEqual([puckName(), pillName()], [above(), above()], 'at the project level');

  await clickBlock('Build lanes', () => crumbs().includes('Build lanes'), 'the activity level to open');
  assert.deepEqual([puckName(), pillName()], ['alpha', 'alpha'], 'at the activity level');

  const row = [...document.querySelectorAll('.session-row')]
    .find((node) => node.querySelector('.session-name').textContent.trim() === 'Placeholder lane session');
  row.click();
  await waitFor(() => crumbs().includes('Placeholder lane session'), 'the anatomy page to open');
  assert.deepEqual([puckName(), pillName()], ['Build lanes', 'Build lanes'], 'at the session level');

  // One click, ONE level — the puck walks back up the same trail it came down,
  // never jumping to the landing.
  puck().click();
  await waitFor(() => crumbs().at(-1) === 'Build lanes', 'the puck to return to the activity level');
  assert.equal(puckName(), 'alpha');

  puck().click();
  await waitFor(() => crumbs().at(-1) === 'alpha', 'the puck to return to the project');
  assert.equal(puckName(), 'Overview');

  // …and the pill does the same one step, from the other end of the page.
  pill().click();
  await waitFor(() => crumbs().length === 1, 'the pill to return to the landing');
  assert.deepEqual(crumbs(), ['Overview']);
});

test('the return controls are absent at the overview, and a return never strands the keyboard', async (t) => {
  await landing(t);

  // Nothing is above the landing, so there is no control at all — not a
  // disabled-looking one, which explains nothing (#65/#113).
  assert.equal(puck(), null, 'no puck at the overview');
  assert.equal(pill(), null, 'no pill at the overview');

  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the drill to open');
  assert.ok(puck() && pill(), 'both controls appear below the landing');

  // Both are real buttons a keyboard reaches, and both say where they go.
  for (const node of [puck(), pill()]) {
    assert.equal(node.tagName, 'BUTTON');
    assert.equal(node.disabled, false, 'never natively disabled');
    assert.match(node.getAttribute('aria-label'), /one level to Overview/);
  }

  // The last step up unmounts the control under the reader's own finger (#363):
  // focus must land on the breadcrumb trail rather than on nothing.
  const control = pill();
  control.focus();
  assert.equal(document.activeElement, control);
  control.click();
  await waitFor(() => crumbs().length === 1, 'the landing to come back');
  await waitFor(
    () => document.activeElement === document.querySelector('.crumbs'),
    'focus to park on the breadcrumb trail',
  );
  assert.equal(puck(), null, 'and the controls are gone again');
});
