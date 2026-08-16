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
import { clearArrivalFragment, currentArrival, reportRoute } from './route.js';

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

function MemberBlackoutAlerts({ status }) {
  const alerts = Array.isArray(status?.alerts) ? status.alerts : [];
  if (!alerts.length) return null;
  return (
    <div className="member-blackout-alerts" aria-label="Proxy pool alerts">
      {alerts.map((alert) => (
        <div className="member-blackout-alert" role="alert" key={alert.accountId}>
          <span className="member-blackout-badge">Pool alert</span>
          <span>
            <strong>{alert.label}</strong>: {alert.consecutiveFailures} routed requests failed in a row
            {alert.statusCode ? ` (HTTP ${alert.statusCode})` : ''}.{' '}
            {alert.remedy || 'Sign in again to restore proxy routing.'}
          </span>
        </div>
      ))}
    </div>
  );
}

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
function useRoute({ rangeKey, scope, initial = HOME }) {
  // Stamped from the first render: a route is only meaningful under the range
  // and scope it was made under (#393), and an arriving one is no exception.
  const [route, setRoute] = useState(() => ({ ...initial, rangeKey, scope }));
  // A ref, not a dependency: the listener is registered once, and re-registering
  // it on every filter change would drop a pop that arrived mid-swap.
  const filters = useRef({ rangeKey, scope });
  filters.current = { rangeKey, scope };
  // The arriving position is a mount-time fact; a ref keeps the seeding effect
  // a genuine once-only without pretending `initial` is not read inside it.
  const seedRoute = useRef(initial);

  const stamp = useCallback((next) => ({ ...next, ...filters.current }), []);

  useEffect(() => {
    // The deep link (#424) seeds the FIRST history entry, so the back button
    // out of an arrival behaves exactly like the back button out of a drill
    // the reader opened himself — one navigation system, one history.
    const seed = { ...seedRoute.current, ...filters.current };
    try { window.history.replaceState({ [ROUTE_MARK]: true, route: seed }, ''); } catch { /* opaque origin */ }
    // The instruction has been carried out; it is not the reader's position.
    clearArrivalFragment();
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
  /*
   * DEEP-LINK ARRIVAL (#424). The app window opens this page with a route on
   * the URL fragment; route.js parses it. Read once, before any state exists,
   * because it decides the INITIAL value of three of them.
   *
   * FILTER CARRY-THROUGH (#371), the arrival case. Range and provider scope
   * are App state, so a route that names them has to seed that state — land
   * on a drill with the wrong range and its keys name nothing, which is the
   * exact stale-route failure #393 already guards on the back button. Seeded
   * here, they are simply the filters the reader arrives holding, and every
   * later navigation preserves them the way it always did.
   */
  const arrival = useRef(null);
  if (!arrival.current) arrival.current = currentArrival();
  const start = arrival.current;
  const [rangeKey, setRangeKey] = useState(start.rangeKey);
  const [scope, setScope] = useState(start.scope);
  const [lens, setLens] = useState('subs');
  const [theme, setTheme] = useTheme();
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(true);
  const [route, go] = useRoute({ rangeKey, scope, initial: start.route });
  const first = useRef(true);
  const here = useRef(route);
  // The return controls (issue #408). One level up, named — presentation over
  // the same `go` the crumbs call, so history behaves identically either way.
  const parent = parentOf(route);
  const trail = useRef(null);
  const goUp = () => {
    if (!parent) return;
    go(parent.to);
  };
  /*
   * KEYBOARD FOCUS ACROSS RE-RENDERS (#363).
   *
   * A data re-render does not cost the reader his place: this page is React, so
   * a refetch reconciles the tree and every control keeps the DOM node it had,
   * focus included. NAVIGATION is the case that does, and it is the whole of the
   * defect: the control a reader activates to change level is often removed BY
   * that change — a treemap block and a session row open the level they name and
   * then cease to exist, the crumb reading "Overview" becomes plain text once it
   * IS the page, and both return controls are absent at the landing. The browser
   * answers a removed focus by dropping to <body>, which puts a keyboard reader
   * back at the top of the document with his position gone.
   *
   * So one rule, over every route change and therefore every view: if a
   * navigation left focus stranded on <body>, park it on the breadcrumb trail —
   * the one navigation landmark present at every level, and where a reader needs
   * to be to walk back out of where he just went. Focus that SURVIVED the commit
   * is never moved, which is what keeps a filter or a toggle exactly where it is.
   *
   * A deep-link arrival (#424) is the same problem without a click: nothing on
   * this page was activated at all, so focus is wherever the host window left it
   * — for the app window, on the window chrome. It parks unconditionally.
   */
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    // A plain load is not a navigation: the reader is at the top of the page
    // because that is where he opened it, and stealing his focus would be rude.
    if (first && !start.deepLinked) return;
    const active = document.activeElement;
    if (!first && active && active !== document.body) return;
    if (trail.current) trail.current.focus();
  }, [route]);
  // Tell the host window where the reader is, so a relaunch reopens here
  // (#402(c)). One-way and advisory — a browser tab has no host and this is a
  // no-op there. It reports the position, never asks for one.
  useEffect(() => { reportRoute(route); }, [route]);
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

      <MemberBlackoutAlerts status={model?.memberBlackout} />

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
