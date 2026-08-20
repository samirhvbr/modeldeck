import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { activateClaudeProfile } from '../src/adapters/claude.mjs';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';

const API_PORT = 43484;
const API_TOKEN = 'activation-watchdog-placeholder-token';

function settleWithin(promise, timeoutMs, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function apiRequest(app, route) {
  const req = Readable.from([]);
  Object.assign(req, {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    url: route,
    headers: {
      host: `127.0.0.1:${API_PORT}`,
      'x-modeldeck-token': API_TOKEN,
      cookie: `modeldeck_session=${API_TOKEN}`,
    },
  });
  let status;
  let payload;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = JSON.parse(String(value)); },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, body: payload };
}

// TRIPWIRE #484: the first activation does not settle until the test releases
// it. Later work must fail loudly, never overlap it, and become eligible only
// after the timed-out operation itself has stopped.
test('TRIPWIRE #484: a never-settling activation cannot wedge the Claude activation queue', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-activation-watchdog-'));
  const profilesDir = path.join(root, 'claude-profiles');
  const firstHome = path.join(profilesDir, 'first');
  const secondHome = path.join(profilesDir, 'second');
  const activeLink = path.join(root, 'active', '.claude');
  fs.mkdirSync(firstHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(activeLink), { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);

  const store = new Store(':memory:');
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'error', () => { throw new Error('stderr unavailable'); });

  let activationCalls = 0;
  let firstStartedResolve;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const service = new ModelDeckService(store, {
    dataDir: path.join(root, 'data'),
    claudeProfilesDir: profilesDir,
    claudeActiveLink: activeLink,
    platform: 'linux',
    listProviderProcesses: async () => [],
    claudeActivationOperationTimeoutMs: 80,
    claudeActivationQueueTimeoutMs: 15,
    activateClaude: async (options) => {
      activationCalls += 1;
      if (activationCalls === 1) {
        firstStartedResolve();
        await firstBlocked;
      }
      return activateClaudeProfile(options);
    },
  });
  service.scopeClaudeSecureStorage = async () => {};
  const first = store.saveAccount({
    provider: 'claude', label: 'First', identity: 'first@example.invalid', profileRef: firstHome,
  });
  const second = store.saveAccount({
    provider: 'claude', label: 'Second', identity: 'second@example.invalid', profileRef: secondHome,
  });
  let firstDefaultedResolve;
  const firstDefaulted = new Promise((resolve) => { firstDefaultedResolve = resolve; });
  const setDefaultAccount = service.setDefaultAccount.bind(service);
  service.setDefaultAccount = (provider, accountId) => {
    const account = setDefaultAccount(provider, accountId);
    if (accountId === first.id) firstDefaultedResolve();
    return account;
  };
  const app = createApp({ store, service, host: '127.0.0.1', port: API_PORT, mutationToken: API_TOKEN });

  const wedged = apiRequest(app, `/api/accounts/${first.id}/activate`);
  await firstStarted;

  const queued = await settleWithin(
    apiRequest(app, `/api/accounts/${second.id}/activate`),
    200,
    'queued activation',
  );
  assert.equal(queued.status, 503);
  assert.deepEqual(queued.body, {
    error: 'This Claude activation request timed out while queued behind earlier account work. It did not start; retry after the earlier operation finishes.',
    code: 'claude-activation-queue-timeout',
  });

  const watchdog = await settleWithin(wedged, 200, 'wedged activation watchdog');
  assert.equal(watchdog.status, 504);
  assert.deepEqual(watchdog.body, {
    error: 'Claude account work exceeded its safety limit. The underlying operation may still be running, so ModelDeck is refusing overlapping credential changes until it stops.',
    code: 'claude-activation-operation-timeout',
  });

  const fenced = await settleWithin(
    apiRequest(app, `/api/accounts/${second.id}/activate`),
    200,
    'activation while timed-out work is still running',
  );
  assert.equal(fenced.status, 503);
  assert.deepEqual(fenced.body, {
    error: 'A timed-out Claude account operation is still running. This request did not start because overlapping credential changes are unsafe; retry after the earlier operation stops.',
    code: 'claude-activation-operation-still-running',
  });
  assert.equal(activationCalls, 1, 'the safety fence must prevent overlapping activation work');

  releaseFirst();
  await settleWithin(firstDefaulted, 200, 'timed-out activation completion');
  await new Promise((resolve) => setImmediate(resolve));

  const recovered = await settleWithin(service.activateAccount(second.id), 200, 'post-settlement activation');
  assert.equal(recovered.account.id, second.id);
  assert.equal(activationCalls, 2);
  assert.equal(fs.realpathSync(activeLink), fs.realpathSync(secondHome));
});

test('TRIPWIRE #484: a never-settling settings operation cannot strand the Claude activation safety fence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-settings-watchdog-'));
  const store = new Store(':memory:');
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'error', () => {});

  const service = new ModelDeckService(store, {
    dataDir: path.join(root, 'data'),
    platform: 'linux',
    claudeActivationOperationTimeoutMs: 40,
    claudeActivationQueueTimeoutMs: 15,
  });
  const profileRef = path.join(root, 'claude-profile');
  const recoveredProfileRef = path.join(root, 'recovered-claude-profile');
  let settingsStartedResolve;
  let settingsPromise;
  const settingsStarted = new Promise((resolve) => { settingsStartedResolve = resolve; });
  const neverSettles = new Promise(() => {});

  const wedged = service.withClaudeActivationLock(() => {
    settingsPromise = service.withClaudeProfileSettingsLock(profileRef, async () => {
      settingsStartedResolve();
      await neverSettles;
    });
    return settingsPromise;
  });
  await settingsStarted;

  const activationError = await settleWithin(wedged, 200, 'outer activation watchdog').then(
    () => assert.fail('the outer activation watchdog should reject'),
    (error) => error,
  );
  assert.equal(activationError.statusCode, 504);
  assert.equal(activationError.code, 'claude-activation-operation-timeout');

  const settingsError = await settleWithin(settingsPromise, 200, 'inner settings watchdog').then(
    () => assert.fail('the inner settings watchdog should reject'),
    (error) => error,
  );
  assert.equal(settingsError.statusCode, 504);
  assert.equal(settingsError.code, 'claude-profile-settings-operation-timeout');
  await new Promise((resolve) => setImmediate(resolve));

  const recovered = await settleWithin(
    service.withClaudeActivationLock(
      () => service.withClaudeProfileSettingsLock(recoveredProfileRef, async () => 'recovered'),
    ),
    200,
    'Claude work after the settings timeout',
  );
  assert.equal(recovered, 'recovered');
});

test('TRIPWIRE #484: a timed-out settings write stays fenced until its late operation settles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-settings-fence-'));
  const profileRef = path.join(root, 'claude-profile');
  const otherProfileRef = path.join(root, 'other-claude-profile');
  const settingsPath = path.join(profileRef, 'settings.json');
  const otherSettingsPath = path.join(otherProfileRef, 'settings.json');
  fs.mkdirSync(profileRef, { recursive: true });
  fs.mkdirSync(otherProfileRef, { recursive: true });
  fs.writeFileSync(settingsPath, 'initial settings');

  const store = new Store(':memory:');
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = new ModelDeckService(store, {
    dataDir: path.join(root, 'data'),
    platform: 'linux',
    claudeProfileSettingsOperationTimeoutMs: 40,
  });

  let firstStartedResolve;
  let releaseFirst;
  let firstWriteCompletedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const firstWriteCompleted = new Promise((resolve) => { firstWriteCompletedResolve = resolve; });
  const timedOut = service.withClaudeProfileSettingsLock(profileRef, async () => {
    firstStartedResolve();
    await firstBlocked;
    await fs.promises.writeFile(settingsPath, 'timed-out settings');
    firstWriteCompletedResolve();
  });
  await firstStarted;

  const timeoutError = await settleWithin(timedOut, 200, 'timed-out settings write').then(
    () => assert.fail('the settings watchdog should reject'),
    (error) => error,
  );
  assert.equal(timeoutError.statusCode, 504);
  assert.equal(timeoutError.code, 'claude-profile-settings-operation-timeout');

  let newerStarted = false;
  const newer = service.withClaudeProfileSettingsLock(profileRef, async () => {
    newerStarted = true;
    await fs.promises.writeFile(settingsPath, 'newer settings');
    return 'newer settings';
  });
  const otherProfile = service.withClaudeProfileSettingsLock(otherProfileRef, async () => {
    await fs.promises.writeFile(otherSettingsPath, 'other profile settings');
    return 'other profile settings';
  });

  assert.equal(
    await settleWithin(otherProfile, 200, 'different-profile settings write'),
    'other profile settings',
  );
  await new Promise((resolve) => setImmediate(resolve));
  const newerOverlappedTimedOutWrite = newerStarted;

  releaseFirst();
  await settleWithin(firstWriteCompleted, 200, 'late timed-out settings write');
  assert.equal(await settleWithin(newer, 200, 'newer settings write'), 'newer settings');

  assert.equal(newerOverlappedTimedOutWrite, false);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'newer settings');
  assert.equal(fs.readFileSync(otherSettingsPath, 'utf8'), 'other profile settings');
});
