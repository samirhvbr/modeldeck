// Issue #407 — the chart's HOVER CURSOR, held on the drawn geometry.
//
// THE NAMED TRIPWIRE of this fix is the first test below:
//   'bar-mode hover draws a band cursor, never a crosshair line'
// The bug: recharts renders a rectangle cursor only when the chart element is
// literally a <BarChart>. This chart is a ComposedChart, so `cursor={{ fill }}`
// fell through to the library's curve branch and drew a vertical line carrying
// recharts' own default stroke '#ccc' — the stray white line at the hovered bar.
// Nothing in DailyChart's source said "line", so the regression is invisible at
// the source level and has to be held here, on what the reader actually sees.
//
// The second test is the other half of the same rule: the crosshair is CORRECT
// for line/area (aim at a date, not at a 2px stroke), so a fix that deletes the
// cursor outright must fail too. The third pins the band under the marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, loadModule, waitFor } from '../dashboard/test-support/index.mjs';

const BUCKETS = [
  '2026-08-12T09:00:00Z', '2026-08-12T10:00:00Z',
  '2026-08-12T11:00:00Z', '2026-08-12T12:00:00Z',
];
const SERIES = [
  { key: 'codex', label: 'Codex', color: 'var(--cat-1)' },
  { key: 'claude', label: 'Claude', color: 'var(--cat-2)' },
];
const VALUES = new Map([
  ['codex', new Map(BUCKETS.map((bucket, i) => [bucket, 1 + i]))],
  ['claude', new Map(BUCKETS.map((bucket, i) => [bucket, 2 + i]))],
]);

const WIDTH = 900;
const HEIGHT = 320;

/** Mount the chart, hover the middle of the plot, and hand back the cursor node. */
async function hoverChart(chartStyle) {
  const dom = installDom({ width: WIDTH, height: HEIGHT });
  const { mountChart } = await loadModule('test-support/mount-chart.jsx');
  const root = dom.window.document.getElementById('root');
  mountChart(root, {
    buckets: BUCKETS,
    series: SERIES,
    values: VALUES,
    unit: 'cost',
    resolution: 'hour',
    selection: null,
    onSelect: () => {},
    chartStyle,
  });
  await waitFor(() => root.querySelector('.recharts-surface'), 'chart drawn');

  // jsdom lays nothing out, and recharts turns a pointer position into a bucket
  // in real pixels — so the SVG has to report the plot's size like the HTML
  // elements installDom already does.
  const svg = root.querySelector('.recharts-surface');
  const box = {
    width: WIDTH, height: HEIGHT, top: 0, left: 0,
    right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON() {},
  };
  Object.defineProperty(dom.window.SVGElement.prototype, 'getBoundingClientRect', {
    value: () => box, configurable: true,
  });
  for (const type of ['mouseenter', 'mousemove']) {
    svg.dispatchEvent(new dom.window.MouseEvent(type, {
      bubbles: true, clientX: WIDTH / 2, clientY: HEIGHT / 2,
    }));
  }
  const cursor = await waitFor(
    () => root.querySelector('.recharts-tooltip-cursor'), chartStyle + ' hover cursor',
  );
  return { root, cursor, svg };
}

test('bar-mode hover draws a band cursor, never a crosshair line', async () => {
  const { root, cursor } = await hoverChart('bars');

  // A band is a rect. A crosshair is a <path>/<line> — either would fail here,
  // and so would recharts' own curve cursor, which also carries this class.
  assert.equal(cursor.tagName.toLowerCase(), 'rect', 'bar cursor must be a rect band');
  assert.ok(
    !cursor.getAttribute('class').includes('recharts-curve'),
    'bar cursor must not be recharts\' curve (line) cursor',
  );
  assert.equal(root.querySelectorAll('.recharts-tooltip-cursor').length, 1, 'exactly one cursor');

  // The white line was a STROKE. A band carries fill only, so any stroke on the
  // bar cursor is the bug coming back in a different shape.
  const stroke = cursor.getAttribute('stroke');
  assert.ok(stroke == null || stroke === 'none', 'bar cursor must carry no stroke, got ' + stroke);
  assert.equal(cursor.getAttribute('fill'), 'var(--surface-2)');

  // And it must be a BAND, not a collapsed rect that reads as a line: one
  // bucket's share of the plot, within a pixel of rounding.
  const width = Number(cursor.getAttribute('width'));
  const height = Number(cursor.getAttribute('height'));
  const plotWidth = WIDTH - 58 /* PLOT_LEFT */ - 8 /* PLOT_RIGHT */;
  assert.ok(
    Math.abs(width - plotWidth / BUCKETS.length) < 1,
    'band should span one bucket (' + (plotWidth / BUCKETS.length) + '), got ' + width,
  );
  assert.ok(height > 100, 'band should span the plot height, got ' + height);
});

test('area-mode hover keeps the crosshair line', async () => {
  const { cursor } = await hoverChart('area');
  assert.ok(
    cursor.getAttribute('class').includes('recharts-curve'),
    'area cursor must stay a crosshair line',
  );
  assert.equal(cursor.getAttribute('stroke'), 'var(--baseline)');
});

test('the bar band is painted under the marks, not over them', async () => {
  const { svg } = await hoverChart('bars');
  const painted = [...svg.querySelectorAll('.recharts-tooltip-cursor, .recharts-bar')];
  assert.ok(painted.length > 1, 'expected the cursor and the bars in one SVG');
  assert.ok(
    painted[0].classList.contains('recharts-tooltip-cursor'),
    'the band must be drawn before the bars, or it paints over the data',
  );
});
