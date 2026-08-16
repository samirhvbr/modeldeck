// Issue #396 — in-app repair for an expired CLIProxyAPI pool credential.
// THE NAMED TRIPWIRE of this slice is the first test below:
//   relogin-never-touches-auth-files
// It is the structural guarantee behind the #398 verdict: ModelDeck drives
// the PROXY's own login flow and never becomes a writer of credential state.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelDeckService } from '../src/service.mjs';
import { Store } from '../src/db.mjs';
import {
  assertProxyAuthFilesShape,
  assertProxyAuthStatusShape,
  assertProxyAuthUrlShape,
  decideProxyReloginAvailability,
  isSettledProxyReloginPhase,
  loopbackManagementUrl,
  PROXY_RELOGIN_AUTH_URL_PATHS,
  proxyCredentialHealthFromAuthFiles,
  proxyCredentialHealthOf,
  ProxyReloginDriver,
  ProxyReloginError,
  proxyReloginFailureText,
  proxyReloginNextPhase,
} from '../src/proxy-relogin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_EMAIL = 'relogin-fixture@example.invalid';
const CODEX_ACCOUNT_ID = 'acct-relogin-fixture';

// ---------------------------------------------------------------------------
// TRIPWIRE
// ---------------------------------------------------------------------------

// Every filesystem-mutating API name. A re-login path that acquires ANY of
// them has stopped being "ask the proxy to sign in" and started being
// "ModelDeck manages credentials", which is precisely what #398 forbids.
const WRITE_APIS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync',
  'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createWriteStream', 'truncate', 'truncateSync', 'ftruncate',
  'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync',
  'symlink', 'symlinkSync', 'link', 'linkSync', 'write', 'writev',
];

/// The #396 service methods, sliced by their own boundary comments so the
/// grep covers exactly the re-login code and not the rest of service.mjs.
function reloginServiceRegion() {
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'service.mjs'), 'utf8');
  const start = source.indexOf('  // Issue #396 — CREDENTIAL HEALTH');
  const end = source.indexOf('  async joinProxyPool(accountId) {', start);
  assert.ok(start > 0 && end > start, 'the #396 service region markers must still exist');
  return source.slice(start, end);
}

test('TRIPWIRE relogin-never-touches-auth-files — the re-login path holds no filesystem write, so CLIProxyAPI stays the sole writer of its credentials', () => {
  const sources = {
    'src/proxy-relogin.mjs': fs.readFileSync(path.join(repoRoot, 'src', 'proxy-relogin.mjs'), 'utf8'),
    'src/service.mjs (#396 region)': reloginServiceRegion(),
  };
  for (const [label, source] of Object.entries(sources)) {
    // Strip comments: the files EXPLAIN the rule, and explaining it must not
    // trip the check that enforces it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const api of WRITE_APIS) {
      assert.ok(
        !new RegExp(`\\.${api}\\s*\\(`).test(code),
        `${label} must not call fs.${api} — the proxy is the only writer of auth state (#398)`,
      );
    }
    assert.ok(
      !/require\(['"]fs|from ['"]node:fs\/promises/.test(code) || label !== 'src/service.mjs (#396 region)',
      `${label} must not reach for a second filesystem handle`,
    );
  }
});

/// Every file under a root, with the facts a write would change. The
/// behavioural half of the tripwire compares this before and after a whole
/// re-login: the proxy's auth directory — and the daemon's own state root —
/// must come out byte-identical.
function treeSnapshot(root) {
  const snapshot = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { snapshot[`${target}/`] = 'dir'; walk(target); continue; }
      const stat = fs.statSync(target);
      snapshot[target] = `${stat.size}:${stat.mtimeMs}:${stat.mode}`;
    }
  };
  walk(root);
  return snapshot;
}

test('TRIPWIRE relogin-never-touches-auth-files — a whole flow, driven end to end, leaves the auth directory byte-identical', async (t) => {
  const data = await fixture(t, { proxyReloginFetch: stubProxy() });
  const before = treeSnapshot(data.root);

  const start = await data.service.startProxyRelogin(data.claude.id);
  assert.equal(start.phase, 'awaiting-browser');
  assert.equal((await data.service.proxyReloginState(data.claude.id)).phase, 'awaiting-browser');
  data.proxy.status = 'ok';
  assert.equal((await data.service.proxyReloginState(data.claude.id)).phase, 'succeeded');
  await data.service.accountsWithAuthState();

  // A credential ModelDeck did not write cannot be a credential ModelDeck
  // stored, lost, or corrupted. That is the whole safety argument.
  assert.deepEqual(treeSnapshot(data.root), before);
});

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

test('the loopback guard refuses any management URL that is not local HTTP', () => {
  assert.equal(
    loopbackManagementUrl('http://127.0.0.1:8317', '/v0/management/get-auth-status', { state: 'abc' }).href,
    'http://127.0.0.1:8317/v0/management/get-auth-status?state=abc',
  );
  for (const hostile of [
    'http://proxy.example.com:8317',
    'https://10.0.0.4:8317',
    'file:///etc/passwd',
    'ftp://127.0.0.1:8317',
  ]) {
    assert.throws(() => loopbackManagementUrl(hostile, '/v0/management/auth-files'), /loopback HTTP/);
  }
});

test('availability says WHY it is unavailable, never just no', () => {
  const base = { provider: 'claude', baseUrl: 'http://127.0.0.1:8317', managementKeyPresent: true };
  assert.deepEqual(decideProxyReloginAvailability(base), { available: true, reason: null });

  const noKey = decideProxyReloginAvailability({ ...base, managementKeyPresent: false });
  assert.equal(noKey.available, false);
  // Issue #431: a freshly seeded managed config has no key yet. The user is
  // told that in plain words instead of meeting an opaque 401 later.
  assert.match(noKey.reason, /no management key/);

  const remote = decideProxyReloginAvailability({ ...base, baseUrl: 'http://proxy.example.com:8317' });
  assert.equal(remote.available, false);
  assert.match(remote.reason, /not a local address/);

  for (const provider of ['gemini', undefined, 'constructor']) {
    const other = decideProxyReloginAvailability({ ...base, provider });
    assert.equal(other.available, false);
    assert.match(other.reason, /Claude and Codex/);
  }
});

test('the flow state machine settles exactly once and never resurrects a settled attempt', () => {
  assert.equal(proxyReloginNextPhase('idle', 'start'), 'starting');
  assert.equal(proxyReloginNextPhase('idle', 'poll-ok'), 'idle');
  assert.equal(proxyReloginNextPhase('starting', 'started'), 'awaiting-browser');
  assert.equal(proxyReloginNextPhase('starting', 'transport-error'), 'failed');
  assert.equal(proxyReloginNextPhase('starting', 'cancel'), 'cancelled');
  assert.equal(proxyReloginNextPhase('awaiting-browser', 'poll-wait'), 'awaiting-browser');
  assert.equal(proxyReloginNextPhase('awaiting-browser', 'poll-ok'), 'succeeded');
  assert.equal(proxyReloginNextPhase('awaiting-browser', 'poll-error'), 'failed');
  assert.equal(proxyReloginNextPhase('awaiting-browser', 'expired'), 'failed');
  assert.equal(proxyReloginNextPhase('awaiting-browser', 'cancel'), 'cancelled');
  for (const settled of ['succeeded', 'failed', 'cancelled']) {
    assert.ok(isSettledProxyReloginPhase(settled));
    for (const event of ['poll-ok', 'poll-wait', 'poll-error', 'cancel', 'expired', 'transport-error']) {
      assert.equal(proxyReloginNextPhase(settled, event), settled, `${settled} must ignore ${event}`);
    }
    // Only a NEW attempt moves a settled phase.
    assert.equal(proxyReloginNextPhase(settled, 'start'), 'starting');
  }
  assert.ok(!isSettledProxyReloginPhase('awaiting-browser'));
  assert.equal(proxyReloginNextPhase('nonsense', 'start'), 'idle');
});

test('every failure reason has an honest sentence that says what to try', () => {
  const reasons = ['no-key', 'unreachable', 'malformed', 'unsupported-provider', 'bad-state', 'expired', 'no-session', null];
  for (const reason of reasons) {
    const text = proxyReloginFailureText(reason);
    assert.ok(text.length > 20, `${reason} needs a real sentence`);
    assert.ok(!/undefined|null|\[object/.test(text), `${reason} leaked an internal value`);
  }
  assert.match(proxyReloginFailureText('http', { status: 401 }), /management key/);
  assert.match(proxyReloginFailureText('http', { status: 404 }), /remote management turned off/);
  assert.match(proxyReloginFailureText('http', { status: 500 }), /HTTP 500/);
});

// ---------------------------------------------------------------------------
// Response shapes (the surfaces the live capture pins)
// ---------------------------------------------------------------------------

test('the auth-url shape accepts the proxy answer and refuses anything it could not open safely', () => {
  assert.deepEqual(
    assertProxyAuthUrlShape('{"status":"ok","url":"https://claude.ai/oauth/authorize?x=1","state":"abc-123_x.y"}'),
    { url: 'https://claude.ai/oauth/authorize?x=1', state: 'abc-123_x.y' },
  );
  assert.throws(() => assertProxyAuthUrlShape('['), /not valid JSON/);
  assert.throws(() => assertProxyAuthUrlShape('[]'), /must be a JSON object/);
  assert.throws(() => assertProxyAuthUrlShape('{"status":"error"}'), /status ok/);
  // Never hand the app a non-https target to open, and never put a remote
  // value with path separators back into a query string.
  assert.throws(() => assertProxyAuthUrlShape('{"status":"ok","url":"javascript:alert(1)","state":"a"}'), /https authorize URL/);
  assert.throws(() => assertProxyAuthUrlShape('{"status":"ok","url":"https://a","state":"../../etc"}'), /usable state/);
  assert.throws(() => assertProxyAuthUrlShape(`{"status":"ok","url":"https://a","state":"${'x'.repeat(129)}"}`), /usable state/);
});

test('the auth-status shape carries the proxy verdict, including its own error text', () => {
  assert.deepEqual(assertProxyAuthStatusShape('{"status":"wait"}'), { status: 'wait', error: null });
  assert.deepEqual(assertProxyAuthStatusShape('{"status":"ok"}'), { status: 'ok', error: null });
  assert.deepEqual(
    assertProxyAuthStatusShape('{"status":"error","error":"unknown or expired state"}'),
    { status: 'error', error: 'unknown or expired state' },
  );
  assert.equal(assertProxyAuthStatusShape({ status: 'error', error: 'x'.repeat(500) }).error.length, 200);
  assert.throws(() => assertProxyAuthStatusShape('{"status":"pending"}'), /ok, wait, or error/);
});

test('the auth-files reader takes the non-secret allowlist and NOTHING else', () => {
  const entries = assertProxyAuthFilesShape(JSON.stringify({
    files: [
      {
        name: 'claude-a.json',
        provider: 'claude',
        email: '  Mixed.Case@Example.Invalid ',
        status: 'ERROR',
        status_message: 'unauthorized',
        unavailable: true,
        disabled: false,
        // Both of these must be ignored: `account` is the API KEY for an
        // api-key auth entry upstream, and access_token is never ours to read.
        account: 'sk-super-secret-key',
        access_token: 'must-not-be-read',
      },
      {
        name: 'codex-b.json',
        type: 'codex',
        status: 'active',
        id_token: { chatgpt_account_id: ' acct-9 ', plan_type: 'pro' },
      },
      'not-an-object',
      null,
    ],
  }));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    name: 'claude-a.json',
    provider: 'claude',
    email: 'mixed.case@example.invalid',
    codexAccountId: null,
    status: 'error',
    statusMessage: 'unauthorized',
    disabled: false,
    unavailable: true,
  });
  assert.equal(entries[1].codexAccountId, 'acct-9');
  assert.equal(entries[1].provider, 'codex');
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes('sk-super-secret-key'));
  assert.ok(!serialized.includes('must-not-be-read'));
  assert.throws(() => assertProxyAuthFilesShape('{"files":{}}'), /files array/);
  assert.throws(() => assertProxyAuthFilesShape('[]'), /must be a JSON object/);
});

test('credential health names the three states and lets a healthy sibling win', () => {
  assert.equal(proxyCredentialHealthOf({ status: 'active', disabled: false, unavailable: false }), 'ok');
  assert.equal(proxyCredentialHealthOf({ status: 'refreshing', disabled: false, unavailable: false }), 'ok');
  // Benched is not broken: a re-login would not un-bench it.
  assert.equal(proxyCredentialHealthOf({ status: 'active', disabled: true, unavailable: false }), 'disabled');
  assert.equal(proxyCredentialHealthOf({ status: 'error', disabled: false, unavailable: true }), 'error');
  assert.equal(proxyCredentialHealthOf({ status: 'unknown', disabled: false, unavailable: false }), null);

  const health = proxyCredentialHealthFromAuthFiles([
    { provider: 'claude', email: 'a@x.invalid', status: 'error', statusMessage: 'unauthorized', disabled: false, unavailable: true },
    { provider: 'claude', email: 'a@x.invalid', status: 'active', statusMessage: '', disabled: false, unavailable: false },
    { provider: 'claude', email: 'b@x.invalid', status: 'error', statusMessage: 'unauthorized', disabled: false, unavailable: true },
    { provider: 'codex', codexAccountId: 'acct-1', status: 'active', statusMessage: '', disabled: false, unavailable: false },
    { provider: 'codex', codexAccountId: null, status: 'error', statusMessage: 'x', disabled: false, unavailable: true },
  ]);
  // A stale file left behind by an earlier login must not condemn an
  // identity whose live file still serves traffic.
  assert.deepEqual(health.byClaudeEmail.get('a@x.invalid'), { health: 'ok', detail: null });
  assert.deepEqual(health.byClaudeEmail.get('b@x.invalid'), { health: 'error', detail: 'unauthorized' });
  assert.deepEqual(health.byCodexAccountId.get('acct-1'), { health: 'ok', detail: null });
  assert.equal(health.byCodexAccountId.size, 1);
});

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

function recordingFetch(responses) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: url.href, init });
    const answer = responses.shift();
    if (typeof answer === 'function') return answer();
    return answer;
  };
  return { fetcher, calls };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    body: { cancel: async () => {} },
  };
}

test('the driver asks the proxy to own the callback port, and reads the key fresh every request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-relogin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, '.mgmt-key');
  fs.writeFileSync(keyPath, 'first-key\n', { mode: 0o600 });

  const { fetcher, calls } = recordingFetch([
    jsonResponse({ status: 'ok', url: 'https://claude.ai/oauth/authorize', state: 'st-1' }),
    jsonResponse({ status: 'wait' }),
  ]);
  const driver = new ProxyReloginDriver({ baseUrl: 'http://127.0.0.1:8317', managementKeyPath: keyPath, fetcher });

  assert.deepEqual(await driver.start('claude'), { url: 'https://claude.ai/oauth/authorize', state: 'st-1' });
  // is_webui=1 is the whole no-terminal guarantee: it makes the PROXY bind
  // the provider's fixed callback port and complete its own exchange.
  assert.equal(calls[0].url, 'http://127.0.0.1:8317/v0/management/anthropic-auth-url?is_webui=1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer first-key');
  assert.equal(calls[0].init.redirect, 'error');

  // Rotate the key on disk: the next request must pick it up, which proves
  // it was never retained.
  fs.writeFileSync(keyPath, 'second-key\n', { mode: 0o600 });
  assert.deepEqual(await driver.status('st-1'), { status: 'wait', error: null });
  assert.equal(calls[1].url, 'http://127.0.0.1:8317/v0/management/get-auth-status?state=st-1');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer second-key');
  const retained = JSON.stringify(driver, (key, value) => (typeof value === 'function' ? undefined : value));
  assert.ok(!retained.includes('first-key') && !retained.includes('second-key'));
});

test('the driver reports transport failures as reason codes and never reads an error body', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-relogin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, '.mgmt-key');
  fs.writeFileSync(keyPath, 'k', { mode: 0o600 });

  let cancelled = false;
  const unauthorized = {
    ok: false,
    status: 401,
    text: async () => { throw new Error('the error body must never be read'); },
    body: { cancel: async () => { cancelled = true; } },
  };
  const failing = new ProxyReloginDriver({
    managementKeyPath: keyPath,
    fetcher: async () => unauthorized,
  });
  await assert.rejects(() => failing.authFiles(), (error) => {
    assert.ok(error instanceof ProxyReloginError);
    assert.equal(error.reason, 'http');
    assert.equal(error.status, 401);
    return true;
  });
  assert.ok(cancelled, 'an error body is cancelled, not read');

  const offline = new ProxyReloginDriver({
    managementKeyPath: keyPath,
    fetcher: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => offline.status('st'), (error) => error.reason === 'unreachable');

  const keyless = new ProxyReloginDriver({ managementKeyPath: null, fetcher: async () => jsonResponse({}) });
  assert.equal(await keyless.managementKeyPresent(), false);
  await assert.rejects(() => keyless.start('claude'), (error) => error.reason === 'no-key');

  const empty = path.join(root, 'empty-key');
  fs.writeFileSync(empty, '   ', { mode: 0o600 });
  const blank = new ProxyReloginDriver({ managementKeyPath: empty, fetcher: async () => jsonResponse({}) });
  assert.equal(await blank.managementKeyPresent(), false);

  const garbled = new ProxyReloginDriver({
    managementKeyPath: keyPath,
    fetcher: async () => jsonResponse('not json at all'),
  });
  await assert.rejects(() => garbled.start('codex'), (error) => error.reason === 'malformed');

  const wrongProvider = new ProxyReloginDriver({ managementKeyPath: keyPath, fetcher: async () => jsonResponse({}) });
  await assert.rejects(() => wrongProvider.start('gemini'), (error) => error.reason === 'unsupported-provider');
  // A state token the proxy could not have issued never reaches a URL.
  await assert.rejects(() => wrongProvider.status('../../etc'), (error) => error.reason === 'bad-state');
  await assert.rejects(() => wrongProvider.cancel(''), (error) => error.reason === 'bad-state');
});

test('both pooled providers map to their own upstream login route', () => {
  assert.deepEqual(PROXY_RELOGIN_AUTH_URL_PATHS, {
    claude: '/v0/management/anthropic-auth-url',
    codex: '/v0/management/codex-auth-url',
  });
});

// ---------------------------------------------------------------------------
// Service integration
// ---------------------------------------------------------------------------

/// A stub CLIProxyAPI management API whose answers the test drives directly.
function stubProxy(options = {}) {
  const state = {
    status: options.status || 'wait',
    error: options.error || null,
    authFiles: options.authFiles || [],
    startFailure: options.startFailure || null,
    calls: [],
  };
  const fetcher = async (url) => {
    state.calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('-auth-url')) {
      if (state.startFailure) return jsonResponse({ error: 'nope' }, state.startFailure);
      return jsonResponse({ status: 'ok', url: 'https://provider.invalid/authorize', state: 'st-fixture' });
    }
    if (url.pathname === '/v0/management/get-auth-status') {
      return jsonResponse({ status: state.status, ...(state.error ? { error: state.error } : {}) });
    }
    if (url.pathname === '/v0/management/oauth-session') return jsonResponse({ status: 'ok', cancelled: true });
    if (url.pathname === '/v0/management/auth-files') return jsonResponse({ files: state.authFiles });
    return jsonResponse({ error: 'not found' }, 404);
  };
  fetcher.state = state;
  return fetcher;
}

async function fixture(t, serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-relogin-svc-'));
  const claudeProfilesDir = path.join(root, 'claude-profiles');
  const codexProfilesDir = path.join(root, 'codex-profiles');
  const claudeHome = path.join(claudeProfilesDir, 'work');
  const codexHome = path.join(codexProfilesDir, 'work');
  const cliproxyAuthDir = path.join(root, 'cliproxy-auth');
  for (const directory of [claudeProfilesDir, codexProfilesDir, claudeHome, codexHome, cliproxyAuthDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const managementKeyPath = path.join(root, '.mgmt-key');
  fs.writeFileSync(managementKeyPath, 'fixture-key', { mode: 0o600 });
  fs.writeFileSync(
    path.join(cliproxyAuthDir, 'claude-fixture.json'),
    JSON.stringify({ type: 'claude', email: CLAUDE_EMAIL, weight: 5, access_token: 'placeholder-not-a-credential' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(cliproxyAuthDir, 'codex-fixture.json'),
    JSON.stringify({ type: 'codex', account_id: CODEX_ACCOUNT_ID, weight: 3, access_token: 'placeholder-not-a-credential' }),
    { mode: 0o600 },
  );

  const store = new Store(':memory:');
  const claude = store.saveAccount({
    provider: 'claude', label: 'Pool Claude', identity: CLAUDE_EMAIL, profileRef: claudeHome, isDefault: true,
  });
  const codex = store.saveAccount({
    provider: 'codex', label: 'Pool Codex', identity: '', profileRef: codexHome, isDefault: true,
  });
  const fetcher = serviceOptions.proxyReloginFetch || stubProxy();
  let now = 1_000_000;
  const service = new ModelDeckService(store, {
    claudeProfilesDir,
    codexProfilesDir,
    claudeActiveLink: path.join(root, 'active', '.claude'),
    cliproxyAuthDir,
    cliproxyBaseUrl: 'http://127.0.0.1:8317',
    cliproxyManagementKeyPath: managementKeyPath,
    platform: 'linux',
    claudeCredentialsPresent: async () => true,
    listProviderProcesses: async () => [],
    childEnv: { PATH: '/fixture/bin' },
    userInfo: () => ({ username: 'fixture-user' }),
    proxyReloginNow: () => now,
    ...serviceOptions,
    proxyReloginFetch: fetcher,
  });
  service.codexAccountIdentifiers.set(codex.id, CODEX_ACCOUNT_ID);
  t.after(() => { service.stopAutoRefresh(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, store, service, claude, codex, managementKeyPath, cliproxyAuthDir,
    proxy: fetcher.state,
    advance: (ms) => { now += ms; },
  };
}

test('a re-login runs start → wait → success, and the success is visible as restored health', async (t) => {
  const proxy = stubProxy({
    authFiles: [{
      name: 'claude-fixture.json', provider: 'claude', email: CLAUDE_EMAIL,
      status: 'error', status_message: 'unauthorized', unavailable: true, disabled: false,
    }],
  });
  const data = await fixture(t, { proxyReloginFetch: proxy });

  // Before: the proxy's own verdict marks this member broken, and the FIX is
  // offered because a management key exists.
  const [before] = (await data.service.accountsWithAuthState()).filter((a) => a.id === data.claude.id);
  assert.equal(before.proxyPool, 'member');
  assert.equal(before.proxyCredential, 'error');
  assert.equal(before.proxyCredentialDetail, 'unauthorized');
  assert.deepEqual(before.proxyRelogin, { available: true });

  const start = await data.service.startProxyRelogin(data.claude.id);
  assert.equal(start.phase, 'awaiting-browser');
  assert.equal(start.provider, 'claude');
  // The authorize URL is handed to the app ONCE so it can open a browser.
  assert.equal(start.url, 'https://provider.invalid/authorize');
  assert.ok(proxy.state.calls.some((call) => call.startsWith('/v0/management/anthropic-auth-url?is_webui=1')));

  const waiting = await data.service.proxyReloginState(data.claude.id);
  assert.equal(waiting.phase, 'awaiting-browser');
  assert.equal(waiting.url, undefined, 'the poll never repeats the authorize URL');

  // The proxy completes its own exchange and writes its own auth file.
  proxy.state.status = 'ok';
  proxy.state.authFiles = [{
    name: 'claude-fixture.json', provider: 'claude', email: CLAUDE_EMAIL,
    status: 'active', status_message: '', unavailable: false, disabled: false,
  }];
  const done = await data.service.proxyReloginState(data.claude.id);
  assert.equal(done.phase, 'succeeded');
  assert.equal(done.detail, undefined);

  // THE RECOVERY SIGNAL (#395's detector clears on this): health flips back
  // on the very next state read, without waiting for the cache to age out.
  const [after] = (await data.service.accountsWithAuthState()).filter((a) => a.id === data.claude.id);
  assert.equal(after.proxyCredential, 'ok');
  assert.equal(after.proxyCredentialDetail, undefined);
});

test('a Codex member is repaired through the codex login route', async (t) => {
  const proxy = stubProxy({
    authFiles: [{
      name: 'codex-fixture.json', provider: 'codex', status: 'error', status_message: 'unauthorized',
      unavailable: true, disabled: false, id_token: { chatgpt_account_id: CODEX_ACCOUNT_ID },
    }],
  });
  const data = await fixture(t, { proxyReloginFetch: proxy });
  const [before] = (await data.service.accountsWithAuthState()).filter((a) => a.id === data.codex.id);
  assert.equal(before.proxyCredential, 'error');
  await data.service.startProxyRelogin(data.codex.id);
  assert.ok(proxy.state.calls.some((call) => call.startsWith('/v0/management/codex-auth-url?is_webui=1')));
});

test('the proxy’s own failure reason is relayed, not replaced with a guess', async (t) => {
  const data = await fixture(t);
  await data.service.startProxyRelogin(data.claude.id);
  data.proxy.status = 'error';
  data.proxy.error = 'Failed to exchange authorization code for tokens';
  const failed = await data.service.proxyReloginState(data.claude.id);
  assert.equal(failed.phase, 'failed');
  assert.match(failed.detail, /Failed to exchange authorization code for tokens/);
  // Settled stays settled, even if the proxy's answer changes underneath.
  data.proxy.status = 'ok';
  assert.equal((await data.service.proxyReloginState(data.claude.id)).phase, 'failed');
});

test('a sign-in nobody finishes expires instead of waiting forever', async (t) => {
  const data = await fixture(t);
  await data.service.startProxyRelogin(data.claude.id);
  // The proxy's own callback waiter gives up at five minutes.
  data.advance(5 * 60_000);
  const expired = await data.service.proxyReloginState(data.claude.id);
  assert.equal(expired.phase, 'failed');
  assert.match(expired.detail, /not finished in time/);
  // And a new attempt is allowed immediately afterwards.
  assert.equal((await data.service.startProxyRelogin(data.claude.id)).phase, 'awaiting-browser');
});

test('cancelling asks the proxy to drop its own session, and refuses when there is none', async (t) => {
  const data = await fixture(t);
  await assert.rejects(
    () => data.service.cancelProxyRelogin(data.claude.id),
    (error) => error.statusCode === 409 && /no sign-in in progress/.test(error.message),
  );
  await data.service.startProxyRelogin(data.claude.id);
  const cancelled = await data.service.cancelProxyRelogin(data.claude.id);
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.cancelledUpstream, true);
  assert.ok(data.proxy.calls.some((call) => call.startsWith('/v0/management/oauth-session?state=')));
});

test('two sign-ins for one account cannot run at once', async (t) => {
  const data = await fixture(t);
  await data.service.startProxyRelogin(data.claude.id);
  await assert.rejects(
    () => data.service.startProxyRelogin(data.claude.id),
    (error) => error.statusCode === 409 && /already in progress/.test(error.message),
  );
});

// CodeRabbit (PR #435): the session record lands only after the driver's
// start round trip, so two starts racing inside that window both used to
// reach the proxy — the first OAuth session was orphaned on the provider's
// fixed callback port. The guard must hold WHILE a start is in flight.
test('TRIPWIRE proxy-relogin-start-round-trip-overlap — concurrent starts reach the proxy exactly once', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  let authUrlCalls = 0;
  const inner = stubProxy();
  const fetcher = async (url) => {
    if (url.pathname.endsWith('-auth-url')) {
      authUrlCalls += 1;
      if (authUrlCalls === 1) {
        markEntered();
        await gate;
      }
    }
    return inner(url);
  };
  fetcher.state = inner.state;
  const data = await fixture(t, { proxyReloginFetch: fetcher });

  const first = data.service.startProxyRelogin(data.claude.id);
  // Do not infer overlap from invocation order: each caller first awaits an
  // independent management-key read. Wait until the first proxy request is
  // verifiably held open, then issue the competing start inside that window.
  await entered;
  await assert.rejects(
    () => data.service.startProxyRelogin(data.claude.id),
    (error) => error.statusCode === 409 && /already in progress/.test(error.message),
  );
  assert.equal(authUrlCalls, 1);
  release();
  assert.equal((await first).phase, 'awaiting-browser');
  assert.equal(inner.state.calls.filter((call) => call.includes('-auth-url')).length, 1);
});

test('a start the proxy refuses fails honestly instead of pretending to wait', async (t) => {
  const proxy = stubProxy({ startFailure: 404 });
  const data = await fixture(t, { proxyReloginFetch: proxy });
  await assert.rejects(
    () => data.service.startProxyRelogin(data.claude.id),
    (error) => error.statusCode === 502 && /remote management turned off/.test(error.message),
  );
  // No phantom session is left behind.
  assert.equal((await data.service.proxyReloginState(data.claude.id)).phase, 'idle');
});

test('without a management key the repair is unavailable WITH the reason, never a silent no', async (t) => {
  const data = await fixture(t, { cliproxyManagementKeyPath: null });
  const [account] = (await data.service.accountsWithAuthState()).filter((a) => a.id === data.claude.id);
  assert.equal(account.proxyPool, 'member');
  // Health is unknown without a key, so nothing is claimed about it.
  assert.equal(account.proxyCredential, undefined);
  assert.equal(account.proxyRelogin.available, false);
  assert.match(account.proxyRelogin.reason, /no management key/);
  await assert.rejects(
    () => data.service.startProxyRelogin(data.claude.id),
    (error) => error.statusCode === 409 && /no management key/.test(error.message),
  );
  const idle = await data.service.proxyReloginState(data.claude.id);
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.available, false);
});

test('a machine with no CLIProxyAPI pool renders nothing at all', async (t) => {
  const data = await fixture(t, { cliproxyAuthDir: null });
  const [account] = (await data.service.accountsWithAuthState()).filter((a) => a.id === data.claude.id);
  assert.equal(account.proxyPool, undefined);
  assert.equal(account.proxyRelogin, undefined);
  assert.equal(account.proxyCredential, undefined);
});

test('an unreachable proxy leaves health unknown rather than declaring every member broken', async (t) => {
  const data = await fixture(t, { proxyReloginFetch: async () => { throw new Error('ECONNREFUSED'); } });
  const [account] = (await data.service.accountsWithAuthState()).filter((a) => a.id === data.claude.id);
  assert.equal(account.proxyPool, 'member');
  assert.equal(account.proxyCredential, undefined);
  // The repair itself is still offered — it is exactly what a user whose
  // proxy is misbehaving may want to try, and it fails honestly if it cannot.
  assert.equal(account.proxyRelogin.available, true);
});

test('the health probe is cached, so a deck refresh is not a burst of management calls', async (t) => {
  const data = await fixture(t);
  await Promise.all([data.service.accountsWithAuthState(), data.service.accountsWithAuthState()]);
  await data.service.accountsWithAuthState();
  const probes = data.proxy.calls.filter((call) => call === '/v0/management/auth-files').length;
  assert.equal(probes, 1);
  data.advance(20_000);
  await data.service.accountsWithAuthState();
  assert.equal(data.proxy.calls.filter((call) => call === '/v0/management/auth-files').length, 2);
});
