import React, { useEffect, useMemo, useState } from 'react';
import DailyChart from './DailyChart.jsx';
import { Meter, Segmented, Why, slotColor, NEUTRAL } from './ui.jsx';
import { ProviderMark } from './brand.jsx';
import { getJSON, query } from './api.js';
import {
  allocateRounded, boundsForSelection, bucketsIn, foldCwd, projectValueSeries, sumOver,
} from './model.js';
import {
  formatClock, formatDayShort, formatHourShort, formatMoney, formatPercent,
  formatSubs, formatTokens, moneyPlaces, plural,
} from './format.js';

/*
 * THE DETAIL VIEWS (issue #387; charter decisions 2, 3 and 4, amendment d7).
 *
 * What the charter did to the pre-redesign tabs:
 *
 *   headroom      DEMOTED (d2). Pool availability carries the landing's
 *                 headline; which ACCOUNT is nearly out is a question you come
 *                 here to ask, and this is the only page that answers it per
 *                 limit rather than per account.
 *   burn timeline REDENOMINATED (#370). Subscriptions burned per day and the
 *                 share of one weekly subscription — never tokens, and the word
 *                 "windows" appears nowhere. The limit toggle is Tim's own ask:
 *                 the model-scoped weekly limit (his primary lens) or the
 *                 account-wide one.
 *   model×effort  GAINS A PROJECT FILTER (#371).
 *   project burn  DELETED (d3) — the Overview treemap and the project drill
 *                 subsume it, so there is no tab here for it and no route to it.
 *   sessions      DEMOTED to ONE direct link (d4). The primary path is
 *                 project → sessions inside the drill; this is the cross-project
 *                 question ("which session anywhere burned most") and it hands
 *                 the reader back to the project path on click.
 *
 * FILTERS CARRY (#371). Range, provider scope and the unit lens are App state
 * and survive every navigation untouched. The two positional filters — the
 * chart's time selection and the project — ride the route, so they arrive here
 * from the landing or the drill and go back out with the browser's own back
 * button. Changing the project here changes the route, which is why the drill
 * you open from a session row lands with the same filters in hand.
 *
 * SUMS. Same rule as every other level: one largest-remainder pass per figure
 * set, over the FINAL set, at the precision it is printed to. Where a set is
 * genuinely not summable — nested weekly limits describe the same requests from
 * different angles — no total is printed at all rather than one that lies.
 *
 * SECTION-LOCAL FILTERS (#410) LAYER, never fight. A section filter chooses
 * among the rows the header's provider scope already admits, so it can only ever
 * narrow the page — and it is section state, so the carried filters above are
 * untouched by it. The FINAL set is the filtered one, which is what the single
 * largest-remainder pass runs over; a filtered caption says what it now covers.
 */

export const DETAIL_VIEWS = [
  { value: 'headroom', label: 'Headroom' },
  { value: 'timeline', label: 'Burn timeline' },
  { value: 'model-effort', label: 'Model × effort' },
  { value: 'sessions', label: 'Sessions' },
];
export const DEFAULT_DETAIL = 'headroom';

// The views a project filter means something for. Headroom and the burn
// timeline are measurements of the POOL — the provider's own usage levels — and
// a project cannot narrow a measurement it is not a dimension of. The filter
// still rides the route through them, so it is there when you come back.
const PROJECT_SCOPED = new Set(['model-effort', 'sessions']);

const PROVIDER_SLOT = { claude: 1, codex: 0 };
const providerColor = (name) => slotColor(PROVIDER_SLOT[name] ?? -1);

// Reasoning effort, in the order a reader ranks it, with anything unrecognised
// after it and "no effort recorded" last — an absent effort is a fact about the
// request, not a bucket to bury in the middle of the table.
const EFFORT_ORDER = ['high', 'medium', 'low', 'minimal'];
const NO_EFFORT = '(none)';

/*
 * The ASCII unit separator, which the warehouse itself keys on: it can occur in
 * none of the fields joined with it. A key built by bare concatenation is not a
 * tuple, and the same session id under two profiles is two different sessions —
 * conflating them is this repo's recurring defect class.
 */
const SEP = '\u001f';
const SESSION_LIMIT = 50;

/** The unnarrowed position of a section filter — "everything the page admits". */
const ALL = 'all';

export function detailLabel(value) {
  const entry = DETAIL_VIEWS.find((view) => view.value === value);
  return entry ? entry.label : DETAIL_VIEWS[0].label;
}

export default function Detail({ model, route, go, lens }) {
  const view = DETAIL_VIEWS.some((entry) => entry.value === route.detail)
    ? route.detail : DEFAULT_DETAIL;
  const selection = route.selection || null;
  const projectKey = route.projectKey || '';
  const isCost = lens === 'cost';

  const setView = (next) => go({ ...route, detail: next }, { push: false });
  const setProject = (key) => {
    const entry = model.projects.find((row) => row.key === key) || null;
    go({
      ...route,
      projectKey: key || null,
      projectName: entry ? entry.name : null,
    }, { push: false });
  };

  const label = model.resolution === 'hour' ? formatHourShort : formatDayShort;
  const sliceLabel = selection
    ? (selection.from === selection.to
      ? label(selection.from)
      : label(selection.from) + ' – ' + label(selection.to))
    : null;

  return (
    <>
      <div className="filters detailbar">
        <span className="filter-label">View</span>
        <Segmented options={DETAIL_VIEWS} value={view} onChange={setView} label="Detail view" />
        {PROJECT_SCOPED.has(view) ? (
          <>
            <span className="filter-label">Project</span>
            <select
              className="pick"
              aria-label="Project filter"
              value={projectKey}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">All projects</option>
              {model.projects.filter((entry) => !entry.unattributed).map((entry) => (
                <option key={entry.key} value={entry.key}>{entry.name}</option>
              ))}
            </select>
          </>
        ) : null}
        <span className="spacer" />
        {sliceLabel ? <span className="chip">{sliceLabel}</span> : null}
      </div>

      {view === 'headroom' ? <Headroom model={model} /> : null}
      {view === 'timeline' ? <Timeline model={model} selection={selection} /> : null}
      {view === 'model-effort' ? (
        <ModelEffort
          model={model}
          selection={selection}
          projectKey={projectKey}
          isCost={isCost}
        />
      ) : null}
      {view === 'sessions' ? (
        <Sessions model={model} selection={selection} projectKey={projectKey} route={route} go={go} />
      ) : null}
    </>
  );
}

/**
 * A SECTION-LOCAL narrowing (#410), over rows that each name an account.
 *
 * The header's provider scope has already decided which accounts exist on this
 * page; this only chooses among those, which is what makes the two controls
 * compose rather than compete — every position of a section filter is a subset
 * of the global one, and the "all" position is exactly the page's own scope.
 * Both positions are DERIVED before they are read, so a scope change that
 * retires a provider or an account narrows nothing on the render that drops it.
 */
function useSectionFilter(rows) {
  const [provider, setProvider] = useState(ALL);
  const [account, setAccount] = useState(ALL);

  // Claude before Codex, the standing Fable-first framing.
  const providers = useMemo(() => [...new Set(rows.map((row) => row.provider))].sort((a, b) => (
    (a === 'claude' ? 0 : 1) - (b === 'claude' ? 0 : 1) || String(a).localeCompare(String(b))
  )), [rows]);

  const live = providers.includes(provider) ? provider : ALL;

  const choices = useMemo(() => {
    const seen = new Map();
    for (const row of rows) {
      if (live !== ALL && row.provider !== live) continue;
      if (!seen.has(String(row.accountId))) seen.set(String(row.accountId), row.label);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [rows, live]);

  const pick = choices.some((entry) => entry.value === account) ? account : ALL;

  // The state follows the derivation, so a control never shows a position that
  // is no longer on offer.
  useEffect(() => { if (live !== provider) setProvider(live); }, [live, provider]);
  useEffect(() => { if (pick !== account) setAccount(pick); }, [pick, account]);

  return {
    provider: live,
    setProvider,
    account: pick,
    setAccount,
    providers,
    choices,
    narrowed: live !== ALL || pick !== ALL,
    admits: (row) => (live === ALL || row.provider === live)
      && (pick === ALL || String(row.accountId) === pick),
  };
}

/**
 * The control itself: the header's own segmented pattern for the provider, and
 * a select for the account because that list is as long as the reader has
 * subscriptions — the same reasoning the detail bar's project picker follows. A
 * dimension with nothing to choose between draws no control at all.
 */
function SectionFilter({ name, filter }) {
  const showProvider = filter.providers.length > 1;
  const showAccount = filter.choices.length > 1;
  if (!showProvider && !showAccount) return null;
  return (
    <div className="card-filters">
      {showProvider ? (
        <Segmented
          label={name + ' provider'}
          value={filter.provider}
          onChange={filter.setProvider}
          options={[{ value: ALL, label: 'All' }].concat(filter.providers.map((entry) => ({
            value: entry,
            label: providerLabel(entry),
            icon: (
              <span className="pmark-slot" style={{ color: providerColor(entry) }}>
                <ProviderMark provider={entry} size={12} />
              </span>
            ),
          })))}
        />
      ) : null}
      {showAccount ? (
        // A section whose name already carries the noun ("By subscription")
        // labels its picker "… filter" — never "By subscription subscription".
        <select
          className="pick"
          aria-label={/subscription/i.test(name) ? name + ' filter' : name + ' subscription'}
          value={filter.account}
          onChange={(event) => filter.setAccount(event.target.value)}
        >
          <option value={ALL}>All subscriptions</option>
          {filter.choices.map((entry) => (
            <option key={entry.value} value={entry.value}>{entry.label}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function providerLabel(name) {
  const text = String(name);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * HEADROOM (charter d2), the page the landing's availability verdict points at.
 *
 * Two tables, because they answer two questions and only one of them has a sum.
 * "Burned this range" per ACCOUNT partitions the pool total, so it is rounded
 * once, largest-remainder, to the figure printed on it. The per-LIMIT table
 * below carries no total at all: a model-scoped weekly limit and the
 * account-wide one describe the SAME requests from different angles, and a
 * column of them adds up to nothing real.
 */
function Headroom({ model }) {
  const accounts = model.pool.accounts;
  const windows = model.pool.windows.filter((entry) => entry.binding);
  const hot = windows.filter((entry) => Number(entry.binding.usedPercent) >= 80);

  const every = useMemo(() => {
    const list = [];
    for (const row of accounts) {
      const burned = new Map((row.scopes || []).map((entry) => [entry.scope, entry.subscriptions]));
      for (const limit of row.weekly || []) {
        list.push({ ...limit, accountId: row.accountId, label: row.label, provider: row.provider, burned: burned.get(limit.scope) });
      }
    }
    return list;
  }, [accounts]);

  const bySub = useSectionFilter(accounts);
  const byLimit = useSectionFilter(every);
  const rows = accounts.filter(bySub.admits);
  const limits = every.filter(byLimit.admits);

  /*
   * ONE pass, over the FINAL set. The filtered rows are the set the reader adds
   * up, so the allocation runs over them against their own printed total — never
   * over the pool and then rounded again to fit the narrowed caption, which is
   * the second rounding this repo's sum rule exists to forbid. Unfiltered, the
   * total is the pool's own figure by construction.
   */
  const total = useMemo(() => Math.round(
    rows.reduce((sum, row) => sum + row.subscriptions, 0) * 100,
  ) / 100, [rows]);
  const shown = useMemo(
    () => allocateRounded(rows.map((row) => row.subscriptions), total, 2),
    [rows, total],
  );

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">Subscriptions with headroom</div>
          <div className="hero-figure">
            {windows.length - hot.length}
            <span className="hero-unit">of {windows.length}</span>
          </div>
          <div className="hero-sub">
            {hot.length} at or above 80% used
            <Why text="Headroom is per SUBSCRIPTION here. The landing answers the pool question — can I start heavy work now — and this page is where the reader asks which subscription is the one that is nearly out." />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            By subscription
            <Why text="Each subscription's own measured burn over this range, and its current level. Nested weekly limits describe the same requests, so only the limit that moved most is counted — they are never summed. The column adds up to the figure beside this title exactly, filtered or not." />
          </h2>
          <span className="card-note">
            {formatSubs(total)}
            {bySub.narrowed
              ? ' burned across ' + rows.length + ' of ' + plural(accounts.length, 'subscription')
              : ' burned across the pool'}
          </span>
          <SectionFilter name="By subscription" filter={bySub} />
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Subscription</th>
              <th className="num">Burned</th>
              <th className="num">Now used</th>
              <th style={{ width: '30%' }}>Level</th>
              <th className="num">Resets</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  {bySub.narrowed ? 'No subscriptions match this filter.' : 'No enabled subscriptions in this scope.'}
                </td>
              </tr>
            ) : rows.map((row, index) => {
              const used = row.binding ? Number(row.binding.usedPercent) : null;
              return (
                <tr key={row.accountId}>
                  <td>
                    <span className="cell-key">
                      <span className="pmark-slot" style={{ color: providerColor(row.provider) }}>
                        <ProviderMark provider={row.provider} size={12} />
                      </span>
                      {row.label}
                    </span>
                  </td>
                  <td className="num">{formatSubs(shown[index])}</td>
                  <td className="num">{used == null ? '—' : Math.round(used) + '%'}</td>
                  <td><Meter value={used || 0} max={100} color={levelColor(used)} /></td>
                  <td className="num muted">{row.binding ? formatClock(row.binding.resetsAt) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            Every weekly limit
            <Why text="One row per limit, not per subscription: a subscription carries a subscription-wide weekly limit and a model-scoped one, and the binding constraint is often the model-scoped one. These rows are NOT summable — the same requests count against more than one of them — so no total is printed." />
          </h2>
          <span className="card-note">
            {byLimit.narrowed
              ? limits.length + ' of ' + plural(every.length, 'limit')
              : plural(limits.length, 'limit')}
          </span>
          <SectionFilter name="Every weekly limit" filter={byLimit} />
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Subscription</th>
              <th>Limit</th>
              <th className="num">Burned</th>
              <th className="num">Now used</th>
              <th style={{ width: '26%' }}>Level</th>
              <th className="num">Resets</th>
            </tr>
          </thead>
          <tbody>
            {limits.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  {byLimit.narrowed ? 'No weekly limits match this filter.' : 'No weekly limits recorded in this scope.'}
                </td>
              </tr>
            ) : limits.map((limit) => (
              <tr key={limit.accountId + SEP + limit.scope}>
                <td>
                  <span className="cell-key">
                    <span className="pmark-slot" style={{ color: providerColor(limit.provider) }}>
                      <ProviderMark provider={limit.provider} size={12} />
                    </span>
                    {limit.label}
                  </span>
                </td>
                <td>{limitLabel(limit.scope)}</td>
                <td className="num">{limit.burned == null ? '—' : formatSubs(limit.burned)}</td>
                <td className="num">{Math.round(limit.usedPercent) + '%'}</td>
                <td><Meter value={limit.usedPercent} max={100} color={levelColor(limit.usedPercent)} /></td>
                <td className="num muted">{formatClock(limit.resetsAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function levelColor(used) {
  if (used == null) return NEUTRAL;
  if (used >= 90) return 'var(--critical)';
  if (used >= 80) return 'var(--warning)';
  return 'var(--good)';
}

/** The account-wide weekly limit reads as "all"; a model-scoped one names itself. */
function limitLabel(scope) {
  return String(scope) === 'weekly' ? 'All weekly' : String(scope);
}

/**
 * BURN TIMELINE (issue #370), in subscription units.
 *
 * The decider's ask, in his words: how many weekly subscriptions did a day
 * consume, and what share of one subscription was that. Tokens are not the unit
 * here and the word "windows" appears nowhere — the limit itself is what a
 * figure is denominated in, and which limit is the reader's choice: the
 * model-scoped weekly one he actually runs out of (the default, first in the
 * list) or the account-wide one.
 *
 * ONE ROUNDING. The per-bucket figures are largest-remainder allocated to the
 * printed range total once; the chart, the table and the percent column all read
 * that same allocation, so the column a reader adds up is the column he sees.
 */
function Timeline({ model, selection }) {
  const scopes = useMemo(() => {
    const names = new Set();
    for (const account of model.pool.accounts) {
      for (const entry of account.scopes || []) names.add(entry.scope);
    }
    // Model-scoped weekly limits first — Fable-first framing (charter standing
    // directive): the limit the decider actually runs out of leads, and the
    // account-wide "all" limit is the alternative rather than the default.
    return [...names].sort((a, b) => {
      const rank = (name) => (name === 'weekly' ? 1 : 0);
      return rank(a) - rank(b) || String(a).localeCompare(String(b));
    });
  }, [model]);

  const [scope, setScope] = useState(scopes[0] || null);
  useEffect(() => {
    if (!scopes.includes(scope)) setScope(scopes[0] || null);
  }, [scopes, scope]);

  const buckets = useMemo(() => bucketsIn(model.buckets, selection), [model.buckets, selection]);

  const exact = useMemo(() => {
    const byBucket = new Map();
    for (const account of model.pool.accounts) {
      const entry = (account.scopes || []).find((row) => row.scope === scope);
      if (!entry) continue;
      for (const [hour, percent] of entry.byHour) {
        const bucket = model.resolution === 'hour' ? hour : hour.slice(0, 10);
        byBucket.set(bucket, (byBucket.get(bucket) || 0) + percent / 100);
      }
    }
    return buckets.map((bucket) => byBucket.get(bucket) || 0);
  }, [model, scope, buckets]);

  const total = Math.round(exact.reduce((sum, value) => sum + value, 0) * 100) / 100;
  const shown = useMemo(() => allocateRounded(exact, total, 2), [exact, total]);

  const days = model.resolution === 'hour' ? Math.max(1 / 24, buckets.length / 24) : Math.max(1, buckets.length);
  const perDay = total / days;
  const values = useMemo(() => {
    const map = new Map();
    buckets.forEach((bucket, index) => { if (shown[index] > 0) map.set(bucket, shown[index]); });
    return new Map([['burn', map]]);
  }, [buckets, shown]);

  let peak = null;
  buckets.forEach((bucket, index) => {
    if (!peak || shown[index] > peak.value) peak = { bucket, value: shown[index] };
  });
  const label = model.resolution === 'hour' ? formatHourShort : formatDayShort;

  return (
    <>
      <section className="hero">
        <div className="hero-main">
          <div className="hero-label">Burned this range</div>
          <div className="hero-figure">
            {formatSubs(total)}
            <span className="hero-unit">{limitLabel(scope || 'weekly').toLowerCase()} subscriptions</span>
          </div>
          <div className="hero-sub">
            {formatSubs(perDay)} subscriptions per day · {(perDay * 100).toFixed(0)}% of a subscription a day
            <Why text="Measured on the provider's own usage levels for this limit: the sum of the rises in percent-used across the pool, so a reset counts the fresh burn after it rather than a negative. One subscription is one full weekly limit." />
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Peak {model.resolution === 'hour' ? 'hour' : 'day'}</div>
            <div className="stat-value">{peak ? formatSubs(peak.value) : '—'}</div>
            <div className="stat-detail">{peak ? label(peak.bucket) : ''}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Share of one subscription</div>
            <div className="stat-value">{(total * 100).toFixed(0)}%</div>
            <div className="stat-detail">over {plural(Math.round(days), 'day')}</div>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            Subscription burn
            <Why text="Every figure on this page is denominated in weekly subscriptions, never tokens. The columns sum to the headline exactly." />
          </h2>
          {scopes.length > 1 ? (
            <Segmented
              options={scopes.map((name) => ({ value: name, label: limitLabel(name) }))}
              value={scope}
              onChange={setScope}
              label="Weekly limit"
            />
          ) : null}
          <span className="spacer" />
          <span className="card-note">{formatSubs(total)} subscriptions</span>
        </div>
        <DailyChart
          buckets={buckets}
          series={[{ key: 'burn', label: limitLabel(scope || 'weekly'), color: slotColor(1) }]}
          values={values}
          unit="subs"
          resolution={model.resolution}
          selection={null}
          onSelect={null}
          height={240}
          chartStyle="bars"
          showBrush={false}
          hint={false}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">By {model.resolution === 'hour' ? 'hour' : 'day'}</h2>
          <span className="card-note">{formatSubs(total)} total</span>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>{model.resolution === 'hour' ? 'Hour' : 'Day'}</th>
              <th className="num">Subscriptions</th>
              <th className="num">% of a subscription</th>
              <th className="num">Share of range</th>
            </tr>
          </thead>
          <tbody>
            {buckets.length === 0 ? (
              <tr><td colSpan={4} className="empty">No measured burn in this range.</td></tr>
            ) : buckets.map((bucket, index) => (
              <tr key={bucket}>
                <td>{label(bucket)}</td>
                <td className="num">{formatSubs(shown[index])}</td>
                <td className="num muted">{(shown[index] * 100).toFixed(0)}%</td>
                <td className="num muted">{formatPercent(shown[index], total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/**
 * MODEL × EFFORT (issue #371), with the project filter the view was missing.
 *
 * The matrix reads the SESSION corpus (/api/usage/model-effort), not the proxy
 * warehouse's model_effort grouping — the warehouse records no project, so a
 * project filter cannot be honoured there at all. Reading the corpus is also
 * what lets the cells partition the SAME figure the level above printed: the
 * project's subscriptions, or the pool's, apportioned by each cell's measured
 * token share in one largest-remainder pass over the whole matrix. Row totals
 * and column totals are then sums of printed cells, so every direction a reader
 * adds them up in agrees.
 */
function ModelEffort({ model, selection, projectKey, isCost }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const bounds = useMemo(() => boundsForSelection(model, selection), [model, selection]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getJSON('/api/usage/model-effort?' + query({
      ...bounds, provider: model.scope || undefined, project: projectKey || undefined,
    }))
      .then((next) => { if (!cancelled) setData(next); })
      .catch((cause) => { if (!cancelled) setError(String(cause.message || cause)); });
    return () => { cancelled = true; };
  }, [bounds, model.scope, projectKey]);

  const projectValues = useMemo(() => projectValueSeries(model, isCost), [model, isCost]);
  const target = useMemo(() => {
    if (projectKey) return sumOver(projectValues.get(projectKey), model.buckets, selection);
    let sum = 0;
    for (const [, map] of projectValues) sum += sumOver(map, model.buckets, selection);
    return sum;
  }, [projectValues, model.buckets, selection, projectKey]);

  const places = isCost ? moneyPlaces(target) : 2;
  const factor = Math.pow(10, places);
  const printed = Math.round(target * factor) / factor;
  const show = (value) => (isCost ? formatMoney(value, places) : formatSubs(value));

  const cells = (data && data.cells) || [];
  const tokenTotal = cells.reduce((sum, cell) => sum + cell.totalTokens, 0);
  // ONE pass, over the whole matrix, at the printed precision.
  const values = useMemo(() => allocateRounded(
    cells.map((cell) => (tokenTotal ? printed * (cell.totalTokens / tokenTotal) : 0)),
    printed,
    places,
  ), [cells, tokenTotal, printed, places]);

  const efforts = useMemo(() => {
    const names = new Set(cells.map((cell) => cell.effort || NO_EFFORT));
    return [...names].sort((a, b) => {
      const rank = (name) => {
        if (name === NO_EFFORT) return EFFORT_ORDER.length + 1;
        const at = EFFORT_ORDER.indexOf(String(name).toLowerCase());
        return at === -1 ? EFFORT_ORDER.length : at;
      };
      return rank(a) - rank(b) || String(a).localeCompare(String(b));
    });
  }, [cells]);

  const rows = useMemo(() => {
    const byModel = new Map();
    cells.forEach((cell, index) => {
      const key = cell.provider + SEP + (cell.model || '(unnamed)');
      if (!byModel.has(key)) {
        byModel.set(key, {
          key,
          provider: cell.provider,
          model: cell.model || '(unnamed)',
          byEffort: new Map(),
          tokens: 0,
          requests: 0,
          value: 0,
        });
      }
      const row = byModel.get(key);
      const effort = cell.effort || NO_EFFORT;
      row.byEffort.set(effort, (row.byEffort.get(effort) || 0) + values[index]);
      row.tokens += cell.totalTokens;
      row.requests += cell.requests;
      row.value += values[index];
    });
    // Claude before Codex: Fable-first framing is a standing directive, and the
    // provider order is how it is honoured without hardcoding a model name that
    // the payload is free to change.
    return [...byModel.values()].sort((a, b) => (
      (a.provider === 'claude' ? 0 : 1) - (b.provider === 'claude' ? 0 : 1)
      || b.value - a.value
      || b.tokens - a.tokens
    ));
  }, [cells, values]);

  const columnTotals = efforts.map((effort) => rows.reduce(
    (sum, row) => sum + (row.byEffort.get(effort) || 0), 0,
  ));
  const grand = rows.reduce((sum, row) => sum + row.value, 0);

  if (error) return <div className="card error">Could not load model × effort: {error}</div>;

  return (
    <section className={'card' + (data ? '' : ' loading')}>
      <div className="card-head">
        <h2 className="card-title">
          Model × effort
          <Why text={'Measured tokens per model and reasoning effort, over the session corpus — which is '
            + 'the universe that carries a project, so the filter above narrows this table to one project. '
            + 'Each cell is the figure the level above printed, apportioned by that cell\'s measured token '
            + 'share; the cells sum to the headline in both directions. An unrecorded effort is shown as '
            + 'such rather than folded into a bucket no request was made under.'} />
        </h2>
        <span className="card-note">
          {show(grand)}
          {isCost ? '*' : ' subscriptions'}
          {' · '}
          {formatTokens(tokenTotal)} tokens
          {projectKey ? ' · one project' : ' · all projects'}
        </span>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Model</th>
            {efforts.map((effort) => (
              <th key={effort} className="num">{effort === NO_EFFORT ? 'no effort' : effort}</th>
            ))}
            <th className="num">Total</th>
            <th className="num">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={efforts.length + 3} className="empty">
                {data ? 'No measured activity in this slice.' : 'Measuring…'}
              </td>
            </tr>
          ) : rows.map((row) => (
            <tr key={row.key}>
              <td>
                <span className="cell-key">
                  <span className="pmark-slot" style={{ color: providerColor(row.provider) }}>
                    <ProviderMark provider={row.provider} size={12} />
                  </span>
                  {row.model}
                </span>
              </td>
              {efforts.map((effort) => (
                <td key={effort} className="num">
                  {row.byEffort.has(effort) ? show(row.byEffort.get(effort)) : <span className="muted">—</span>}
                </td>
              ))}
              <td className="num">{show(row.value)}</td>
              <td className="num muted">{formatTokens(row.tokens)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length ? (
          <tfoot>
            <tr>
              <th scope="row">All models</th>
              {columnTotals.map((value, index) => (
                <td key={efforts[index]} className="num">{show(value)}</td>
              ))}
              <td className="num">{show(grand)}</td>
              <td className="num muted">{formatTokens(tokenTotal)}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </section>
  );
}

/**
 * THE SESSION EXPLORER, demoted (charter d4).
 *
 * One direct link, for the cross-project question the drill cannot answer:
 * which session ANYWHERE burned the most. It is deliberately a dead end for
 * analysis — clicking a row hands the reader back onto the primary path, the
 * project drill, with the filters he arrived with still set.
 */
function Sessions({ model, selection, projectKey, route, go }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const bounds = useMemo(() => boundsForSelection(model, selection), [model, selection]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getJSON('/api/usage/sessions?' + query({
      ...bounds,
      provider: model.scope || undefined,
      project: projectKey || undefined,
      limit: SESSION_LIMIT,
    }))
      .then((next) => { if (!cancelled) setData(next); })
      .catch((cause) => { if (!cancelled) setError(String(cause.message || cause)); });
    return () => { cancelled = true; };
  }, [bounds, model.scope, projectKey]);

  const rows = (data && data.sessions) || [];
  const tokens = rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const lead = rows.length ? (rows[0].totalTokens || 0) : 0;

  const projectOf = (session) => {
    const parent = foldCwd(session.cwd).parent;
    return model.projects.find((entry) => entry.key === parent) || null;
  };
  const open = (session) => {
    const entry = projectOf(session);
    if (!entry) return;
    go({
      ...route,
      level: 'project',
      projectKey: entry.key,
      projectName: entry.name,
      dimension: 'activity',
      pick: null,
      pickLabel: null,
      sessionKey: null,
      sessionTitle: null,
    });
  };

  if (error) return <div className="card error">Could not load sessions: {error}</div>;

  return (
    <section className={'card' + (data ? '' : ' loading')}>
      <div className="card-head">
        <h2 className="card-title">
          Sessions, across projects
          <Why text="The cross-project ranking, by measured tokens — the one question the project drill cannot answer. Inside a project, sessions live under the activity breakdown, which is where they belong: clicking a row here opens that project's drill rather than dead-ending in a session." />
        </h2>
        <span className="card-note">
          {plural(rows.length, 'session')} · {formatTokens(tokens)} tokens
          {data && data.truncated ? ' · top ' + SESSION_LIMIT : ''}
        </span>
      </div>
      <div className="bars">
        {rows.length === 0 ? (
          <div className="empty">{data ? 'No sessions in this slice.' : 'Measuring…'}</div>
        ) : rows.map((session) => {
          const entry = projectOf(session);
          return (
            <button
              key={session.provider + SEP + session.sessionId + SEP + (session.profileSlug || '')}
              type="button"
              className="bar-row session-row"
              onClick={() => open(session)}
              disabled={!entry}
              title={entry ? 'Open ' + entry.name : 'This session has no project to open'}
            >
              <span className="session-name">
                <span className="pmark-slot" style={{ color: providerColor(session.provider) }}>
                  <ProviderMark provider={session.provider} size={12} />
                </span>
                {session.title || session.gitBranch || String(session.sessionId).slice(0, 8)}
                <span className="muted">{entry ? ' · ' + entry.name : ''}</span>
              </span>
              <span className="session-value">{formatTokens(session.totalTokens || 0)}</span>
              <span className="track">
                <i style={{
                  background: entry ? slotColor(entry.rank) : NEUTRAL,
                  width: (lead ? Math.max(1, ((session.totalTokens || 0) / lead) * 100) : 0) + '%',
                }} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
