/*
 * DEEP-LINK ARRIVAL (issue #424, #402(b)).
 *
 * The app window (macOS) opens the daemon's own /dashboard in a WKWebView and
 * lands the reader on a scoped drill. The binding decision is that there is
 * exactly ONE navigation system: the drill position is already a serialisable
 * route object (#386/#393, App.jsx useRoute), so the window passes THAT object
 * and this module parses it. Swift never grows a navigator of its own; it
 * writes a route and reads one back.
 *
 * THE FRAGMENT, NOT THE QUERY. The route rides `#route=<url-encoded JSON>`.
 * A fragment is never sent to the server, so a route can never land in a
 * request log, and the daemon's `/dashboard` handler stays the byte-for-byte
 * static page it is today (no server-side interpolation, so nothing here can
 * reach the HTML). The daemon token does NOT ride the URL at any point — it
 * travels as the `x-modeldeck-token` header and the `modeldeck_session`
 * cookie the server already requires (src/server.mjs mutationAllowed).
 *
 * UNTRUSTED INPUT. Everything below treats the fragment as hostile: JSON.parse
 * inside a try, a whitelist for every enumerated field, a length cap on every
 * free string, and a level whose required keys are absent is not a level — it
 * lands on the overview rather than rendering a drill for a project that was
 * never named. Nothing here is eval'd, interpolated into markup, or used to
 * build a URL.
 */
import { RANGES, DEFAULT_RANGE } from './api.js';

/** The landing. Same object App.jsx and DrillNav.jsx call HOME. */
const HOME = { level: 'overview', selection: null };

/** The fragment parameter the Swift side writes (DashboardRouteCodec). */
export const ROUTE_PARAM = 'route';

/** The bridge the app window installs; absent in a browser tab. */
const BRIDGE = 'modeldeckRoute';

/*
 * A level is only a level if the keys its page reads are actually there.
 * ProjectDrill keys off projectKey, an activity off the pick within it, a
 * session off its own key — a route naming none of them describes no page.
 */
const LEVELS = {
  overview: [],
  detail: [],
  project: ['projectKey'],
  activity: ['projectKey', 'pick'],
  session: ['projectKey', 'sessionKey'],
};

/** Free-text fields, carried through verbatim but bounded. */
const TEXT_KEYS = [
  'projectKey', 'projectName', 'pick', 'pickLabel', 'sessionKey', 'sessionTitle', 'detail',
];

/*
 * A cap, not a truth test: these are keys and labels the warehouse produced,
 * and the longest real one is a filesystem path. Anything longer is not a
 * route, and an unbounded string from an untrusted fragment is a way to make
 * the page do work nobody asked for.
 */
const MAX_TEXT = 512;

const SCOPES = ['claude', 'codex', ''];

/*
 * The project breakdown dimension (PR #429 review): part of the drill
 * position — ProjectDrill's segmented control writes it into the route — so a
 * restore that drops it lands the reader on a different chart than the one
 * they left. An enum, not free text.
 */
const PROJECT_DIMENSIONS = ['activity', 'model', 'skill'];

const text = (value) => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null
);

/**
 * The chart's time selection — the one filter that is positional (#371), so it
 * rides the route. Both ends are bucket keys; a half-selection scopes nothing.
 */
function selectionOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const from = text(value.from);
  const to = text(value.to);
  return from && to ? { from, to } : null;
}

/**
 * Parse a location fragment into a starting position: the route to land on and
 * the filters it was made under. Returns the landing for anything it cannot
 * vouch for — a deep link is a convenience, and a malformed one must open the
 * dashboard, never break it.
 */
export function parseArrival(hash) {
  const fallback = { route: HOME, rangeKey: DEFAULT_RANGE, scope: 'claude', deepLinked: false };
  if (typeof hash !== 'string' || hash.length === 0) return fallback;
  let raw = null;
  try {
    raw = new URLSearchParams(hash.replace(/^#/, '')).get(ROUTE_PARAM);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

  // The filters come back first: they are App state, not route state, and a
  // deep link that names them must arrive with them already applied — the same
  // carry-through in-dashboard drill navigation gives (#371). They apply even
  // when the level itself is rejected, because a range is meaningful on the
  // landing too.
  const rangeKey = RANGES.some((entry) => entry.key === parsed.rangeKey)
    ? parsed.rangeKey : DEFAULT_RANGE;
  const scope = SCOPES.includes(parsed.scope) ? parsed.scope : 'claude';

  const required = Object.prototype.hasOwnProperty.call(LEVELS, parsed.level)
    ? LEVELS[parsed.level] : null;
  if (required === null) return { ...fallback, rangeKey, scope };

  const route = { level: parsed.level, selection: selectionOf(parsed.selection) };
  for (const key of TEXT_KEYS) route[key] = text(parsed[key]);
  if (PROJECT_DIMENSIONS.includes(parsed.dimension)) route.dimension = parsed.dimension;
  if (required.some((key) => !route[key])) return { ...fallback, rangeKey, scope };

  return { route, rangeKey, scope, deepLinked: parsed.level !== 'overview' };
}

/** The current fragment, or '' anywhere there is no location to read. */
export function currentArrival() {
  try {
    return parseArrival(window.location.hash);
  } catch {
    return parseArrival('');
  }
}

/**
 * Tell the host window where the reader now is, so a relaunch can restore it
 * (#402(c)). One-way and advisory: the bundle owns navigation, the host only
 * records. A browser tab has no bridge and this is a no-op there.
 */
export function reportRoute(route) {
  try {
    const handlers = window.webkit && window.webkit.messageHandlers;
    const bridge = handlers && handlers[BRIDGE];
    // A JSON string, not an object: the host decodes it with the same codec it
    // encodes fragments with, so there is one wire shape in both directions.
    if (bridge) bridge.postMessage(JSON.stringify(route));
  } catch {
    /* no host window — nothing to report to */
  }
}

/**
 * Drop the route out of the address bar once it has been consumed. The
 * fragment is a one-shot instruction, not the reader's position: leaving it
 * would make a reload jump back to where the menu bar sent him rather than
 * where he navigated to. Never touches path or query.
 */
export function clearArrivalFragment() {
  try {
    if (!window.location.hash) return;
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  } catch {
    /* history unavailable — the route is already applied either way */
  }
}
