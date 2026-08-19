// Issue #520 — the daemon half of client-key provisioning: the
// `client_key_map` store and the app's full-state hash→profile report.
//
// Design: docs/keys-with-riders-design.md §2.1/§2.2, decision 0036 D1.
// The named cases this file owns are report REPLAY, ROTATION, and REMOVAL —
// the app-side halves live in
// macos/ModelDeckMac/Tests/ModelDeckMacCoreTests/Issue520ClientKeyProvisioningTests.swift.
//
// No raw key material appears anywhere here: the wire carries SHA-256 hashes
// only, and the hashes below are placeholder hex, not digests of anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { ModelDeckService } from '../src/service.mjs';

const PORT = 43291;
const TOKEN = 'client-key-map-placeholder-token';
const PROFILE_A = '0f3a1c22-aaaa-4444-8888-111111111111';
const PROFILE_B = '7b2d9e01-bbbb-4444-8888-222222222222';
const HASH_A = 'a'.repeat(64);
const HASH_A2 = 'c'.repeat(64);
const HASH_B = 'b'.repeat(64);
const EMPTY_KEY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-client-key-map-'));
  const store = new Store(':memory:');
  const service = new ModelDeckService(store, {
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    detectForeignUsageConsumers: async () => ({ checked: true, consumers: [], probe: 'ok' }),
  });
  const app = createApp({ store, service, host: '127.0.0.1', port: PORT, mutationToken: TOKEN });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, service, store };
}

async function post(app, route, body, { authenticated = true } = {}) {
  const payload = JSON.stringify(body);
  const req = Readable.from([Buffer.from(payload)]);
  Object.assign(req, {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    url: route,
    headers: {
      host: `127.0.0.1:${PORT}`,
      'content-type': 'application/json',
      ...(authenticated
        ? { 'x-modeldeck-token': TOKEN, cookie: `modeldeck_session=${TOKEN}` }
        : {}),
    },
  });
  let status;
  let responseBody;
  const res = {
    writeHead(value) { status = value; },
    end(value) { responseBody = value ? JSON.parse(String(value)) : null; },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, body: responseBody };
}

const entry = (keySha256, profileId, profileLabel) => ({
  key_sha256: keySha256,
  profile_id: profileId,
  profile_label: profileLabel,
});

test('a report replaces the whole mapping atomically', (t) => {
  const { service, store } = fixture(t);
  const applied = service.reportClientKeys({
    generation: 1,
    entries: [entry(HASH_A, PROFILE_A, 'Work'), entry(HASH_B, PROFILE_B, 'Personal')],
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.generation, 1);
  assert.deepEqual(
    store.clientKeyMapEntries().map((row) => row.profileId).sort(),
    [PROFILE_A, PROFILE_B].sort(),
  );
  assert.deepEqual(store.clientKeyProfile(HASH_A), { profileId: PROFILE_A, profileLabel: 'Work' });
  assert.equal(store.clientKeyProfile('f'.repeat(64)), null);
});

test('report rotation — the rotated key resolves and the old hash resolves to nothing', (t) => {
  const { service, store } = fixture(t);
  service.reportClientKeys({ generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] });
  service.reportClientKeys({ generation: 2, entries: [entry(HASH_A2, PROFILE_A, 'Work')] });

  assert.deepEqual(store.clientKeyProfile(HASH_A2), { profileId: PROFILE_A, profileLabel: 'Work' });
  // The old hash is gone: a request still carrying the retired key attributes
  // to honest NULL, never to its former profile.
  assert.equal(store.clientKeyProfile(HASH_A), null);
  assert.equal(store.clientKeyMapEntries().length, 1);
});

test('report removal — a profile absent from the report is deleted', (t) => {
  const { service, store } = fixture(t);
  service.reportClientKeys({
    generation: 1,
    entries: [entry(HASH_A, PROFILE_A, 'Work'), entry(HASH_B, PROFILE_B, 'Personal')],
  });
  service.reportClientKeys({ generation: 2, entries: [entry(HASH_A, PROFILE_A, 'Work')] });

  assert.equal(store.clientKeyProfile(HASH_B), null);
  assert.deepEqual(store.clientKeyMapEntries().map((row) => row.profileId), [PROFILE_A]);
});

test('report replay — an already-applied generation is rejected and changes nothing', (t) => {
  const { service, store } = fixture(t);
  service.reportClientKeys({ generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] });
  service.reportClientKeys({ generation: 2, entries: [entry(HASH_A2, PROFILE_A, 'Work')] });

  // The replayed generation-1 report would resurrect the rotated key.
  const replay = service.reportClientKeys({ generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] });
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, 'stale-generation');
  assert.equal(replay.generation, 2);
  assert.equal(store.clientKeyProfile(HASH_A), null);
  assert.deepEqual(store.clientKeyProfile(HASH_A2), { profileId: PROFILE_A, profileLabel: 'Work' });

  // Same generation again is equally rejected (out-of-order delivery).
  assert.equal(service.reportClientKeys({ generation: 2, entries: [] }).applied, false);
  assert.equal(store.clientKeyMapEntries().length, 1);
});

test('an empty full-state report clears the mapping', (t) => {
  const { service, store } = fixture(t);
  service.reportClientKeys({ generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] });
  const cleared = service.reportClientKeys({ generation: 2, entries: [] });
  assert.equal(cleared.applied, true);
  assert.equal(store.clientKeyMapEntries().length, 0);
  assert.equal(store.clientKeyMapGeneration(), 2);
});

test('the empty-key hash is refused so keyless requests can never attribute', (t) => {
  const { service, store } = fixture(t);
  // Recon V1: a keyless proxy request's usage record carries `api_key: ""`.
  assert.throws(
    () => service.reportClientKeys({ generation: 1, entries: [entry(EMPTY_KEY_HASH, PROFILE_A, 'Work')] }),
    /empty-key hash/,
  );
  assert.equal(store.clientKeyMapEntries().length, 0);
  assert.equal(store.clientKeyMapGeneration(), 0);
});

test('malformed reports are refused with 400 and leave the mapping untouched', (t) => {
  const { service, store } = fixture(t);
  service.reportClientKeys({ generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] });

  const bad = [
    { generation: 0, entries: [] },
    { generation: 2.5, entries: [] },
    { generation: '2', entries: [] },
    { generation: 2, entries: {} },
    { generation: 2, entries: [entry('A'.repeat(64), PROFILE_A, 'Work')] },   // uppercase hex
    { generation: 2, entries: [entry('a'.repeat(63), PROFILE_A, 'Work')] },   // short
    { generation: 2, entries: [entry(HASH_A, '', 'Work')] },                  // no profile
    { generation: 2, entries: [entry(HASH_A, PROFILE_A, 'x'.repeat(257))] },  // label too long
    { generation: 2, entries: [entry(HASH_A, PROFILE_A, 'Work'), entry(HASH_A, PROFILE_B, 'Other')] },
    { generation: 2, entries: [entry(HASH_A, PROFILE_A, 'Work'), entry(HASH_B, PROFILE_B, ' work ')] },
  ];
  for (const payload of bad) {
    assert.throws(() => service.reportClientKeys(payload), (error) => error.statusCode === 400, JSON.stringify(payload));
  }
  // Every refusal happened before any write.
  assert.equal(store.clientKeyMapGeneration(), 1);
  assert.deepEqual(store.clientKeyMapEntries().map((row) => row.keySha256), [HASH_A]);
});

test('client key reports reject control characters and overlong profile identity fields before persistence', (t) => {
  const { service, store } = fixture(t);
  const hostileEntries = [
    entry(HASH_A, `profile\nid`, 'Work'),
    entry(HASH_A, `\t${PROFILE_A}`, 'Work'),
    entry(HASH_A, 'p'.repeat(129), 'Work'),
    entry(HASH_A, PROFILE_A, 'Work\nInjected'),
    entry(HASH_A, PROFILE_A, 'Work\u0000Injected'),
    entry(HASH_A, PROFILE_A, 'x'.repeat(129)),
  ];

  for (const hostileEntry of hostileEntries) {
    assert.throws(
      () => service.reportClientKeys({ generation: 1, entries: [hostileEntry] }),
      (error) => error.statusCode === 400,
    );
  }
  assert.equal(store.clientKeyMapGeneration(), 0);
  assert.deepEqual(store.clientKeyMapEntries(), []);
});

test('an absurd generation cannot brick attribution', (t) => {
  // CodeRabbit, PR #529: the generation is a one-way ratchet, so a single
  // report claiming MAX_SAFE_INTEGER would persist a value no honest
  // successor could exceed — every later report rejected forever, and the
  // app's resync would adopt the poisoned number and make it permanent.
  const { service, store } = fixture(t);
  service.reportClientKeys({ generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] });

  for (const generation of [Number.MAX_SAFE_INTEGER, 1_000_000_001, 2 ** 40]) {
    assert.throws(
      () => service.reportClientKeys({ generation, entries: [] }),
      (error) => error.statusCode === 400,
      String(generation),
    );
  }
  // The ceiling alone would only move the problem lower, so a report may move
  // the ratchet forward but not teleport it.
  const jumped = service.reportClientKeys({ generation: 900_000_000, entries: [] });
  assert.equal(jumped.applied, false);
  assert.equal(jumped.reason, 'generation-jump-refused');
  assert.equal(jumped.generation, 1);

  // Nothing was poisoned: the very next honest report still applies.
  assert.equal(store.clientKeyMapGeneration(), 1);
  const healthy = service.reportClientKeys({ generation: 2, entries: [entry(HASH_B, PROFILE_B, 'Personal')] });
  assert.equal(healthy.applied, true);
  assert.deepEqual(store.clientKeyProfile(HASH_B), { profileId: PROFILE_B, profileLabel: 'Personal' });
});

test('blank labels collide with each other, exactly as the app treats them', (t) => {
  // CodeRabbit, PR #529: two rows both labelled "" are as indistinguishable
  // on a receipt as two labelled "Work". The app-side gate collides them, so
  // the daemon must too or it accepts a report the app would never build.
  const { service, store } = fixture(t);

  for (const [first, second] of [['', ''], [null, null], ['', '   '], [null, ''], ['  ', null]]) {
    assert.throws(
      () => service.reportClientKeys({
        generation: 1,
        entries: [entry(HASH_A, PROFILE_A, first), entry(HASH_B, PROFILE_B, second)],
      }),
      (error) => error.statusCode === 400,
      JSON.stringify([first, second]),
    );
  }
  assert.equal(store.clientKeyMapGeneration(), 0);

  // ONE blank label is legal — it is only a collision that is refused.
  const applied = service.reportClientKeys({
    generation: 1,
    entries: [entry(HASH_A, PROFILE_A, ''), entry(HASH_B, PROFILE_B, 'Work')],
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(store.clientKeyProfile(HASH_A), { profileId: PROFILE_A, profileLabel: '' });
});

test('POST /api/client-keys/report requires the mutation token', async (t) => {
  const { app, store } = fixture(t);
  const payload = { generation: 1, entries: [entry(HASH_A, PROFILE_A, 'Work')] };

  const rejected = await post(app, '/api/client-keys/report', payload, { authenticated: false });
  assert.equal(rejected.status, 403);
  assert.equal(store.clientKeyMapEntries().length, 0);

  const accepted = await post(app, '/api/client-keys/report', payload);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.clientKeys.applied, true);
  assert.equal(store.clientKeyMapEntries().length, 1);
});

test('the mapping stores no raw-key-shaped column', (t) => {
  const { store } = fixture(t);
  // Tripwire for the discard-hardening invariant (design §3.1): the only
  // key-derived value in SQLite is a SHA-256 hash of our own random key.
  const columns = store.db.prepare('PRAGMA table_info(client_key_map)').all().map((column) => column.name);
  assert.deepEqual(columns.sort(), ['created_at', 'key_sha256', 'profile_id', 'profile_label']);
  assert.ok(!columns.some((name) => /api_key|^key$|secret|token/.test(name)));
});
