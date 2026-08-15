// Issue #395 — silent routed-request blackouts must become loud state.
//
// TRIPWIRE member-blackout-alert (MUTATION-VERIFIED): the fixture stream
// enters through the daemon's ONE existing destructive queue consumer. Two
// failures stay below the recorded threshold; the third raises /api/state;
// disabling the member suppresses it; one later success clears it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import {
  MEMBER_BLACKOUT_FAILURE_THRESHOLD,
  ModelDeckService,
} from '../src/service.mjs';

const stream = JSON.parse(fs.readFileSync(
  new URL('./fixtures/member-blackout-stream.json', import.meta.url),
  'utf8',
));
const TEST_PORT = 18395;
const TOKEN = 'member-blackout-placeholder-token';
const noForeignConsumers = async () => ({ checked: true, consumers: [], probe: 'ok' });

function queueResponse(records) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(records),
  };
}

function fixture(t, { membership = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-member-blackout-'));
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  const profileRef = path.join(root, 'claude-placeholder-profile');
  fs.mkdirSync(profileRef, { mode: 0o700 });
  // CodeRabbit (PR #434): the alert scopes to CONFIRMED pool members, so the
  // fixture supplies the same membership evidence readProxyWeights() consumes
  // live — parseable auth files carrying identity + placeholder credential.
  const authDir = path.join(root, 'cliproxy-auth');
  if (membership) {
    fs.mkdirSync(authDir, { mode: 0o700 });
    fs.writeFileSync(path.join(authDir, 'claude-blackout-placeholder.json'), JSON.stringify({
      type: 'claude',
      email: 'blackout-member@example.invalid',
      access_token: 'access-token-placeholder',
      weight: 1,
    }));
    fs.writeFileSync(path.join(authDir, 'codex-blackout-placeholder.json'), JSON.stringify({
      type: 'codex',
      account_id: 'acct-blackout-placeholder',
      weight: 1,
    }));
  }
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Blackout Placeholder',
    identity: 'blackout-member@example.invalid',
    profileRef,
  });
  const responses = [];
  const requests = [];
  const service = new ModelDeckService(store, {
    projectsRoot: root,
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    cliproxyManagementKeyPath: path.join(root, '.mgmt-key-placeholder'),
    cliproxyAuthDir: authDir,
    usageQueueBaseUrl: `http://127.0.0.1:${TEST_PORT}`,
    usageQueueReadFile: async () => 'management-key-placeholder',
    usageQueueFetch: async (url) => {
      requests.push(String(url));
      assert.ok(responses.length > 0, 'the fixture planned every destructive-read response');
      return queueResponse(responses.shift());
    },
    claudeCredentialsPresent: async () => true,
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: () => {},
    platform: 'linux',
  });
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: TEST_PORT,
    mutationToken: TOKEN,
    laneManifestPath: path.join(root, 'absent-lane-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { account, app, requests, responses, service, store };
}

async function apiState(app) {
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/api/state',
    headers: { host: `127.0.0.1:${TEST_PORT}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let payload;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = String(value); },
  };
  await app.server.listeners('request')[0](req, res);
  assert.equal(status, 200);
  return JSON.parse(payload);
}

test('TRIPWIRE member-blackout-alert — consecutive failures fire, disable suppresses, recovery clears', async (t) => {
  const data = fixture(t);
  assert.equal(MEMBER_BLACKOUT_FAILURE_THRESHOLD, 3, 'the reviewed evidence bar stays explicit');

  data.responses.push(stream.failureBatches[0]);
  await data.service.pullUsageQueue();
  let state = await apiState(data.app);
  assert.deepEqual(state.memberBlackout, { threshold: 3, alerts: [] });

  data.responses.push(stream.failureBatches[1]);
  await data.service.pullUsageQueue();
  state = await apiState(data.app);
  assert.deepEqual(state.memberBlackout, {
    threshold: 3,
    alerts: [{
      accountId: data.account.id,
      provider: 'claude',
      label: 'Blackout Placeholder',
      consecutiveFailures: 3,
      firstFailureAt: '2026-08-14T12:00:00.000Z',
      lastFailureAt: '2026-08-14T12:02:00.000Z',
      statusCode: 401,
      remedy: 'Sign in again to restore proxy routing.',
    }],
  });

  data.store.saveAccount({ ...data.account, enabled: false });
  assert.deepEqual((await apiState(data.app)).memberBlackout.alerts, [], 'a disabled member is benched');

  data.store.saveAccount({ ...data.account, enabled: true });
  assert.equal((await apiState(data.app)).memberBlackout.alerts.length, 1, 're-enabling restores unresolved evidence');

  data.responses.push(stream.recoveryBatch);
  await data.service.pullUsageQueue();
  assert.deepEqual((await apiState(data.app)).memberBlackout.alerts, [], 'one routed success resets the streak');

  // Codex request rows remain source-keyed in the warehouse. The daemon's
  // already-remembered account_id identifier supplies the observational join;
  // no auth file is opened by this detector.
  const codexHome = path.join(path.dirname(data.account.profileRef), 'codex-placeholder-profile');
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const codex = data.store.saveAccount({
    provider: 'codex',
    label: 'Codex Blackout Placeholder',
    profileRef: codexHome,
  });
  const codexSource = 'acct-blackout-placeholder';
  data.service.codexAccountIdentifiers.set(codex.id, codexSource);
  data.responses.push(stream.failureBatches.flat().map((record, index) => ({
    ...record,
    provider: 'codex',
    source: codexSource,
    model: 'gpt-placeholder-model',
    request_id: `codex-blackout-request-placeholder-${index + 1}`,
  })));
  await data.service.pullUsageQueue();
  state = await apiState(data.app);
  assert.deepEqual(
    state.memberBlackout.alerts.map((alert) => [alert.accountId, alert.provider, alert.consecutiveFailures]),
    [[codex.id, 'codex', 3]],
  );
  data.store.saveAccount({ ...codex, enabled: false });
  assert.deepEqual((await apiState(data.app)).memberBlackout.alerts, [], 'a disabled Codex member is also benched');

  assert.deepEqual(data.requests, [
    `http://127.0.0.1:${TEST_PORT}/v0/management/usage-queue?count=500`,
    `http://127.0.0.1:${TEST_PORT}/v0/management/usage-queue?count=500`,
    `http://127.0.0.1:${TEST_PORT}/v0/management/usage-queue?count=500`,
    `http://127.0.0.1:${TEST_PORT}/v0/management/usage-queue?count=500`,
  ]);
});

// CodeRabbit (PR #434): with no parseable auth files the pool is unknowable —
// `proxyPool` is omitted from the account and the recorded pool-member-only
// scope benches it, however deep its historical failure tail.
test('member-blackout-alert — unconfirmed pool membership never alarms', async (t) => {
  const data = fixture(t, { membership: false });
  data.responses.push(stream.failureBatches[0]);
  await data.service.pullUsageQueue();
  data.responses.push(stream.failureBatches[1]);
  await data.service.pullUsageQueue();
  assert.deepEqual((await apiState(data.app)).memberBlackout, { threshold: 3, alerts: [] });
});
