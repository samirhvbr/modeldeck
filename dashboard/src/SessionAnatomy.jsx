import React, { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import DailyChart, { PLOT_LEFT, PLOT_RIGHT } from './DailyChart.jsx';
import Treemap, { collapseSmall } from './Treemap.jsx';
import { FoldedList } from './Overview.jsx';
import {
  Badge, Legend, Meter, Why, slotColor, useElementSize, usePersisted, NEUTRAL,
} from './ui.jsx';
import { ProviderMark } from './brand.jsx';
import { getJSON, query } from './api.js';
import { allocateRounded } from './model.js';
import { cacheFlagged, cacheHealth, whyTerm, CACHE_AMBER, CACHE_RED } from './detectors.js';
import {
  formatClock, formatCount, formatMoney, formatPercent, formatSubs, formatTokens, plural,
} from './format.js';

/*
 * SESSION ANATOMY (issue #386) — the level the drill used to dead-end at.
 *
 * The decider's question, verbatim: "what was it INSIDE this session that spent
 * so much of the usage?" The old drill answered that with a paragraph. This is
 * the same drill grammar one level deeper — pictures first, text last:
 *
 *   1. WHY   one computed sentence, numbers first: the largest term in the
 *            session's own token classes, CHOSEN rather than written.
 *   2. WHEN  the session's own burn over its own duration, main loop vs the
 *            lanes it launched, with skills and lane launches annotated under it
 *            on the same buckets — the spike inside the spike.
 *   3. WHAT  the main loop and every subagent run as sized blocks, the same
 *            treemap and the same legibility fold as the level above.
 *   4. HOW   the per-request context curve — the visual proof of the sentence
 *            when context re-reading is the term — and the session's own cache
 *            diagnostics against the project level's thresholds.
 *   5. Then, and only then, text.
 *
 * SUM EXACTNESS. Every picture partitions ONE figure: the subscriptions (or
 * API-$) the drill printed for this session. The timeline buckets and the
 * composition blocks are each largest-remainder-rounded to that same figure at
 * the same precision, so both add up to it and to each other.
 *
 * COLOUR. Two entities on this page, everywhere: the MAIN LOOP wears the
 * session's provider colour and SUBAGENT LANES wear the indigo step. The blocks,
 * the stack, the curve and the rail all use that one assignment, so a colour
 * means the same thing in every picture on the page.
 *
 * CODEX DEGRADES HONESTLY. /api/usage/session-anatomy reports what a rollout
 * actually records in `supports`, and this page reads that rather than assuming
 * Claude's shape: a Codex session counts TURNS, not requests; it has no subagent
 * or skill records to dissect, so those cards say so instead of drawing an empty
 * one; and the per-request caching thresholds carry no verdict on a turn.
 */

const PROVIDER_SLOT = { claude: 1, codex: 0 };
const LANE_COLOR = 'var(--cat-7)';
const TREEMAP_HEIGHT = 300;
const CURVE_HEIGHT = 190;
const STYLE_KEY = 'modeldeck.overview.chartStyle';

const providerColor = (name) => slotColor(PROVIDER_SLOT[name] ?? -1);

/** 'YYYY-MM-DDTHH:MM' bucket keys are local wall-clock, offset-free. */
function bucketDate(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  return new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]),
  );
}
const clockOf = (date) => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayClockOf = (date) => date.toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total - hours * 3600) / 60);
  if (hours >= 1) return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
  if (minutes >= 1) return minutes + 'm';
  return Math.round(total) + 's';
}

function bucketLabel(ms) {
  if (ms >= 3600 * 1000) return (ms / (3600 * 1000)) + '-hour';
  if (ms >= 60 * 1000) return (ms / (60 * 1000)) + '-minute';
  return (ms / 1000) + '-second';
}

export default function SessionAnatomy({ session, value, places, isCost, project }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [chartStyle] = usePersisted(STYLE_KEY, 'bars', ['bars', 'area']);
  const [expandMore, setExpandMore] = useState(false);
  const [mapRef, mapSize] = useElementSize({ width: 1040, height: TREEMAP_HEIGHT });

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setExpandMore(false);
    getJSON('/api/usage/session-anatomy?' + query({
      sessionId: session.sessionId, profile: session.profileSlug, provider: session.provider,
    })).then((payload) => { if (!cancelled) setData(payload); })
      .catch((cause) => { if (!cancelled) setError(String(cause.message || cause)); });
    return () => { cancelled = true; };
  }, [session.sessionId, session.profileSlug, session.provider]);

  const money = (amount) => formatMoney(amount, places);
  const show = (amount) => (isCost ? money(amount) : formatSubs(amount));
  const mainColor = providerColor(session.provider);

  const totals = data && data.totals;
  const supports = (data && data.supports) || {};
  // Claude counts REQUESTS; a Codex rollout counts TURNS, each of which may be
  // several calls. The page uses the provider's own word rather than flattening
  // both into "requests", which would make the two rates look comparable.
  const unit = supports.unit || 'request';

  // ---- the WHEN timeline ----------------------------------------------------
  const timeline = useMemo(() => {
    const rows = (data && data.timeline && data.timeline.buckets) || [];
    if (!rows.length) return null;
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    // The buckets carry the SESSION's printed figure, apportioned by the tokens
    // measured in each one and rounded once at the page's precision — so the
    // columns add up to the headline rather than to a second total.
    const exact = rows.map((row) => (tokens ? value * (row.tokens / tokens) : 0));
    const main = rows.map((row) => (tokens ? value * (row.mainTokens / tokens) : 0));
    const shown = allocateRounded(exact, value, places);
    const mainShown = allocateRounded(main, main.reduce((sum, entry) => sum + entry, 0), places);
    const mainMap = new Map();
    const laneMap = new Map();
    rows.forEach((row, index) => {
      const mainValue = Math.min(mainShown[index], shown[index]);
      if (mainValue > 0) mainMap.set(row.key, mainValue);
      // The lane band is the REMAINDER of the column, never its own rounding —
      // that is what keeps main + lane equal to the column the reader adds up.
      const laneValue = Math.round((shown[index] - mainValue) * Math.pow(10, places))
        / Math.pow(10, places);
      if (laneValue > 0) laneMap.set(row.key, laneValue);
    });
    return {
      rows,
      buckets: rows.map((row) => row.key),
      values: new Map([['main', mainMap], ['lane', laneMap]]),
    };
  }, [data, value, places]);

  // ---- the WHAT blocks ------------------------------------------------------
  const composition = useMemo(() => {
    const parts = (data && data.composition) || [];
    const tokens = parts.reduce((sum, part) => sum + part.tokens, 0);
    if (!tokens) return [];
    let laneIndex = 0;
    // EXACT values here. There is exactly ONE rounding for the blocks (mapShown,
    // below), over the final block set at the page's precision — rounding twice
    // lets a second pass repair a sum the first one broke, which is how a
    // column that does not add up survives a test that says it does.
    return parts.map((part) => {
      const isMain = part.kind === 'main';
      if (!isMain) laneIndex += 1;
      // A lane is labelled by its agent_type when the transcript recorded one.
      // Most on this warehouse do not, and inventing a name for them would be
      // the page lying: an unrecorded lane is numbered in launch order and says
      // what it ran and when.
      const name = isMain ? 'Main loop' : (part.agentType || 'Lane ' + laneIndex);
      return {
        key: part.key,
        name,
        value: value * (part.tokens / tokens),
        part,
        color: isMain ? mainColor : LANE_COLOR,
        title: (isMain ? 'The session\'s own turns' : 'Subagent run ' + part.agentId)
          + ' · ' + formatTokens(part.tokens) + ' tokens over ' + plural(part.requests, unit),
      };
    }).filter((item) => item.value > 0 || item.part.tokens > 0);
  }, [data, value, mainColor, unit]);

  // A lane whose share ROUNDS TO ZERO at the page's precision still ran, so it
  // is folded rather than dropped: it joins the "+N more" count and its list,
  // adding nothing to the total but never vanishing from it.
  const factor = Math.pow(10, places);
  const drawable = useMemo(
    () => composition.filter((item) => Math.round(item.value * factor) > 0), [composition, factor],
  );
  const zeroed = useMemo(
    () => composition.filter((item) => Math.round(item.value * factor) === 0), [composition, factor],
  );
  const folded = useMemo(() => {
    const collapsed = collapseSmall(drawable, { width: mapSize.width, height: TREEMAP_HEIGHT });
    return { ...collapsed, hidden: collapsed.hidden.concat(zeroed) };
  }, [drawable, zeroed, mapSize.width]);
  const mapShown = useMemo(() => {
    const values = folded.kept.map((item) => item.value);
    if (folded.hidden.length) values.push(folded.hidden.reduce((sum, item) => sum + item.value, 0));
    return allocateRounded(values, value, places);
  }, [folded, value, places]);
  const totalShown = mapShown.reduce((sum, entry) => sum + entry, 0);
  const morePrinted = folded.hidden.length ? mapShown[mapShown.length - 1] : 0;

  const decorate = (item, printed) => ({
    ...item,
    valueLabel: show(printed),
    subLabel: formatTokens(item.part.tokens) + ' · ' + plural(item.part.requests, unit)
      + (item.part.model ? ' · ' + item.part.model : ''),
    disabled: true,
  });
  const mapItems = useMemo(() => {
    const items = folded.kept.map((item, index) => decorate(item, mapShown[index]));
    if (folded.hidden.length && folded.moreFits) {
      items.push({
        key: '__more',
        name: '+' + folded.hidden.length + ' more',
        value: folded.hidden.reduce((sum, item) => sum + item.value, 0),
        valueLabel: show(morePrinted),
        subLabel: formatPercent(morePrinted, totalShown) + ' · click to open',
        color: NEUTRAL,
        more: true,
        title: folded.hidden.map((item) => item.name).join(', '),
      });
    }
    return items;
  }, [folded, mapShown, morePrinted, totalShown, isCost, places]);
  const moreItems = useMemo(() => {
    if (!folded.hidden.length) return [];
    const shown = allocateRounded(folded.hidden.map((item) => item.value), morePrinted, places);
    return folded.hidden.map((item, index) => decorate(item, shown[index]));
  }, [folded, morePrinted, places, isCost]);

  // ---- the session's own cache health ---------------------------------------
  const health = useMemo(() => (totals ? cacheHealth({
    requests: totals.requests,
    flows: {
      inputUncached: totals.inputUncached,
      inputCacheRead: totals.inputCacheRead,
      inputCacheWrite: totals.inputCacheWrite,
    },
  }) : null), [totals]);

  const why = useMemo(() => whyTerm(totals), [totals]);

  if (error) return <div className="card error">Could not open this session: {error}</div>;
  if (!data) return <div className="card empty">Measuring this session…</div>;
  if (!data.session) return <div className="card empty">That session is not in the warehouse.</div>;

  const bucketMs = (data.timeline && data.timeline.bucketMs) || 0;
  const sameDay = timeline && timeline.rows.length
    && String(timeline.rows[0].key).slice(0, 10)
      === String(timeline.rows[timeline.rows.length - 1].key).slice(0, 10);
  const formatTick = (key) => {
    const date = bucketDate(key);
    if (!date) return String(key);
    return sameDay ? clockOf(date) : dayClockOf(date).replace(/,/, '');
  };
  const formatLabel = (key) => {
    const date = bucketDate(key);
    if (!date) return String(key);
    return dayClockOf(date) + ' · ' + bucketLabel(bucketMs);
  };

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">
            <span className="pmark-slot" style={{ color: mainColor }}>
              <ProviderMark provider={session.provider} size={12} />
            </span>
            {session.title || session.gitBranch || String(session.sessionId).slice(0, 8)}
          </div>
          <div className="hero-figure">
            {show(value)}
            {isCost ? '*' : <span className="hero-unit">weekly subscriptions</span>}
          </div>
          <div className="hero-sub">
            {formatTokens(totals.tokens)} tokens · {plural(totals.requests, unit)}
            {' · '}{formatDuration(totals.durationMs)}
            {' · '}{formatClock(totals.firstAt)}
            {isCost ? ' · * if billed at full API rate' : ''}
            <Why text={'This session\'s share of ' + (project ? project.name : 'the project')
              + '\'s apportioned burn, split by the tokens each part of the session measured. '
              + 'Every figure on this page partitions this one. It is an estimate; the pool total '
              + 'it comes out of is not.'} />
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Main loop</div>
            <div className="stat-value">{formatPercent(totals.mainTokens, totals.tokens)}</div>
            <div className="stat-detail">{plural(totals.mainRequests, unit)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Subagent lanes</div>
            <div className="stat-value">
              {supports.composition ? formatPercent(totals.laneTokens, totals.tokens) : '—'}
            </div>
            <div className="stat-detail">
              {supports.composition
                ? plural(totals.lanes, 'run') + ' · ' + plural(totals.laneRequests, unit)
                : 'not recorded'}
            </div>
          </div>
        </div>
      </section>

      <WhySentence why={why} totals={totals} supports={supports} unit={unit} />

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            Inside the session
            <Why text={'The session\'s own burn in ' + bucketLabel(bucketMs) + ' buckets, split into the '
              + 'main loop and the subagent lanes it launched. The bucket size follows the session\'s '
              + 'length. The columns are this session\'s figure apportioned by the tokens measured in '
              + 'each bucket, so they sum to the headline exactly.'} />
          </h2>
          <span className="card-note">
            {bucketLabel(bucketMs)} buckets · {formatDuration(totals.durationMs)}
          </span>
        </div>
        {timeline ? (
          <DailyChart
            buckets={timeline.buckets}
            series={[
              { key: 'main', label: 'Main loop', color: mainColor },
              // A series is only named when it exists: a Codex session has no
              // lanes, and a legend that lists one advertises a colour the
              // reader will never see.
              ...(totals.laneTokens > 0 ? [{ key: 'lane', label: 'Subagent lanes', color: LANE_COLOR }] : []),
            ]}
            values={timeline.values}
            unit={isCost ? 'cost' : 'subs'}
            resolution="bucket"
            selection={null}
            onSelect={null}
            height={220}
            chartStyle={chartStyle}
            formatTick={formatTick}
            formatLabel={formatLabel}
            showBrush={false}
            hint={<EventRail timeline={timeline} supports={supports} formatLabel={formatLabel} />}
          />
        ) : <div className="empty">No requests recorded for this session.</div>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            What was running
            <Why text={'One block for the session\'s own turns and one for every subagent run, sized by '
              + 'the tokens each measured. Subagent requests are part of the session total, never an '
              + 'addition to it, so the blocks sum to the headline. Blocks too small to draw at label '
              + 'size fold into one, exactly as on the levels above.'} />
          </h2>
          <span className="card-note">
            {supports.composition
              ? plural(totals.lanes, 'subagent run') + ' · ' + formatTokens(totals.laneTokens)
                + (data.compositionTruncated
                  ? ' · showing ' + data.composition.length + ' of ' + data.compositionTotal : '')
                + (totals.lanesWithoutRequests
                  ? ' · ' + totals.lanesWithoutRequests + ' with no measured requests' : '')
              : 'Codex rollouts record no subagent runs'}
          </span>
          <span className="spacer" />
          {expandMore ? (
            <button type="button" className="chip" style={{ cursor: 'pointer', background: 'none' }} onClick={() => setExpandMore(false)}>
              ← All parts
            </button>
          ) : null}
          {!expandMore && folded.hidden.length && !folded.moreFits ? (
            <button
              type="button"
              className="chip more-chip"
              style={{ cursor: 'pointer', background: 'none' }}
              onClick={() => setExpandMore(true)}
            >
              +{folded.hidden.length} more · {show(morePrinted)} · {formatPercent(morePrinted, totalShown)}
            </button>
          ) : null}
        </div>
        {expandMore ? (
          <FoldedList items={moreItems} total={morePrinted} isCost={isCost} onOpen={() => {}} noun="part" />
        ) : (
          <div ref={mapRef} style={{ height: TREEMAP_HEIGHT }}>
            <Treemap
              items={mapItems}
              height={TREEMAP_HEIGHT}
              onSelect={(item) => { if (item.more) setExpandMore(true); }}
              emptyText="No requests recorded for this session."
            />
          </div>
        )}
      </section>

      <ContextCurve
        unit={unit}
        curve={data.curve}
        stride={data.curveStride}
        totals={totals}
        mainColor={mainColor}
        supports={supports}
        timeline={timeline}
      />

      <SessionCache health={health} totals={totals} unit={unit} comparable={supports.cacheRate !== false} />

      <SessionText
        session={session}
        data={data}
        project={project}
        health={health}
        supports={supports}
      />
    </>
  );
}

/**
 * THE COMPUTED SENTENCE — the page's headline answer.
 *
 * One sentence, numbers first, SELECTED by the largest term rather than written,
 * so it says something different about a session that spent its tokens
 * generating than about one that spent them re-reading. The tiles beside it are
 * the terms the sentence rests on; the ⓘ carries the method and the runners-up,
 * because the ranking is the only part that is an argument.
 */
function WhySentence({ why, totals, supports, unit }) {
  if (!why) return null;
  const requestWord = plural(why.requests, unit);
  const context = formatTokens(Math.round(why.avgContext));
  const share = Math.round(why.share * 100) + '%';
  const sentence = why.term === 'contextRead'
    ? requestWord + ' × ' + context + ' average context — ' + share
      + ' of this session is context re-reading, not output.'
    : why.term === 'contextWrite'
      ? formatTokens(why.tokens) + ' written into the cache over ' + requestWord + ' — ' + share
        + ' of this session is building context, not reusing it.'
      : why.term === 'freshInput'
        ? formatTokens(why.tokens) + ' of uncached input over ' + requestWord + ' — ' + share
          + ' of this session is context the cache never held.'
        : formatTokens(why.tokens) + ' of output over ' + requestWord + ' — ' + share
          + ' of this session is generation, not context.';
  return (
    <section className="card why-card">
      <div className="why-head">
        <p className="why-sentence">{sentence}</p>
        <Why text={'Chosen, not written: the four token classes partition the session exactly '
          + '(cache reads, cache writes, uncached input, output) and the largest one picks the '
          + 'sentence. Here: '
          + why.ranked.map((entry) => entry.label + ' ' + Math.round(entry.share * 100) + '%').join(', ')
          + '. Average context is every ' + unit + '\'s cache-read plus input tokens, divided by '
          + unit + 's.'} />
      </div>
      <div className="stats why-stats">
        <div className="stat">
          <div className="stat-label">Average context</div>
          <div className="stat-value">{context}</div>
          <div className="stat-detail">peak {formatTokens(why.maxContext)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Output</div>
          <div className="stat-value">{formatTokens(totals.output)}</div>
          <div className="stat-detail">{formatPercent(totals.output, totals.tokens)} of the session</div>
        </div>
        {supports.composition ? (
          <div className="stat">
            <div className="stat-label">In subagent lanes</div>
            <div className="stat-value">{Math.round(why.laneShare * 100)}%</div>
            <div className="stat-detail">{plural(why.lanes, 'run')} · {formatTokens(why.laneTokens)}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * THE EVENT RAIL — skills and lane launches on the timeline's own buckets, so
 * "the spike inside the spike" has a cause under it.
 *
 * It is a grid rather than reference lines: seventy launches drawn as vertical
 * rules would black out the plot, and a rail keeps the columns readable while
 * putting the events at the same x. The grid has exactly one column per bucket,
 * which is where a band chart puts its marks.
 *
 * ALIGNMENT. The row's LABEL occupies the plot's left inset — it does not sit
 * beside it. A label of its own width plus a gap plus a PLOT_LEFT padding on the
 * track put every glyph 60px to the right of the bucket it described, which is
 * the state CodeRabbit caught on PR #393 and is worse than drawing no rail at
 * all. So the label is sized from PLOT_LEFT itself rather than from a CSS
 * constant that can drift away from it, the row carries no gap, and the track
 * starts exactly where the plot's first column does.
 *
 * Shape carries the meaning, not colour: ◆ a skill, ▲ a lane launch. A cell with
 * more than one event prints the count.
 */
function EventRail({ timeline, supports, formatLabel }) {
  if (!timeline || !supports.skillEvents) {
    return (
      <div className="chart-hint">
        {supports.laneLaunches
          ? ''
          : 'Codex rollouts record no skill or subagent events — the timeline is turns only.'}
      </div>
    );
  }
  const rows = [
    { key: 'launches', glyph: '▲', label: 'Lanes', noun: 'lane launch', count: (row) => row.launches },
    { key: 'skills', glyph: '◆', label: 'Skills', noun: 'skill run', count: (row) => row.skills },
  ].filter((entry) => timeline.rows.some((row) => entry.count(row) > 0));
  if (!rows.length) return <div className="chart-hint" />;
  return (
    <div className="rail-wrap">
      {rows.map((entry) => (
        <div className="rail" key={entry.key}>
          <span className="rail-label" style={{ width: PLOT_LEFT }}>{entry.label}</span>
          <div
            className="rail-track"
            style={{
              paddingRight: PLOT_RIGHT,
              gridTemplateColumns: 'repeat(' + timeline.rows.length + ', 1fr)',
            }}
          >
            {timeline.rows.map((row) => {
              const count = entry.count(row);
              return (
                <span
                  className={'rail-cell' + (count ? ' on' : '')}
                  key={row.key}
                  title={count ? formatLabel(row.key) + ' · ' + plural(count, entry.noun) : undefined}
                >
                  {count ? <span aria-hidden>{entry.glyph}</span> : null}
                  {count > 1 ? <span className="rail-count">{count}</span> : null}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * THE CONTEXT CURVE — per-request context size over the session.
 *
 * This is the proof of the sentence above when context re-reading is the term: a
 * line that climbs and stays high is a conversation being re-read in full on
 * every turn, and each lane's own climb is visible beside it. Two series, the
 * page's two entities, dots off — three thousand points is a shape, not a
 * scatter — and a table view carrying per-bucket averages, since no reader can
 * read a value off a line this dense.
 */
function ContextCurve({ curve, stride, totals, mainColor, supports, timeline, unit }) {
  const [showTable, setShowTable] = useState(false);
  const data = useMemo(() => (curve || []).map((point) => ({
    t: Date.parse(point.at),
    main: point.lane ? null : point.context,
    lane: point.lane ? point.context : null,
  })).filter((point) => !Number.isNaN(point.t)), [curve]);
  if (!data.length) return null;
  const series = [
    { key: 'main', label: 'Main loop', color: mainColor },
    ...(supports.composition && data.some((point) => point.lane != null)
      ? [{ key: 'lane', label: 'Subagent lanes', color: LANE_COLOR }] : []),
  ];
  const start = data[0].t;
  const end = data[data.length - 1].t;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          Context per {unit}
          <Why text={'Every ' + unit + '\'s cache-read plus input tokens, in the order they were sent. '
            + 'A line that climbs and holds is a context being re-read in full every turn; each '
            + 'subagent lane carries its own, which is why a session can re-read far more than one '
            + 'conversation\'s worth.'
            + (stride > 1 ? ' Every ' + stride + 'th ' + unit + ' is plotted, evenly across the session.' : '')} />
        </h2>
        <span className="card-note">
          peak {formatTokens(totals.contextMax)}
          {' · average '}
          {formatTokens(Math.round(totals.contextSum / Math.max(1, totals.requests)))}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="chip"
          style={{ cursor: 'pointer', background: 'none' }}
          onClick={() => setShowTable((current) => !current)}
          aria-pressed={showTable}
        >
          {showTable ? 'Hide table' : 'Table'}
        </button>
      </div>
      <div className="chart-wrap">
        <div className="card-head" style={{ marginBottom: 8 }}>
          <Legend series={series} shape="line" />
        </div>
        <ResponsiveContainer width="100%" height={CURVE_HEIGHT}>
          <LineChart data={data} margin={{ top: 8, right: PLOT_RIGHT, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[start, end]}
              tickFormatter={(entry) => clockOf(new Date(entry))}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--baseline)' }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(entry) => formatTokens(entry)}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={PLOT_LEFT}
            />
            <Tooltip
              cursor={{ stroke: 'var(--baseline)', strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null;
                const rows = payload.filter((entry) => entry.value != null);
                if (!rows.length) return null;
                return (
                  <div className="tip">
                    <div className="tip-head">{dayClockOf(new Date(label))}</div>
                    {rows.map((entry) => (
                      <div className="tip-row" key={entry.dataKey}>
                        <span className="tip-name">
                          <span className="tip-key" style={{ background: entry.color }} aria-hidden />
                          {entry.dataKey === 'lane' ? 'Subagent lane' : 'Main loop'}
                        </span>
                        <span className="tip-value">{formatTokens(entry.value)}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {series.map((entry) => (
              <Line
                key={entry.key}
                dataKey={entry.key}
                stroke={entry.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 2, stroke: 'var(--surface)' }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {showTable && timeline ? (
        <div style={{ marginTop: 12, maxHeight: 260, overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Bucket</th>
                <th className="num">{unit === 'turn' ? 'Turns' : 'Requests'}</th>
                <th className="num">Average context</th>
                <th className="num">Peak context</th>
              </tr>
            </thead>
            <tbody>
              {timeline.rows.filter((row) => row.requests > 0).map((row) => (
                <tr key={row.key}>
                  <td>{dayClockOf(bucketDate(row.key) || new Date())}</td>
                  <td className="num muted">{formatCount(row.requests)}</td>
                  <td className="num muted">{formatTokens(Math.round(row.contextSum / row.requests))}</td>
                  <td className="num">{formatTokens(row.contextMax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/**
 * SESSION CACHE DIAGNOSTICS — the project level's metric and thresholds, the
 * same badge and meter language, measured on this session instead.
 *
 * NOT flagged on Codex. The thresholds are per REQUEST, and a Codex rollout's
 * unit is a turn that may cover many calls, so the same number means something
 * different there — the rate is still shown, without a verdict attached to it,
 * and the composition (how much input came from cache) carries the reading.
 */
function SessionCache({ health, totals, unit, comparable }) {
  if (!health || health.level === 'unknown') return null;
  const level = comparable ? health.level : 'ok';
  const color = level === 'red' ? 'var(--critical)'
    : level === 'amber' ? 'var(--warning)' : 'var(--good)';
  return (
    <section className="card compact">
      <div className="card-head">
        <h2 className="card-title">
          Prompt caching, this session
          <Why text={comparable
            ? 'Uncached input tokens per request, the same metric and the same absolute '
              + 'thresholds the project level uses — ' + formatCount(CACHE_RED) + ' a request is broken, '
              + formatCount(CACHE_AMBER) + ' is the warning line. Cached input is billed at a fraction of '
              + 'the uncached rate and burns the weekly subscription far slower.'
            : 'A Codex rollout records one row per TURN, and a turn may be several model calls, so '
              + 'the per-request thresholds used on Claude sessions do not transfer and no verdict is '
              + 'given here. The share of input served from cache is measured the same way on both.'} />
        </h2>
        <span className="spacer" />
        {/* Two conditions, both explicit: the reading has to be COMPARABLE (a
            turn is not a request, so no threshold applies to Codex) and it has
            to be a red or amber verdict. Without the second one the label
            ternary below reads "caching weak" for a healthy session. */}
        {comparable && cacheFlagged(health) ? (
          <Badge level={health.level} title="Uncached input per request is far above the healthy range">
            {health.level === 'red' ? 'caching broken' : 'caching weak'}
          </Badge>
        ) : null}
      </div>
      <div className="cache-row">
        <div className="stat">
          <div className="stat-label">Uncached input / {unit}</div>
          <div className="stat-value" style={{ color: level === 'ok' ? undefined : color }}>
            {formatCount(Math.round(health.perRequest))}
          </div>
          <div className="stat-detail">
            over {plural(health.requests, unit)}
            {comparable ? '' : ' · no threshold applies to a turn'}
          </div>
        </div>
        <div className="stat grow">
          <div className="stat-label">Input served from cache</div>
          <div className="stat-value">{(health.readShare * 100).toFixed(1)}%</div>
          <Meter value={health.readShare * 100} max={100} color={color} />
        </div>
        <div className="stat">
          <div className="stat-label">Written to cache</div>
          <div className="stat-value">{formatTokens(totals.inputCacheWrite)}</div>
          <div className="stat-detail">{formatPercent(totals.inputCacheWrite, totals.tokens)} of the session</div>
        </div>
      </div>
    </section>
  );
}

/**
 * The deepest level, and the ONLY text on it: what this session actually was.
 * Everything above is pictures and figures; this is the "so what is this?" the
 * drill's dead-end block used to carry, kept short.
 */
function SessionText({ session, data, project, health, supports }) {
  const skills = (data.events && data.events.skills) || [];
  const byName = new Map();
  for (const event of skills) byName.set(event.name, (byName.get(event.name) || 0) + 1);
  const types = new Map();
  for (const part of data.composition || []) {
    if (part.kind !== 'lane' || !part.agentType) continue;
    types.set(part.agentType, (types.get(part.agentType) || 0) + 1);
  }
  const models = [...new Set((data.composition || []).map((part) => part.model).filter(Boolean))];
  const flagged = supports.cacheRate !== false && cacheFlagged(health);
  return (
    <section className="card compact">
      <div className="card-head">
        <h2 className="card-title">What this session was</h2>
      </div>
      <div className="detail-text">
        {session.activityLabel ? (
          <div>
            Classified <strong>{session.activityLabel}</strong>
            {session.activityWhy ? ' because ' + session.activityWhy : ''}.
          </div>
        ) : null}
        {models.length ? (
          <div>
            Models: {models.map((name) => <span key={name} className="chip">{name}</span>)}
          </div>
        ) : null}
        {byName.size ? (
          <div>
            Ran: {[...byName.entries()].slice(0, 12).map(([name, count]) => (
              <span key={name} className="chip">{name}{count > 1 ? ' ×' + count : ''}</span>
            ))}
          </div>
        ) : null}
        {/* The agent-type list is a LIST, and a list with nothing in it renders
            nothing at all rather than an open and a close bracket around a void.
            Most subagent rows on this warehouse carry no agent_type, which is
            what produced the decider's photographed "(…)". */}
        {supports.composition ? (
          <div>
            {plural(data.totals.lanes, 'subagent run')} · {formatTokens(data.totals.laneTokens)}
            {types.size
              ? ' (' + [...types.entries()].slice(0, 6).map(([name, count]) => name + ' ×' + count).join(', ') + ')'
              : ' · agent type not recorded for these runs'}
          </div>
        ) : (
          // The NORMALIZED prop, not data.supports: this branch is exactly the
          // one that runs when the payload carries no supports object at all,
          // which is where reaching through the raw payload throws.
          <div>{supports.note}</div>
        )}
        {flagged ? (
          <div className={'note ' + health.level}>
            <strong>Prompt caching is {health.level === 'red' ? 'not working' : 'weak'} here.</strong>{' '}
            Every request carries {formatCount(Math.round(health.perRequest))} input tokens the provider
            had to read fresh — {formatTokens(health.uncached)} over {plural(health.requests, supports.unit || 'request')}.
            A cache breaks when something near the front of the context changes between turns; every
            token after the change is re-read at full price. Find what moves at the front and pin it.
          </div>
        ) : null}
        {session.cwd ? <div className="detail-path">{session.cwd}</div> : null}
        {project && project.path && project.path !== session.cwd
          ? <div className="detail-path">in {project.name}</div> : null}
      </div>
    </section>
  );
}
