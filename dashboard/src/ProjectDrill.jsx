import React, { useEffect, useMemo, useState } from 'react';
import DailyChart from './DailyChart.jsx';
import Treemap, { collapseSmall } from './Treemap.jsx';
import SessionAnatomy from './SessionAnatomy.jsx';
import { FoldedList } from './Overview.jsx';
import { Badge, Meter, Segmented, Why, slotColor, useElementSize, usePersisted, NEUTRAL } from './ui.jsx';
import { ProviderMark } from './brand.jsx';
import { getJSON, query } from './api.js';
import {
  allocateRounded, boundsForSelection, enumerateBuckets, projectValueSeries, sumOver,
} from './model.js';
import { cacheHealth, cacheCohort, cacheFlagged, CACHE_AMBER, CACHE_RED } from './detectors.js';
import {
  formatCount, formatDayShort, formatHourShort, formatPercent,
  formatMoney, formatSubs, formatTokens, moneyPlaces, plural,
} from './format.js';

/*
 * THE PROJECT DRILL (issue #386, amendment decision 11).
 *
 * The narrative the decider gave: see a spike → dig in → "what caused my usage
 * to go so fast" → PICTURES first at every level, text only at the deepest "so
 * what is this?" level. Inside a project he thinks in TASKS and ACTIVITY
 * SPIKES, not in sessions — so the page reads:
 *
 *   1. WHAT   the activity treemap, LEADING (amendment d11 + charter d8).
 *             A dimension switch cuts the same burn by activity, model or skill.
 *   2. WHEN   the project's own burn over the range the reader arrived with.
 *   3. WHICH  sessions as ranked blocks — the last resort, not the unit of
 *             analysis. Opening one opens the SESSION ANATOMY page.
 *   4. Caching diagnostics, and no prose anywhere above them.
 *
 * SUM EXACTNESS. Every picture on this page partitions ONE figure: the
 * subscriptions (or API-$) the LANDING printed for this project, over the slice
 * the reader carried in. That figure is not recomputed here — it comes out of
 * model.js's projectValueSeries, the same function the landing's block reads —
 * so the two levels cannot disagree by a cent.
 *
 * WHERE THE ACTIVITY LABEL COMES FROM. Not from a second heuristic written in
 * the page: /api/usage/activity-breakdown (slice 2) is the classifier, and it
 * sees things the browser cannot — the lane manifest and each session's subagent
 * types. The page reads its buckets, its labels and its per-session reason, and
 * invents none of them. Charter d8: heuristic AND LABELED in v1, which is what
 * the card's ⓘ says.
 */

const DIMENSIONS = [
  { value: 'activity', label: 'Activity' },
  { value: 'model', label: 'Model' },
  { value: 'skill', label: 'Skill' },
];

/*
 * ACTIVITY COLOUR. Fixed by activity, never by rank in the current cut, so
 * "Build lanes" is the same hue on every project and in every range. The keys
 * are the API's own bucket keys.
 */
const ACTIVITY_SLOT = {
  lane: 0, review: 1, orchestration: 2, design: 3, other: -1,
};

const PROVIDER_SLOT = { claude: 1, codex: 0 };
const providerColor = (name) => slotColor(PROVIDER_SLOT[name] ?? -1);

const TREEMAP_HEIGHT = 300;
const STYLE_KEY = 'modeldeck.overview.chartStyle';
const SESSION_ROWS = 24;

const UNRECORDED_MODEL = '(model not recorded)';
const UNRECORDED_SKILL = '(no skill recorded)';

/*
 * A session's IDENTITY. The id alone is not one: the same session id under two
 * profiles is two different sessions, and mixing them is this repo's recurring
 * defect class. The separator is the ASCII unit separator the warehouse itself
 * keys on, which can occur in neither field.
 */
const SEP = '\u001f';
const sessionKey = (session) => (
  session.provider + SEP + session.sessionId + SEP + (session.profileSlug || '')
);

// The leaderboard returns both of these most-used-first, so the head of the
// list is the session's primary one.
const primaryModel = (session) => (session.models || [])[0] || UNRECORDED_MODEL;
const primarySkill = (session) => (
  (session.skills || [])[0] || (session.commands || [])[0] || UNRECORDED_SKILL
);

export default function ProjectDrill({ model, route, go, lens }) {
  const [data, setData] = useState(null);
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState(null);
  const [chartStyle] = usePersisted(STYLE_KEY, 'bars', ['bars', 'area']);
  const [expandMore, setExpandMore] = useState(false);
  const [expandSessions, setExpandSessions] = useState(false);
  const [mapRef, mapSize] = useElementSize({ width: 1040, height: TREEMAP_HEIGHT });

  const projectKey = route.projectKey;
  const selection = route.selection || null;
  const dimension = route.dimension || 'activity';
  const pick = route.pick || null;

  const project = model.projects.find((entry) => entry.key === projectKey) || null;
  const isCost = lens === 'cost';

  // The slice the reader arrived with. The API bounds session aggregates to
  // IN-RANGE requests, so asking for the slice gives exact per-slice tokens
  // rather than whole-session totals filtered after the fact.
  const bounds = useMemo(() => boundsForSelection(model, selection), [model, selection]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setActivity(null);
    setError(null);
    setExpandMore(false);
    setExpandSessions(false);
    const base = { ...bounds, project: projectKey, provider: model.scope || undefined };
    Promise.all([
      getJSON('/api/usage/projects?' + query({
        ...base, bucket: model.resolution === 'hour' ? 'hour' : 'local_day', limit: 200,
      })),
      // Slice 2's classifier. A failure here costs the ACTIVITY dimension its
      // labels, not the page — the other two dimensions and every figure stand.
      getJSON('/api/usage/activity-breakdown?' + query(base)).catch(() => null),
    ]).then(([burn, breakdown]) => {
      if (cancelled) return;
      setData(burn);
      setActivity(breakdown);
    }).catch((cause) => { if (!cancelled) setError(String(cause.message || cause)); });
    return () => { cancelled = true; };
  }, [projectKey, bounds, model.resolution, model.scope]);

  // ---- the one figure every picture below partitions -------------------------
  const projectValues = useMemo(() => projectValueSeries(model, isCost), [model, isCost]);
  const projectExact = project
    ? sumOver(projectValues.get(project.key), model.buckets, selection)
    : 0;
  const places = isCost ? moneyPlaces(projectExact) : 2;
  const factor = Math.pow(10, places);
  const projectTotal = Math.round(projectExact * factor) / factor;
  const money = (value) => formatMoney(value, places);
  const show = (value) => (isCost ? money(value) : formatSubs(value));

  // ---- sessions, with their activity label joined on -------------------------
  const activityLabels = useMemo(() => {
    const out = new Map();
    for (const bucket of (activity && activity.buckets) || []) out.set(bucket.key, bucket.label);
    return out;
  }, [activity]);

  const sessions = useMemo(() => {
    const rows = (data && data.sessions && data.sessions.sessions) || [];
    const classified = new Map();
    for (const row of (activity && activity.sessions) || []) classified.set(sessionKey(row), row);
    return rows
      .filter((session) => {
        // projectBurn keys by cwd verbatim; the drill's project is the FOLDED
        // parent, so a worktree child belongs to it too.
        const cwd = String(session.cwd || '');
        return cwd === projectKey || cwd.startsWith(projectKey + '/');
      })
      .map((session) => {
        const tag = classified.get(sessionKey(session));
        return {
          ...session,
          activity: tag ? tag.activity : null,
          activityWhy: tag ? tag.why : null,
        };
      })
      .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
  }, [data, activity, projectKey]);

  // ---- the WHAT cut ---------------------------------------------------------
  const cut = useMemo(() => {
    const keyOf = dimension === 'activity'
      ? (session) => session.activity || 'other'
      : dimension === 'model' ? primaryModel : primarySkill;
    const groups = new Map();
    for (const session of sessions) {
      const key = keyOf(session);
      if (!groups.has(key)) groups.set(key, { key, tokens: 0, sessions: [] });
      const group = groups.get(key);
      group.tokens += session.totalTokens || 0;
      group.sessions.push(session);
    }
    const rows = [...groups.values()].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
    const covered = rows.reduce((sum, row) => sum + row.tokens, 0);
    // EXACT here, deliberately. There is exactly ONE rounding on this page
    // (mapShown, below), over the final block set at the page's precision.
    // Rounding twice — once here and once there — lets a block print a figure
    // the level it opens does not partition, and hides a broken sum behind a
    // second pass that repairs it.
    rows.forEach((row) => { row.value = covered ? projectTotal * (row.tokens / covered) : 0; });
    return rows;
  }, [sessions, dimension, projectTotal]);

  const labelOf = (row) => (
    dimension === 'activity' ? (activityLabels.get(row.key) || row.key) : row.key
  );
  const colorFor = (row, index) => {
    if (dimension === 'activity') {
      const slot = ACTIVITY_SLOT[row.key];
      return slot != null && slot >= 0 ? slotColor(slot) : NEUTRAL;
    }
    return slotColor(index < 8 ? index : -1);
  };

  const rawItems = useMemo(() => cut.map((row, index) => ({
    key: row.key,
    name: labelOf(row),
    value: row.value,
    tokens: row.tokens,
    color: colorFor(row, index),
    row,
  })), [cut, dimension, activityLabels]);

  const folded = useMemo(
    () => collapseSmall(rawItems, { width: mapSize.width, height: TREEMAP_HEIGHT }),
    [rawItems, mapSize.width],
  );
  // One rounding over the FINAL block set, so the labels on the map sum to the
  // headline and the "+N more" label is what the blocks inside it sum to.
  const mapShown = useMemo(() => {
    const values = folded.kept.map((item) => item.value);
    if (folded.hidden.length) values.push(folded.hidden.reduce((sum, item) => sum + item.value, 0));
    return allocateRounded(values, projectTotal, places);
  }, [folded, projectTotal, places]);
  const totalShown = mapShown.reduce((sum, value) => sum + value, 0);
  const morePrinted = folded.hidden.length ? mapShown[mapShown.length - 1] : 0;

  // `entry` is what FoldedList reads to decide a row is openable — the folded
  // tail filters the sessions below exactly like a block on the map does.
  const decorate = (item, printed) => ({
    ...item,
    entry: item.row,
    printed,
    valueLabel: show(printed),
    subLabel: formatTokens(item.tokens) + ' · ' + plural(item.row.sessions.length, 'session'),
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

  /*
   * What each block PRINTED. Opening a block hands its printed figure down to
   * the sessions inside it, so the rows under an opened block sum to the label
   * on the block rather than to a fourth number computed a fourth way.
   */
  const printedByKey = useMemo(() => {
    const out = new Map();
    folded.kept.forEach((item, index) => out.set(item.key, mapShown[index]));
    for (const item of moreItems) out.set(item.key, item.printed);
    return out;
  }, [folded, mapShown, moreItems]);

  // ---- the WHEN chart -------------------------------------------------------
  const chartBuckets = useMemo(
    () => enumerateBuckets(bounds.since, bounds.until, model.resolution),
    [bounds, model.resolution],
  );
  const chartValues = useMemo(() => {
    const map = new Map();
    if (!project) return new Map([['burn', map]]);
    const live = chartBuckets.filter((bucket) => (project.byBucket.get(bucket) || 0) > 0);
    const tokens = live.map((bucket) => project.byBucket.get(bucket) || 0);
    const denominator = tokens.reduce((sum, value) => sum + value, 0);
    const exact = tokens.map((value) => (denominator ? projectTotal * (value / denominator) : 0));
    const rounded = allocateRounded(exact, projectTotal, isCost ? 2 : 4);
    live.forEach((bucket, index) => { if (rounded[index] > 0) map.set(bucket, rounded[index]); });
    return new Map([['burn', map]]);
  }, [project, chartBuckets, projectTotal, isCost]);

  // ---- the WHICH rows -------------------------------------------------------
  const shownCut = pick ? cut.find((row) => row.key === pick) : null;
  const sessionRows = shownCut ? shownCut.sessions : sessions;
  // Every block in the cut is either kept on the map or in its folded tail, so
  // an opened block always has a printed figure for its sessions to partition.
  const sessionTarget = shownCut ? printedByKey.get(shownCut.key) : projectTotal;
  const sessionValues = useMemo(() => {
    const tokens = sessionRows.reduce((sum, session) => sum + (session.totalTokens || 0), 0);
    const exact = sessionRows.map((session) => (
      tokens ? sessionTarget * ((session.totalTokens || 0) / tokens) : 0
    ));
    return allocateRounded(exact, sessionTarget, places);
  }, [sessionRows, sessionTarget, places]);

  // ---- caching --------------------------------------------------------------
  const health = useMemo(() => cacheHealth(project), [project]);
  const cohort = useMemo(() => cacheCohort(model.projects), [model]);

  const openIndex = route.level === 'session'
    ? sessionRows.findIndex((row) => sessionKey(row) === route.sessionKey)
    : -1;

  if (error) return <div className="card error">Could not load this project: {error}</div>;
  if (!project) return <div className="card empty">That project is not in the current range.</div>;

  const label = model.resolution === 'hour' ? formatHourShort : formatDayShort;
  const sliceLabel = selection
    ? (selection.from === selection.to
      ? label(selection.from)
      : label(selection.from) + ' – ' + label(selection.to))
    : null;
  const poolTotal = isCost ? model.cost.total : model.pool.total;

  const setDimension = (value) => go(
    { ...route, level: 'project', dimension: value, pick: null, pickLabel: null, sessionKey: null, sessionTitle: null },
    { push: false },
  );
  const clearPick = () => go({
    ...route, level: 'project', pick: null, pickLabel: null, sessionKey: null, sessionTitle: null,
  });
  const openCut = (item) => {
    if (item.more) { setExpandMore(true); return; }
    if (pick === item.key) { clearPick(); return; }
    go({ ...route, level: 'activity', pick: item.key, pickLabel: item.name, sessionKey: null, sessionTitle: null });
  };
  const openSession = (session) => go({
    ...route,
    level: 'session',
    sessionKey: sessionKey(session),
    sessionTitle: session.title || session.gitBranch || String(session.sessionId).slice(0, 8),
  });

  // The session level IS the anatomy page. It is handed the row this page
  // ranked and the exact figure this page printed for it, so nothing about the
  // session is computed twice.
  if (route.level === 'session') {
    if (!data) return <div className="card empty">Measuring…</div>;
    if (openIndex < 0) return <div className="card empty">That session is not in this slice.</div>;
    const target = sessionRows[openIndex];
    return (
      <SessionAnatomy
        session={{ ...target, activityLabel: activityLabels.get(target.activity) || null }}
        value={sessionValues[openIndex] || 0}
        places={places}
        isCost={isCost}
        project={project}
      />
    );
  }

  const visibleSessions = expandSessions ? sessionRows : sessionRows.slice(0, SESSION_ROWS);
  const leadTokens = sessionRows.length ? (sessionRows[0].totalTokens || 0) : 0;

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">
            <ProjectMarks project={project} />
            {project.name}
            {/* The caching flag rides the headline as well as its own card at
                the foot of the page: a diagnostic nobody scrolls to is the
                below-fold defect this drill exists to stop repeating. */}
            {cacheFlagged(health) ? (
              <Badge level={health.level} title="Uncached input per request is far above the healthy range">
                {health.level === 'red' ? 'caching broken' : 'caching weak'}
              </Badge>
            ) : null}
          </div>
          <div className="hero-figure">
            {isCost ? money(projectTotal) + '*' : formatSubs(projectTotal)}
            {!isCost ? <span className="hero-unit">weekly subscriptions</span> : null}
          </div>
          <div className="hero-sub">
            {formatPercent(projectTotal, poolTotal)} of the pool
            {sliceLabel ? ' · ' + sliceLabel : ''}
            {isCost ? ' · * if billed at full API rate' : ''}
            <Why text={'This project\'s share of the pool\'s measured burn, apportioned by weighted '
              + 'token flow — the same figure the Overview\'s block printed, computed once. It is an '
              + 'estimate; the pool total it comes out of is not. '
              + (project.path || '')} />
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Tokens</div>
            <div className="stat-value">
              {formatTokens(sessions.reduce((sum, session) => sum + (session.totalTokens || 0), 0))}
            </div>
            <div className="stat-detail">{plural(sessions.length, 'session')}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Top {dimension === 'activity' ? 'activity' : dimension}</div>
            <div className="stat-value">{cut.length ? labelOf(cut[0]) : '—'}</div>
            <div className="stat-detail">
              {cut.length ? formatPercent(cut[0].value, projectTotal) + ' of this project' : ''}
            </div>
          </div>
        </div>
      </section>

      {/* 1. WHAT — the leading picture (amendment d11). */}
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            Where it went
            <Why text={'Activity is a HEURISTIC read, made by the daemon from the lane manifest, each '
              + 'session\'s skills and subagent types, its branch, its path and its title — first '
              + 'signal wins, and every session lands somewhere named. Model and skill cut the same '
              + 'burn by each session\'s primary one. Blocks are sized by the figure printed on them '
              + 'and always sum to the headline; anything too small to draw at label size folds into '
              + 'one block rather than rendering half a label.'} />
          </h2>
          <Segmented options={DIMENSIONS} value={dimension} onChange={setDimension} label="Breakdown dimension" />
          <span className="spacer" />
          {expandMore ? (
            <button type="button" className="chip" style={{ cursor: 'pointer', background: 'none' }} onClick={() => setExpandMore(false)}>
              ← All blocks
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
          {pick ? (
            <button type="button" className="chip" style={{ cursor: 'pointer', background: 'none' }} onClick={clearPick}>
              Clear filter
            </button>
          ) : null}
        </div>
        {!data ? (
          <div className="empty">Measuring…</div>
        ) : expandMore ? (
          <FoldedList
            items={moreItems}
            total={morePrinted}
            isCost={isCost}
            onOpen={(item) => openCut(item)}
            noun="block"
          />
        ) : (
          <div ref={mapRef} style={{ height: TREEMAP_HEIGHT }}>
            <Treemap
              items={mapItems}
              height={TREEMAP_HEIGHT}
              onSelect={openCut}
              emptyText="No sessions ingested for this project in this slice."
            />
          </div>
        )}
      </section>

      {/* 2. WHEN */}
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            When {project.name} burned
            <Why text="This project's share of the pool's measured burn, placed on the buckets its sessions actually ran in. The columns sum to the headline." />
          </h2>
          <span className="card-note">{sliceLabel || 'full range'}</span>
        </div>
        <DailyChart
          buckets={chartBuckets}
          series={[{ key: 'burn', label: project.name, color: slotColor(project.rank) }]}
          values={chartValues}
          unit={isCost ? 'cost' : 'subs'}
          resolution={model.resolution}
          selection={null}
          // Nothing below this chart scopes to a bucket, so it carries no click
          // affordance, no brush and no hint promising one.
          onSelect={null}
          height={200}
          chartStyle={chartStyle}
          showBrush={false}
          hint={false}
        />
      </section>

      {/* 3. WHICH — the last resort, not the unit of analysis. */}
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            Sessions{shownCut ? ' in ' + labelOf(shownCut) : ''}
            <Why text="Ranked blocks, sized by the same burn — sessions are the last resort here, not the unit of analysis. The blocks sum to whatever is above them: the whole project, or the one block you opened." />
          </h2>
          <span className="card-note">
            {plural(sessionRows.length, 'session')} · {show(sessionTarget)}
            {' · click one to open its anatomy'}
          </span>
          <span className="spacer" />
          {sessionRows.length > SESSION_ROWS ? (
            <button
              type="button"
              className="chip more-chip"
              style={{ cursor: 'pointer', background: 'none' }}
              onClick={() => setExpandSessions((current) => !current)}
              aria-pressed={expandSessions}
            >
              {expandSessions
                ? '← Top ' + SESSION_ROWS
                : '+' + (sessionRows.length - SESSION_ROWS) + ' more'}
            </button>
          ) : null}
        </div>
        <div className="bars">
          {visibleSessions.map((session, index) => {
            const slot = ACTIVITY_SLOT[session.activity];
            const color = slot != null && slot >= 0 ? slotColor(slot) : NEUTRAL;
            return (
              <button
                key={sessionKey(session)}
                type="button"
                className="bar-row session-row"
                onClick={() => openSession(session)}
              >
                <span className="session-name">
                  <span className="pmark-slot" style={{ color: providerColor(session.provider) }}>
                    <ProviderMark provider={session.provider} size={12} />
                  </span>
                  {session.title || session.gitBranch || String(session.sessionId).slice(0, 8)}
                </span>
                <span className="session-value">{show(sessionValues[index] || 0)}</span>
                <span className="track">
                  <i style={{
                    background: color,
                    width: (leadTokens
                      ? Math.max(1, ((session.totalTokens || 0) / leadTokens) * 100) : 0) + '%',
                  }} />
                </span>
              </button>
            );
          })}
          {sessionRows.length === 0 ? <div className="empty">No sessions in this slice.</div> : null}
        </div>
      </section>

      <CacheCard health={health} cohort={cohort} />
    </>
  );
}

/** The provider marks a project actually used, in the fixed provider order. */
function ProjectMarks({ project }) {
  const list = ['claude', 'codex'].filter((name) => project.providers && project.providers.has(name));
  if (!list.length) return null;
  return (
    <span className="pmarks">
      {list.map((name) => (
        <span key={name} className="pmark-slot" style={{ color: providerColor(name) }}>
          <ProviderMark provider={name} size={12} />
        </span>
      ))}
    </span>
  );
}

/**
 * CACHE HEALTH — numbers, a meter and a flag, no prose.
 *
 * The meter reads the wrong way round on purpose: it fills with the share of
 * input tokens that were served from cache, so a healthy project is a full bar
 * and the broken one is visibly short. The rate underneath it is the actual
 * detector, because share alone hides scale.
 *
 * Rendered for every project, flagged only for the ones that are wrong.
 */
function CacheCard({ health, cohort }) {
  if (health.level === 'unknown') return null;
  const color = health.level === 'red' ? 'var(--critical)'
    : health.level === 'amber' ? 'var(--warning)' : 'var(--good)';
  return (
    <section className="card compact">
      <div className="card-head">
        <h2 className="card-title">
          Prompt caching
          <Why text={'Uncached input tokens per request. Agent turns re-send the same context every '
            + 'time, so caching should drive this near zero — the context is written once and read '
            + 'back. At or above ' + formatCount(CACHE_RED) + ' a request the project is paying full '
            + 'freight for context it already paid for; ' + formatCount(CACHE_AMBER) + ' is the warning '
            + 'line. Open a session above for what that looks like inside one.'} />
        </h2>
        <span className="spacer" />
        {/* The gate is HERE, not only inside Badge. A healthy project reaches
            this line with a measurable rate, and the label ternary below it
            would read "caching weak" for it — the badge is currently suppressed
            by Badge's own red/amber guard, which is a correct outcome resting on
            a decision made in another file. */}
        {cacheFlagged(health) ? (
          <Badge level={health.level} title="Uncached input per request is far above the healthy range">
            {health.level === 'red' ? 'caching broken' : 'caching weak'}
          </Badge>
        ) : null}
      </div>
      <div className="cache-row">
        <div className="stat">
          <div className="stat-label">Uncached input / request</div>
          <div className="stat-value" style={{ color: health.level === 'ok' ? undefined : color }}>
            {formatCount(Math.round(health.perRequest))}
          </div>
          <div className="stat-detail">
            {cohort != null ? 'healthy projects here run ' + formatCount(Math.round(cohort)) : ''}
          </div>
        </div>
        <div className="stat grow">
          <div className="stat-label">Input served from cache</div>
          <div className="stat-value">{(health.readShare * 100).toFixed(1)}%</div>
          <Meter value={health.readShare * 100} max={100} color={color} />
        </div>
        <div className="stat">
          <div className="stat-label">Uncached input</div>
          <div className="stat-value">{formatTokens(health.uncached)}</div>
          <div className="stat-detail">over {plural(health.requests, 'request')}</div>
        </div>
      </div>
    </section>
  );
}
