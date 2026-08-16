// Issue #447 — the chart's X-AXIS LABELS.
//
// THE NAMED TRIPWIRE of this fix is the first test below:
//   'single-day scope labels its x-axis with hours only, never a date'
// The bug: with the overview scoped to one calendar day every tick read
// "Aug 14 at 12 AM". The axis dropped the date by stripping it back out of a
// formatted string — `.replace(/^.*?, /, '')` — and current ICU separates date
// from hour with " at ", not ", ", so in the shipped app the strip matched
// nothing and the date stayed on every tick.
//
// The second test is the other half of the same rule and guards #369: an hour
// axis that CROSSES midnight must keep its date, or its hours cannot be placed.
// A fix that simply deletes the date must fail there. The third pins day
// buckets, and the fourth holds the rule on the DRAWN axis — one tick is all
// jsdom's fake text metrics leave standing, which is why the rule itself is
// held above on the exported labeler rather than only on the rendering.
//
// The rule all four hold: label granularity matches the visible span. The date
// lives in the range control and the hover readout, not on every tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installDom, loadModule, waitFor } from '../dashboard/test-support/index.mjs';

// #450's ruling, applied to a suite with no wall-clock relationship at all:
// every bucket below is an absolute local key, so nothing here drifts with the
// time of day. The pin is for the calendar, not the clock — a fixed-offset,
// DST-free zone cannot put an hour key inside a skipped hour, which is the one
// way local-component parsing could move a label. (POSIX inverts the sign:
// Etc/GMT-5 means UTC+5, an early afternoon.)
process.env.TZ = 'Etc/GMT-5';

// A date component in every shape this page's formatters can produce it: a
// month name, or a numeric date like "8/14".
const DATE_SHAPED = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\d{1,2}\/\d{1,2}/;
const HOUR_ONLY = /^\d{1,2}\s?(AM|PM)$/;

/** An hour key for every hour of one calendar day, `from` through `to`. */
const hoursOf = (day, from = 0, to = 23) => Array.from(
  { length: to - from + 1 },
  (_, i) => day + 'T' + String(from + i).padStart(2, '0') + ':00',
);

const chart = await loadModule('src/DailyChart.jsx');
/** Every label the axis would print over these buckets. */
const labels = (buckets, resolution) => buckets.map(chart.tickLabeler(buckets, resolution));

test('single-day scope labels its x-axis with hours only, never a date', () => {
  const buckets = hoursOf('2026-08-14');
  const ticks = labels(buckets, 'hour');
  for (const tick of ticks) {
    assert.ok(
      !DATE_SHAPED.test(tick),
      'a one-day span must carry no date on its ticks, got ' + JSON.stringify(tick),
    );
    assert.ok(
      HOUR_ONLY.test(tick),
      'expected an hour-only label like "3 AM", got ' + JSON.stringify(tick),
    );
  }
  // And they are the RIGHT hours, not merely date-free strings.
  assert.equal(ticks[0], '12 AM');
  assert.equal(ticks[3], '3 AM');
  assert.equal(ticks[23], '11 PM');

  // A scope that is part of a day is still one day.
  assert.deepEqual(labels(hoursOf('2026-08-14', 9, 11), 'hour'), ['9 AM', '10 AM', '11 AM']);
});

test('#369: an hourly span that crosses midnight keeps the date on its ticks', () => {
  const buckets = [...hoursOf('2026-08-13', 18), ...hoursOf('2026-08-14', 0, 12)];
  const ticks = labels(buckets, 'hour');
  assert.ok(
    ticks.every((tick) => DATE_SHAPED.test(tick)),
    'a span across midnight must place its hours on a date, got ' + JSON.stringify(ticks),
  );
  assert.ok(ticks[0].includes('Aug 13') && ticks[ticks.length - 1].includes('Aug 14'));
});

test('day buckets keep their short date labels', () => {
  const ticks = labels(['2026-08-10', '2026-08-11', '2026-08-12'], 'day');
  assert.deepEqual(ticks, ['Aug 10', 'Aug 11', 'Aug 12']);
});

/*
 * The other half of the tripwire, and the only half that can see THIS bug come
 * back. Node's ICU still joins a month/day/hour skeleton with ", " (verified:
 * "Aug 14, 3 AM" on ICU 78), while the WebView the app ships in joins it with
 * " at " — so the old strip passes every behavioural test in this runner and
 * fails on Tim's screen. A single-day axis must therefore never be built by
 * cutting a date back out of a formatted label; it must format an hour only.
 */
test('the hour axis never strips a date back out of a formatted label', async () => {
  const source = await readFile(
    new URL('../dashboard/src/DailyChart.jsx', import.meta.url), 'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/format\w*\([^)]*\)\s*\.replace\(/.test(code),
    'the axis must format the granularity it wants, not strip a formatted label',
  );
});

test('the drawn single-day axis carries no date', async () => {
  const dom = installDom({ width: 900, height: 320 });
  const { mountChart } = await loadModule('test-support/mount-chart.jsx');
  const root = dom.window.document.getElementById('root');
  const buckets = hoursOf('2026-08-14');
  mountChart(root, {
    buckets,
    series: [{ key: 'burn', label: 'Claude', color: 'var(--cat-1)' }],
    values: new Map([['burn', new Map(buckets.map((bucket, i) => [bucket, 1 + (i % 5)]))]]),
    unit: 'subs',
    resolution: 'hour',
    selection: null,
    onSelect: () => {},
    chartStyle: 'bars',
  });
  const drawn = await waitFor(
    () => {
      const nodes = [...root.querySelectorAll('.recharts-xAxis-tick-labels text')]
        .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return nodes.length ? nodes : null;
    },
    'x-axis tick labels drawn',
  );
  for (const tick of drawn) {
    assert.ok(
      !DATE_SHAPED.test(tick) && HOUR_ONLY.test(tick),
      'a drawn one-day tick must read as an hour alone, got ' + JSON.stringify(tick),
    );
  }
});
