import React, { useEffect, useMemo, useState } from 'react';
import DailyChart from './DailyChart.jsx';
import Treemap, { collapseSmall } from './Treemap.jsx';
import {
  Badge, Segmented, Why, slotColor, useElementSize, usePersisted, NEUTRAL,
} from './ui.jsx';
import { ProviderMark } from './brand.jsx';
import {
  allocateRounded, bucketsIn, dimensionSeries, projectValueSeries, sumOver,
  TOP_PROJECTS, UNATTRIBUTED,
} from './model.js';
import { cacheHealth, movers, formatMultiple } from './detectors.js';
import {
  formatDayShort, formatHourShort, formatMoney, formatPercent, formatSubs,
  formatTokens, formatClock, formatCount, moneyPlaces, plural,
} from './format.js';

const SERIES_MODES = [
  { value: 'provider', label: 'Provider' },
  { value: 'project', label: 'Project' },
  { value: 'model', label: 'Model' },
];

/*
 * CHART STYLE. Two marks for the same series, the reader's
 * choice, remembered. The glyphs carry the switch so it reads as a style
 * control rather than a fourth series dimension sitting beside the series one.
 */
const CHART_STYLES = [
  { value: 'bars', label: 'Bars', title: 'Columns — when did the total spike' },
  { value: 'area', label: 'Area', title: 'Smoothed stacked area — the shape of it' },
];
const STYLE_KEY = 'modeldeck.overview.chartStyle';

const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };

/*
 * PROVIDER COLOUR (the decider's own call).
 *
 * Claude wears the clay/orange slot — Anthropic's own accent, and the colour of
 * the spark mark everywhere else he sees it — and Codex wears the cool blue.
 * Round 9 had these the other way round, which read as wrong at a glance before
 * any label was checked. Both slots are the SAME two validated categorical steps
 * as before, only reassigned, so the palette's CVD and contrast results carry
 * over unchanged; the assignment is here, once, and every provider-scoped mark
 * on the page reads it.
 */
const PROVIDER_SLOT = { claude: 1, codex: 0 };
const providerColor = (name) => slotColor(PROVIDER_SLOT[name] ?? -1);

/*
 * STACK ORDER — Codex first, so it is the series at the BASELINE. The thin band
 * belongs on the axis where it reads as thin; riding the cumulative total its
 * stroke impersonates a Codex-sized Claude. This is a fixed list, never a sort
 * of whatever the current scope happens to hold, so a Claude → Codex →
 * Combined round-trip lands on the same stack it started with. Recharts stacks
 * in MOUNT order, so DailyChart remounts on any change to the series set
 * (see stackKey there) — that pair of rules is what makes the order
 * deterministic, and test/dashboard-overview-clicktest.test.mjs holds them.
 */
export const PROVIDER_STACK_ORDER = ['codex', 'claude'];

const TREEMAP_HEIGHT = 340;

/*
 * THE BLOCKS' DIMENSION (issue #411).
 *
 * The same segment control the chart's series toggle wears, in the same place,
 * because it is the same kind of question: which axis am I looking at. Projects
 * is the default and the one with a level below it; the other two are measured
 * partitions of the identical section total.
 *
 * Every dimension's blocks are sized by the figure printed on them, and the
 * final rounding pass (mapShown) runs over whichever set is on the map — so the
 * contract "the blocks add up to the card's own total" is a property of the
 * pipeline, not of the dimension.
 */
const BLOCK_DIMENSIONS = [
  { value: 'projects', label: 'Projects' },
  { value: 'accounts', label: 'Subscriptions' },
  { value: 'providers', label: 'Providers' },
];
const BLOCK_DIMENSION_KEY = 'modeldeck.overview.blockDimension';
const BLOCK_DIMENSION_VALUES = BLOCK_DIMENSIONS.map((entry) => entry.value);

const DIMENSION_NOUN = { projects: 'project', accounts: 'subscription', providers: 'provider' };
const DIMENSION_WHY = {
  projects: 'Blocks are sized by the figure shown on them. Project figures are the pool\'s measured burn apportioned by weighted token flow — they always sum to the measured total, including the untraceable remainder. Anything too small to draw at label size folds into one block rather than rendering half a label.',
  accounts: 'Blocks are sized by the figure shown on them. A subscription\'s burn is measured directly on that subscription\'s own usage levels; its $-equivalent is its provider\'s measured cost in the share of that provider\'s measured tokens the subscription sent. Either way the blocks sum to the same section total the other dimensions do.',
  providers: 'Blocks are sized by the figure shown on them. Provider figures are measured directly — the pool\'s burn on that provider\'s subscriptions, or the warehouse\'s priced tokens on that provider — and every provider the data carries gets a block. They sum to the same section total the other dimensions do.',
};
// No drill exists below these two yet, so their blocks are INERT and say why
// rather than opening something that is not the level they name (#409).
const DIMENSION_INERT = {
  accounts: 'No level below a subscription yet — per-subscription limits are under Detail views → Headroom.',
  providers: 'No level below a provider yet — the Provider filter above scopes the whole page to one.',
};
const DIMENSION_RESIDUAL = {
  accounts: {
    name: 'Not traceable to a subscription',
    title: 'Measured burn the pool records against no subscription this range still holds — most often requests whose source could not be resolved to an enabled subscription.',
  },
  providers: {
    name: 'Not traceable to a provider',
    title: 'Measured burn this range holds that carries no provider of its own.',
  },
};
const DIMENSION_EMPTY = {
  projects: 'No project activity in this slice.',
  accounts: 'No subscription burn in this slice.',
  providers: 'No provider burn in this slice.',
};

// A provider the assignment above does not name still needs a hue of its own,
// and it must not wear either of the two the named providers already own.
const SPARE_SLOTS = [2, 3, 4, 5, 6, 7];
const providerBlockColor = (name, index) => (
  PROVIDER_SLOT[name] != null ? providerColor(name) : slotColor(SPARE_SLOTS[index % SPARE_SLOTS.length])
);

/** The blocks for the accounts / providers dimensions, scoped to the selection. */
function dimensionItems(series, buckets, selection, dimension) {
  const items = series.rows
    .map((row, index) => ({ row, index, value: sumOver(row.values, buckets, selection) }))
    .filter((entry) => entry.value > 0)
    .map(({ row, index, value }) => ({
      key: row.key,
      name: dimension === 'providers' ? (PROVIDER_LABEL[row.name] || row.name) : row.name,
      value,
      tokens: 0,
      color: dimension === 'providers' ? providerBlockColor(row.name, index) : slotColor(index),
      marks: row.provider ? (
        <span className="pmarks">
          <span className="pmark-slot" style={{ color: providerColor(row.provider) }}>
            <ProviderMark provider={row.provider} size={12} />
          </span>
        </span>
      ) : null,
      disabled: true,
      title: DIMENSION_INERT[dimension],
    }))
    .sort((a, b) => b.value - a.value);
  const residual = sumOver(series.residual, buckets, selection);
  if (residual > 0) {
    items.push({
      key: '__residual',
      ...DIMENSION_RESIDUAL[dimension],
      value: residual,
      tokens: 0,
      color: NEUTRAL,
      disabled: true,
    });
  }
  return items;
}

export default function Overview({ model, lens, selection, onSelect, onOpenProject }) {
  const [mode, setMode] = useState('provider');
  const [chartStyle, setChartStyle] = usePersisted(STYLE_KEY, 'bars', ['bars', 'area']);
  const [expandMore, setExpandMore] = useState(false);
  // Remembered, and App never unmounts this page for a range or scope change —
  // so the dimension the reader chose survives both.
  const [dimension, setDimension] = usePersisted(
    BLOCK_DIMENSION_KEY, 'projects', BLOCK_DIMENSION_VALUES,
  );
  const [mapRef, mapSize] = useElementSize({ width: 1040, height: TREEMAP_HEIGHT });

  useEffect(() => { setExpandMore(false); }, [model.rangeKey, model.scope, selection, lens, dimension]);

  const isCost = lens === 'cost';
  const buckets = model.buckets;

  // ---- project values, in the current lens unit, per bucket -----------------
  // Chart and treemap read the SAME derivation, so the number under the cursor
  // is by construction the number the block is sized by — and the DRILL reads it
  // too (model.js projectValueSeries), so opening a block cannot change its
  // figure.
  const projectValues = useMemo(() => projectValueSeries(model, isCost), [model, isCost]);

  // ---- treemap items, rescoped live by the chart selection ------------------
  const scoped = useMemo(() => {
    const rows = model.projects
      .filter((entry) => !entry.unattributed)
      .map((entry) => ({
        entry,
        value: sumOver(projectValues.get(entry.key), buckets, selection),
        tokens: bucketsIn(buckets, selection).reduce((sum, b) => sum + (entry.byBucket.get(b) || 0), 0),
      }))
      .filter((row) => row.value > 0 || row.tokens > 0)
      .sort((a, b) => b.value - a.value || b.tokens - a.tokens);
    const untraced = sumOver(projectValues.get('__untraced'), buckets, selection)
      + sumOver(projectValues.get(UNATTRIBUTED), buckets, selection);
    const total = rows.reduce((sum, row) => sum + row.value, 0) + untraced;
    return { rows, untraced, total };
  }, [model, projectValues, buckets, selection]);

  // Colour follows the entity across the whole page: rank is assigned once, on
  // the full range, so brushing never repaints the survivors.
  const colorFor = (entry) => slotColor(entry.rank < TOP_PROJECTS ? entry.rank : -1);

  // The headline is the same derivation the blocks are, summed over the whole
  // range — so with nothing selected the hero IS the sum of the blocks, rather
  // than a second number computed a second way that can drift from them.
  const heroValue = useMemo(() => {
    let total = 0;
    for (const [, map] of projectValues) for (const [, value] of map) total += value;
    return Math.round(total * 100) / 100;
  }, [projectValues]);

  // Display precision is chosen once for the whole set, then every member is
  // re-rounded with largest-remainder AT that precision — so the labels a
  // reader adds up sum to the label on the total, not just the maths behind it.
  const places = isCost ? moneyPlaces(scoped.total) : 2;
  const money = (value) => formatMoney(value, places);
  const heroPlaces = isCost ? moneyPlaces(heroValue) : 2;

  // ---- cache health, per project, over the whole range ----------------------
  // The rate is a property of how the project's requests are shaped, not of the
  // slice, so it is computed on the range totals and does not move when the
  // reader brushes a day.
  const cacheByKey = useMemo(() => {
    const out = new Map();
    for (const entry of model.projects) out.set(entry.key, cacheHealth(entry));
    return out;
  }, [model]);

  // The non-project dimensions, partitioning the SAME per-bucket totals.
  const alternate = useMemo(
    () => (dimension === 'projects' ? null : dimensionSeries(model, isCost, dimension)),
    [model, isCost, dimension],
  );

  // ---- the treemap: fold anything that cannot be drawn legibly --------------
  const rawItems = useMemo(() => {
    if (alternate) return dimensionItems(alternate, buckets, selection, dimension);
    const top = scoped.rows.slice(0, 12);
    const rest = scoped.rows.slice(12);
    const restValue = rest.reduce((sum, row) => sum + row.value, 0);
    const items = top.map((row) => {
      const health = cacheByKey.get(row.entry.key);
      return {
        key: row.entry.key,
        name: row.entry.name,
        value: row.value,
        tokens: row.tokens,
        color: colorFor(row.entry),
        title: row.entry.path || row.entry.name,
        entry: row.entry,
        // A flagged project is folded last: the badge is the reason the block
        // is worth its area.
        pin: !!health && (health.level === 'red' || health.level === 'amber'),
      };
    });
    if (restValue > 0) {
      items.push({
        key: '__other',
        name: 'Other (' + plural(rest.length, 'project') + ')',
        value: restValue,
        tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
        color: NEUTRAL,
        disabled: true,
      });
    }
    if (scoped.untraced > 0) {
      items.push({
        key: '__untraced',
        name: 'Not traceable to a project',
        value: scoped.untraced,
        tokens: 0,
        color: NEUTRAL,
        disabled: true,
        title: 'Burn measured on the pool while no ingested session was running anywhere — other machines, or surfaces that write no local transcript.',
      });
    }
    return items;
  }, [scoped, model, cacheByKey, alternate, buckets, selection, dimension]);

  const folded = useMemo(
    () => collapseSmall(rawItems, { width: mapSize.width, height: TREEMAP_HEIGHT }),
    [rawItems, mapSize.width],
  );

  // One rounding over the FINAL block set — the folded blocks plus the "+N more"
  // block — so the labels on the map sum to the map's own total exactly, and the
  // "+N more" label is exactly what the blocks inside it will sum to.
  const mapShown = useMemo(() => {
    const values = folded.kept.map((item) => item.value);
    const hiddenValue = folded.hidden.reduce((sum, item) => sum + item.value, 0);
    if (hiddenValue > 0) values.push(hiddenValue);
    return allocateRounded(values, scoped.total, places);
  }, [folded, scoped.total, places]);

  const totalShown = mapShown.reduce((sum, value) => sum + value, 0);
  const morePrinted = folded.hidden.length ? mapShown[mapShown.length - 1] : 0;

  const decorate = (item, printed) => {
    const health = item.entry ? cacheByKey.get(item.entry.key) : null;
    return {
      ...item,
      valueLabel: isCost ? money(printed) : formatSubs(printed),
      subLabel: (item.tokens ? formatTokens(item.tokens) + ' tokens · ' : '')
        + formatPercent(printed, totalShown),
      marks: item.marks || (item.entry ? <ProviderMarksFor entry={item.entry} /> : null),
      badge: health && (health.level === 'red' || health.level === 'amber') ? (
        <Badge
          level={health.level}
          title={'Prompt caching: ' + formatCount(Math.round(health.perRequest))
            + ' uncached input tokens per request. Open the project for what that means.'}
        >
          cache
        </Badge>
      ) : null,
    };
  };

  const mapItems = useMemo(() => {
    const items = folded.kept.map((item, index) => decorate(item, mapShown[index]));
    // Only drawn when it can be drawn legibly; otherwise the card head carries
    // it (see the "+N more" chip below).
    if (folded.hidden.length && folded.moreFits) {
      items.push({
        key: '__more',
        name: '+' + folded.hidden.length + ' more',
        value: folded.hidden.reduce((sum, item) => sum + item.value, 0),
        valueLabel: isCost ? money(morePrinted) : formatSubs(morePrinted),
        subLabel: formatPercent(morePrinted, totalShown) + ' · click to open',
        color: NEUTRAL,
        more: true,
        title: folded.hidden.map((item) => item.name).join(', '),
      });
    }
    return items;
  }, [folded, mapShown, morePrinted, totalShown, isCost, places, cacheByKey]);

  // The folded set, opened.
  //
  // NOT a second treemap. The folded set is by definition the long tail — the
  // shares that had no legible cell in the first place — and squarifying them
  // again just reproduces the bug one level down. A ranked list is legible at
  // any share, so this is the form the tail gets. Its figures are re-rounded to
  // the exact total the "+N more" printed, and its percentages are still quoted
  // against the whole map so the two views are directly comparable.
  const moreItems = useMemo(() => {
    if (!folded.hidden.length) return [];
    const shown = allocateRounded(folded.hidden.map((item) => item.value), morePrinted, places);
    return folded.hidden.map((item, index) => decorate(item, shown[index]));
  }, [folded, morePrinted, places, isCost, totalShown, cacheByKey]);

  // ---- movers ---------------------------------------------------------------
  const sliceDays = useMemo(() => {
    const count = bucketsIn(buckets, selection).length;
    return model.resolution === 'hour' ? Math.max(1 / 24, count / 24) : Math.max(1, count);
  }, [buckets, selection, model.resolution]);

  const moverRows = useMemo(() => movers({
    rows: scoped.rows, sliceDays, baseline: model.baseline,
  }), [scoped.rows, sliceDays, model.baseline]);

  // ---- chart series ---------------------------------------------------------
  const chart = useMemo(() => {
    if (mode === 'provider') {
      const names = model.scope ? [model.scope] : PROVIDER_STACK_ORDER;
      const source = isCost ? model.cost.byProviderBucket : model.pool.byProviderBucket;
      const series = names.map((name) => ({
        key: name,
        label: PROVIDER_LABEL[name] || name,
        color: providerColor(name),
        mark: <ProviderMark provider={name} size={12} />,
      }));
      const values = new Map(names.map((name) => [name, source.get(name) || new Map()]));
      return { series, values };
    }
    if (mode === 'project') {
      const top = scoped.rows.slice(0, TOP_PROJECTS);
      const rest = scoped.rows.slice(TOP_PROJECTS);
      const series = top.map((row) => ({
        key: row.entry.key, label: row.entry.name, color: colorFor(row.entry),
        mark: <ProviderMarksFor entry={row.entry} size={11} />,
      }));
      const values = new Map(top.map((row) => [row.entry.key, projectValues.get(row.entry.key)]));
      if (rest.length) {
        const merged = new Map();
        for (const row of rest) {
          for (const [bucket, value] of projectValues.get(row.entry.key) || []) {
            merged.set(bucket, (merged.get(bucket) || 0) + value);
          }
        }
        series.push({ key: '__other', label: 'Other (' + rest.length + ')', color: NEUTRAL });
        values.set('__other', merged);
      }
      const untracedMap = new Map();
      for (const key of ['__untraced', UNATTRIBUTED]) {
        for (const [bucket, value] of projectValues.get(key) || []) {
          untracedMap.set(bucket, (untracedMap.get(bucket) || 0) + value);
        }
      }
      if (untracedMap.size) {
        series.push({ key: '__untr', label: 'Not traceable', color: NEUTRAL });
        values.set('__untr', untracedMap);
      }
      return { series, values };
    }
    // by model — straight off the measured per-model-per-bucket table.
    //
    // The table holds one row per PROVIDER × model (loadCost asks each provider
    // for its own model list), and the same id can appear under both — an
    // unnamed model, or a model served through either surface. So the series key
    // is provider-qualified: keyed on the id alone, the second row would
    // overwrite the first one's values and draw an empty band under a duplicate
    // React key. The label stays the model's own name; the provider mark beside
    // it is what tells the two apart.
    const series = [];
    const values = new Map();
    model.cost.models.slice(0, 8).forEach((row, index) => {
      const key = row.provider + ':' + row.model;
      const map = new Map();
      for (const bucket of buckets) {
        if (isCost) {
          const value = row.byBucket.get(bucket) || 0;
          if (value > 0) map.set(bucket, value);
        } else {
          // Subscription burn is measured on the pool, not per model — the
          // model's measured token share of the bucket apportions it.
          const tokens = row.tokensByBucket.get(bucket) || 0;
          const measured = model.cost.tokensByBucket.get(bucket) || 0;
          const poolBurn = model.pool.byBucket.get(bucket) || 0;
          if (tokens > 0 && measured > 0) map.set(bucket, poolBurn * (tokens / measured));
        }
      }
      series.push({
        key, label: row.model, color: slotColor(index),
        mark: <ProviderMark provider={row.provider} size={11} />,
      });
      values.set(key, map);
    });
    return { series, values };
  }, [mode, model, isCost, scoped, projectValues, buckets]);

  // ---- headline -------------------------------------------------------------
  const windows = model.pool.windows.filter((entry) => entry.binding);
  const hot = windows.filter((entry) => Number(entry.binding.usedPercent) >= 80);
  const free = windows.length - hot.length;
  const verdict = free >= 3
    ? { text: 'Yes — ' + free + ' subscriptions have headroom', color: 'var(--good)' }
    : free >= 1
      ? { text: 'Thin — only ' + free + (free === 1 ? ' subscription has' : ' subscriptions have') + ' headroom', color: 'var(--warning)' }
      : { text: 'No — every subscription is hot', color: 'var(--critical)' };
  const worst = windows[0] || null;

  const rangeDays = Math.max(1 / 24, (new Date(model.until) - new Date(model.since)) / 86400000);

  const peak = useMemo(() => {
    let best = null;
    for (const bucket of buckets) {
      const value = isCost ? (model.cost.byBucket.get(bucket) || 0) : (model.pool.byBucket.get(bucket) || 0);
      if (!best || value > best.value) best = { bucket, value };
    }
    return best;
  }, [buckets, model, isCost]);

  const label = model.resolution === 'hour' ? formatHourShort : formatDayShort;
  const sliceLabel = selection
    ? (selection.from === selection.to ? label(selection.from) : label(selection.from) + ' – ' + label(selection.to))
    : null;

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">{isCost ? 'API-$ equivalent' : 'Burned this range'}</div>
          <div className="hero-figure">
            {isCost ? formatMoney(heroValue, heroPlaces) + '*' : formatSubs(heroValue)}
            {!isCost ? <span className="hero-unit">weekly subscriptions</span> : null}
          </div>
          <div className="hero-sub">
            {isCost
              ? '* if billed at full API rate'
              : formatSubs(heroValue / rangeDays) + ' per day'}
            <Why text={isCost
              ? 'Priced from measured provider-truth tokens only, at the pinned LiteLLM API rate list. You are not billed this — it is what the same tokens would cost on the API.'
              : 'Measured on the provider\'s own usage levels across the pool: the sum of the rises in percent-used, so a reset counts the fresh burn after it rather than a negative.'} />
          </div>
        </div>

        <div className="hero-main">
          <div className="hero-label">Can I start heavy work now?</div>
          <div className="verdict" style={{ marginTop: 8 }}>
            <span className="dot" style={{ background: verdict.color }} aria-hidden />
            {verdict.text}
          </div>
          <div className="hero-sub" style={{ marginTop: 4 }}>
            {hot.length} of {windows.length} subscriptions ≥ 80% used
            {worst ? ' · worst ' + worst.label + ' ' + Math.round(worst.binding.usedPercent) + '%' : ''}
            <Why text={'Pool-level availability across every enabled subscription. Worst subscription resets '
              + (worst && worst.binding.resetsAt ? formatClock(worst.binding.resetsAt) : 'unknown') + '.'} />
          </div>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="stat-label">Peak {model.resolution === 'hour' ? 'hour' : 'day'}</div>
            <div className="stat-value">{peak ? (isCost ? money(peak.value) : formatSubs(peak.value)) : '—'}</div>
            <div className="stat-detail">{peak ? label(peak.bucket) : ''}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Not traceable</div>
            <div className="stat-value">{isCost ? money(scoped.untraced) : formatSubs(scoped.untraced)}</div>
            <div className="stat-detail">
              {model.pool.untracedHours} {model.pool.untracedHours === 1 ? 'hour' : 'hours'} with no session
              <Why text="Burn measured on the pool during hours when no ingested session was running anywhere — other machines, or surfaces that write no local transcript." />
            </div>
          </div>
        </div>
      </section>

      <MoversStrip
        rows={moverRows}
        baseline={model.baseline}
        onOpen={(entry) => onOpenProject(entry.key)}
      />

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {model.resolution === 'hour' ? 'Hourly' : 'Daily'} {isCost ? 'API-$ equivalent' : 'subscription burn'}
          </h2>
          <Segmented options={SERIES_MODES} value={mode} onChange={setMode} label="Chart series" />
          <Segmented
            options={CHART_STYLES}
            value={chartStyle}
            onChange={setChartStyle}
            label="Chart style"
            className="style"
          />
          <span className="spacer" />
          {selection ? (
            <span className="card-note">
              {sliceLabel}
              {' · '}
              {isCost ? money(scoped.total) : formatSubs(scoped.total)}
              {' of '}
              {isCost ? formatMoney(heroValue, heroPlaces) : formatSubs(heroValue)}
            </span>
          ) : null}
        </div>

        <DailyChart
          buckets={buckets}
          series={chart.series}
          values={chart.values}
          unit={isCost ? 'cost' : 'subs'}
          resolution={model.resolution}
          selection={selection}
          onSelect={onSelect}
          chartStyle={chartStyle}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {BLOCK_DIMENSIONS.find((entry) => entry.value === dimension).label}
            <Why text={DIMENSION_WHY[dimension]} />
          </h2>
          <Segmented
            options={BLOCK_DIMENSIONS}
            value={dimension}
            onChange={setDimension}
            label="Block dimension"
          />
          <span className="card-note">
            {selection ? 'scoped to ' + sliceLabel : 'full range'}
            {' · '}
            {isCost ? money(scoped.total) : formatSubs(scoped.total) + ' subscriptions'}
          </span>
          <span className="spacer" />
          {expandMore ? (
            <button type="button" className="chip" style={{ cursor: 'pointer', background: 'none' }} onClick={() => setExpandMore(false)}>
              ← All {DIMENSION_NOUN[dimension]}s
            </button>
          ) : null}
          {!expandMore && folded.hidden.length && !folded.moreFits ? (
            <button
              type="button"
              className="chip more-chip"
              style={{ cursor: 'pointer', background: 'none' }}
              onClick={() => setExpandMore(true)}
            >
              +{folded.hidden.length} more · {isCost ? money(morePrinted) : formatSubs(morePrinted)}
              {' · '}{formatPercent(morePrinted, totalShown)}
            </button>
          ) : null}
          {selection ? (
            <button type="button" className="chip" style={{ cursor: 'pointer', background: 'none' }} onClick={() => onSelect(null)}>
              Clear selection
            </button>
          ) : null}
        </div>
        {expandMore ? (
          <FoldedList
            items={moreItems}
            total={morePrinted}
            isCost={isCost}
            noun={DIMENSION_NOUN[dimension]}
            onOpen={(item) => item.entry && onOpenProject(item.entry.key)}
          />
        ) : (
          <div ref={mapRef} style={{ height: TREEMAP_HEIGHT }}>
            <Treemap
              items={mapItems}
              height={TREEMAP_HEIGHT}
              onSelect={(item) => {
                if (item.more) { setExpandMore(true); return; }
                if (item.entry) onOpenProject(item.entry.key);
              }}
              emptyText={DIMENSION_EMPTY[dimension]}
            />
          </div>
        )}
      </section>

      {/* Charter decision 2: per-account headroom is NOT on the landing. The
          availability verdict above carries the pool question, and which
          account is nearly out is a detail page (Detail views → Headroom). */}
      {isCost ? <ModelTable model={model} selection={selection} /> : null}
    </>
  );
}

/**
 * The folded tail, as a ranked list. Every row is legible whatever its share —
 * which is the whole reason these rows were not blocks — and the values are the
 * ones re-rounded to the "+N more" figure, so the list sums to it exactly.
 */
export function FoldedList({ items, total, isCost, onOpen, noun = 'project' }) {
  const max = items.reduce((peak, item) => Math.max(peak, item.value), 0);
  return (
    <div className="bars folded">
      <div className="card-note" style={{ marginBottom: 4 }}>
        {plural(items.length, noun)} too small to draw at label size ·{' '}
        {isCost ? formatMoney(total, moneyPlaces(total)) : formatSubs(total)} together
      </div>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="bar-row folded-row"
          // aria-disabled, NOT the disabled attribute — same reasoning as the
          // treemap blocks (issue #411): a native-disabled row leaves the tab
          // order and drops the hover title, so the explanation of why it does
          // not open would reach nobody. The click guard is what makes it inert.
          onClick={() => { if (item.entry) onOpen(item); }}
          aria-disabled={!item.entry ? true : undefined}
          title={item.title}
        >
          <span className="folded-name">
            {item.marks}
            {item.name}
            {item.badge}
          </span>
          <span className="folded-value">{item.valueLabel}</span>
          <span className="track">
            <i style={{ width: (max > 0 ? Math.max(1, (item.value / max) * 100) : 0) + '%', background: item.color }} />
          </span>
        </button>
      ))}
    </div>
  );
}

/** The provider marks a project actually used, in the fixed provider order. */
function ProviderMarksFor({ entry, size = 12 }) {
  const list = ['claude', 'codex'].filter((name) => entry.providers && entry.providers.has(name));
  if (!list.length) return null;
  return (
    <span className="pmarks">
      {list.map((name) => (
        <span key={name} className="pmark-slot" style={{ color: providerColor(name) }}>
          <ProviderMark provider={name} size={size} />
        </span>
      ))}
    </span>
  );
}

/**
 * WHAT CHANGED.
 *
 * One row, numbers only, and NOTHING when there is nothing to say — no empty
 * state, no "no significant movers" line. A ratio is all it prints, so it owes
 * the page no sum.
 */
function MoversStrip({ rows, baseline, onOpen }) {
  if (!rows.length || !baseline) return null;
  const window = formatDayShort(baseline.firstDay) + ' – ' + formatDayShort(baseline.lastDay);
  return (
    <div className="movers">
      <span className="movers-label">What changed</span>
      {/* When the trailing window runs past where the
          warehouse's continuous ingestion begins, the baseline is clamped to
          the covered days — and the strip says which days those are, on the
          face rather than in the tooltip, because the alternative is five rows
          of multiples measured against days nothing was recorded. */}
      {baseline.clamped ? (
        <span className="chip" title={'The ' + baseline.windowDays + '-day window predates continuous ingestion; '
          + 'the baseline is the covered days only.'}>
          since {formatDayShort(baseline.firstDay)}
        </span>
      ) : null}
      {rows.map((row) => (
        <button
          key={row.entry.key}
          type="button"
          className="mover"
          onClick={() => onOpen(row.entry)}
          title={'Open ' + row.entry.name}
        >
          <ProviderMarksFor entry={row.entry} size={11} />
          <span className="mover-name">{row.entry.name}</span>
          <span className="mover-x">{formatMultiple(row.ratio)}</span>
          {/* A zero baseline means the warehouse holds nothing for this project
              in that window — which is not the same claim as "this project is
              new", and the strip should not make the bigger claim. */}
          <span className="mover-vs">
            {row.isNew ? 'none in the prior ' + plural(baseline.days, 'day') : 'vs ' + baseline.days + '-day norm'}
          </span>
        </button>
      ))}
      <Why text={'Token pace in the selected slice against the same project\'s token pace over the '
        + baseline.days + ' days before it (' + window + '), averaged over every elapsed day in that '
        + 'window — not only the days it ran. Projects below 1% of the slice are left out. '
        + 'This is a ratio of like to like; it is not a subscriptions or dollar figure.'
        + (baseline.clamped
          ? ' The window asked for ' + baseline.windowDays + ' days from ' + formatDayShort(baseline.windowFirstDay)
            + ', but continuous ingestion only starts ' + formatDayShort(baseline.firstDay)
            + '; the days before that are dropped from both the tokens and the denominator, so no row is'
            + ' measured against days nothing was recorded.'
          : '')} />
    </div>
  );
}

/** Per-model $-equivalents, T3-style: cost, share, tokens, provider. */
function ModelTable({ model, selection }) {
  const pending = false;
  // No refetch: the table is a sum of the same per-model-per-bucket table the
  // chart and the blocks read, restricted to the selected buckets. That is what
  // makes a selected day's model rows add up to the selected day's blocks.
  const rows = useMemo(() => model.cost.models
    .map((row) => {
      let usd = 0;
      let tokens = 0;
      for (const [bucket, value] of row.byBucket) {
        if (selection && (bucket < selection.from || bucket > selection.to)) continue;
        usd += value;
        tokens += row.tokensByBucket.get(bucket) || 0;
      }
      return { ...row, usd, tokens };
    })
    .filter((row) => row.usd > 0 || row.tokens > 0)
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens), [model, selection]);

  const exact = rows.reduce((sum, row) => sum + row.usd, 0);
  // Same rule as the blocks: pick the precision once, then round every row to
  // it with largest remainder so the column adds up to the printed total.
  const places = moneyPlaces(exact);
  const shown = allocateRounded(rows.map((row) => row.usd), Math.round(exact * Math.pow(10, places)) / Math.pow(10, places), places);
  const total = shown.reduce((sum, value) => sum + value, 0);
  return (
    <section className={'card' + (pending ? ' loading' : '')}>
      <div className="card-head">
        <h2 className="card-title">
          By model
          <Why text="Priced from measured provider-truth tokens at the pinned LiteLLM rate list. Rows marked ≈ are priced through the nearest sibling model because the exact id is not in the rate list." />
        </h2>
        <span className="card-note">{formatMoney(total, places)}* total</span>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">$ equivalent</th>
            <th className="num">Share</th>
            <th className="num">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} className="empty">No measured activity in this slice.</td></tr>
          ) : rows.map((row, index) => (
            <tr key={row.provider + ':' + row.model}>
              <td>
                <span className="cell-key">
                  <span className="cell-swatch" style={{ background: slotColor(index < 8 ? index : -1) }} aria-hidden />
                  <span className="pmark-slot" style={{ color: providerColor(row.provider) }}>
                    <ProviderMark provider={row.provider} size={12} title={row.provider === 'codex' ? 'OpenAI' : 'Anthropic'} />
                  </span>
                  {row.model}
                  {row.via ? <span className="chip" title={'priced as ' + row.via}>≈</span> : null}
                </span>
              </td>
              <td className="num">{formatMoney(shown[index], places)}</td>
              <td className="num muted">{formatPercent(shown[index], total)}</td>
              <td className="num muted">{formatTokens(row.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
