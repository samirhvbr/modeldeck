import React, { useMemo, useState } from 'react';
import {
  Area, Bar, Brush, CartesianGrid, ComposedChart, DefaultZIndexes, ResponsiveContainer,
  Tooltip, XAxis, YAxis, ZIndexLayer,
} from 'recharts';
import { formatDayShort, formatHourOnly, formatHourShort, formatSubs, formatUsd } from './format.js';
import { Legend, Why } from './ui.jsx';

/*
 * Visual grammar adapted from T3 Code's usage page (MIT, pingdotgg/t3code —
 * apps/web/src/components/usage/UsageProviderChart.tsx): the big daily
 * provider chart as the page's entry point, a metric toggle over it, and one
 * hover readout listing every series plus the total.
 *
 * BOTH STYLES, ONE CHART. The decider wants T3's smoothed
 * stacked area as well as the columns, so the style is a switch rather than a
 * decision the page makes for him:
 *
 *   bars — "when did the TOTAL spike": stack height answers it directly, and
 *          each column is its own hit target.
 *   area — "what is the shape of this": a smoothed stacked area reads trend and
 *          composition at a glance, and it is what T3 ships.
 *
 * Both are fed by the SAME `data` rows and the same series list, and both wire
 * the same click-to-scope, the same brush, and the same readout — the style
 * switch changes the marks and nothing else. The readout differs only in its
 * pointer affordance, which is a dataviz rule rather than a preference: bars
 * carry a per-mark cursor, line/area carries a crosshair that snaps to the X, so
 * the reader aims at a date instead of at a 2px stroke.
 */

const GAP = 2; // the surface gap that separates touching marks
const RADIUS = 4; // rounded data-end, square at the baseline

/*
 * THE REMOUNT KEY. Recharts assigns stack order by MOUNT order, not by the
 * order of the series list — so a series that leaves and re-enters (a Claude →
 * Codex → Combined round-trip) rejoins the stack on top wherever it sits in the
 * list, and Codex stops being the baseline band. Keying the chart on the series
 * SET forces a remount whenever the set changes, which pins stack order to list
 * order. Named and exported so the regression test can hold it.
 */
export const stackKey = (series) => series.map((entry) => entry.key).join('|');

/*
 * PLOT GEOMETRY, exported. The session-anatomy timeline hangs an event rail
 * under this chart, and a rail one bucket out of step is worse than no rail at
 * all — so the rail reads the plot's own inset from here instead of guessing it.
 * A categorical band chart places bucket i's centre at (i + 0.5)/N of the plot
 * width, which is exactly an N-column CSS grid inset by these two numbers.
 */
export const PLOT_LEFT = 58; // the y-axis width below
export const PLOT_RIGHT = 8; // the chart's right margin below

function SegmentShape(props) {
  const { x, y, width, height, fill, payload, dataKey } = props;
  if (!(height > 0)) return null;
  const isTop = payload && payload.__top === dataKey;
  const inset = height > GAP + 1 ? GAP : 0;
  const h = height - inset;
  const top = y + inset;
  const r = isTop ? Math.min(RADIUS, h, width / 2) : 0;
  const path = r > 0
    ? `M${x},${top + h} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + width - r},${top} Q${x + width},${top} ${x + width},${top + r} L${x + width},${top + h} Z`
    : `M${x},${top} L${x + width},${top} L${x + width},${top + h} L${x},${top + h} Z`;
  return <path d={path} fill={fill} />;
}

/*
 * THE BAR CURSOR (issue #407). Recharts draws a RECTANGLE cursor only when the
 * chart element is literally a <BarChart>; every other chart — ComposedChart
 * included — falls through to its curve branch, so `cursor={{ fill }}` on bars
 * got a vertical crosshair carrying the library's own default `stroke: '#ccc'`.
 * That is the stray white line at the hovered bar. The band is therefore drawn
 * here, from what recharts hands a custom cursor element: the active point and
 * the plot box (top/left/width/height). Bucket count comes from the caller
 * because the tooltip axis band size is not exposed to a cursor.
 *
 * The ZIndexLayer is not decoration: the default layer for a curve cursor sits
 * ABOVE the marks, and a filled band above a stacked column would paint over the
 * data. cursorRectangle is the layer recharts puts its own band cursor in.
 */
export function BandCursor({ points, top, left, width, height, buckets, fill, className }) {
  const point = points && points[0];
  if (!point || !(buckets > 0) || !(width > 0) || !(height > 0)) return null;
  const band = width / buckets;
  const x = Math.min(Math.max(point.x - band / 2, left), left + width - band);
  return (
    <ZIndexLayer zIndex={DefaultZIndexes.cursorRectangle}>
      <rect
        className={className}
        x={x}
        y={top}
        width={band}
        height={height}
        fill={fill}
        pointerEvents="none"
      />
    </ZIndexLayer>
  );
}

/*
 * THE AXIS LABEL: granularity matches the visible span (issue #447). Hour
 * buckets whose whole span sits inside one calendar day print the hour alone —
 * the date is the same on every tick there, so it only crowds the axis, and it
 * is already carried by the range control and the hover readout. A span that
 * crosses midnight keeps its date, which is what makes an hourly axis over
 * several days placeable at all (#369).
 *
 * The date is dropped by NOT FORMATTING ONE rather than by stripping it back
 * out of a formatted string: the previous `.replace(/^.*?, /, '')` matched the
 * comma ICU used to put between date and hour, and current ICU writes "Aug 14
 * at 12 AM" — so in the shipped app the strip matched nothing and every tick
 * kept its date. Exported (like stackKey above) so the regression test can hold
 * the rule over a whole day of buckets, not just the ticks a layout survives.
 */
export function tickLabeler(buckets, resolution) {
  if (resolution !== 'hour') return formatDayShort;
  const spansOneDay = buckets.length > 0
    && String(buckets[0]).slice(0, 10) === String(buckets[buckets.length - 1]).slice(0, 10);
  return spansOneDay ? formatHourOnly : formatHourShort;
}

// A readout lists at most this many series before the rest become one row.
export const READOUT_ROWS = 8;

/**
 * What one hover prints: the series with a value, biggest first, and — when
 * there are more of them than rows — the tail as ONE row of its own.
 *
 * The tail row is the point. The readout obeys the page's sum rule like every
 * other figure set here: project mode reaches top-N + other + not-traceable, so
 * silently truncating the list would print a Total larger than the numbers above
 * it, which is exactly the arithmetic the decider checks by hand.
 */
export function readoutRows(series, bucketRow) {
  const rows = series
    .map((entry) => ({ ...entry, value: (bucketRow && bucketRow[entry.key]) || 0 }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  const rest = rows.slice(READOUT_ROWS);
  return {
    shown: rows.slice(0, READOUT_ROWS),
    rest,
    restValue: rest.reduce((sum, entry) => sum + entry.value, 0),
    total: rows.reduce((sum, entry) => sum + entry.value, 0),
    empty: rows.length === 0,
  };
}

function Readout({ active, payload, label, series, unit, resolution, formatLabel }) {
  if (!active || !payload || !payload.length) return null;
  const { shown, rest, restValue, total, empty } = readoutRows(series, payload[0].payload);
  const format = unit === 'cost' ? formatUsd : formatSubs;
  return (
    <div className="tip">
      <div className="tip-head">
        {formatLabel
          ? formatLabel(label)
          : resolution === 'hour' ? formatHourShort(label) : formatDayShort(label)}
      </div>
      {empty ? <div className="tip-row"><span className="tip-name">No burn</span></div> : null}
      {shown.map((entry) => (
        <div className="tip-row" key={entry.key}>
          <span className="tip-name">
            <span className="tip-key" style={{ background: entry.color }} aria-hidden />
            {entry.mark || null}
            {entry.label}
          </span>
          <span className="tip-value">{format(entry.value)}</span>
        </div>
      ))}
      {rest.length ? (
        <div className="tip-row">
          <span className="tip-name">{'+' + rest.length + ' more'}</span>
          <span className="tip-value">{format(restValue)}</span>
        </div>
      ) : null}
      <div className="tip-row tip-total">
        <span className="tip-name">Total</span>
        <span className="tip-value">{format(total)}</span>
      </div>
    </div>
  );
}

export default function DailyChart({
  buckets, series, values, unit, resolution, selection, onSelect, height = 300,
  chartStyle = 'bars',
  /*
   * THE DRILL'S RE-USE (issue #386). The same chart draws three different time
   * axes now — days on the landing, the project's own range on the drill, and
   * sub-hour buckets inside one session — so the parts that are axis-specific
   * are parameters rather than three chart implementations that drift apart:
   *
   *   formatTick/formatLabel  the axis and the readout's own wording
   *   showBrush               off where there is nothing below to scope
   *   hint                    replaces the click hint; the anatomy timeline
   *                           hangs its event rail here so the rail is inside
   *                           the chart's own layout box, not floating near it
   */
  formatTick, formatLabel, showBrush = true, hint = null,
}) {
  const [showTable, setShowTable] = useState(false);
  const isArea = chartStyle === 'area';

  const data = useMemo(() => {
    const rows = buckets.map((bucket) => {
      const row = { bucket };
      let total = 0;
      let top = null;
      for (const entry of series) {
        const value = values.get(entry.key)?.get(bucket) || 0;
        row[entry.key] = value;
        total += value;
        if (value > 0) top = entry.key;
      }
      row.__top = top;
      row.__total = total;
      return row;
    });
    // The hit bar spans the plot's full height at every bucket, so a click or a
    // focus lands on the DAY rather than on whichever mark happens to be under
    // the pointer. It is given the stack's own maximum, so adding it cannot move
    // the y-domain, and it carries no stackId so it never joins the stack.
    const ceiling = rows.reduce((max, row) => Math.max(max, row.__total), 0);
    for (const row of rows) row.__hit = ceiling;
    return rows;
  }, [buckets, series, values]);

  const format = unit === 'cost' ? formatUsd : formatSubs;
  const inSelection = (bucket) => {
    if (!selection) return true;
    return bucket >= selection.from && bucket <= selection.to;
  };

  // One click path for both styles. The hit bar hands us the bucket directly,
  // which is why the two chart styles cannot drift apart on what a click means.
  const pickBucket = (bucket) => {
    if (!bucket || !onSelect) return;
    if (selection && selection.from === bucket && selection.to === bucket) onSelect(null);
    else onSelect({ from: bucket, to: bucket });
  };
  const handleHitClick = (payload) => {
    const bucket = payload && (payload.bucket || (payload.payload && payload.payload.bucket));
    pickBucket(bucket);
  };

  const handleBrush = (range) => {
    if (!range || range.startIndex == null) return;
    const from = buckets[range.startIndex];
    const to = buckets[range.endIndex];
    if (!from || !to) return;
    if (from === buckets[0] && to === buckets[buckets.length - 1]) onSelect(null);
    else onSelect({ from, to });
  };

  // Shared children — identical axes, grid, readout, brush and selection wiring
  // under both styles, so a style switch can never change what a click means.
  const axes = (
    <>
      <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
      <XAxis
        dataKey="bucket"
        tickFormatter={formatTick || tickLabeler(buckets, resolution)}
        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
        axisLine={{ stroke: 'var(--baseline)' }}
        tickLine={false}
        minTickGap={16}
      />
      <YAxis
        tickFormatter={(value) => (value === 0 ? '0' : format(value))}
        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
        axisLine={false}
        tickLine={false}
        width={PLOT_LEFT}
      />
      <Tooltip
        cursor={isArea
          ? { stroke: 'var(--baseline)', strokeWidth: 1 }
          : <BandCursor buckets={data.length} fill="var(--surface-2)" />}
        content={(props) => (
          <Readout
            {...props}
            series={series}
            unit={unit}
            resolution={resolution}
            formatLabel={formatLabel}
          />
        )}
      />
    </>
  );

  const brush = showBrush && buckets.length > 3 ? (
    <Brush
      dataKey="bucket"
      height={22}
      travellerWidth={8}
      stroke="var(--baseline)"
      fill="var(--surface-2)"
      onChange={handleBrush}
      tickFormatter={() => ''}
    />
  ) : null;

  return (
    <div className="chart-wrap">
      <div className="card-head" style={{ marginBottom: 8 }}>
        <Legend series={series} shape={isArea ? 'area' : 'rect'} />
        <span className="spacer" />
        <button
          type="button"
          className="chip"
          style={{ cursor: 'pointer', background: 'none' }}
          onClick={() => setShowTable((value) => !value)}
          aria-pressed={showTable}
        >
          {showTable ? 'Hide table' : 'Table'}
        </button>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        {/* One chart type for both styles — only the marks differ, so the axes,
            the readout, the brush and the click target are literally the same
            elements rather than two implementations that have to be kept in
            step. */}
        {/* Keyed on the series SET — see stackKey above. */}
        <ComposedChart key={stackKey(series)} data={data} margin={{ top: 8, right: PLOT_RIGHT, bottom: 0, left: 0 }}>
          {axes}
          <Bar
            dataKey="__hit"
            fill="transparent"
            isAnimationActive={false}
            onClick={handleHitClick}
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            legendType="none"
            tooltipType="none"
          />
          {isArea ? series.map((entry) => (
            <Area
              key={entry.key}
              dataKey={entry.key}
              stackId="burn"
              // Smoothed like T3's, but monotone rather than a free spline: it
              // cannot overshoot into a dip the data never had.
              type="monotone"
              stroke={entry.color}
              strokeWidth={2}
              fill={entry.color}
              fillOpacity={0.22}
              activeDot={{ r: 3, strokeWidth: 2, stroke: 'var(--surface)' }}
              isAnimationActive={false}
            />
          )) : series.map((entry) => (
            <Bar
              key={entry.key}
              dataKey={entry.key}
              stackId="burn"
              fill={entry.color}
              shape={<SegmentShape />}
              maxBarSize={38}
              isAnimationActive={false}
            />
          ))}
          {brush}
        </ComposedChart>
      </ResponsiveContainer>

      {hint === null && onSelect ? (
        <div className="chart-hint">
          Click a {resolution === 'hour' ? 'point' : 'day'} to scope everything below it; drag the rail to scope a range.
          {selection ? ' Click the same one again to clear.' : ''}
          <Why text="The blocks, the model table and the headline detail all follow the chart's selection — under either chart style, which changes the marks and nothing else. The headline total always stays the full range, so you can see the part against the whole." />
        </div>
      ) : hint}

      {showTable ? (
        <div style={{ marginTop: 12, maxHeight: 260, overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>{resolution === 'hour' ? 'Hour' : 'Day'}</th>
                {series.map((entry) => (<th key={entry.key} className="num">{entry.label}</th>))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.filter((row) => inSelection(row.bucket)).map((row) => {
                const total = series.reduce((sum, entry) => sum + (row[entry.key] || 0), 0);
                return (
                  <tr key={row.bucket}>
                    <td>{resolution === 'hour' ? formatHourShort(row.bucket) : formatDayShort(row.bucket)}</td>
                    {series.map((entry) => (
                      <td key={entry.key} className="num muted">{format(row[entry.key] || 0)}</td>
                    ))}
                    <td className="num">{format(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
