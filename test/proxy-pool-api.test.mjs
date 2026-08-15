import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

const PORT = 43279;
const TOKEN = 'proxy-pool-api-placeholder-token';

function statusError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-proxypool-api-'));
  const claudeHome = path.join(root, 'claude-placeholder');
  const codexHome = path.join(root, 'codex-placeholder');
  fs.mkdirSync(claudeHome, { mode: 0o700 });
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const store = new Store(':memory:');
  const claude = store.saveAccount({
    provider: 'claude',
    label: 'Claude Placeholder',
    identity: 'api-placeholder@example.invalid',
    profileRef: claudeHome,
    isDefault: true,
  });
  const codex = store.saveAccount({
    provider: 'codex',
    label: 'Codex Placeholder',
    identity: '',
    profileRef: codexHome,
    isDefault: true,
  });
  const calls = [];
  const service = {
    async joinProxyPool(accountId) {
      calls.push(['join', accountId]);
      return { accountId, provider: store.getAccount(accountId).provider, proxyPool: 'member', alreadyMember: false };
    },
    async wireProxyRouting(accountId) {
      calls.push(['wire', accountId]);
      const account = store.getAccount(accountId);
      if (account.provider !== 'claude') {
        throw statusError('proxy session routing is only supported for claude accounts', 400);
      }
      return { accountId, provider: 'claude', proxyRouted: true, helperRouted: true };
    },
    async unwireProxyRouting(accountId) {
      calls.push(['unwire', accountId]);
      const account = store.getAccount(accountId);
      if (account.provider !== 'claude') {
        throw statusError('proxy session routing is only supported for claude accounts', 400);
      }
      return { accountId, provider: 'claude', proxyRouted: false, helperRouted: false };
    },
    startAutoRefresh() {},
    stopAutoRefresh() {},
    ...overrides,
  };
  const app = createApp({ store, service, host: '127.0.0.1', port: PORT, mutationToken: TOKEN });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, store, service, claude, codex, calls };
}

async function request(app, route, { authenticated = true, method = 'POST' } = {}) {
  const req = Readable.from([]);
  Object.assign(req, {
    socket: { remoteAddress: '127.0.0.1' },
    method,
    url: route,
    headers: {
      host: `127.0.0.1:${PORT}`,
      ...(authenticated ? {
        'x-modeldeck-token': TOKEN,
        cookie: `modeldeck_session=${TOKEN}`,
      } : {}),
    },
  });
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(value, nextHeaders) {
      status = value;
      headers = nextHeaders;
    },
    end(value) {
      payload = value == null || value === '' ? null : JSON.parse(String(value));
    },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, headers, body: payload };
}

test('proxy-pool and routing POSTs are token-gated and return their exact service shapes', async (t) => {
  const data = fixture(t);
  const routes = [
    `/api/accounts/${data.claude.id}/proxy-pool/join`,
    `/api/accounts/${data.claude.id}/proxy-routing/wire`,
    `/api/accounts/${data.claude.id}/proxy-routing/unwire`,
  ];

  for (const route of routes) {
    const rejected = await request(data.app, route, { authenticated: false });
    assert.equal(rejected.status, 403);
    assert.deepEqual(rejected.body, { error: 'mutation token or origin rejected' });
  }
  assert.deepEqual(data.calls, [], 'rejected mutations never reach the service');

  let result = await request(data.app, routes[0]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    accountId: data.claude.id,
    provider: 'claude',
    proxyPool: 'member',
    alreadyMember: false,
  });
  assert.match(result.headers['Content-Type'], /^application\/json\b/);

  result = await request(data.app, routes[1]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    accountId: data.claude.id,
    provider: 'claude',
    proxyRouted: true,
    helperRouted: true,
  });

  result = await request(data.app, routes[2]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    accountId: data.claude.id,
    provider: 'claude',
    proxyRouted: false,
    helperRouted: false,
  });
  assert.deepEqual(data.calls, [
    ['join', data.claude.id],
    ['wire', data.claude.id],
    ['unwire', data.claude.id],
  ]);
});

test('all proxy-pool routes return 404 before calling the service for an unknown account', async (t) => {
  const data = fixture(t);
  for (const route of [
    '/api/accounts/missing/proxy-pool/join',
    '/api/accounts/missing/proxy-routing/wire',
    '/api/accounts/missing/proxy-routing/unwire',
  ]) {
    const result = await request(data.app, route);
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'account not found' });
  }
  assert.deepEqual(data.calls, []);
});

test('Claude-only routing returns the service provider-mismatch 400 for Codex', async (t) => {
  const data = fixture(t);
  for (const action of ['wire', 'unwire']) {
    const result = await request(data.app, `/api/accounts/${data.codex.id}/proxy-routing/${action}`);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'proxy session routing is only supported for claude accounts' });
  }
  assert.deepEqual(data.calls, [
    ['wire', data.codex.id],
    ['unwire', data.codex.id],
  ]);
});

test('join and routing conflicts propagate as honest 409 JSON responses', async (t) => {
  const joinMessage = 'a claude proxy-pool join is already in progress';
  const routingMessage = "cannot change proxy routing while this account's Claude renewal is in progress";
  const data = fixture(t, {
    async joinProxyPool() { throw statusError(joinMessage, 409); },
    async wireProxyRouting() { throw statusError(routingMessage, 409); },
  });

  let result = await request(data.app, `/api/accounts/${data.claude.id}/proxy-pool/join`);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: joinMessage });

  result = await request(data.app, `/api/accounts/${data.claude.id}/proxy-routing/wire`);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: routingMessage });
});

// --- Issue #396: the in-app credential repair routes -------------------------

function reloginFixture(t, overrides = {}) {
  return fixture(t, {
    async startProxyRelogin(accountId) {
      return {
        accountId,
        provider: 'claude',
        phase: 'awaiting-browser',
        url: 'https://provider.invalid/authorize',
      };
    },
    async proxyReloginState(accountId) {
      return { accountId, provider: 'claude', phase: 'awaiting-browser' };
    },
    async cancelProxyRelogin(accountId) {
      return { accountId, provider: 'claude', phase: 'cancelled', cancelledUpstream: true };
    },
    ...overrides,
  });
}

test('the relogin start POST is token-gated and hands back the proxy authorize URL', async (t) => {
  const data = reloginFixture(t);
  const route = `/api/accounts/${data.claude.id}/proxy-relogin`;

  const rejected = await request(data.app, route, { authenticated: false });
  assert.equal(rejected.status, 403);

  const started = await request(data.app, route);
  assert.equal(started.status, 200);
  assert.deepEqual(started.body, {
    accountId: data.claude.id,
    provider: 'claude',
    phase: 'awaiting-browser',
    url: 'https://provider.invalid/authorize',
  });
});

test('the relogin poll answers on GET, like every other daemon read', async (t) => {
  // Reading the phase of a flow the user already started is not a mutation.
  const data = reloginFixture(t);
  const result = await request(data.app, `/api/accounts/${data.claude.id}/proxy-relogin`, {
    method: 'GET',
    authenticated: false,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.phase, 'awaiting-browser');
});

test('relogin cancel is token-gated and reports whether the proxy dropped its session', async (t) => {
  const data = reloginFixture(t);
  const route = `/api/accounts/${data.claude.id}/proxy-relogin/cancel`;
  assert.equal((await request(data.app, route, { authenticated: false })).status, 403);
  const cancelled = await request(data.app, route);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.phase, 'cancelled');
  assert.equal(cancelled.body.cancelledUpstream, true);
});

test('relogin routes 404 an unknown account and propagate the service refusal verbatim', async (t) => {
  const message = 'This CLIProxyAPI install has no management key yet, so ModelDeck cannot ask it to start a sign-in.';
  const data = reloginFixture(t, {
    async startProxyRelogin() { throw statusError(message, 409); },
  });
  const missing = await request(data.app, '/api/accounts/missing/proxy-relogin');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'account not found' });

  const refused = await request(data.app, `/api/accounts/${data.claude.id}/proxy-relogin`);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: message });
});
