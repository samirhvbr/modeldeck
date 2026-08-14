// Issue #385 — the Overview landing, CLICK-TESTED in a real DOM.
//
// THE NAMED TRIPWIRE of this slice is the first test below:
//   'provider stack order survives the load → Codex → Combined round-trip'
// Round 13's regression was that after visiting a single-provider scope and
// coming back to Combined, Codex stopped being the baseline band: Recharts
// assigns stack order by MOUNT order, so a series that leaves and re-enters the
// chart rejoins the stack on top wherever it sits in the series list. The fix is
// a chart keyed on the series set (DailyChart's stackKey) plus a fixed
// PROVIDER_STACK_ORDER; neither is observable from the source, so it is held
// here, on the drawn geometry, at the level a reader sees it.
//
// The page is driven against the REAL daemon readers — the fetch stub calls the
// app's own request listener, so these clicks also prove the landing's queries
// pass the readers' parameter validation. Placeholder identities and synthetic
// paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import {
  bootPage, installDom, installFetch, loadModule, waitFor,
} from '../dashboard/test-support/index.mjs';

const PORT = 43385;
const TOKEN = 'overview-clicktest-placeholder-token';
const CLAUDE_PROJECT = '/placeholder/projects/alpha';
const CODEX_PROJECT = '/placeholder/projects/beta';
// Claude wears categorical slot 2 and Codex slot 1 (Overview's PROVIDER_SLOT).
// The marks carry the CSS variable verbatim, which makes them the series' own
// identifiers in the DOM.
const CLAUDE_INK = 'var(--cat-2)';
const CODEX_INK = 'var(--cat-1)';
// One model id recorded under BOTH providers, which is what the model-series
// keys have to survive.
const SHARED_MODEL = 'shared-placeholder-model';

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function transcriptRequest({ key, sessionId, observedAt, input, output }) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug: 'placeholder-claude-profile',
    messageId: key,
    recordUuid: null,
    model: 'claude-opus-5',
    effort: null,
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
 * A pool with both providers burning, and a project on each side, at two hours
 * inside the default 7-day range — enough for a stacked chart, a treemap and a
 * priced model table.
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
  // Rising weekly levels: burn is the sum of the RISES, so the first snapshot
  // only establishes the floor.
  for (const [account, levels] of [[claude, [10, 20, 40]], [codex, [5, 9, 15]]]) {
    levels.forEach((usedPercent, index) => {
      store.recordUsage(account.id, {
        scope: 'weekly',
        observedAt: hoursAgo([30, 26, 2][index]),
        usedPercent,
        resetsAt: hoursAgo(-48),
        source: 'overview-clicktest-fixture',
        detail: { fixture: 'placeholder' },
      });
    });
  }

  store.ingestTranscriptBatch({
    sessions: [{
      sessionId: 'placeholder-claude-session',
      profileSlug: 'placeholder-claude-profile',
      machine: 'placeholder-machine',
      cwd: CLAUDE_PROJECT,
      gitBranch: 'main',
      firstAt: hoursAgo(26),
      lastAt: hoursAgo(2),
    }],
    requests: [
      transcriptRequest({
        key: 'alpha-early', sessionId: 'placeholder-claude-session',
        observedAt: hoursAgo(26), input: 4000, output: 900,
      }),
      transcriptRequest({
        key: 'alpha-late', sessionId: 'placeholder-claude-session',
        observedAt: hoursAgo(2), input: 9000, output: 1800,
      }),
    ],
  });
  store.ingestCodexSession(
    {
      sessionId: 'placeholder-codex-session',
      profileSlug: 'placeholder-codex-profile',
      machine: 'placeholder-machine',
      cwd: CODEX_PROJECT,
      gitBranch: 'main',
      firstTimestamp: hoursAgo(26),
      lastTimestamp: hoursAgo(2),
      archived: false,
    },
    [
      {
        turnIndex: 0, turnId: 'turn-0', model: 'gpt-5.6-sol', reasoningEffort: 'medium',
        inputTokens: 3000, cachedInputTokens: 6000, cacheWriteInputTokens: 0,
        outputTokens: 900, reasoningOutputTokens: 300, totalTokens: 9900,
        timestamp: hoursAgo(26),
      },
      {
        turnIndex: 1, turnId: 'turn-1', model: 'gpt-5.6-sol', reasoningEffort: 'medium',
        inputTokens: 5000, cachedInputTokens: 9000, cacheWriteInputTokens: 0,
        outputTokens: 1200, reasoningOutputTokens: 400, totalTokens: 15200,
        timestamp: hoursAgo(2),
      },
    ],
  );
  // The proxy warehouse is what the COST lens prices, and it is a separate
  // universe from the transcripts above.
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
    // The SAME model id under both providers — two rows in the per-model table
    // that a model-keyed series list would collapse into one.
    proxyRecord({
      requestId: 'proxy-shared-claude', observedAt: hoursAgo(26), provider: 'claude',
      model: SHARED_MODEL, source: 'placeholder-claude@example.invalid', total: 30000,
    }),
    proxyRecord({
      requestId: 'proxy-shared-codex', observedAt: hoursAgo(2), provider: 'codex',
      model: SHARED_MODEL, source: 'placeholder-codex-source-hash', total: 50000,
    }),
  ]);
  return { claude, codex };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-overview-click-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  store.saveSettings({ usageAnalyticsEnabled: true });
  const accounts = seed(store, root);
  const service = {
    projectsRoot: root,
    startAutoRefresh() {},
    stopAutoRefresh() {},
    async state() { return store.state(); },
  };
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: PORT,
    mutationToken: TOKEN,
    laneManifestPath: path.join(root, 'absent-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store, accounts };
}

/**
 * Mount the landing and wait for its first load to draw. installDom runs before
 * the bundle is imported because react-dom expects a document at module scope.
 *
 * The root and the window are torn down after each test: five live jsdom windows
 * each holding a mounted React tree (with its ResizeObserver and its timers) is a
 * leak that grows with every test added here.
 */
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
  await waitFor(() => seriesCount() > 0, 'the chart to draw');
  return data;
}

async function clickLabel(label, until, what) {
  const target = [...document.querySelectorAll('button')]
    .find((node) => node.textContent.trim() === label);
  assert.ok(target, 'a button labelled ' + JSON.stringify(label) + ' exists');
  target.click();
  await waitFor(until, what || 'the page to answer ' + JSON.stringify(label));
  return target;
}

/**
 * The drawn geometry of one stacked series, bucket by bucket. Every path command
 * the bar shape emits (M/L/Q/Z) takes coordinate PAIRS, so the flat number list
 * is x,y,x,y — the odd entries are the y's.
 */
function segments(ink) {
  const layer = [...document.querySelectorAll('.recharts-bar')]
    .find((node) => [...node.querySelectorAll('path')].some((mark) => mark.getAttribute('fill') === ink));
  if (!layer) return [];
  return [...layer.querySelectorAll('path')]
    .filter((mark) => mark.getAttribute('fill') === ink)
    .map((mark) => {
      const numbers = (mark.getAttribute('d').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      const ys = numbers.filter((value, index) => index % 2 === 1);
      return { top: Math.min(...ys), bottom: Math.max(...ys) };
    });
}

function seriesCount() {
  // The transparent full-height hit bar is a Bar too; it is not a series.
  return [...document.querySelectorAll('.recharts-bar')]
    .filter((node) => [...node.querySelectorAll('path')]
      .some((mark) => mark.getAttribute('fill') !== 'transparent')).length;
}

test('provider stack order survives the load → Codex → Combined round-trip', async (t) => {
  await landing(t);

  // The landing opens on Claude: one series, and it is Claude's.
  assert.equal(seriesCount(), 1, 'the Claude scope draws exactly one series');
  assert.ok(segments(CLAUDE_INK).length > 0, 'and it is the Claude series');
  assert.equal(segments(CODEX_INK).length, 0);

  await clickLabel('Codex', () => segments(CODEX_INK).length > 0 && segments(CLAUDE_INK).length === 0,
    'the Codex scope to draw');
  assert.equal(seriesCount(), 1, 'the Codex scope draws exactly one series');

  // …and back to Combined, which is where the regression showed itself.
  for (const trip of [1, 2]) {
    await clickLabel('Combined',
      () => segments(CODEX_INK).length > 0 && segments(CLAUDE_INK).length > 0,
      'trip ' + trip + ': both series to draw');
    const codex = segments(CODEX_INK);
    const claude = segments(CLAUDE_INK);
    assert.equal(seriesCount(), 2, 'trip ' + trip + ': Combined draws both series');
    assert.ok(codex.length > 0 && claude.length > 0, 'trip ' + trip + ': both series are drawn');
    assert.equal(codex.length, claude.length, 'trip ' + trip + ': one segment each per bucket');

    const baseline = Math.max(...codex.map((cell) => cell.bottom), ...claude.map((cell) => cell.bottom));
    codex.forEach((cell, index) => {
      const above = claude[index];
      assert.ok(
        Math.abs(cell.bottom - baseline) < 1,
        'trip ' + trip + ', bucket ' + index + ': Codex sits on the plot baseline',
      );
      assert.ok(
        above.bottom < cell.top + 1,
        'trip ' + trip + ', bucket ' + index + ': Claude is stacked above Codex, never under it',
      );
    });

    // Round-trip through a single-provider scope: the second pass is the one
    // that used to come back with the stack inverted.
    if (trip === 1) {
      await clickLabel('Claude', () => segments(CODEX_INK).length === 0, 'the Claude scope to draw');
    }
  }
});

test('the landing leads with availability in subscriptions, then the chart, then the treemap', async (t) => {
  await landing(t);
  const page = document.querySelector('.page');

  // Availability headline, in subscriptions — and the word 'windows' appears
  // nowhere but its one defining tooltip.
  assert.match(page.querySelector('.hero').textContent, /Can I start heavy work now\?/);
  assert.match(page.textContent, /weekly subscriptions/);
  const surfaces = [...page.querySelectorAll('.hero, .movers, .card')]
    .map((node) => node.textContent).join(' ');
  assert.equal(/\bwindows?\b/i.test(surfaces), false, 'no rendered figure surface says "window"');
  // The only 'window' left anywhere on the page is the pinned price file's name.
  assert.deepEqual(
    page.querySelector('.footer').textContent.match(/[\w.]*window[\w.]*/gi),
    ['model_prices_and_context_window.json'],
  );
  const tooltips = [...page.querySelectorAll('[title]')].map((node) => node.getAttribute('title')).join(' ');
  assert.match(tooltips, /usage levels across the pool/);

  // Document order: hero → chart → treemap (amendment decision 9).
  const order = [...page.querySelectorAll('.hero, .chart-wrap, .treemap')]
    .map((node) => node.className.split(' ')[0]);
  assert.deepEqual(order, ['hero', 'chart-wrap', 'treemap']);

  // A block is an activatable button and says so to a screen reader: no role
  // attribute overrides that, and each carries its own figure in its label.
  for (const block of document.querySelectorAll('.treemap .block')) {
    assert.equal(block.tagName, 'BUTTON');
    assert.equal(block.getAttribute('role'), null, 'nothing overrides the button role');
    assert.match(block.getAttribute('aria-label'), /\d/);
  }

  // Blocks are real and labelled, and the pool figure is a number.
  const names = () => [...document.querySelectorAll('.treemap .block .block-name-text')]
    .map((node) => node.textContent.trim());
  assert.deepEqual(names(), ['alpha'], 'the Claude scope shows the Claude project');
  assert.match(document.querySelector('.hero-figure').textContent, /^\d+\.\d{2}/);

  // Combined is a legitimate scope, and both projects tile it.
  await clickLabel('Combined', () => names().includes('beta'), 'the Codex project to join the map');
  assert.deepEqual(names().sort(), ['alpha', 'beta']);
});

test('the COST lens re-denominates the page and shows the model table with its API-rate caveat', async (t) => {
  await landing(t);
  const cardTitles = () => [...document.querySelectorAll('.card-title')].map((node) => node.textContent);
  // Issue #387 (charter d2): per-account headroom is no longer ON the landing —
  // it is a detail page, and the landing carries the pool verdict instead.
  assert.equal(cardTitles().some((title) => title.startsWith('By subscription')), false, 'headroom is demoted');
  assert.equal(cardTitles().some((title) => title.startsWith('By model')), false, 'no model table yet');

  await clickLabel('Cost', () => document.querySelector('.hero-figure').textContent.startsWith('$'),
    'the cost lens to re-denominate the headline');
  const titles = [...document.querySelectorAll('.card-title')].map((node) => node.textContent);
  assert.ok(titles.some((title) => title.startsWith('By model')), 'the model table is on the cost lens');
  assert.match(document.querySelector('.hero-sub').textContent, /\* if billed at full API rate/);

  // Every printed row sums to the printed total (largest remainder at the
  // printed precision), which is the rule the decider checks by hand.
  const card = [...document.querySelectorAll('.card')]
    .find((node) => node.querySelector('.card-title')?.textContent.startsWith('By model'));
  const cells = [...card.querySelectorAll('tbody tr')]
    .map((row) => row.querySelectorAll('td.num')[0].textContent);
  const sum = cells.reduce((total, text) => total + Number(text.replace(/[$,]/g, '')), 0);
  const printed = Number(card.querySelector('.card-note').textContent.replace(/[^0-9.]/g, ''));
  assert.ok(cells.length > 0, 'the model table has rows');
  assert.ok(Math.abs(sum - printed) < 0.005, 'model rows sum to the printed total (' + sum + ' vs ' + printed + ')');

  await clickLabel('Subscriptions', () => /^\d/.test(document.querySelector('.hero-figure').textContent),
    'the subscriptions lens to come back');
});

/** The Projects card's note, which says what the blocks are currently scoped to. */
function projectsNote() {
  const card = [...document.querySelectorAll('.card')]
    .find((node) => node.querySelector('.card-title')?.textContent.startsWith('Projects'));
  return card ? card.querySelector('.card-note').textContent : '';
}

test('a click on the chart re-scopes the treemap, and clears again', async (t) => {
  await landing(t);
  assert.match(projectsNote(), /full range/);

  const hit = document.querySelector('.recharts-bar path[fill="transparent"]');
  assert.ok(hit, 'the chart has a full-height hit target per bucket');
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /scoped to /.test(projectsNote()), 'the treemap to re-scope to the clicked day');

  await clickLabel('Clear selection', () => /full range/.test(projectsNote()),
    'the selection to clear');
});

test('one model id under two providers stays two series, each with its own values', async (t) => {
  await landing(t);
  await clickLabel('Combined', () => segments(CODEX_INK).length > 0, 'the Combined scope to draw');
  await clickLabel('Model', () => document.querySelectorAll('.legend-item').length > 2,
    'the model series to draw');

  // Both providers' rows for the shared id are present, and drawn as their own
  // bands: keyed on the model id alone, the second row overwrote the first's
  // values and one band came out empty.
  const labels = [...document.querySelectorAll('.legend-item')].map((node) => node.textContent.trim());
  assert.equal(labels.filter((label) => label === SHARED_MODEL).length, 2, labels.join(' | '));

  await clickLabel('Table', () => document.querySelectorAll('table.data').length > 0, 'the data table');
  const table = document.querySelector('table.data');
  const headers = [...table.querySelectorAll('thead th')].map((node) => node.textContent.trim());
  const rows = [...table.querySelectorAll('tbody tr')]
    .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()));
  // Column 0 is the bucket, the last is the Total; every series column between
  // them carries a figure somewhere.
  for (let column = 1; column < headers.length - 1; column += 1) {
    const drawn = rows.some((row) => Number(row[column].replace(/[$,]/g, '')) > 0);
    assert.ok(drawn, 'series column ' + JSON.stringify(headers[column]) + ' carries its own values');
  }
});

/*
 * THE NAMED TRIPWIRE of issue #411 (rule 9).
 *
 * The blocks section switches between Projects / Accounts / Providers, and the
 * one thing that must hold under all three is the treemap's contract: the blocks
 * are sized by the figure printed on them, and those figures sum EXACTLY to the
 * section's own total — the SAME total under every dimension, because all three
 * partition the same measured pool. A dimension that computes its own total a
 * second way is exactly the drift this holds the line against. It also holds the
 * #409 lesson (no affordance that strands the reader: the two dimensions with no
 * level below them are inert and say so) and the carry-through of the chart's
 * time selection and the range filter into the chosen dimension.
 */
function blocksCard() {
  return [...document.querySelectorAll('.card')]
    .find((node) => node.querySelector('[aria-label="Block dimension"]'));
}

/** The dimension the segment control currently reads as chosen. */
function chosenDimension() {
  const group = blocksCard().querySelector('[aria-label="Block dimension"]');
  const on = [...group.querySelectorAll('button')].find((node) => node.getAttribute('aria-pressed') === 'true');
  return on ? on.textContent.trim() : null;
}

/** The blocks card's own note — which says what the blocks are scoped to. */
function blocksNote() {
  return blocksCard().querySelector('.card-note').textContent;
}

function blockNames() {
  return [...blocksCard().querySelectorAll('.treemap .block .block-name-text')]
    .map((node) => node.textContent.trim())
    .sort();
}

/** Every printed block figure, and the section total they have to add up to. */
function blockSum() {
  const card = blocksCard();
  assert.equal(card.querySelector('.more-chip'), null,
    'this fixture is small enough that nothing folds — a fold would make the sum below partial');
  const printed = [...card.querySelectorAll('.treemap .block .block-value')]
    .map((node) => Number(node.textContent.replace(/[$,]/g, '')));
  const total = Number((card.querySelector('.card-note').textContent.match(/([\d.,]+)\s*subscriptions/) || [])[1]
    ?.replace(/,/g, ''));
  return { sum: printed.reduce((acc, value) => acc + value, 0), total, count: printed.length };
}

/** One named block's printed figure. */
function blockValue(name) {
  const block = [...blocksCard().querySelectorAll('.treemap .block')]
    .find((node) => node.querySelector('.block-name-text').textContent.trim() === name);
  assert.ok(block, 'a block named ' + JSON.stringify(name) + ' is on the map');
  return Number(block.querySelector('.block-value').textContent.replace(/[$,]/g, ''));
}

test('the blocks dimension switch: every dimension tiles, sums exactly, and survives a range change', async (t) => {
  await landing(t);

  // The landing opens on the Claude scope, so this is Claude's measured burn
  // arrived at a completely different way — by filtering the whole page. It is
  // what the Claude blocks below have to agree with: the final rounding pass
  // FORCES the blocks to sum to the section total, so a dimension that only
  // covered part of the pool would still print a tidy column of inflated
  // figures. This is the check that catches that.
  const claudeOnly = blockSum().total;
  assert.ok(claudeOnly > 0, 'the Claude scope measures some burn');

  await clickLabel('Combined', () => blockNames().includes('beta'), 'both providers in scope');

  // Projects is the default, and it is the one dimension with a level below it.
  assert.equal(chosenDimension(), 'Projects');
  assert.deepEqual(blockNames(), ['alpha', 'beta']);
  const first = blockSum();
  assert.ok(first.total > 0, 'the section prints a total');
  assert.ok(Math.abs(first.sum - first.total) < 0.005,
    'Projects blocks sum to the section total (' + first.sum + ' vs ' + first.total + ')');
  for (const block of blocksCard().querySelectorAll('.treemap .block')) {
    assert.equal(block.getAttribute('aria-disabled'), null, 'a project block opens the project drill');
  }

  // Accounts: measured per account, the pool's own labels, same total.
  await clickLabel('Accounts', () => chosenDimension() === 'Accounts', 'the accounts dimension');
  assert.deepEqual(blockNames(), ['Placeholder Claude One', 'Placeholder Codex One']);
  const accounts = blockSum();
  assert.equal(accounts.total, first.total, 'the section total does not move with the dimension');
  assert.ok(Math.abs(accounts.sum - accounts.total) < 0.005,
    'Accounts blocks sum to the section total (' + accounts.sum + ' vs ' + accounts.total + ')');
  assert.ok(Math.abs(blockValue('Placeholder Claude One') - claudeOnly) < 0.011,
    'the one Claude account carries the Claude scope\'s own measured burn ('
      + blockValue('Placeholder Claude One') + ' vs ' + claudeOnly + ')');

  // Providers: whatever the data carries, never a hard-coded pair.
  await clickLabel('Providers', () => chosenDimension() === 'Providers', 'the providers dimension');
  assert.deepEqual(blockNames(), ['Claude', 'Codex']);
  const providers = blockSum();
  assert.equal(providers.total, first.total, 'the section total does not move with the dimension');
  assert.ok(Math.abs(providers.sum - providers.total) < 0.005,
    'Providers blocks sum to the section total (' + providers.sum + ' vs ' + providers.total + ')');
  assert.ok(Math.abs(blockValue('Claude') - claudeOnly) < 0.011,
    'the Claude block carries the Claude scope\'s own measured burn ('
      + blockValue('Claude') + ' vs ' + claudeOnly + ')');

  // Neither of the two carries a drill, so neither strands the reader: the
  // blocks are inert and every one of them says why on hover.
  for (const dimension of ['Accounts', 'Providers']) {
    await clickLabel(dimension, () => chosenDimension() === dimension);
    const blocks = [...blocksCard().querySelectorAll('.treemap .block')];
    assert.ok(blocks.length > 0, dimension + ' draws blocks');
    for (const block of blocks) {
      // aria-disabled, not the disabled attribute: a disabled button fires no
      // pointer events and takes no focus, so the sentence below would reach
      // neither a hovering mouse nor a keyboard.
      assert.equal(block.getAttribute('aria-disabled'), 'true',
        dimension + ': blocks are inert, not dead ends');
      assert.equal(block.disabled, false, dimension + ': and still reachable to hover and focus');
      assert.match(block.getAttribute('title'), /No level below a/,
        dimension + ': the block says on hover why it does not open');
    }
  }

  // The chart's time selection scopes the blocks under the chosen dimension too
  // (#371 carry-through) — and the total it sums to is the scoped one.
  // The LAST bucket, which is the one this fixture burns in — an empty bucket
  // would make the sum below trivially 0 = 0.
  const hits = [...document.querySelectorAll('.recharts-bar path[fill="transparent"]')];
  hits[hits.length - 1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /scoped to /.test(blocksNote()), 'the blocks to re-scope to the clicked bucket');
  const scoped = blockSum();
  assert.ok(scoped.total > 0 && scoped.total <= first.total, 'the slice is a part of the range');
  assert.ok(Math.abs(scoped.sum - scoped.total) < 0.005,
    'the scoped Providers blocks still sum exactly (' + scoped.sum + ' vs ' + scoped.total + ')');
  await clickLabel('Clear selection', () => /full range/.test(blocksNote()));

  // …and the chosen dimension survives a change of range, which reloads the
  // whole model underneath it.
  await clickLabel('30 days', () => chosenDimension() === 'Providers' && blockNames().length > 0,
    'the 30-day range to load with Providers still chosen');
  assert.deepEqual(blockNames(), ['Claude', 'Codex']);
  const wider = blockSum();
  assert.ok(Math.abs(wider.sum - wider.total) < 0.005,
    'and the wider range still sums exactly (' + wider.sum + ' vs ' + wider.total + ')');
  assert.deepEqual(
    [...blocksCard().querySelectorAll('[aria-label="Block dimension"] button')]
      .map((node) => node.textContent.trim()),
    ['Projects', 'Accounts', 'Providers'],
    'all three positions are still offered',
  );
});

test('folded alternate rows stay reachable and explain themselves', async (t) => {
  // The treemap blocks carry aria-disabled + a title instead of the native
  // disabled attribute, so inert blocks stay hoverable and focusable — but the
  // "+N more" FOLDED LIST renders through its own JSX, and review of #411
  // caught it still using native disabled there. This drives that exact path:
  // enough sliver accounts that the Accounts dimension MUST fold.
  const data = fixture(t);
  for (let index = 2; index <= 13; index += 1) {
    const sliver = data.store.saveAccount({
      provider: 'claude',
      label: 'Placeholder Claude Sliver ' + index,
      identity: 'placeholder-sliver-' + index + '@example.invalid',
      profileRef: path.join(os.tmpdir(), 'claude-sliver-' + index),
    });
    // A 0.2-point rise each: far below the minimum legible cell against the
    // main account's 30-point rise, so these can only render folded.
    [0.1, 0.2, 0.3].forEach((usedPercent, levelIndex) => {
      data.store.recordUsage(sliver.id, {
        scope: 'weekly',
        observedAt: hoursAgo([30, 26, 2][levelIndex]),
        usedPercent,
        resetsAt: hoursAgo(-48),
        source: 'overview-clicktest-fixture',
        detail: { fixture: 'placeholder' },
      });
    });
  }
  const dom = installDom({ width: 1040, height: 340 });
  installFetch(data.app, { host: `127.0.0.1:${PORT}` });
  const harness = await loadModule('test-support/mount.jsx');
  const root = harness.mountApp(document.getElementById('root'));
  t.after(() => {
    root.unmount();
    dom.window.close();
  });
  await waitFor(() => document.querySelector('.hero-figure'), 'the headline to load');
  await waitFor(() => seriesCount() > 0, 'the chart to draw');

  await clickLabel('Accounts', () => chosenDimension() === 'Accounts');
  // The fold announces itself either as the header chip or as the map's own
  // "+N more" block, depending on whether the block fits — open whichever.
  const opener = blocksCard().querySelector('.more-chip')
    || [...blocksCard().querySelectorAll('.treemap .block')]
      .find((node) => /\+\d+ more/.test(node.textContent));
  assert.ok(opener, 'the sliver accounts fold into a +N more opener');
  opener.click();
  await waitFor(() => blocksCard().querySelectorAll('.folded-row').length > 0,
    'the folded list to open');

  const rows = [...blocksCard().querySelectorAll('.folded-row')];
  assert.ok(rows.length >= 12, 'the slivers are all in the folded list (' + rows.length + ')');
  for (const row of rows) {
    // aria-disabled, not the disabled attribute — same contract as the blocks:
    // a native-disabled row leaves the tab order and drops the hover title.
    assert.equal(row.getAttribute('aria-disabled'), 'true',
      'a folded account row is inert, not a dead end');
    assert.equal(row.disabled, false, 'and still reachable to hover and focus');
    assert.match(row.getAttribute('title') || '', /No level below a/,
      'and says on hover why it does not open');
  }
});

test('the BUILT page the daemon serves boots and draws, not just the sources', async (t) => {
  // Everything above renders dashboard/src. This one runs the compiled bytes:
  // a bundle that throws on load draws an empty page in a real browser and
  // passes every source-level test in this file.
  const data = fixture(t);
  const dom = bootPage(DASHBOARD_APP_HTML, data.app, { host: `127.0.0.1:${PORT}` });
  t.after(() => dom.window.close());
  const { document: page } = dom.window;

  await waitFor(() => page.querySelector('.hero-figure'), 'the built page to draw its headline');
  await waitFor(() => page.querySelectorAll('.treemap .block').length > 0, 'the built page to tile');
  assert.match(page.querySelector('.hero-figure').textContent, /^\d+\.\d{2}/);
  assert.match(page.querySelector('.hero').textContent, /Can I start heavy work now\?/);
  assert.equal(page.querySelectorAll('.card.error').length, 0, 'and no load error');
});

test('the theme toggle is persisted and drives the document, System leaving it to the OS', async (t) => {
  await landing(t);
  assert.equal(document.documentElement.getAttribute('data-theme'), null);

  await clickLabel('Dark', () => document.documentElement.getAttribute('data-theme') === 'dark');
  assert.equal(localStorage.getItem('modeldeck.overview.theme'), 'dark');

  await clickLabel('Light', () => document.documentElement.getAttribute('data-theme') === 'light');
  assert.equal(localStorage.getItem('modeldeck.overview.theme'), 'light');

  await clickLabel('System', () => document.documentElement.getAttribute('data-theme') === null);
  assert.equal(localStorage.getItem('modeldeck.overview.theme'), 'system');
});
