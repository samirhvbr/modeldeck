// Issue #385: the Overview landing's derivations, tested where they live.
//
// These are the rules the decider checks by hand and the ones a refit (#383/#384)
// could silently break: printed parts sum to the printed total, a block that
// cannot be drawn legibly folds instead of shearing its label, ModelDeck's own
// automation directories are not projects, movers print a ratio and never an
// absolute, and prices come from the pinned snapshot. The modules are JSX-free,
// so they are bundled and imported directly (dashboard/test-support).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from '../dashboard/test-support/index.mjs';

// A fixed zone with a DST transition, so the range boundaries can be tested
// where fixed-24-hour arithmetic breaks. Set before any Date is constructed.
process.env.TZ = 'America/Los_Angeles';

const model = await loadModule('src/model.js');
const api = await loadModule('src/api.js');
const chart = await loadModule('src/DailyChart.jsx');
const layout = await loadModule('src/Treemap.jsx');
const detectors = await loadModule('src/detectors.js');
const prices = await loadModule('src/prices.js');
const format = await loadModule('src/format.js');

test('printed parts sum to the printed total at the printed precision', () => {
  const cases = [
    { values: [1 / 3, 1 / 3, 1 / 3], total: 1, places: 2 },
    { values: [0.004, 0.004, 0.004, 8.988], total: 9, places: 2 },
    { values: [10.005, 20.005, 30.005], total: 60.02, places: 2 },
    { values: [0, 0, 5], total: 5, places: 2 },
    { values: [99.999, 0.001], total: 100, places: 0 },
    { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], total: 55.55, places: 2 },
  ];
  for (const { values, total, places } of cases) {
    const shown = model.allocateRounded(values, total, places);
    const factor = 10 ** places;
    const summed = shown.reduce((sum, value) => sum + Math.round(value * factor), 0);
    assert.equal(summed, Math.round(total * factor), JSON.stringify(values) + ' sums to ' + total);
    for (const value of shown) assert.ok(value >= 0, 'no part is negative');
  }
});

test('rounding drift is taken off a part, never left on the total', () => {
  // Floors that overshoot the target by a cent give the cent back rather than
  // printing a column that adds up to more than its own total.
  const shown = model.allocateRounded([2, 2], 3.99, 2);
  assert.equal(shown.reduce((sum, value) => sum + value, 0).toFixed(2), '3.99');
  for (const value of shown) assert.ok(value >= 0, 'no part is negative');
});

test('worktree cwds fold into their checkout, and ModelDeck internals are not a project', () => {
  assert.equal(model.foldCwd('/p/repo/.claude/worktrees/lane-a/sub').parent, '/p/repo');
  assert.equal(model.foldCwd('/p/repo').parent, '/p/repo');

  const internal = '/Users/placeholder/Library/Application Support/ModelDeck/claude-renewal';
  assert.equal(model.isInternalPath(internal), true);

  // With a modeldeck checkout in range, the internals fold into it…
  const withCheckout = model.buildKeyResolver([internal, '/p/projects/modeldeck', '/p/projects/other']);
  assert.equal(withCheckout(internal), '/p/projects/modeldeck');
  assert.equal(withCheckout('/p/projects/other'), '/p/projects/other');
  // …and without one they carry one honest label instead of a machine path.
  const alone = model.buildKeyResolver([internal]);
  assert.equal(alone(internal), model.INTERNAL_KEY);
  assert.equal(model.projectKeyOf({ key: internal }, alone), model.INTERNAL_KEY);
  assert.equal(model.projectKeyOf({ unattributed: true }, alone), model.UNATTRIBUTED);
});

test('measured burn is the sum of the RISES, so a reset counts as fresh burn', () => {
  const rows = [
    { bucketStart: '2026-08-03T00:00:00.000Z', maxUsedPercent: 12, lastUsedPercent: 12 },
    { bucketStart: '2026-08-02T00:00:00.000Z', maxUsedPercent: 95, lastUsedPercent: 8 },
    { bucketStart: '2026-08-01T00:00:00.000Z', maxUsedPercent: 60, lastUsedPercent: 60 },
    { bucketStart: '2026-07-31T00:00:00.000Z', maxUsedPercent: 20, lastUsedPercent: 20 },
  ];
  // Newest-first, as the endpoint returns them: 20 → 60 (+40), then a reset
  // inside the next bucket (95 peak, ends at 8 → +35 +8), then 8 → 12 (+4).
  const burned = model.burnedSeries({ rows });
  assert.equal(Math.round(burned.subscriptions * 100), 87);
  const summed = [...burned.byHour.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(summed), 87);
});

test('nested weekly limits are never summed: the worst level binds', () => {
  const state = {
    accounts: [
      { id: 'a', label: 'Placeholder A', provider: 'claude', enabled: true },
      { id: 'b', label: 'Placeholder B', provider: 'claude', enabled: false },
    ],
    usage: [
      { accountId: 'a', scope: 'weekly', usedPercent: 40 },
      { accountId: 'a', scope: 'model-weekly', usedPercent: 91 },
      { accountId: 'a', scope: 'weekly-spend', usedPercent: 99 },
      { accountId: 'b', scope: 'weekly', usedPercent: 12 },
    ],
  };
  const rows = model.accountWindows(state, 'claude');
  assert.equal(rows.length, 1, 'a disabled account is not in the pool');
  assert.equal(rows[0].binding.scope, 'model-weekly');
  assert.equal(rows[0].weeklyScopeNames.includes('weekly-spend'), false, 'spend caps are not usage limits');
});

test('a block too small to carry a label folds into one "+N more", and the fold is stable', () => {
  const items = [
    { key: 'big', value: 100 },
    { key: 'mid', value: 30 },
    { key: 'small', value: 0.4 },
    { key: 'tiny', value: 0.2 },
  ];
  const size = { width: 800, height: 300 };
  const folded = layout.collapseSmall(items, size);
  assert.deepEqual(folded.kept.map((item) => item.key), ['big', 'mid']);
  assert.deepEqual(folded.hidden.map((item) => item.key), ['small', 'tiny']);
  // Same input, same fold — never a function of what the pointer is near.
  assert.deepEqual(
    layout.collapseSmall(items, size).hidden.map((item) => item.key),
    ['small', 'tiny'],
  );
  // A tail too small to draw does not cost the map its legible blocks: the
  // remainder gives up its own cell (moreFits false → the card head carries it).
  assert.equal(folded.moreFits, false);

  // Every drawn cell clears the legible floor, and the tiles cover the map.
  const hiddenValue = folded.hidden.reduce((sum, item) => sum + item.value, 0);
  const placed = layout.squarify(folded.kept.concat([{ key: '__more', value: hiddenValue }]), {
    x: 0, y: 0, w: 100, h: 100,
  });
  const area = placed.reduce((sum, cell) => sum + cell.w * cell.h, 0);
  assert.ok(Math.abs(area - 10000) < 1, 'the blocks tile the whole map');
  for (const cell of placed) {
    if (cell.item.key === '__more' && !folded.moreFits) continue;
    assert.ok((cell.w / 100) * size.width >= layout.MIN_CELL_W - 1e-6, cell.item.key + ' can be labelled');
    assert.ok((cell.h / 100) * size.height >= layout.MIN_CELL_H - 1e-6, cell.item.key + ' can be labelled');
  }

  // On a wide map the same share is legible and nothing folds — the floor is
  // geometric, not a share threshold.
  const roomy = layout.collapseSmall(
    [{ key: 'a', value: 60 }, { key: 'b', value: 40 }], { width: 1200, height: 400 },
  );
  assert.deepEqual(roomy.hidden, []);
});

test('a flagged project is folded last, but its flag never protects a sliver', () => {
  const items = [
    { key: 'big', value: 100 },
    { key: 'mid', value: 40 },
    { key: 'flagged', value: 6, pin: true },
    { key: 'small', value: 5 },
  ];
  const folded = layout.collapseSmall(items, { width: 420, height: 200 });
  assert.equal(folded.kept.some((item) => item.key === 'small'), false, 'the loose block folds first');

  // When the pinned block is itself the illegible one the pin is void: a badge
  // nobody can read is not worth an unreadable map.
  const hopeless = layout.collapseSmall(
    [{ key: 'big', value: 1000 }, { key: 'flagged', value: 0.3, pin: true }],
    { width: 300, height: 120 },
  );
  assert.deepEqual(hopeless.hidden.map((item) => item.key), ['flagged']);
});

test('cache health is an absolute rate with a request floor, never a comparison', () => {
  const project = (requests, uncached) => ({
    requests, flows: { inputUncached: uncached, inputCacheRead: 1_000_000, inputCacheWrite: 0 },
  });
  assert.equal(detectors.cacheHealth(project(1000, 9_800_000)).level, 'red');
  assert.equal(detectors.cacheHealth(project(1000, 400_000)).level, 'amber');
  assert.equal(detectors.cacheHealth(project(1000, 8_000)).level, 'ok');
  // Below the request floor the rate is noise, so nothing is claimed.
  assert.equal(detectors.cacheHealth(project(5, 9_800_000)).level, 'unknown');
  assert.equal(detectors.cacheHealth({ requests: 0, flows: {} }).level, 'unknown');
});

test('movers print a pace RATIO against a covered baseline, and stay silent otherwise', () => {
  const entry = (key) => ({ key, name: key });
  const rows = [
    { entry: entry('loud'), tokens: 800 },
    { entry: entry('steady'), tokens: 190 },
    { entry: entry('crumb'), tokens: 1 },
  ];
  const baseline = {
    days: 10,
    clamped: false,
    tokensByProject: new Map([['loud', 400], ['steady', 1900]]),
  };
  const out = detectors.movers({ rows, sliceDays: 1, baseline });
  assert.deepEqual(out.map((row) => row.entry.key), ['loud']);
  assert.equal(Math.round(out[0].ratio), 20);
  assert.equal(detectors.formatMultiple(out[0].ratio), '+20×');
  assert.equal(detectors.formatMultiple(Infinity), 'new');

  // A project with no baseline is 'new' only when the window was actually
  // covered; under a clamped baseline the strip reports measured ratios only.
  const fresh = [{ entry: entry('brand-new'), tokens: 500 }];
  assert.equal(detectors.movers({ rows: fresh, sliceDays: 1, baseline }).length, 1);
  assert.equal(detectors.movers({
    rows: fresh, sliceDays: 1, baseline: { ...baseline, clamped: true },
  }).length, 0);
  // Too short a baseline says nothing at all.
  assert.deepEqual(detectors.movers({ rows, sliceDays: 1, baseline: { ...baseline, days: 1 } }), []);
});

test('prices come from the pinned snapshot, and an unlisted model is flagged, never guessed silently', () => {
  assert.equal(prices.PRICE_SNAPSHOT_DATE, '2026-08-11');
  const flow = {
    inputUncached: 1_000_000, inputCacheRead: 0, inputCacheWrite: 0, outputTotal: 1_000_000,
  };
  const opus = prices.costOf('claude-opus-5', flow);
  assert.equal(opus.priced, true);
  assert.equal(opus.via, null);
  assert.equal(Math.round(opus.usd), 30);

  const aliased = prices.costOf('claude-3-5-haiku-20241022', flow);
  assert.equal(aliased.priced, true);
  assert.equal(aliased.via, 'claude-haiku-4-5-20251001', 'an aliased row names what priced it');

  const unknown = prices.costOf('model-nobody-has-heard-of', flow);
  assert.deepEqual(unknown, { usd: 0, priced: false, via: null });

  // Own properties only. A model id that names something on Object's prototype
  // used to price against a Function and return NaN — and one NaN travels
  // through every sum on the cost lens until the whole page prints NaN.
  for (const id of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const priced = prices.costOf(id, flow);
    assert.deepEqual(priced, { usd: 0, priced: false, via: null }, id + ' is not a price');
  }
});

test('a hover readout prints every series it counts, tail included', () => {
  const series = Array.from({ length: 11 }, (unused, index) => ({ key: 'k' + index, label: 'k' + index }));
  const bucket = Object.fromEntries(series.map((entry, index) => [entry.key, index + 1]));
  const readout = chart.readoutRows(series, bucket);

  assert.equal(readout.shown.length, chart.READOUT_ROWS);
  assert.equal(readout.rest.length, 11 - chart.READOUT_ROWS);
  // The printed figures — the listed rows plus the tail row — sum to the printed
  // Total. Truncating the list without printing the tail broke exactly this.
  const printed = readout.shown.reduce((sum, entry) => sum + entry.value, 0) + readout.restValue;
  assert.equal(printed, readout.total);
  assert.equal(readout.total, 66);
  // Biggest first, and a zero series is not a row at all.
  assert.deepEqual(readout.shown.map((entry) => entry.value), [11, 10, 9, 8, 7, 6, 5, 4]);
  const sparse = chart.readoutRows(series, { k0: 0, k1: 5 });
  assert.deepEqual(sparse.shown.map((entry) => entry.key), ['k1']);
  assert.equal(sparse.rest.length, 0);
  assert.equal(chart.readoutRows(series, {}).empty, true);
});

test('range boundaries are local calendar midnights, DST days included', (t) => {
  // 2026-11-02 10:00 local, the day AFTER US DST ends — so 'yesterday' is a
  // 25-hour day and fixed 24-hour arithmetic lands at 01:00, not midnight.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T18:00:00.000Z') });

  const today = api.boundsFor('today');
  assert.equal(new Date(today.since).getHours(), 0, 'today starts at local midnight');
  const yesterday = api.boundsFor('yesterday');
  assert.equal(new Date(yesterday.since).getHours(), 0, 'yesterday starts at local midnight');
  assert.equal(new Date(yesterday.until).getHours(), 0, 'and ends at local midnight');
  assert.equal(
    (new Date(yesterday.until) - new Date(yesterday.since)) / 3600000,
    25,
    'the transition day really is 25 hours long',
  );

  // A 7-day range starts at a midnight and covers exactly 7 calendar days, which
  // is what enumerateBuckets (stepping with setDate) will enumerate.
  const week = api.boundsFor('7d');
  assert.equal(new Date(week.since).getHours(), 0);
  assert.equal(model.enumerateBuckets(week.since, week.until, 'day').length, 7);
  assert.equal(model.enumerateBuckets(week.since, week.until, 'day')[0], '2026-10-27');
  assert.equal(model.enumerateBuckets(week.since, week.until, 'day')[6], '2026-11-02');
  // Hour buckets over the transition day carry its extra hour, with no gap.
  const hours = model.enumerateBuckets(yesterday.since, yesterday.until, 'hour');
  assert.equal(hours[0], '2026-11-01T00:00');
  assert.equal(new Set(hours).size, hours.length, 'no hour key repeats');
});

test('figures read as figures: two decimals for subscriptions, whole dollars once cents are noise', () => {
  assert.equal(format.formatSubs(2.9149), '2.91');
  assert.equal(format.formatSubs(0), '0.00');
  assert.equal(format.moneyPlaces(12.5), 2);
  assert.equal(format.moneyPlaces(1200), 0);
  assert.equal(format.formatMoney(1234.5, 0), '$1,235');
  assert.equal(format.formatTokens(3_200_000_000), '3.2B');
  assert.equal(format.formatPercent(1, 4), '25.0%');
  assert.equal(format.formatPercent(1, 0), '—');
  // '1 session', not '1 sessions' — the decider photographed that one.
  assert.equal(format.plural(1, 'session'), '1 session');
  assert.equal(format.plural(2, 'session'), '2 sessions');
});
