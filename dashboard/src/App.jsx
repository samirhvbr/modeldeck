import React, { useCallback, useEffect, useRef, useState } from 'react';
import Overview from './Overview.jsx';
import ProjectDrill from './ProjectDrill.jsx';
import Detail, { DEFAULT_DETAIL, detailLabel } from './Detail.jsx';
import { Segmented, Why, usePersisted } from './ui.jsx';
import { ProviderMark } from './brand.jsx';
import { RANGES, DEFAULT_RANGE } from './api.js';
import { loadModel } from './model.js';
import { PRICE_SNAPSHOT_DATE, PRICE_SOURCE } from './prices.js';
import { UpPill, ZoomOutPuck, parentOf } from './DrillNav.jsx';

/*
 * PROVIDER COLOUR — the assignment lives in Overview.jsx (one place); the tabs
 * import the same two slots so a tab can never disagree with the series it
 * scopes to. Claude wears the clay/orange step, Codex the cool blue.
 */
const TAB_COLOR = { claude: 'var(--cat-2)', codex: 'var(--cat-1)' };

const Tab = ({ provider }) => (
  <span className="pmark-slot" style={{ color: TAB_COLOR[provider] }}>
    <ProviderMark provider={provider} size={12} />
  </span>
);

const SCOPES = [
  { value: 'claude', label: 'Claude', icon: <Tab provider="claude" /> },
  { value: 'codex', label: 'Codex', icon: <Tab provider="codex" /> },
  {
    value: '',
    label: 'Combined',
    icon: <span className="pmarks"><Tab provider="claude" /><Tab provider="codex" /></span>,
  },
];

const LENSES = [
  { value: 'subs', label: 'Subscriptions' },
  { value: 'cost', label: 'Cost' },
];

/*
 * The header's view switch (issue #409). The old control was a one-way chip
 * that vanished on arrival, so the affordance that took the reader into the
 * detail views was gone when he wanted back out — "now I feel like I am
 * stuck". A two-position switch instead, drawn like the segment controls
 * beside it and present on EVERY page in both directions. Drill pages hang
 * off the landing, so their truthful position is Overview.
 */
const VIEWS = [
  { value: 'overview', label: 'Overview' },
  { value: 'detail', label: 'Detail views' },
];

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const THEME_KEY = 'modeldeck.overview.theme';
const THEME_VALUES = THEMES.map((entry) => entry.value);

const HOME = { level: 'overview', selection: null };
// Marks a history entry as ours. A back that lands on an entry without it (the
// page the reader arrived from) is not a drill level and must not be read as one.
const ROUTE_MARK = 'modeldeckDrill';

/** System / Light / Dark, remembered (charter decision 12). */
function useTheme() {
  const [theme, setTheme] = usePersisted(THEME_KEY, 'system', THEME_VALUES);
  useEffect(() => {
    // 'system' sets no attribute at all, so prefers-color-scheme keeps deciding.
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
  return [theme, setTheme];
}

/*
 * NAVIGATION (issue #386).
 *
 * The decider's report on the first drill prototype was "no way to get back a
 * level". Two things fix that, and they have to be the SAME thing:
 *
 *   * a breadcrumb trail present at every level and clickable at every level
 *     above the current one, and
 *   * the browser's own back button, because that is what a reader's hand
 *     reaches for first.
 *
 * So the drill's position is one serialisable route object, and that object IS
 * the history entry. Opening a level pushes; changing a filter on the level you
 * are on REPLACES (a brush drag would otherwise bury the back button under
 * twenty indistinguishable states); changing range or provider scope returns
 * home, because those change which projects exist at all.
 *
 * FILTER CARRY-THROUGH (#371). Range, provider scope and the unit lens are App
 * state, not route state, so they survive every drill navigation and every back
 * out of it untouched. The chart's time selection is the one filter that IS
 * positional — it scopes what the drill loads — so it rides the route and comes
 * back with it.
 *
 * STAMPED WITH THE FILTERS ITS KEYS MEAN SOMETHING UNDER. Changing the range or
 * the provider scope replaces the CURRENT entry with home, but the entries
 * already pushed under the old range stay in the back stack — and a route is
 * nothing but keys: a bucket key, a project key, a session key. Restored under a
 * different range those keys name nothing, and the drill would bound its request
 * to a slice outside the loaded window and render an empty page. So every entry
 * records the range and scope it was made under, and a restore that does not
 * match is not a level to return to: it lands on the overview, and the entry is
 * rewritten so a second press of the same button does not repeat the trip.
 */
function useRoute({ rangeKey, scope }) {
  const [route, setRoute] = useState(HOME);
  // A ref, not a dependency: the listener is registered once, and re-registering
  // it on every filter change would drop a pop that arrived mid-swap.
  const filters = useRef({ rangeKey, scope });
  filters.current = { rangeKey, scope };

  const stamp = useCallback((next) => ({ ...next, ...filters.current }), []);

  useEffect(() => {
    const seed = { ...HOME, ...filters.current };
    try { window.history.replaceState({ [ROUTE_MARK]: true, route: seed }, ''); } catch { /* opaque origin */ }
    const onPop = (event) => {
      const stored = event.state && event.state[ROUTE_MARK] ? event.state.route : null;
      const current = filters.current;
      const usable = stored
        && stored.rangeKey === current.rangeKey
        && stored.scope === current.scope;
      const next = usable ? stored : { ...HOME, ...current };
      setRoute(next);
      if (usable) return;
      try { window.history.replaceState({ [ROUTE_MARK]: true, route: next }, ''); } catch { /* opaque origin */ }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next, { push = true } = {}) => {
    const stamped = stamp(next);
    setRoute(stamped);
    try {
      const state = { [ROUTE_MARK]: true, route: stamped };
      if (push) window.history.pushState(state, '');
      else window.history.replaceState(state, '');
    } catch { /* history unavailable — the crumbs still work */ }
  }, [stamp]);

  return [route, go];
}

function Crumbs({ route, go, trailRef }) {
  const trail = [{ key: 'overview', label: 'Overview', to: HOME }];
  // The detail views (issue #387) hang off the landing, not off a project: the
  // project is a FILTER on them, changeable on the page, so it is not a level
  // above them that a crumb could walk back to.
  if (route.level === 'detail') {
    trail.push({ key: 'detail', label: detailLabel(route.detail), to: null });
  } else if (route.level !== 'overview') {
    trail.push({
      key: 'project',
      label: route.projectName || route.projectKey,
      to: { ...route, level: 'project', pick: null, pickLabel: null, sessionKey: null, sessionTitle: null },
    });
  }
  if (route.level === 'activity' || (route.level === 'session' && route.pick)) {
    trail.push({
      key: 'pick',
      label: route.pickLabel || route.pick,
      to: { ...route, level: 'activity', sessionKey: null, sessionTitle: null },
    });
  }
  if (route.level === 'session') {
    trail.push({ key: 'session', label: route.sessionTitle || 'Session', to: null });
  }
  return (
    // tabIndex -1 makes the trail programmatically focusable without adding a
    // tab stop: it is where focus is parked when a return control unmounts
    // under the reader's own click (see goUp below).
    <nav className="crumbs" aria-label="Breadcrumb" ref={trailRef} tabIndex={-1}>
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1;
        return (
          <React.Fragment key={crumb.key}>
            {index > 0 ? <span aria-hidden>›</span> : null}
            {last || !crumb.to
              ? <span aria-current="page">{crumb.label}</span>
              : <button type="button" onClick={() => go(crumb.to)}>{crumb.label}</button>}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export default function App() {
  const [rangeKey, setRangeKey] = useState(DEFAULT_RANGE);
  const [scope, setScope] = useState('claude');
  const [lens, setLens] = useState('subs');
  const [theme, setTheme] = useTheme();
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(true);
  const [route, go] = useRoute({ rangeKey, scope });
  const first = useRef(true);
  const here = useRef(route);
  // The return controls (issue #408). One level up, named — presentation over
  // the same `go` the crumbs call, so history behaves identically either way.
  const parent = parentOf(route);
  const trail = useRef(null);
  const returning = useRef(false);
  const goUp = () => {
    if (!parent) return;
    returning.current = true;
    go(parent.to);
  };
  // A return click can unmount the control that was clicked — both controls are
  // absent at the overview — which would strand focus on a removed node and drop
  // the keyboard reader at the top of the document (#363). When that happens,
  // and only then, focus parks on the breadcrumb trail: the one navigation
  // landmark present at every level.
  useEffect(() => {
    if (!returning.current) return;
    returning.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (trail.current) trail.current.focus();
  }, [route]);
  // Committed in an effect (declared before the range/scope effect, so it runs
  // first within a commit): a render-time write could leak a discarded render's
  // route into the history replace below.
  useEffect(() => { here.current = route; }, [route]);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    loadModel({ rangeKey, scope })
      .then((next) => { if (!cancelled) { setModel(next); setPending(false); } })
      .catch((cause) => { if (!cancelled) { setError(String(cause.message || cause)); setPending(false); } });
    return () => { cancelled = true; };
  }, [rangeKey, scope]);

  // A new range or scope invalidates every level below the landing, the time
  // selection included — so it REPLACES rather than stacking a dead state on the
  // history. The first render is not a change and must not overwrite the entry
  // useRoute just seeded.
  //
  // The DETAIL views are the exception, and deliberately so (#371): they are not
  // a drill position but a page with filters on it, and a reader who narrows the
  // range while reading the model × effort table is filtering that table, not
  // asking to be sent back to the landing. Only the chart selection is dropped,
  // because its bucket keys name nothing under a different range.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    // A ref, not a dependency: `route` in the dependency list would re-run this
    // on every navigation and send the reader home for opening a level.
    const current = here.current;
    go(current.level === 'detail' ? { ...current, selection: null } : HOME, { push: false });
  }, [rangeKey, scope, go]);

  const openProject = (key, selection) => {
    const entry = model && model.projects.find((row) => row.key === key);
    go({
      level: 'project',
      projectKey: key,
      projectName: entry ? entry.name : key,
      // The chart selection the reader arrived with rides the route into the
      // drill and comes back out of it on the browser's own back button.
      selection: selection === undefined ? route.selection || null : selection,
      dimension: 'activity',
      pick: null, pickLabel: null, sessionKey: null, sessionTitle: null,
    });
  };

  /*
   * The detail views, opened from the landing or from anywhere in the drill —
   * with the filters the reader already has in hand. That is the whole of
   * #371's carry-through on this side: the chart's time selection and the
   * project ride the route, so opening the model × effort table from inside a
   * project opens it ALREADY narrowed to that project and that slice, and the
   * browser's back button puts the reader back where he was.
   */
  const openDetail = () => go({
    level: 'detail',
    detail: route.detail || DEFAULT_DETAIL,
    selection: route.selection || null,
    projectKey: route.projectKey || null,
    projectName: route.projectName || null,
  });

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">ModelDeck · Usage</span>
        <Crumbs route={route} go={go} trailRef={trail} />
        <span className="spacer" />
        <Segmented
          options={VIEWS}
          value={route.level === 'detail' ? 'detail' : 'overview'}
          onChange={(next) => {
            if (next === 'detail') { if (route.level !== 'detail') openDetail(); }
            else if (route.level !== 'overview') go(HOME);
          }}
          className="views"
          label="View"
        />
        <Segmented options={LENSES} value={lens} onChange={setLens} className="lens" label="Unit lens" />
      </header>

      <div className="filters">
        <span className="filter-label">Range</span>
        <Segmented
          options={RANGES.map((entry) => ({ value: entry.key, label: entry.label }))}
          value={rangeKey}
          onChange={setRangeKey}
          label="Time range"
        />
        <span className="filter-label">Provider</span>
        <Segmented options={SCOPES} value={scope} onChange={setScope} label="Provider scope" />
        <span className="spacer" />
        <span className="filter-label">Theme</span>
        <Segmented options={THEMES} value={theme} onChange={setTheme} label="Theme" />
      </div>

      {error ? <div className="card error">Could not load usage: {error}</div> : null}

      {/* Zoom back out, one level a click (#408). Both are null at the overview. */}
      <UpPill parent={parent} onUp={goUp} />
      <ZoomOutPuck parent={parent} onUp={goUp} />

      {!model ? (
        <div className="card empty">{pending ? 'Measuring…' : 'No data.'}</div>
      ) : (
        // Refetch keeps the frame: the previous render holds at reduced opacity
        // rather than flashing a skeleton.
        <div className={pending ? 'loading' : ''}>
          {route.level === 'overview' ? (
            <Overview
              model={model}
              lens={lens}
              selection={route.selection || null}
              // Brushing the chart is a filter on the level you are already on,
              // so it replaces rather than stacking a history entry per drag.
              onSelect={(selection) => go({ ...HOME, selection }, { push: false })}
              onOpenProject={openProject}
            />
          ) : route.level === 'detail' ? (
            <Detail model={model} route={route} go={go} lens={lens} />
          ) : (
            <ProjectDrill model={model} route={route} go={go} lens={lens} />
          )}
        </div>
      )}

      <footer className="footer">
        <p>
          Subscription figures are the provider's own measured usage levels across the pool, apportioned
          across projects by weighted token flow — the parts always sum to the measured total, including
          the untraceable remainder. Project figures are estimates; the pool total is not.
        </p>
        <p>
          <strong>*</strong> Cost is an API-$ equivalent, priced from measured provider-truth tokens at
          the pinned {PRICE_SOURCE} snapshot of {PRICE_SNAPSHOT_DATE}. Nothing here is a bill — these
          subscriptions are flat-rate.
          <Why text="Rates are vendored in the build and never fetched at runtime. A model id absent from the rate list is priced through its nearest sibling and marked ≈ in the model table." />
        </p>
        <p>Read-only — nothing on this page writes.</p>
      </footer>
    </div>
  );
}
