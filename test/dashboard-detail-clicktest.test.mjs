// Issue #387 — the DETAIL VIEWS, click-tested in a real DOM against the REAL
// daemon readers (the fetch stub calls the app's own request listener), so these
// clicks also prove the new /api/usage/model-effort query passes its own
// parameter validation.
//
// THE NAMED TRIPWIRES of this slice, each held on the drawn page rather than on
// the source, because every behaviour below is one the decider checks by eye and
// none of them is visible in a diff:
//
//   TRIPWIRE headroom-demoted — 'per-account headroom is not on the landing, and
//   the page it moved to sums'. Charter d2 demoted it; a later edit that puts a
//   headroom table back on the Overview, or a detail page whose Burned column
//   does not add up to the pool figure printed beside it, fails here. VERIFIED
//   TO FAIL by rounding each account's burn on its own instead of one
//   largest-remainder pass — the column then prints 0.26 against a 0.25 total.
//
//   TRIPWIRE project-burn-deleted — 'the deleted tab is deleted'. Charter d3
//   removed the project-burn view entirely (the Overview treemap and the drill
//   subsume it). The detail switcher must offer exactly the four views the
//   charter kept and no route may reach a fifth. Held with the route test in
//   dashboard-overview.test.mjs, which holds the daemon side of the same fact.
//
//   TRIPWIRE subscription-units — 'the burn timeline is denominated in
//   subscriptions, and says so in the decider's own words'. Issue #370: windows
//   per day became subscriptions per day and a share of one subscription, and
//   the word "window" appears on no rendered surface. The per-bucket column sums
//   exactly to the printed range total. VERIFIED TO FAIL by rounding each bucket
//   independently — the column then prints 0.26 against a 0.25 total.
//
//   TRIPWIRE matrix-sums — 'model × effort partitions the figure the LANDING
//   printed, in both directions'. Every cell is that figure apportioned by
//   measured token share in ONE largest-remainder pass, so the row totals, the
//   column totals and the grand total are all sums of the same printed cells —
//   and the grand total is anchored to the landing's own headline, because three
//   internal sums only prove the table agrees with itself, which a wrong number
//   does too. VERIFIED TO FAIL by rounding each cell on its own: the four equal
//   cells this fixture is built to produce then print 0.24 against a 0.25
//   headline.
//
//   TRIPWIRE filter-carry — 'every filter carries through, and a detail view is
//   not a level you get thrown out of'. Issue #371: opening a detail view from
//   inside a project arrives with that project AND the chart's time selection
//   already applied; browser back returns to the drill with both still set; and
//   changing the RANGE while on a detail view re-queries the view rather than
//   sending the reader back to the landing. VERIFIED TO FAIL by restoring the
//   unconditional go(HOME) on a range change, which drops the reader onto the
//   Overview mid-question.
//
//   TRIPWIRE view-switch-persistent — 'the way in is the way out'. Issue #409:
//   the header control that opened the detail views used to disappear on
//   arrival, leaving the reader feeling stuck. It is now a two-position switch
//   drawn on EVERY page — landing, detail view and drill — and operable in both
//   directions from each. VERIFIED TO FAIL by restoring the one-way chip, which
//   drops the switch from the detail page entirely.
//
//   TRIPWIRE section-filters-narrow — 'a section filter narrows, and the
//   narrowed table still sums and says what it covers'. Issue #410: each
//   headroom section carries its own account and provider filters. Three facts
//   are held here, because each fails a different way: the filter LAYERS on the
//   header scope (it may only ever choose among the accounts that scope admits,
//   and it never moves the header itself); the Burned column still sums exactly
//   to the caption beside the title under any narrowing, which needs the single
//   largest-remainder pass to run over the FILTERED set rather than the pool;
//   and the caption stops saying "across the pool" the moment it stops covering
//   it. VERIFIED TO FAIL by allocating over the unfiltered rows and slicing the
//   result — the two Claude rows then print 0.13 + 0.13 against a 0.25 caption.
//
//   TRIPWIRE sessions-demoted — 'the session explorer is one link, and it hands
//   the reader back to the project path'. Charter d4: sessions are the last
//   resort, so a row here opens that session's PROJECT drill rather than
//   dead-ending in a cross-project session page.
//
// Placeholder identities and synthetic paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import { bootPage, installDom, installFetch, loadModule, waitFor } from '../dashboard/test-support/index.mjs';

// #450: these fixtures anchor "recent" events a couple of hours in the past
// and their tests click the chart's last ("today") bar — between 00:00 and
// 02:00 local the anchors crossed midnight, the last day emptied, and the
// suite failed two hours every day. Pin the process to a DST-free
// fixed-offset zone where it is currently early afternoon, so "a couple of
// hours ago" is always today at any wall-clock time, without disturbing the
// fixtures' hand-tuned burn/rounding numbers. (POSIX inverts the sign:
// Etc/GMT-5 means UTC+5.) The spawned daemon inherits TZ from process.env.
{
  const utcHour = new Date().getUTCHours();
  const offset = (((13 - utcHour) % 24) + 24) % 24;
  process.env.TZ = offset === 0 ? 'Etc/GMT'
    : offset <= 14 ? `Etc/GMT-${offset}` : `Etc/GMT+${24 - offset}`;
}


const PORT = 43388;
const TOKEN = 'detail-clicktest-placeholder-token';
const CLAUDE_PROJECT = '/placeholder/projects/alpha';
const OTHER_PROJECT = '/placeholder/projects/gamma';
const CODEX_PROJECT = '/placeholder/projects/beta';
const CLAUDE_PROFILE = 'placeholder-claude-profile';
const CODEX_PROFILE = 'placeholder-codex-profile';

// The two weekly limits an account carries in the field: the account-wide one
// and the model-scoped one, which is usually the binding constraint and is the
// one the decider means by "Fable weekly".
const MODEL_LIMIT = 'Fable weekly';
const ALL_LIMIT = 'weekly';

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function transcriptRequest({
  key, sessionId, observedAt, input, output, model = 'claude-opus-5', effort = null,
}) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug: CLAUDE_PROFILE,
    messageId: key,
    recordUuid: null,
    model,
    effort,
    observedAt,
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: input * 10,
    outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0,
    cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: false,
    agentId: null,
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
 * Two Claude projects whose sessions run three model × effort combinations, and
 * a Codex project beside them. The Claude account carries BOTH weekly limits, so
 * the burn timeline has a real toggle rather than a single option pretending to
 * be one.
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
  const second = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder Claude Two',
    identity: 'placeholder-claude-two@example.invalid',
    profileRef: path.join(root, 'claude-placeholder-home-two'),
  });
  const codex = store.saveAccount({
    provider: 'codex',
    label: 'Placeholder Codex One',
    identity: 'placeholder-codex@example.invalid',
    profileRef: codexHome,
  });

  /*
   * The levels are chosen so the SUM RULE is actually load-bearing on this
   * fixture, not merely stated. Each Claude account rises 12.5 points over the
   * range, and each of the two days carries 12.5 points across the pool — so
   * every figure set here is a pair of 0.125s against a 0.25 total, which
   * independent rounding prints as 0.13 + 0.13 = 0.26. Both tripwires below
   * therefore go when the single largest-remainder pass goes.
   *
   * Model-scoped weekly moves most, so it is the binding limit AND the pool
   * figure's source; the account-wide limit moves less, which is what makes the
   * timeline's toggle observable.
   */
  const levels = [
    [claude, MODEL_LIMIT, [[30, 10], [26, 15], [2, 22.5]]],
    [claude, ALL_LIMIT, [[30, 5], [26, 9], [2, 17]]],
    [second, MODEL_LIMIT, [[30, 40], [26, 47.5], [2, 52.5]]],
    [codex, ALL_LIMIT, [[30, 5], [26, 9], [2, 15]]],
  ];
  for (const [account, scope, rows] of levels) {
    for (const [hours, usedPercent] of rows) {
      store.recordUsage(account.id, {
        scope,
        observedAt: hoursAgo(hours),
        usedPercent,
        resetsAt: hoursAgo(-48),
        source: 'detail-clicktest-fixture',
        detail: { fixture: 'placeholder' },
      });
    }
  }

  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: 'placeholder-alpha-session',
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        cwd: CLAUDE_PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(26),
        lastAt: hoursAgo(2),
        title: 'Placeholder alpha session',
        titleSource: 'last-prompt',
      },
      {
        sessionId: 'placeholder-gamma-session',
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        cwd: OTHER_PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(25),
        lastAt: hoursAgo(3),
        title: 'Placeholder gamma session',
        titleSource: 'last-prompt',
      },
    ],
    /*
     * FOUR model × effort cells carrying EQUAL tokens (11,000 each, counting
     * the cache reads), which is what makes the matrix's single rounding pass
     * load-bearing: a quarter of the 0.25 pool figure is 0.0625, and four cells
     * rounded on their own print 0.06 apiece — 0.24 against a 0.25 headline.
     * A fixture whose shares happen to round cleanly would let double-rounding
     * ship, which is the defect this slice's constraint exists to stop.
     */
    requests: [
      transcriptRequest({
        key: 'alpha-1', sessionId: 'placeholder-alpha-session', observedAt: hoursAgo(26),
        input: 500, output: 500, model: 'claude-opus-5', effort: 'high',
      }),
      transcriptRequest({
        key: 'alpha-2', sessionId: 'placeholder-alpha-session', observedAt: hoursAgo(2),
        input: 900, output: 1100, model: 'claude-opus-5', effort: 'medium',
      }),
      transcriptRequest({
        key: 'alpha-3', sessionId: 'placeholder-alpha-session', observedAt: hoursAgo(3),
        input: 900, output: 1100, model: 'claude-sonnet-5', effort: null,
      }),
      transcriptRequest({
        key: 'gamma-1', sessionId: 'placeholder-gamma-session', observedAt: hoursAgo(25),
        input: 900, output: 1100, model: 'claude-sonnet-5', effort: 'high',
      }),
      transcriptRequest({
        key: 'gamma-2', sessionId: 'placeholder-gamma-session', observedAt: hoursAgo(3),
        input: 400, output: 600, model: 'claude-opus-5', effort: 'high',
      }),
    ],
    subagents: [],
    skills: [],
  });

  store.ingestCodexSession(
    {
      sessionId: 'placeholder-codex-session',
      profileSlug: CODEX_PROFILE,
      machine: 'placeholder-machine',
      cwd: CODEX_PROJECT,
      gitBranch: 'main',
      firstTimestamp: hoursAgo(26),
      lastTimestamp: hoursAgo(2),
      archived: false,
    },
    Array.from({ length: 6 }, (unused, turnIndex) => ({
      turnIndex,
      turnId: 'turn-' + turnIndex,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      inputTokens: 9000,
      cachedInputTokens: 6000,
      cacheWriteInputTokens: 0,
      outputTokens: 900,
      reasoningOutputTokens: 300,
      totalTokens: 9900,
      timestamp: hoursAgo(turnIndex < 3 ? 26 : 3),
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
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-detail-click-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  store.saveSettings({ usageAnalyticsEnabled: true });
  seed(store, root);
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
  return { app, store };
}

async function landing(t) {
  const data = fixture(t);
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
async function clickLabel(label, until, what) {
  const target = [...document.querySelectorAll('button')]
    .find((node) => node.textContent.trim() === label);
  assert.ok(target, 'a button labelled ' + JSON.stringify(label) + ' exists');
  target.click();
  if (until) await waitFor(until, what || 'the page to answer ' + JSON.stringify(label));
  return target;
}

async function clickBlock(name, until, what) {
  const target = [...document.querySelectorAll('.treemap .block')]
    .find((node) => node.querySelector('.block-name-text').textContent.trim() === name);
  assert.ok(target, 'a block named ' + JSON.stringify(name) + ' exists');
  target.click();
  if (until) await waitFor(until, what || 'the block ' + JSON.stringify(name) + ' to open');
  return target;
}

const crumbs = () => [...document.querySelectorAll('.crumbs > *')]
  .map((node) => node.textContent.trim()).filter((text) => text && text !== '›');

function pressed(label) {
  const group = document.querySelector('.segmented[aria-label="' + label + '"]');
  const on = group && [...group.querySelectorAll('button')]
    .find((node) => node.getAttribute('aria-pressed') === 'true');
  return on ? on.textContent.trim() : null;
}

const cardNamed = (start) => [...document.querySelectorAll('.card')]
  .find((node) => node.querySelector('.card-title')?.textContent.trim().startsWith(start));

const numbers = (nodes) => [...nodes].map((node) => Number(node.textContent.replace(/[$,%]/g, '')));

const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * Click a position on the HEADER's view switch. Deliberately not clickLabel:
 * the breadcrumb also carries a button reading "Overview", and it is the
 * switch — not the crumb — that issue #409 is about.
 */
async function clickView(label, until, what) {
  const group = document.querySelector('.segmented[aria-label="View"]');
  assert.ok(group, 'the header carries the view switch');
  const target = [...group.querySelectorAll('button')]
    .find((node) => node.textContent.trim() === label);
  assert.ok(target, 'the switch offers ' + JSON.stringify(label));
  target.click();
  if (until) await waitFor(until, what || 'the switch to move to ' + JSON.stringify(label));
  return target;
}

/** Open the detail views from wherever the page currently is. */
async function openDetail(view) {
  await clickLabel('Detail views', () => crumbs().length > 1, 'the detail views to open');
  if (view && pressed('Detail view') !== view) {
    await clickLabel(view, () => pressed('Detail view') === view, 'the ' + view + ' view to open');
  }
}

// ---------------------------------------------------------------------------

test('TRIPWIRE headroom-demoted — headroom left the landing, and its page sums to the pool', async (t) => {
  await landing(t);

  // Charter d2: the landing answers the POOL question and nothing per-account.
  const titles = () => [...document.querySelectorAll('.card-title')].map((node) => node.textContent.trim());
  assert.equal(titles().some((title) => title.startsWith('By subscription')), false,
    'no per-account table on the landing: ' + titles().join(' | '));
  assert.match(document.querySelector('.page').textContent, /Can I start heavy work now\?/);

  await openDetail('Headroom');
  assert.deepEqual(crumbs(), ['Overview', 'Headroom']);

  // Every account, with its own measured burn — and the column adds up to the
  // pool figure printed beside it, at the printed precision.
  const card = cardNamed('By subscription');
  assert.ok(card, 'the headroom page carries the per-account table');
  const burned = numbers(card.querySelectorAll('tbody tr td.num:nth-child(2)'));
  assert.ok(burned.length >= 2, 'both Claude subscriptions are listed');
  const printed = Number(card.querySelector('.card-note').textContent.replace(/[^0-9.]/g, ''));
  assert.ok(Math.abs(sum(burned) - printed) < 0.005,
    'the burned column sums to the pool total (' + sum(burned) + ' vs ' + printed + ')');

  // …and the second table answers the question the first cannot: WHICH limit.
  const limits = cardNamed('Every weekly limit');
  assert.ok(limits, 'every weekly limit is listed');
  const names = [...limits.querySelectorAll('tbody tr td:nth-child(2)')].map((node) => node.textContent.trim());
  assert.ok(names.includes(MODEL_LIMIT), names.join(' | '));
  assert.ok(names.includes('All weekly'), names.join(' | '));
  // Nested limits count the same requests, so this table prints NO total.
  assert.equal(/total/i.test(limits.querySelector('.card-note').textContent), false);
});

test('TRIPWIRE project-burn-deleted — the switcher offers only the chartered detail views', async (t) => {
  await landing(t);
  await openDetail();

  const views = [...document.querySelectorAll('.segmented[aria-label="Detail view"] button')]
    .map((node) => node.textContent.trim());
  assert.deepEqual(views, ['Headroom', 'Reset calendar', 'Burn timeline', 'Model × effort', 'Sessions']);
  // Charter d3: the project-burn view is gone, not renamed and not hidden.
  assert.equal(/project burn/i.test(document.querySelector('.page').textContent), false);
});

test('TRIPWIRE subscription-units — the burn timeline is subscriptions per day, never windows', async (t) => {
  await landing(t);
  await openDetail('Burn timeline');

  const page = document.querySelector('.page');
  // Issue #370's rename, held on every rendered surface.
  assert.equal(/\bwindows?\b/i.test(page.textContent), false, 'the word "window" appears nowhere');
  assert.match(page.textContent, /subscriptions per day/);
  assert.match(page.textContent, /% of a subscription a day/);

  // The limit toggle is Tim's own ask: the model-scoped weekly limit leads
  // (Fable-first), the account-wide one is the alternative.
  const options = [...document.querySelectorAll('.segmented[aria-label="Weekly limit"] button')]
    .map((node) => node.textContent.trim());
  assert.deepEqual(options, [MODEL_LIMIT, 'All weekly']);
  assert.equal(pressed('Weekly limit'), MODEL_LIMIT, 'the model-scoped limit is the default lens');

  // The per-bucket column sums EXACTLY to the printed total, at printed
  // precision — one largest-remainder pass, the rule the decider checks by hand.
  const byDay = cardNamed('By ');
  assert.ok(byDay, 'the per-bucket table is drawn');
  const perBucket = numbers(byDay.querySelectorAll('tbody tr td.num:nth-child(2)'));
  const total = Number(byDay.querySelector('.card-note').textContent.replace(/[^0-9.]/g, ''));
  assert.ok(perBucket.length > 0, 'the table has rows');
  assert.ok(Math.abs(sum(perBucket) - total) < 0.005,
    'the bucket column sums to the printed total (' + sum(perBucket) + ' vs ' + total + ')');
  // …and the headline is that same figure, not a second derivation of it.
  const hero = Number(document.querySelector('.hero-figure').textContent.replace(/[^0-9.]/g, ''));
  assert.ok(Math.abs(hero - total) < 0.005, 'the headline is the table total (' + hero + ' vs ' + total + ')');

  // Switching the limit re-denominates the page rather than filtering it: the
  // account-wide limit moved less, so it must print a smaller figure.
  await clickLabel('All weekly', () => pressed('Weekly limit') === 'All weekly', 'the account-wide limit');
  const other = Number(document.querySelector('.hero-figure').textContent.replace(/[^0-9.]/g, ''));
  assert.ok(other < hero, 'the account-wide limit burned less than the model-scoped one');
});

test('TRIPWIRE matrix-sums — model × effort partitions the headline in both directions', async (t) => {
  await landing(t);
  // The figure the matrix has to partition, read off the landing before we
  // leave it: the pool's measured burn for this range.
  const poolFigure = Number(document.querySelector('.hero-figure').textContent.replace(/[^0-9.]/g, ''));
  await openDetail('Model × effort');
  await waitFor(() => document.querySelectorAll('.card tbody tr').length > 0, 'the matrix to load');

  const card = cardNamed('Model × effort');
  const headers = [...card.querySelectorAll('thead th')].map((node) => node.textContent.trim());
  // Effort is a real column set, taken from the requests rather than invented:
  // this fixture ran high, medium, and one request with no effort recorded.
  assert.ok(headers.includes('high'), headers.join(' | '));
  assert.ok(headers.includes('no effort'), headers.join(' | '));

  const rows = [...card.querySelectorAll('tbody tr')];
  assert.ok(rows.length >= 2, 'more than one model is listed');
  const cellsOf = (row) => [...row.querySelectorAll('td.num')].slice(0, headers.length - 3);
  const rowTotalOf = (row) => {
    const cells = [...row.querySelectorAll('td.num')];
    return Number(cells[cells.length - 2].textContent.replace(/[$,]/g, ''));
  };

  // 1. Each row's cells sum to its own total.
  for (const row of rows) {
    const values = cellsOf(row)
      .map((node) => node.textContent.trim())
      .filter((text) => text !== '—')
      .map((text) => Number(text.replace(/[$,]/g, '')));
    assert.ok(Math.abs(sum(values) - rowTotalOf(row)) < 0.005,
      'row cells sum to the row total (' + sum(values) + ' vs ' + rowTotalOf(row) + ')');
  }

  // 2. The rows sum to the grand total in the foot…
  const foot = [...card.querySelectorAll('tfoot td.num')];
  const grand = Number(foot[foot.length - 2].textContent.replace(/[$,]/g, ''));
  const rowTotals = rows.map(rowTotalOf);
  assert.ok(Math.abs(sum(rowTotals) - grand) < 0.005,
    'the rows sum to the grand total (' + sum(rowTotals) + ' vs ' + grand + ')');

  // 3. …and so do the column totals, which is the other direction a reader adds
  //    a matrix up in.
  const columnTotals = foot.slice(0, foot.length - 2)
    .map((node) => Number(node.textContent.replace(/[$,]/g, '')));
  assert.ok(Math.abs(sum(columnTotals) - grand) < 0.005,
    'the columns sum to the grand total (' + sum(columnTotals) + ' vs ' + grand + ')');

  // 4. The grand total IS the pool figure the LANDING printed — the matrix
  //    apportions measured truth rather than producing an absolute of its own.
  //    This is the anchor: without it the three sums above only prove the table
  //    agrees with itself, which a wrong number does too.
  assert.ok(Math.abs(grand - poolFigure) < 0.005,
    'the matrix partitions the landing figure (' + grand + ' vs ' + poolFigure + ')');
  assert.match(card.querySelector('.card-note').textContent, /all projects/);
});

test('TRIPWIRE filter-carry — project and time selection ride into the detail views and back', async (t) => {
  const data = await landing(t);
  const { window } = data.dom;

  // Scope the landing to one day, then open a project: both filters are now in
  // the reader's hand.
  const hit = [...document.querySelectorAll('.recharts-bar path[fill="transparent"]')].at(-1);
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /scoped to /.test(cardNamed('Projects').querySelector('.card-note').textContent),
    'the landing to scope to the clicked day');
  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the drill to open');

  // Open the detail views FROM the drill.
  await openDetail('Model × effort');
  await waitFor(() => document.querySelector('.segmented[aria-label="Detail view"]'), 'the detail bar');

  // The project came with it — the filter is set, not merely available.
  const picker = document.querySelector('select[aria-label="Project filter"]');
  assert.ok(picker, 'the project filter is on the page');
  assert.equal(picker.options[picker.selectedIndex].textContent.trim(), 'alpha');
  assert.match(cardNamed('Model × effort').querySelector('.card-note').textContent, /one project/);
  // …and so did the chart's time selection.
  assert.ok([...document.querySelectorAll('.chip')].some((node) => /\w/.test(node.textContent)),
    'the carried slice is named on the page');

  // BROWSER BACK returns to the drill the reader came from, with the slice it
  // was carrying still on it.
  window.history.back();
  await waitFor(() => crumbs().includes('alpha'), 'the drill to come back');
  assert.equal(document.querySelectorAll('.segmented[aria-label="Detail view"]').length, 0);
  assert.match(document.querySelector('.hero-sub').textContent, /of the pool ·/);

  // Changing the RANGE keeps the reader on the view he is reading (#371): a
  // range is a filter on a detail page, not a reason to send him back to the
  // landing. (A drill level IS a position, and a range change still returns
  // there to the landing — that is the slice-4 stale-route rule, held next
  // door in dashboard-drill-clicktest.)
  await openDetail('Model × effort');
  await clickLabel('30 days', () => pressed('Time range') === '30 days', 'the 30-day range');
  await waitFor(() => document.querySelector('.segmented[aria-label="Detail view"]'), 'the detail view to survive');
  assert.deepEqual(crumbs(), ['Overview', 'Model × effort']);
  assert.equal(pressed('Detail view'), 'Model × effort');
  // The project filter survived the range change; the time selection did not,
  // because its bucket keys name nothing under a different range.
  assert.equal(
    document.querySelector('select[aria-label="Project filter"]').selectedOptions[0].textContent.trim(),
    'alpha',
  );
});

test('TRIPWIRE sessions-demoted — one cross-project link, and it opens the project path', async (t) => {
  await landing(t);
  await openDetail('Sessions');
  await waitFor(() => document.querySelectorAll('.session-row').length > 0, 'the leaderboard to load');

  const rows = [...document.querySelectorAll('.session-row')];
  // Cross-project is the whole point of the one surviving link: sessions from
  // more than one project rank against each other here.
  const names = rows.map((row) => row.querySelector('.session-name').textContent);
  assert.ok(names.some((name) => name.includes('alpha')), names.join(' | '));
  assert.ok(names.some((name) => name.includes('gamma')), names.join(' | '));

  // Charter d4: a row hands the reader onto the PRIMARY path — the project
  // drill — rather than dead-ending in a session page reached sideways.
  const alpha = rows.find((row) => row.querySelector('.session-name').textContent.includes('alpha'));
  alpha.click();
  await waitFor(() => crumbs().includes('alpha'), 'the project drill to open');
  assert.equal(document.querySelectorAll('.segmented[aria-label="Detail view"]').length, 0);
});

test('the project filter narrows the matrix, and the narrowed cells still sum', async (t) => {
  await landing(t);
  await openDetail('Model × effort');
  await waitFor(() => document.querySelectorAll('.card tbody tr').length > 0, 'the matrix to load');

  const card = () => cardNamed('Model × effort');
  const tokensOf = () => card().querySelector('tfoot td:last-child').textContent.trim();
  const all = tokensOf();

  const picker = document.querySelector('select[aria-label="Project filter"]');
  const option = [...picker.options].find((entry) => entry.textContent.trim() === 'alpha');
  assert.ok(option, 'alpha is offered as a filter');
  picker.value = option.value;
  picker.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));

  await waitFor(() => tokensOf() !== all, 'the matrix to narrow to one project');
  assert.match(card().querySelector('.card-note').textContent, /one project/);

  // The narrowed matrix partitions the PROJECT's figure, and still adds up.
  const foot = [...card().querySelectorAll('tfoot td.num')];
  const grand = Number(foot[foot.length - 2].textContent.replace(/[$,]/g, ''));
  const rowTotals = [...card().querySelectorAll('tbody tr')].map((row) => {
    const cells = [...row.querySelectorAll('td.num')];
    return Number(cells[cells.length - 2].textContent.replace(/[$,]/g, ''));
  });
  assert.ok(rowTotals.length > 0, 'the narrowed matrix has rows');
  assert.ok(Math.abs(sum(rowTotals) - grand) < 0.005,
    'the narrowed rows sum to the narrowed total (' + sum(rowTotals) + ' vs ' + grand + ')');
});

test('TRIPWIRE section-filters-narrow — each headroom section narrows by account and provider, and still sums', async (t) => {
  await landing(t);

  const subs = () => cardNamed('By subscription');
  const limits = () => cardNamed('Every weekly limit');
  const labelsIn = (card) => [...card.querySelectorAll('tbody tr td:first-child')]
    .map((node) => node.textContent.trim());
  const noteIn = (card) => card.querySelector('.card-note').textContent.trim();
  const figureIn = (card) => Number(noteIn(card).replace(/[^0-9.].*$/, ''));
  const burnedIn = (card) => numbers(card.querySelectorAll('tbody tr td.num:nth-child(2)'));
  // Click a position on ONE section's own provider control, never the header's.
  const narrow = async (group, label, until, what) => {
    const control = document.querySelector('.segmented[aria-label="' + group + '"]');
    assert.ok(control, 'the section carries a ' + JSON.stringify(group) + ' control');
    const target = [...control.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === label);
    assert.ok(target, group + ' offers ' + JSON.stringify(label));
    target.click();
    await waitFor(until, what);
  };
  const choose = async (aria, text, until, what) => {
    const picker = document.querySelector('select[aria-label="' + aria + '"]');
    assert.ok(picker, 'the section carries a ' + JSON.stringify(aria) + ' picker');
    const option = [...picker.options].find((entry) => entry.textContent.trim() === text);
    assert.ok(option, aria + ' offers ' + JSON.stringify(text));
    picker.value = option.value;
    picker.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    await waitFor(until, what);
  };

  // COMBINED scope first: a section filter can only choose among what the header
  // admits, so the layering is only observable on a page carrying both providers.
  await narrow('Provider scope', 'Combined',
    () => pressed('Provider scope') === 'Combined', 'the combined scope');
  await openDetail('Headroom');
  await waitFor(() => subs().querySelectorAll('tbody tr').length === 3, 'all three subscriptions to list');

  // Unfiltered, the section is the pool — and says so.
  assert.match(noteIn(subs()), /burned across the pool/);
  assert.ok(Math.abs(sum(burnedIn(subs())) - figureIn(subs())) < 0.005,
    'the unfiltered column sums (' + sum(burnedIn(subs())) + ' vs ' + figureIn(subs()) + ')');
  const everyLimit = limits().querySelectorAll('tbody tr').length;
  assert.ok(everyLimit >= 4, 'every weekly limit of every account is listed');

  // 1. BY PROVIDER. Only the Claude subscriptions remain, the column still sums
  //    to its caption exactly, and the caption no longer claims the pool.
  await narrow('By subscription provider', 'Claude',
    () => subs().querySelectorAll('tbody tr').length === 2, 'the section to narrow to Claude');
  assert.deepEqual(new Set(labelsIn(subs())),
    new Set(['Placeholder Claude One', 'Placeholder Claude Two']));
  assert.match(noteIn(subs()), /2 of 3 subscriptions/);
  assert.equal(/across the pool/.test(noteIn(subs())), false, 'a narrowed caption drops the pool claim');
  assert.ok(Math.abs(sum(burnedIn(subs())) - figureIn(subs())) < 0.005,
    'the provider-narrowed column sums (' + sum(burnedIn(subs())) + ' vs ' + figureIn(subs()) + ')');
  // SECTION-local: the other card on the same page is untouched…
  assert.equal(limits().querySelectorAll('tbody tr').length, everyLimit);
  // …and so is the header scope this filter layers on.
  assert.equal(pressed('Provider scope'), 'Combined');

  // 2. BY ACCOUNT, narrowing further still.
  await choose('By subscription filter', 'Placeholder Claude Two',
    () => subs().querySelectorAll('tbody tr').length === 1, 'the section to narrow to one subscription');
  assert.deepEqual(labelsIn(subs()), ['Placeholder Claude Two']);
  assert.match(noteIn(subs()), /1 of 3 subscriptions/);
  assert.ok(Math.abs(sum(burnedIn(subs())) - figureIn(subs())) < 0.005,
    'the one-row column is its own caption (' + sum(burnedIn(subs())) + ' vs ' + figureIn(subs()) + ')');

  // 3. …and back out: the section returns to exactly the page's own scope.
  await choose('By subscription filter', 'All subscriptions',
    () => subs().querySelectorAll('tbody tr').length === 2, 'the account filter to clear');
  await narrow('By subscription provider', 'All',
    () => subs().querySelectorAll('tbody tr').length === 3, 'the provider filter to clear');
  assert.match(noteIn(subs()), /burned across the pool/);

  // 4. THE SECOND SECTION filters on its own, by account…
  await choose('Every weekly limit subscription', 'Placeholder Claude One',
    () => limits().querySelectorAll('tbody tr').length < everyLimit, 'the limits to narrow to one account');
  assert.deepEqual(new Set(labelsIn(limits())), new Set(['Placeholder Claude One']));
  assert.match(noteIn(limits()), new RegExp(limits().querySelectorAll('tbody tr').length + ' of ' + everyLimit + ' limits'));
  // Nested limits still print no total, filtered or not.
  assert.equal(/total/i.test(noteIn(limits())), false);

  // …and by provider, which retires an account choice that provider excludes.
  await narrow('Every weekly limit provider', 'Codex',
    () => labelsIn(limits()).every((name) => name === 'Placeholder Codex One'),
    'the limits to narrow to Codex');
  assert.ok(limits().querySelectorAll('tbody tr').length >= 1, 'the Codex limit is listed');
  assert.equal(
    document.querySelector('select[aria-label="Every weekly limit subscription"]'),
    null,
    'a single remaining subscription draws no account picker',
  );
  // The By-subscription section never followed along.
  assert.equal(subs().querySelectorAll('tbody tr').length, 3);

  // 5. NARROWING ONLY. Taking the header down to Claude removes Codex from the
  //    page; no section position can put it back.
  await narrow('Provider scope', 'Claude', () => pressed('Provider scope') === 'Claude', 'the Claude scope');
  await openDetail('Headroom');
  await waitFor(() => subs().querySelectorAll('tbody tr').length === 2, 'the page to narrow to Claude');
  assert.equal(/Placeholder Codex One/.test(document.querySelector('.page').textContent), false);
  assert.equal(document.querySelector('.segmented[aria-label="By subscription provider"]'), null,
    'one provider on the page draws no provider control');
  assert.match(noteIn(subs()), /burned across the pool/);
  assert.ok(Math.abs(sum(burnedIn(subs())) - figureIn(subs())) < 0.005,
    'the re-scoped column sums (' + sum(burnedIn(subs())) + ' vs ' + figureIn(subs()) + ')');
});

test('TRIPWIRE view-switch-persistent — the header switch is on every page, in both directions', async (t) => {
  await landing(t);

  const options = () => {
    const group = document.querySelector('.segmented[aria-label="View"]');
    return group ? [...group.querySelectorAll('button')].map((node) => node.textContent.trim()) : null;
  };
  const onLanding = () => document.querySelectorAll('.treemap .block').length > 0 && crumbs().length === 1;

  // The landing. Both positions are drawn, and the truthful one is lit.
  assert.deepEqual(options(), ['Overview', 'Detail views'], 'the landing carries both positions');
  assert.equal(pressed('View'), 'Overview');

  // Landing → detail, and the control that took the reader there is still there.
  await clickView('Detail views', () => pressed('View') === 'Detail views', 'the detail views to open');
  assert.deepEqual(options(), ['Overview', 'Detail views'], 'the detail page still carries the switch');
  assert.ok(crumbs().length > 1, 'the detail page is a level of its own');

  // …and back out through the switch itself rather than the breadcrumb.
  await clickView('Overview', onLanding, 'the switch to return to the landing');
  assert.equal(pressed('View'), 'Overview');

  // A DRILL page is below the landing, so the switch reads Overview there — and
  // it is operable, forwards…
  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the drill to open');
  assert.deepEqual(options(), ['Overview', 'Detail views'], 'the drill page carries the switch');
  assert.equal(pressed('View'), 'Overview', 'a drill page keeps the truthful position');
  await clickView('Detail views', () => pressed('View') === 'Detail views', 'the detail views from a drill');

  // …and backwards, from a drill page the reader reached the same way.
  await clickView('Overview', onLanding, 'the switch to return from the detail views');
  await clickBlock('alpha', () => crumbs().includes('alpha'), 'the drill to reopen');
  await clickView('Overview', onLanding, 'the switch to return from a drill page');
  assert.equal(pressed('View'), 'Overview');
});

test('the BUILT page the daemon serves reaches every detail view', async (t) => {
  // Everything above renders dashboard/src. This one runs the COMPILED bytes:
  // a bundle that throws on load draws an empty page in a real browser and
  // passes every source-level test in this file. It is also the only check that
  // the detail views survive minification — they are new code inside an
  // artifact that is committed rather than built at runtime.
  const data = fixture(t);
  const dom = bootPage(DASHBOARD_APP_HTML, data.app, { host: `127.0.0.1:${PORT}` });
  t.after(() => dom.window.close());
  const page = dom.window.document;

  await waitFor(() => page.querySelectorAll('.treemap .block').length > 0, 'the built landing to tile');
  const enter = [...page.querySelectorAll('button')]
    .find((node) => node.textContent.trim() === 'Detail views');
  assert.ok(enter, 'the built page carries the one way into the detail views');
  enter.click();
  await waitFor(() => page.querySelector('.segmented[aria-label="Detail view"]'), 'the built detail bar');

  for (const view of ['Headroom', 'Burn timeline', 'Model × effort', 'Sessions']) {
    const button = [...page.querySelectorAll('.segmented[aria-label="Detail view"] button')]
      .find((node) => node.textContent.trim() === view);
    assert.ok(button, 'the built page offers ' + view);
    button.click();
    await waitFor(
      () => page.querySelectorAll('.card table tbody tr, .card .session-row, .card .empty').length > 0,
      'the built ' + view + ' view to draw',
    );
    assert.equal(page.querySelectorAll('.card.error').length, 0, view + ' loaded without error');
  }

  // …and the BUILT header switch still walks back out (issue #409).
  const back = [...page.querySelectorAll('.segmented[aria-label="View"] button')]
    .find((node) => node.textContent.trim() === 'Overview');
  assert.ok(back, 'the built detail page carries the way back');
  back.click();
  await waitFor(() => page.querySelectorAll('.treemap .block').length > 0, 'the built landing to return');
});
