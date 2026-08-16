// Issue #363 — KEYBOARD FOCUS across the dashboard's re-renders, click-tested in
// a real DOM against the REAL daemon readers (the fetch stub calls the app's own
// request listener), on every view the page has.
//
// WHY THIS IS A DOM TEST AND CANNOT BE A SOURCE TEST. The repo's cheaper
// dashboard checks read the rendered HTML with a regex. Focus is not in the
// HTML: `document.activeElement` is a property of the live document, produced by
// what the browser does when the focused node is REMOVED from the tree, and no
// amount of markup inspection can see it. So this file mounts the real App,
// puts focus on a real control, activates it, and asks the document where focus
// ended up — the same question a keyboard reader's next Tab asks.
//
// THE NAMED TRIPWIRE of this slice:
//
//   TRIPWIRE focus-survives-rerender — 'a re-render never costs the keyboard
//   reader his place, on any view'. Two halves, because focus is lost two
//   different ways and only one of them is a bug in this page's own code:
//
//     (a) A DATA re-render keeps the focused control itself. The page is React,
//     so a refetch reconciles and every control keeps its DOM node; a filter the
//     reader operates by keyboard stays under his fingers while the numbers
//     behind it change. The refetch is HELD open (holdResponses below) so the
//     check straddles the commit rather than racing it: focus is asserted once
//     with the request in flight and again on the far side of the re-render.
//     VERIFIED TO FAIL by keying App's top-level `<div className="page">` on the
//     loaded data (`key={String(model.buckets.length)}`) — the tree is then
//     REPLACED rather than reconciled when a refresh lands, which is exactly the
//     failure mode this page had before it was React, and the post-commit
//     assertion reports focus on <body>.
//
//     (b) A NAVIGATION never strands focus on <body>. The control a reader
//     activates to change level is often removed BY that change — a treemap
//     block and a session row open the level they name and then cease to exist,
//     and the crumb reading "Overview" becomes plain text once it IS the page —
//     so focus parks on the breadcrumb trail, the one navigation landmark
//     present at every level. VERIFIED TO FAIL by removing the route-change
//     focus rescue in App.jsx: the treemap block, the crumb and the session row
//     all drop the reader at the top of the document.
//
// Placeholder identities and synthetic paths only; no live ports, no provider
// quota spent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { installDom, installFetch, loadModule, waitFor } from '../dashboard/test-support/index.mjs';

// Same reason as the other dashboard click tests: the fixtures anchor "recent"
// events a couple of hours in the past and the views read a day-bucketed range,
// so a run between 00:00 and 02:00 local would cross midnight and empty the last
// day. Pin the process to a DST-free fixed-offset zone where it is currently
// early afternoon. (POSIX inverts the sign: Etc/GMT-5 means UTC+5.)
{
  const utcHour = new Date().getUTCHours();
  const offset = (((13 - utcHour) % 24) + 24) % 24;
  process.env.TZ = offset === 0 ? 'Etc/GMT'
    : offset <= 14 ? `Etc/GMT-${offset}` : `Etc/GMT+${24 - offset}`;
}

const PORT = 43390;
const TOKEN = 'focus-clicktest-placeholder-token';
const CLAUDE_PROJECT = '/placeholder/projects/alpha';
const OTHER_PROJECT = '/placeholder/projects/gamma';
const CLAUDE_PROFILE = 'placeholder-claude-profile';

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function transcriptRequest({ key, sessionId, observedAt, input, output, model = 'claude-opus-5', effort = null }) {
  return {
    dedupeKey: key,
    requestId: null,
    sessionId,
    profileSlug: CLAUDE_PROFILE,
    messageId: key,
    recordUuid: null,
    model,
    effort,
    observedAt,
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: input * 10,
    outputTokens: output,
    cacheCreationEphemeral5mInputTokens: 0,
    cacheCreationEphemeral1hInputTokens: 0,
    isSidechain: false,
    agentId: null,
  };
}

/** Two Claude projects with sessions in them — enough for a treemap to tile and
 *  a session list to rank, which is all the navigation this file drives. */
function seed(store, root) {
  const claude = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder Claude One',
    identity: 'placeholder-claude@example.invalid',
    profileRef: path.join(root, 'claude-placeholder-home'),
  });
  for (const [hours, usedPercent] of [[30, 10], [26, 15], [2, 22.5]]) {
    store.recordUsage(claude.id, {
      scope: 'weekly',
      observedAt: hoursAgo(hours),
      usedPercent,
      resetsAt: hoursAgo(-48),
      source: 'focus-clicktest-fixture',
      detail: { fixture: 'placeholder' },
    });
  }

  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: 'placeholder-alpha-session',
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        cwd: CLAUDE_PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(26),
        lastAt: hoursAgo(2),
        title: 'Placeholder alpha session',
        titleSource: 'last-prompt',
      },
      {
        sessionId: 'placeholder-gamma-session',
        profileSlug: CLAUDE_PROFILE,
        machine: 'placeholder-machine',
        cwd: OTHER_PROJECT,
        gitBranch: 'main',
        firstAt: hoursAgo(25),
        lastAt: hoursAgo(3),
        title: 'Placeholder gamma session',
        titleSource: 'last-prompt',
      },
    ],
    requests: [
      transcriptRequest({
        key: 'alpha-1', sessionId: 'placeholder-alpha-session', observedAt: hoursAgo(26),
        input: 500, output: 500, effort: 'high',
      }),
      transcriptRequest({
        key: 'alpha-2', sessionId: 'placeholder-alpha-session', observedAt: hoursAgo(2),
        input: 900, output: 1100, effort: 'medium',
      }),
      transcriptRequest({
        key: 'gamma-1', sessionId: 'placeholder-gamma-session', observedAt: hoursAgo(25),
        input: 900, output: 1100, model: 'claude-sonnet-5', effort: 'high',
      }),
      transcriptRequest({
        key: 'gamma-2', sessionId: 'placeholder-gamma-session', observedAt: hoursAgo(3),
        input: 400, output: 600, effort: 'high',
      }),
    ],
    subagents: [],
    skills: [],
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-focus-click-'));
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
  return { app, store };
}

async function landing(t) {
  const data = fixture(t);
  const dom = installDom({ width: 1040, height: 340 });
  installFetch(data.app, { host: `127.0.0.1:${PORT}` });
  const harness = await loadModule('test-support/mount.jsx');
  const root = harness.mountApp(document.getElementById('root'));
  t.after(() => {
    root.unmount();
    dom.window.close();
  });
  await waitFor(() => document.querySelector('.hero-figure'), 'the headline to load');
  await waitFor(() => document.querySelectorAll('.treemap .block').length > 0, 'the treemap to tile');
  return { ...data, dom };
}

/** What the document says has focus, described the way a failure should read. */
function focused() {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return '<body>';
  const label = active.getAttribute('aria-label') || active.textContent || '';
  return active.tagName.toLowerCase()
    + (active.className ? '.' + String(active.className).split(' ')[0] : '')
    + '[' + label.trim().slice(0, 40) + ']';
}

const buttonNamed = (label, scope = document) => [...scope.querySelectorAll('button')]
  .find((node) => node.textContent.trim() === label);

function segment(group, label) {
  const box = document.querySelector('.segmented[aria-label="' + group + '"]');
  assert.ok(box, 'the page carries the ' + group + ' control');
  const target = buttonNamed(label, box);
  assert.ok(target, group + ' offers ' + JSON.stringify(label));
  return target;
}

/**
 * Hold every response until released.
 *
 * Without this the refetch is instantaneous, and an assertion made after the
 * click can land BEFORE the reloaded model commits — so a focus regression in
 * the data-render commit would pass unseen (CodeRabbit on #474). Held, the
 * refetch has an observable middle: the page marks itself loading, the test
 * checks focus there, releases, and checks again on the far side of the commit.
 */
function holdResponses() {
  const inner = globalThis.fetch;
  const waiting = [];
  let holding = false;
  globalThis.fetch = async (...args) => {
    const response = await inner(...args);
    if (holding) await new Promise((resolve) => { waiting.push(resolve); });
    return response;
  };
  return {
    hold() { holding = true; },
    inFlight: () => waiting.length,
    release() {
      holding = false;
      while (waiting.length) waiting.pop()();
    },
  };
}

/** The wrapper App draws around every view, marked while a refetch is in flight. */
const refetching = () => Boolean(document.querySelector('.page > div.loading'));

/** Focus a control, activate it, and let the page settle. */
async function press(node, until, what) {
  node.focus();
  assert.equal(document.activeElement, node, 'the control took focus before the click');
  node.click();
  if (until) await waitFor(until, what || 'the page to answer the click');
  // One more turn after the DOM answers, so React's effects have committed.
  await new Promise((resolve) => { setTimeout(resolve, 50); });
}

// ---------------------------------------------------------------------------

test('TRIPWIRE focus-survives-rerender (a) — a data re-render keeps the focused control', async (t) => {
  await landing(t);

  // The refresh path: a new range refetches the model and redraws every view
  // under it. The control that asked for it is a filter the reader may well be
  // walking by keyboard, so it has to still be under his fingers afterwards.
  const gate = holdResponses();
  gate.hold();
  // NOT the default range (api.js DEFAULT_RANGE is '7d'): clicking the position
  // the page already holds refetches nothing, and every assertion after it would
  // be answered by the render that was already on screen.
  assert.equal(segment('Time range', '7 days').getAttribute('aria-pressed'), 'true',
    'the landing opens on the default range, so the click below must be a different one');
  const range = segment('Time range', '30 days');
  // The wait re-queries rather than reading the captured node, so a page that
  // REBUILDS its tree still gets past it — and fails on the focus assertion
  // below, which is the fact this tripwire is about, rather than on a timeout.
  await press(
    range,
    () => segment('Time range', '30 days').getAttribute('aria-pressed') === 'true',
    'the range to move',
  );
  await waitFor(() => gate.inFlight() > 0, 'the refetch to leave the page');
  await waitFor(refetching, 'the page to mark itself refetching');
  assert.equal(document.activeElement, range,
    'the range button holds focus while the refetch is in flight, not ' + focused());

  // …and, the half the fast path used to skip: across the commit of the new
  // model, which is when every view under the header is rendered again.
  gate.release();
  await waitFor(() => !refetching(), 'the reloaded model to commit');
  await waitFor(() => document.querySelectorAll('.treemap .block').length > 0, 'the landing to redraw');
  assert.equal(document.activeElement, range,
    'the range button still has focus after the refetch, not ' + focused());
  assert.equal(range.isConnected, true, 'and it is the same node, reconciled rather than rebuilt');

  // The same must hold for an in-view toggle that only changes local state.
  const lens = segment('Unit lens', 'Cost');
  await press(lens, () => lens.getAttribute('aria-pressed') === 'true', 'the lens to move');
  assert.equal(document.activeElement, lens, 'the lens button kept focus, not ' + focused());

  // …and for a control inside the redrawn card itself.
  const table = buttonNamed('Table');
  assert.ok(table, 'the chart offers its table toggle');
  await press(table, () => buttonNamed('Hide table'), 'the table to open');
  assert.equal(document.activeElement, table, 'the table toggle kept focus, not ' + focused());
});

test('TRIPWIRE focus-survives-rerender (b) — no navigation strands the reader on <body>', async (t) => {
  await landing(t);
  const trail = () => document.querySelector('.crumbs');
  const inTrail = () => {
    const active = document.activeElement;
    return Boolean(active && trail() && (active === trail() || trail().contains(active)));
  };

  // DRILL IN from the landing. The block is removed by the very click that
  // activates it, so the browser has nowhere to leave focus.
  const block = document.querySelector('.treemap .block');
  await press(block, () => document.querySelectorAll('.crumbs > *').length > 1, 'the project to open');
  assert.equal(block.isConnected, false, 'the clicked block is gone — this is the case that loses focus');
  assert.ok(inTrail(), 'focus parked on the breadcrumb trail, not on ' + focused());

  // DRILL DEEPER, into a session. Same shape, a different view.
  await waitFor(() => document.querySelector('.session-row:not([disabled])'), 'the session list');
  const row = document.querySelector('.session-row:not([disabled])');
  await press(row, () => document.querySelectorAll('.crumbs > *').length > 3, 'the session to open');
  assert.equal(row.isConnected, false, 'the clicked session row is gone');
  assert.ok(inTrail(), 'focus parked on the trail inside the session view, not on ' + focused());

  // BACK OUT with the return control. It is still drawn one level up, so it
  // simply KEEPS focus — the rescue only fires when the clicked control is gone.
  const up = document.querySelector('.uppill');
  assert.ok(up, 'the return control is drawn below the landing');
  await press(up, () => document.querySelectorAll('.crumbs > *').length < 4, 'the level above');
  assert.equal(document.activeElement, up, 'the return control kept focus, not ' + focused());

  // THE CRUMB ITSELF. "Overview" is a button until it IS the page, at which
  // point it becomes plain text — the clicked control, deleted by its own click.
  const home = buttonNamed('Overview', trail());
  assert.ok(home, 'the trail offers a crumb back to the overview');
  await press(home, () => document.querySelectorAll('.crumbs > *').length === 1, 'the landing');
  assert.equal(home.isConnected, false, 'the crumb became the current page and is no longer a button');
  assert.ok(inTrail(), 'focus parked on the trail after a crumb click, not on ' + focused());

  // THE DETAIL VIEWS, the third of the page's three families of view. Their
  // switcher persists, so focus stays on it — nothing to rescue and nothing
  // stolen either.
  const detail = segment('View', 'Detail views');
  await press(detail, () => document.querySelector('.segmented[aria-label="Detail view"]'), 'the detail views');
  assert.equal(document.activeElement, detail, 'the view switch kept focus, not ' + focused());
  const sessions = segment('Detail view', 'Sessions');
  await press(sessions, () => sessions.getAttribute('aria-pressed') === 'true', 'the session explorer');
  assert.equal(document.activeElement, sessions, 'the detail switch kept focus, not ' + focused());

  // …and the one control on that page that removes itself: a session row here
  // hands the reader back onto the project path (charter d4).
  await waitFor(() => document.querySelector('.session-row:not([disabled])'), 'the cross-project ranking');
  const cross = document.querySelector('.session-row:not([disabled])');
  await press(cross, () => document.querySelectorAll('.crumbs > *').length > 1, 'the project drill');
  assert.ok(inTrail(), 'focus parked on the trail leaving the session explorer, not on ' + focused());
});

test('a plain load does not steal focus from the top of the document', async (t) => {
  // The rescue is for navigation only. A reader who just opened the page is at
  // the top of it because that is where he opened it, and moving him would be a
  // second bug wearing the first one's clothes.
  await landing(t);
  assert.equal(focused(), '<body>', 'nothing claimed focus on load, but ' + focused() + ' did');
});
