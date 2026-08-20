// Issue #539 — the blackout alert must be able to say "already repaired".
//
// TRIPWIRE member-blackout-repaired-pending: Tim repaired a pool credential
// with the in-app Fix sign-in, the proxy marked it active again, and the deck
// kept shouting that the last seven requests had failed — which reads as "the
// sign-in didn't take". Doctrine 0034 is why: only a measured routed request
// clears the streak. This suite pins the ADDITIVE fact that lets the surviving
// alert soften instead: the credential verdict is ok and the flip to ok is
// NEWER than the last measured failure.
//
// The three rulings this pins (Tim, 2026-08-19):
//   1. the comparison lives daemon-side, computed once;
//   2. only measured events move it — a new failure re-reddens, a success
//      clears the alert outright;
//   3. no timer of any kind, so no test here advances a clock to change state.
//
// Placeholder identities only, and no live proxy: the management API is a stub
// object, so nothing dials 8317 and no auth file is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

const MEMBER_EMAIL = 'blackout-member@example.invalid';
const FAILURE_AT = ['2026-08-14T12:00:00.000Z', '2026-08-14T12:01:00.000Z', '2026-08-14T12:02:00.000Z'];

/// A CLIProxyAPI management API that answers only what this suite needs, with
/// its verdict driven directly by the test. No fetch, no key, no filesystem.
function stubDriver(authFiles) {
  return {
    state: { authFiles },
    async managementKeyPresent() { return true; },
    async authFiles() { return this.state.authFiles; },
  };
}

function healthyFile() {
  return {
    name: 'claude-fixture.json',
    provider: 'claude',
    email: MEMBER_EMAIL,
    codexAccountId: null,
    status: 'active',
    statusMessage: '',
    disabled: false,
    unavailable: false,
  };
}

function brokenFile() {
  return { ...healthyFile(), status: 'error', statusMessage: 'unauthorized', unavailable: true };
}

/// A refresh in flight. It maps to the same three-word health as `active`
/// (nothing is broken yet) — and it is NOT a sign-in anybody performed.
function refreshingFile() {
  return { ...healthyFile(), status: 'refreshing' };
}

/// The proxy's other not-yet-finished status, which maps to ok for exactly the
/// same reason and must claim exactly as little.
function pendingFile() {
  return { ...healthyFile(), status: 'pending' };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-blackout-repaired-'));
  const profileRef = path.join(root, 'claude-placeholder-profile');
  const authDir = path.join(root, 'cliproxy-auth');
  fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  // Membership evidence, the same shape readProxyWeights() consumes live.
  fs.writeFileSync(path.join(authDir, 'claude-fixture.json'), JSON.stringify({
    type: 'claude',
    email: MEMBER_EMAIL,
    access_token: 'placeholder-not-a-credential',
    weight: 1,
  }), { mode: 0o600 });

  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Blackout Placeholder',
    identity: MEMBER_EMAIL,
    profileRef,
  });
  const driver = stubDriver([brokenFile()]);
  let now = Date.parse('2026-08-14T12:02:30.000Z');
  const service = new ModelDeckService(store, {
    projectsRoot: root,
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    cliproxyAuthDir: authDir,
    cliproxyManagementKeyPath: path.join(root, '.mgmt-key-placeholder'),
    proxyReloginDriver: driver,
    proxyReloginNow: () => now,
    claudeCredentialsPresent: async () => true,
    listProviderProcesses: async () => [],
    platform: 'linux',
  });
  t.after(async () => { await service.stopAutoRefresh(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });

  /// Write failures straight into the request archive the streak reads. The
  /// queue consumer's own path is covered by the #395 tripwire; this suite is
  /// about what the derivation says once the streak exists.
  const record = (at, failed, statusCode) => store.ingestRequestUsage([{
    requestId: `blackout-placeholder-${at}-${failed ? 'fail' : 'ok'}`,
    machine: 'fixture',
    observedAt: at,
    source: MEMBER_EMAIL,
    provider: 'claude',
    model: 'claude-placeholder-model',
    endpoint: '/v1/messages',
    failed,
    statusCode,
  }]);

  const alerts = async () => (await service.memberBlackoutStatus(
    await service.accountsWithAuthState(),
  )).alerts;

  return {
    account, driver, service, store, alerts, record,
    setNow: (iso) => { now = Date.parse(iso); },
    // The health probe is cached for 15s; the daemon forces a re-read on a
    // completed sign-in, and so does this.
    reprobe: () => service.proxyCredentialHealth({ force: true }),
  };
}

test('TRIPWIRE member-blackout-repaired-pending — an ok verdict newer than the last failure softens the alert, and only measured events move it', async (t) => {
  const data = fixture(t);
  for (const at of FAILURE_AT) data.record(at, true, 401);

  // Broken credential, three measured failures: red, exactly as before.
  await data.reprobe();
  let [alert] = await data.alerts();
  assert.equal(alert.consecutiveFailures, 3);
  assert.equal(alert.lastFailureAt, '2026-08-14T12:02:00.000Z');
  assert.equal(alert.repairedPending, undefined, 'a broken credential softens nothing');
  assert.equal(alert.repairedAt, undefined);

  // The user repairs it: the proxy's own verdict flips back to ok. The streak
  // is untouched — no request has been through — but the alert now carries the
  // repair, so the deck can stop telling the user to sign in again.
  //
  // The repair is dated to the LAST BAD OBSERVATION (12:02:30), not to the
  // probe that noticed it (12:04) — see the reviewer's race below.
  data.setNow('2026-08-14T12:04:00.000Z');
  data.driver.state.authFiles = [healthyFile()];
  await data.reprobe();
  [alert] = await data.alerts();
  assert.equal(alert.consecutiveFailures, 3, 'the measured streak is not mutated');
  assert.equal(alert.repairedPending, true);
  assert.equal(alert.repairedAt, '2026-08-14T12:02:30.000Z');

  // No timer exists to take it back: time passing on its own changes nothing.
  data.setNow('2026-08-14T18:00:00.000Z');
  await data.reprobe();
  [alert] = await data.alerts();
  assert.equal(alert.repairedPending, true, 'nothing but a measured event moves this');

  // A NEW measured failure after the repair re-reddens it, by arithmetic:
  // the last failure is now newer than the flip.
  data.record('2026-08-14T18:05:00.000Z', true, 401);
  [alert] = await data.alerts();
  assert.equal(alert.consecutiveFailures, 4);
  assert.equal(alert.repairedPending, undefined, 'a failure after the repair is red again');

  // A measured success clears the whole alert — the #395 behaviour, untouched.
  data.record('2026-08-14T18:06:00.000Z', false, 200);
  assert.deepEqual(await data.alerts(), [], 'one routed success clears the alert outright');
});

test('TRIPWIRE member-blackout-repaired-pending — a failure measured after the last KNOWN-BROKEN observation is never softened', async (t) => {
  // The race the PR #543 review caught. The health probe is cached for 15s and
  // only runs on a state read, so the moment the daemon NOTICES a repair can be
  // long after the sign-in — and long after a request that failed in between.
  // Stamping the repair with the noticing probe softened that failure, which is
  // the same false reassurance in a smaller window. The repair is dated to the
  // last moment the daemon knew the credential was broken instead.
  const data = fixture(t);
  for (const at of FAILURE_AT) data.record(at, true, 401);
  await data.reprobe(); // broken, observed at 12:02:30

  // A request fails AFTER that observation, while the user is mid-repair.
  data.record('2026-08-14T12:03:00.000Z', true, 401);

  // The probe that notices the recovery runs a minute later.
  data.setNow('2026-08-14T12:04:00.000Z');
  data.driver.state.authFiles = [healthyFile()];
  await data.reprobe();

  const [alert] = await data.alerts();
  assert.equal(alert.consecutiveFailures, 4);
  assert.equal(
    alert.repairedPending,
    undefined,
    'a failure the daemon cannot place before the sign-in keeps the alert red',
  );

  // And the boundary itself is strict: a failure measured at the very instant
  // of the last bad observation is not older than it.
  const equal = fixture(t);
  equal.record('2026-08-14T12:02:30.000Z', true, 401);
  equal.record('2026-08-14T12:02:31.000Z', true, 401);
  equal.record('2026-08-14T12:02:32.000Z', true, 401);
  equal.setNow('2026-08-14T12:02:32.000Z');
  await equal.reprobe(); // broken, observed at exactly the last failure instant
  equal.setNow('2026-08-14T12:05:00.000Z');
  equal.driver.state.authFiles = [healthyFile()];
  await equal.reprobe();
  const [equalAlert] = await equal.alerts();
  assert.equal(equalAlert.lastFailureAt, '2026-08-14T12:02:32.000Z');
  assert.equal(equalAlert.repairedPending, undefined, 'equal instants are not a repair');
});

test('member-blackout-repaired-pending — a refresh in flight is not a sign-in', async (t) => {
  // `refreshing` and `pending` map to the same three-word health as `active`.
  // Only `active` is a finished sign-in; the other two must not put "signed in
  // again" in front of a user who did nothing. BOTH are asserted (CodeRabbit,
  // PR #543): a predicate that excluded only `refreshing` would pass a
  // one-status test and still overclaim on the other.
  const data = fixture(t);
  for (const at of FAILURE_AT) data.record(at, true, 401);
  await data.reprobe();

  data.setNow('2026-08-14T12:04:00.000Z');
  data.driver.state.authFiles = [refreshingFile()];
  await data.reprobe();
  let [alert] = await data.alerts();
  assert.equal(alert.repairedPending, undefined, 'a refresh nobody performed claims nothing');

  data.driver.state.authFiles = [pendingFile()];
  await data.reprobe();
  [alert] = await data.alerts();
  assert.equal(alert.repairedPending, undefined, 'a pending credential claims nothing either');

  data.driver.state.authFiles = [healthyFile()];
  await data.reprobe();
  [alert] = await data.alerts();
  assert.equal(alert.repairedPending, true, 'active is the finished sign-in');
  assert.equal(alert.repairedAt, '2026-08-14T12:02:30.000Z');
});

test('member-blackout-repaired-pending — health going unknown after a repair reverts the alert to red', async (t) => {
  // The soft state is only ever spoken while the daemon can still see an ok
  // verdict. An unreachable proxy is not evidence of anything.
  const data = fixture(t);
  for (const at of FAILURE_AT) data.record(at, true, 401);
  await data.reprobe();
  data.setNow('2026-08-14T12:04:00.000Z');
  data.driver.state.authFiles = [healthyFile()];
  await data.reprobe();
  assert.equal((await data.alerts())[0].repairedPending, true);

  data.driver.authFiles = async () => { throw new Error('unreachable'); };
  await data.reprobe();
  const [alert] = await data.alerts();
  assert.equal(alert.repairedPending, undefined, 'unknown health cannot keep the soft state');
  assert.equal(alert.consecutiveFailures, 3, 'and the measured streak is still exactly what it was');
});

test('member-blackout-repaired-pending — a verdict never seen broken is not a repair, and an unknown verdict marks nothing', async (t) => {
  const data = fixture(t);
  for (const at of FAILURE_AT) data.record(at, true, 401);

  // A daemon that has only ever seen this credential healthy (a restart, say)
  // has observed no flip. The alert stays red rather than inventing a repair
  // it never witnessed.
  data.driver.state.authFiles = [healthyFile()];
  await data.reprobe();
  let [alert] = await data.alerts();
  assert.equal(alert.repairedPending, undefined, 'first-seen ok is not a flip');

  // An unreachable proxy leaves health unknown; the last observation stands
  // and nothing is fabricated.
  data.driver.authFiles = async () => { throw new Error('unreachable'); };
  await data.reprobe();
  [alert] = await data.alerts();
  assert.equal(alert.repairedPending, undefined);
});
