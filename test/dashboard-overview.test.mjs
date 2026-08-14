// Issue #385: the Overview landing is what /dashboard serves. Issue #387
// finished the port — the detail views live in that same bundle and the
// pre-redesign stack at /dashboard/legacy is GONE (amendment decision 7: no
// two-stack dashboard survives v1). Contracts under test:
//   - /dashboard sits behind the usageAnalyticsEnabled kill switch and is
//     byte-identical to a nonexistent route while it is off (issue #359), and
//     /dashboard/legacy is now a nonexistent route in both flag states;
//   - the landing is ONE self-contained page: nothing fetchable is referenced,
//     and its only network traffic is same-origin /api reads, which is what the
//     page's CSP allows and nothing more;
//   - the committed build artifact matches the sources in dashboard/, so an
//     un-rebuilt edit fails here instead of shipping;
//   - the landing carries the slice's own IA and the standing directives that can
//     be checked on the served bytes (unit rename, API-rate caveat).
// Placeholder identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { DASHBOARD_APP_HTML, DASHBOARD_APP_SOURCES } from '../src/dashboard-app.mjs';
import { createApp } from '../src/server.mjs';
import { assertSelfContained, fingerprintSources } from '../scripts/dashboard-artifact.mjs';

const PORT = 43386;
const TOKEN = 'overview-landing-placeholder-token';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-overview-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  const service = { projectsRoot: root, startAutoRefresh() {}, stopAutoRefresh() {} };
  const app = createApp({
    store, service, host: '127.0.0.1', port: PORT, mutationToken: TOKEN,
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store };
}

async function request(app, route, { host = `127.0.0.1:${PORT}` } = {}) {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: route, headers: { host } });
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(value, nextHeaders) { status = value; headers = nextHeaders; },
    end(value) { payload = value == null ? null : String(value); },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, headers, body: payload };
}

test('GET /dashboard serves the Overview landing, and it is the ONLY dashboard route', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageAnalyticsEnabled: true });

  for (const route of ['/dashboard', '/dashboard/']) {
    const result = await request(data.app, route);
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(result.body, DASHBOARD_APP_HTML);
  }
  // TRIPWIRE one-stack — issue #387 deleted the pre-redesign stack rather than
  // leaving it serving beside the bundle (amendment d7). Its route is now a
  // route that does not exist, WITH THE FLAG ON, which is the state a
  // half-finished port would pass without: a re-added second dashboard fails
  // here even if every source-level test still renders the React one.
  const unknown = await request(data.app, '/api/route-that-never-existed');
  for (const route of ['/dashboard/legacy', '/dashboard/legacy/']) {
    assert.deepEqual(await request(data.app, route), unknown, route + ' no longer exists');
  }
});

test('both dashboard routes stay invisible while usageAnalyticsEnabled is off', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageAnalyticsEnabled: false });
  const unknown = await request(data.app, '/api/route-that-never-existed');
  for (const route of ['/dashboard', '/dashboard/', '/dashboard/legacy', '/dashboard/legacy/']) {
    assert.deepEqual(await request(data.app, route), unknown, route + ' is indistinguishable');
  }

  // …and the gate closes again in the same process.
  data.store.saveSettings({ usageAnalyticsEnabled: true });
  assert.equal((await request(data.app, '/dashboard')).status, 200);
  data.store.saveSettings({ usageAnalyticsEnabled: false });
  assert.equal((await request(data.app, '/dashboard')).status, 404);
});

test('the Overview landing keeps the Host gate and the inline-only CSP', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageAnalyticsEnabled: true });

  const rejected = await request(data.app, '/dashboard', { host: 'attacker.example' });
  assert.equal(rejected.status, 403);

  const csp = (await request(data.app, '/dashboard')).headers['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self'/);
});

test('the Overview landing is one self-contained page — nothing fetchable, no asset on disk', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageAnalyticsEnabled: true });
  const body = (await request(data.app, '/dashboard')).body;

  // The SAME rule the build enforces, applied to what the daemon actually
  // returned — so the served bytes are held to it even if the artifact was
  // produced some other way.
  assertSelfContained(body);
  // …and the rule itself is not vacuous: a relative asset is rejected too, not
  // only an off-machine URL, because the daemon ships no assets to resolve it
  // against. Anchor navigation is not a resource and stays allowed (the footer
  // links to the detail views).
  for (const reference of [
    '<script src="/assets/app.js"></script>',
    '<img src="/assets/logo.svg">',
    '<img srcset="logo@2x.png 2x">',
    '<link rel="icon" href="/favicon.ico">',
    '<style>body{background:url(/assets/bg.png)}</style>',
    '<style>@import "theme.css";</style>',
    '<script src="https://cdn.example/react.js"></script>',
  ]) {
    assert.throws(() => assertSelfContained('<html>' + reference + '</html>'), /references/, reference);
  }
  assert.doesNotThrow(() => assertSelfContained('<a href="/dashboard">Overview</a>'));
  assert.doesNotThrow(() => assertSelfContained('<img src="data:image/svg+xml,%3Csvg/%3E">'));

  // Its reads are relative /api paths on the daemon's own origin.
  for (const route of ['/api/usage/projects', '/api/usage/history', '/api/usage/summary', '/api/state']) {
    assert.ok(body.includes(route), body.length + ' bytes should mention ' + route);
  }

  // The stylesheet is inlined into the page, both themes with it — a build that
  // drops the CSS still renders every number, which is why this is checked.
  assert.equal((body.match(/<style/g) || []).length, 1);
  assert.ok(body.includes('.treemap'), 'the treemap rules are in the page');
  assert.match(body, /\[data-theme=["']?dark["']?\]/, 'the dark theme rules are in the page');
  assert.ok(body.includes('prefers-color-scheme:dark') || body.includes('prefers-color-scheme: dark'));
});

test('the committed landing artifact was built from the current dashboard sources', () => {
  // A stale artifact serves yesterday's page with today's tests passing, which
  // is why the fingerprint travels inside the generated module.
  assert.deepEqual(
    DASHBOARD_APP_SOURCES,
    fingerprintSources(),
    'src/dashboard-app.mjs is stale — run `npm run dashboard:build`',
  );
});

test('the landing states its unit and labels its API-$ figures on the page itself', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageAnalyticsEnabled: true });
  const body = (await request(data.app, '/dashboard')).body;

  // Charter decision 5: 'subscriptions' is the unit. The word 'windows' survives
  // only in the one tooltip that defines the measurement.
  assert.ok(body.includes('weekly subscriptions'));
  assert.ok(body.includes('Can I start heavy work now?'));
  // Amendment decision 3: every API-$ figure carries the caveat.
  assert.ok(body.includes('* if billed at full API rate'));
  // Charter decision 12: the theme toggle ships with the page.
  for (const label of ['System', 'Light', 'Dark']) assert.ok(body.includes(label));
  // The pinned price snapshot is vendored, never fetched (amendment decision 6).
  assert.ok(body.includes('LiteLLM model_prices_and_context_window.json'));
});

test('ONE bundle carries every view, and nothing in it points at a second stack', () => {
  // TRIPWIRE no-second-stack, the source-side half of the one above. Issue #386
  // moved the project drill in; issue #387 moved the detail views in and deleted
  // what they replaced, so the bundle must neither link out to /dashboard/legacy
  // nor keep the deleted project-burn view alive under another name (charter d3).
  assert.equal(DASHBOARD_APP_HTML.includes('/dashboard/legacy'), false, 'no link to a second stack');
  assert.equal(DASHBOARD_APP_HTML.includes('project-burn'), false, 'the project-burn view is deleted');

  // …and what replaced them: every reader the one bundle now drives itself.
  for (const route of [
    '/api/usage/activity-breakdown', '/api/usage/session-anatomy',
    '/api/usage/model-effort', '/api/usage/sessions',
  ]) {
    assert.ok(DASHBOARD_APP_HTML.includes(route), 'the bundle reads ' + route);
  }
  // The detail views the charter kept, by their own labels on the served bytes.
  for (const label of ['Headroom', 'Burn timeline', 'Model × effort']) {
    assert.ok(DASHBOARD_APP_HTML.includes(label), 'the bundle carries the ' + label + ' view');
  }
});
