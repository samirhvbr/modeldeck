// Issue #424 (1.0 build F) — the app window as a navigation target: the
// dashboard half. The macOS window opens this page with a route object on the
// URL fragment, and the BUNDLE parses it — there is exactly one navigation
// system, the one #386/#393 already built, and Swift only writes into it.
//
// THE NAMED TRIPWIRES of this slice:
//
//   TRIPWIRE deeplink-contract-bytes — 'the fragment the Swift codec emits is
//   the fragment this parser reads'. Swift and JavaScript share no type here,
//   so the contract is a byte string, pinned identically in BOTH suites (the
//   same literal appears in macos/…/Issue424DeepLinkTests.swift). Renaming a
//   route key on either side compiles, ships, and silently lands every deep
//   link on the overview. VERIFIED TO FAIL (on the Swift half, which is where
//   the emitting side is pinned) by dropping `.withoutEscapingSlashes` from
//   DashboardRouteCodec's encoder: every project path in the fragment gains a
//   `\/` and the pinned bytes stop matching.
//
//   TRIPWIRE deeplink-untrusted-payload — 'a route payload is untrusted input
//   and is never trusted into the page'. The fragment is attacker-writable in
//   any world where the window is not the only thing that can open this URL,
//   which is exactly what #402(d) says a non-loopback surface would be. The
//   parser must reject rather than coerce: no eval, no prototype writes, no
//   unbounded strings, and no level whose page would render nothing.
//   VERIFIED TO FAIL by having parseArrival spread the parsed object into the
//   route instead of copying whitelisted keys.
//
//   TRIPWIRE deeplink-carries-its-filters — 'an arrival applies the range and
//   scope its route was made under'. This is #371/#393's lesson on the
//   arrival path: a route is nothing but keys, and keys name nothing under a
//   different range — land a drill under the default range and the reader
//   gets an empty page. VERIFIED TO FAIL by seeding rangeKey/scope from the
//   defaults instead of from the arrival.
//
// Placeholder identities and synthetic paths only. Nothing here binds a port
// or touches a live daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import {
  bootPage, installDom, installFetch, loadModule, waitFor,
} from '../dashboard/test-support/index.mjs';

const PORT = 43424;
const TOKEN = 'deeplink-test-placeholder-token';
const PROJECT = '/placeholder/projects/alpha';
const PROFILE = 'placeholder-claude-profile';
const LANE_SESSION = 'placeholder-lane-session';
const REVIEW_SESSION = 'placeholder-review-session';
// The ASCII unit separator the warehouse keys tuples on (ProjectDrill.jsx).
const SEP = '\u001f';

const route = await loadModule('src/route.js');

/** The fragment for a route, encoded the way DashboardRouteCodec encodes it. */
function fragment(value) {
  const json = JSON.stringify(value);
  const encoded = [...json]
    .map((ch) => (/[A-Za-z0-9\-._~]/.test(ch)
      ? ch
      : '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')))
    .join('');
  return '#route=' + encoded;
}

// ---------------------------------------------------------------------------
// The parser, on its own.

test('TRIPWIRE deeplink-contract-bytes — the Swift codec\'s fragment lands on its drill', () => {
  // Pinned byte-for-byte, and asserted identically on the Swift side.
  const wire = '#route=%7B%22level%22%3A%22project%22%2C%22projectKey%22%3A%22%2Fplaceholder'
    + '%2Fprojects%2Falpha%22%2C%22projectName%22%3A%22alpha%22%2C%22rangeKey%22'
    + '%3A%2230d%22%2C%22scope%22%3A%22codex%22%7D';
  const arrival = route.parseArrival(wire);
  assert.equal(arrival.route.level, 'project');
  assert.equal(arrival.route.projectKey, PROJECT);
  assert.equal(arrival.route.projectName, 'alpha');
  assert.equal(arrival.rangeKey, '30d');
  assert.equal(arrival.scope, 'codex');
  assert.equal(arrival.deepLinked, true);
});

test('every level the bundle renders round-trips through the fragment', () => {
  const cases = [
    { level: 'overview' },
    { level: 'detail', detail: 'model-effort' },
    { level: 'project', projectKey: PROJECT, projectName: 'alpha' },
    { level: 'activity', projectKey: PROJECT, pick: 'claude-opus-5', pickLabel: 'Opus 5' },
    {
      level: 'session',
      projectKey: PROJECT,
      sessionKey: LANE_SESSION,
      sessionTitle: 'Lane',
      selection: { from: '2026-08-01', to: '2026-08-07' },
    },
  ];
  for (const value of cases) {
    const arrival = route.parseArrival(fragment(value));
    assert.equal(arrival.route.level, value.level, JSON.stringify(value));
    for (const [key, expected] of Object.entries(value)) {
      if (key === 'level') continue;
      assert.deepEqual(arrival.route[key], expected, key + ' of ' + value.level);
    }
  }
});

test('TRIPWIRE deeplink-carries-its-filters — an arrival applies the filters its route was made under', () => {
  const arrival = route.parseArrival(fragment({
    level: 'project', projectKey: PROJECT, rangeKey: 'today', scope: '',
  }));
  assert.equal(arrival.rangeKey, 'today');
  assert.equal(arrival.scope, '', 'the Combined scope is a real value, not an absent one');

  // A range nobody serves, and a scope that is not a scope, fall back — but
  // the route itself still lands, because a bad filter is not a bad position.
  const bad = route.parseArrival(fragment({
    level: 'project', projectKey: PROJECT, rangeKey: '9000d', scope: 'gemini',
  }));
  assert.equal(bad.rangeKey, '7d');
  assert.equal(bad.scope, 'claude');
  assert.equal(bad.route.level, 'project');
});

test('TRIPWIRE deeplink-untrusted-payload — a hostile fragment opens the dashboard, never breaks it', () => {
  const hostile = [
    '',
    '#',
    '#route=',
    '#route=not-json',
    '#route=' + encodeURIComponent('[]'),
    '#route=' + encodeURIComponent('null'),
    '#route=' + encodeURIComponent('"project"'),
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'nowhere' })),
    '#route=' + encodeURIComponent(JSON.stringify({ level: '__proto__' })),
    // A level whose page reads keys the payload never named.
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'project' })),
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'activity', projectKey: PROJECT })),
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'session', projectKey: PROJECT })),
    // Shapes, not strings.
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'project', projectKey: { a: 1 } })),
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'project', projectKey: ['x'] })),
    '#route=' + encodeURIComponent(JSON.stringify({ level: 'project', projectKey: 7 })),
    // Not a string at all.
    'not a hash',
  ];
  for (const hash of hostile) {
    const arrival = route.parseArrival(hash);
    assert.equal(arrival.route.level, 'overview', JSON.stringify(hash));
    assert.equal(arrival.deepLinked, false, JSON.stringify(hash));
    assert.equal(arrival.rangeKey, '7d');
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(route.parseArrival(value).route.level, 'overview');
  }
});

test('the breakdown dimension rides the route as an enum, never free text (PR #429)', () => {
  const withDimension = route.parseArrival('#route=' + encodeURIComponent(JSON.stringify({
    level: 'project', projectKey: 'a', dimension: 'model',
  })));
  assert.equal(withDimension.route.dimension, 'model');
  for (const bad of ['bogus', 42, { a: 1 }, 'ACTIVITY', '']) {
    const arrival = route.parseArrival('#route=' + encodeURIComponent(JSON.stringify({
      level: 'project', projectKey: 'a', dimension: bad,
    })));
    assert.equal('dimension' in arrival.route, false);
  }
});

test('the parsed route carries whitelisted keys and nothing else', () => {
  // The payload is BUILT AS A STRING (PR #429 review): `__proto__:` in an
  // object literal sets the literal's prototype and never survives
  // JSON.stringify, so only a raw-string payload actually exercises the
  // pollution path through JSON.parse (which does create the own key).
  const arrival = route.parseArrival('#route=' + encodeURIComponent(
    '{"level":"project","projectKey":"a","smuggled":"anything","__proto__":{"polluted":1}}',
  ));
  assert.equal(arrival.route.level, 'project');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(Object.keys(arrival.route).sort(), [
    'detail', 'level', 'pick', 'pickLabel', 'projectKey', 'projectName',
    'selection', 'sessionKey', 'sessionTitle',
  ]);
});

test('free strings are bounded — a route is keys and labels, not a payload', () => {
  const huge = 'x'.repeat(4096);
  const arrival = route.parseArrival(
    fragment({ level: 'project', projectKey: PROJECT, projectName: huge }),
  );
  assert.equal(arrival.route.level, 'project');
  assert.equal(arrival.route.projectName, null, 'an oversized label is dropped, not truncated');
  // And an oversized REQUIRED key is not a level at all.
  const rejected = route.parseArrival(fragment({ level: 'project', projectKey: huge }));
  assert.equal(rejected.route.level, 'overview');
});

test('a half-selection scopes nothing and is dropped', () => {
  for (const selection of [{ from: 'a' }, { to: 'b' }, 'a..b', ['a', 'b'], null, {}]) {
    const arrival = route.parseArrival(fragment({ level: 'overview', selection }));
    assert.equal(arrival.route.selection, null, JSON.stringify(selection));
  }
  const kept = route.parseArrival(
    fragment({ level: 'overview', selection: { from: 'a', to: 'b' } }),
  );
  assert.deepEqual(kept.route.selection, { from: 'a', to: 'b' });
});

test('an overview deep link is an arrival, but not one that steals focus', () => {
  // deepLinked drives the focus park; landing on the page you would have
  // landed on anyway is not an arrival worth moving the keyboard for.
  const arrival = route.parseArrival(fragment({ level: 'overview', rangeKey: '30d' }));
  assert.equal(arrival.route.level, 'overview');
  assert.equal(arrival.rangeKey, '30d');
  assert.equal(arrival.deepLinked, false);
});

test('reportRoute is a no-op without a host window, and posts JSON with one', () => {
  const posted = [];
  const previous = globalThis.window;
  try {
    globalThis.window = {};
    route.reportRoute({ level: 'overview' });
    globalThis.window = {
      webkit: { messageHandlers: { modeldeckRoute: { postMessage: (m) => posted.push(m) } } },
    };
    route.reportRoute({ level: 'project', projectKey: PROJECT });
    // A string on the wire, decoded by the same codec that writes fragments.
    assert.equal(posted.length, 1);
    assert.equal(typeof posted[0], 'string');
    assert.deepEqual(JSON.parse(posted[0]), { level: 'project', projectKey: PROJECT });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

// ---------------------------------------------------------------------------
// The drawn page: a route in, the drill it names on screen.

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function request({ key, sessionId, observedAt, input, output }) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug: PROFILE,
    messageId: key,
    recordUuid: null,
    model: 'claude-opus-5',
    effort: null,
    observedAt,
    inputTokens: input,
    cacheCreationInputTokens: Math.round(input / 2),
    cacheReadInputTokens: input * 10,
    outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0,
    cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: false,
    agentId: null,
  };
}

/** One Claude project with two sessions — enough for every level to draw. */
function seed(store, root) {
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder Claude One',
    identity: 'placeholder-claude@example.invalid',
    profileRef: path.join(root, 'claude-placeholder-home'),
  });
  for (const [hours, usedPercent] of [[30, 10], [26, 20], [12, 30], [2, 39]]) {
    store.recordUsage(account.id, {
      scope: 'weekly',
      observedAt: hoursAgo(hours),
      usedPercent,
      resetsAt: hoursAgo(-48),
      source: 'deeplink-test-fixture',
      detail: { fixture: 'placeholder' },
    });
  }
  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: LANE_SESSION,
        profileSlug: PROFILE,
        machine: 'placeholder-machine',
        cwd: PROJECT,
        gitBranch: 'lane/placeholder',
        firstAt: hoursAgo(26),
        lastAt: hoursAgo(2),
        title: 'Placeholder lane session',
        titleSource: 'last-prompt',
      },
      {
        sessionId: REVIEW_SESSION,
        profileSlug: PROFILE,
        machine: 'placeholder-machine',
        cwd: PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(25),
        lastAt: hoursAgo(3),
        title: 'Placeholder review session',
        titleSource: 'last-prompt',
      },
    ],
    requests: [
      request({ key: 'lane-1', sessionId: LANE_SESSION, observedAt: hoursAgo(26), input: 4000, output: 900 }),
      request({ key: 'lane-2', sessionId: LANE_SESSION, observedAt: hoursAgo(2), input: 9000, output: 1800 }),
      request({ key: 'review-1', sessionId: REVIEW_SESSION, observedAt: hoursAgo(25), input: 3000, output: 600 }),
      request({ key: 'review-2', sessionId: REVIEW_SESSION, observedAt: hoursAgo(3), input: 5000, output: 1100 }),
    ],
    skills: [],
  });
  return account;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-deeplink-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  store.saveSettings({ usageAnalyticsEnabled: true });
  seed(store, root);
  const service = {
    projectsRoot: root,
    startAutoRefresh() {},
    stopAutoRefresh() {},
    async state() { return store.state(); },
  };
  const app = createApp({
    store, service, host: '127.0.0.1', port: PORT, mutationToken: TOKEN,
    laneManifestPath: path.join(root, 'absent-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return app;
}

/** Mount the real App at a deep link and wait for it to settle. */
async function arriveAt(t, hash) {
  const app = fixture(t);
  const dom = installDom({ width: 1040, height: 340, hash });
  installFetch(app, { host: `127.0.0.1:${PORT}` });
  const harness = await loadModule('test-support/mount.jsx');
  const root = harness.mountApp(document.getElementById('root'));
  t.after(() => {
    root.unmount();
    dom.window.close();
  });
  await waitFor(
    () => document.querySelector('.crumbs') && !document.querySelector('.card.empty'),
    'the deep-linked page to load',
  );
  return dom;
}

const crumbs = (doc = document) => [...doc.querySelectorAll('.crumbs > *')]
  .map((node) => node.textContent.trim()).filter((text) => text && text !== '›');

/** The label of the selected option in a named Segmented control. */
function pressed(label, doc = document) {
  const group = doc.querySelector('.segmented[aria-label="' + label + '"]');
  const on = group && [...group.querySelectorAll('button')]
    .find((node) => node.getAttribute('aria-pressed') === 'true');
  return on ? on.textContent.trim() : null;
}

test('a project deep link lands ON the project drill, not on the landing', async (t) => {
  await arriveAt(t, fragment({
    level: 'project', projectKey: PROJECT, projectName: 'alpha', rangeKey: '7d', scope: 'claude',
  }));
  await waitFor(() => crumbs().includes('alpha'), 'the alpha drill to be the position');
  assert.deepEqual(crumbs(), ['Overview', 'alpha']);
  // The zoom-out affordances (#408) are present, which is what says this is a
  // level and not the landing wearing a crumb.
  assert.ok(document.querySelector('.zoomout-puck'), 'the drill offers its way back out');
});

test('a detail-view deep link lands on that detail view', async (t) => {
  await arriveAt(t, fragment({ level: 'detail', detail: 'model-effort' }));
  await waitFor(() => pressed('View') === 'Detail views', 'the detail views to open');
  assert.deepEqual(crumbs(), ['Overview', 'Model × effort']);
});

test('a session deep link lands on the session anatomy under its project', async (t) => {
  await arriveAt(t, fragment({
    level: 'session',
    projectKey: PROJECT,
    projectName: 'alpha',
    // The warehouse's own tuple key: provider, session, profile, joined with
    // the ASCII unit separator (ProjectDrill.jsx sessionKey).
    sessionKey: ['claude', LANE_SESSION, PROFILE].join(SEP),
    sessionTitle: 'Placeholder lane session',
  }));
  await waitFor(() => crumbs().includes('Placeholder lane session'), 'the session page to open');
  assert.deepEqual(crumbs(), ['Overview', 'alpha', 'Placeholder lane session']);
});

test('the arrival carries its filters onto the page it lands on', async (t) => {
  // TRIPWIRE deeplink-carries-its-filters, on the drawn page: the controls
  // themselves show the range and scope the route was made under, so the
  // drill's keys mean what they meant when the route was written.
  await arriveAt(t, fragment({
    level: 'project', projectKey: PROJECT, projectName: 'alpha', rangeKey: '30d', scope: '',
  }));
  await waitFor(() => crumbs().includes('alpha'), 'the drill to open');
  assert.equal(pressed('Time range'), '30 days');
  assert.equal(pressed('Provider scope'), 'Combined');
});

test('a deep-link arrival parks the keyboard on the crumb trail', async (t) => {
  // #363 class: nothing was clicked, so focus is wherever the host window left
  // it. The trail is the one navigation landmark present at every level, and
  // the place a keyboard reader needs to be to walk back out.
  const dom = await arriveAt(t, fragment({
    level: 'project', projectKey: PROJECT, projectName: 'alpha',
  }));
  await waitFor(() => crumbs().includes('alpha'), 'the drill to open');
  await waitFor(
    () => dom.window.document.activeElement === dom.window.document.querySelector('.crumbs'),
    'focus to park on the breadcrumb trail',
  );
  assert.equal(document.querySelector('.crumbs').getAttribute('tabindex'), '-1',
    'parked without adding a tab stop');
});

test('an arrival does not leave its instruction in the address bar', async (t) => {
  // The fragment is a one-shot instruction, not the reader's position: left
  // there, a reload would jump back to where the menu bar sent him.
  const dom = await arriveAt(t, fragment({
    level: 'project', projectKey: PROJECT, projectName: 'alpha',
  }));
  await waitFor(() => crumbs().includes('alpha'), 'the drill to open');
  assert.equal(dom.window.location.hash, '');
  assert.equal(dom.window.location.pathname, '/dashboard');
  // The position itself is still the drill — clearing the URL is cosmetic,
  // never a navigation.
  assert.deepEqual(crumbs(), ['Overview', 'alpha']);
});

test('the back button out of an arrival behaves like the back button out of a drill', async (t) => {
  const dom = await arriveAt(t, fragment({
    level: 'project', projectKey: PROJECT, projectName: 'alpha',
  }));
  await waitFor(() => crumbs().includes('alpha'), 'the drill to open');
  // The arrival seeded the FIRST history entry, so there is nothing behind it
  // — one navigation system means the deep link is a position, not a push on
  // top of a page the reader never saw.
  assert.equal(dom.window.history.length, 1);
});

test('the BUILT page the daemon serves honours a deep link', async (t) => {
  // The one check that covers the compile step: a parser that throws on a
  // minified bundle renders an empty page and passes every source-level test
  // above. Same bytes the daemon sends, opened at a route.
  const app = fixture(t);
  const dom = bootPage(DASHBOARD_APP_HTML, app, {
    host: `127.0.0.1:${PORT}`,
    hash: fragment({
      level: 'project', projectKey: PROJECT, projectName: 'alpha', rangeKey: '30d',
    }),
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  await waitFor(() => crumbs(doc).includes('alpha'), 'the built page to land on the drill');
  assert.deepEqual(crumbs(doc), ['Overview', 'alpha']);
  assert.equal(pressed('Time range', doc), '30 days');
});

test('a hostile fragment on the BUILT page opens the landing rather than failing', async (t) => {
  const app = fixture(t);
  const dom = bootPage(DASHBOARD_APP_HTML, app, {
    host: `127.0.0.1:${PORT}`,
    hash: '#route=' + encodeURIComponent('{"level":"project"}'),
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  await waitFor(() => doc.querySelector('.treemap .block'), 'the landing to draw');
  assert.deepEqual(crumbs(doc), ['Overview']);
});
