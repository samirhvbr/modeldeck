// Issue #421 (1.0 build C) — the /api/state managed-proxy block.
//
// The Mac app owns the bundled proxy's PROCESS (#397), so the daemon reports
// only what it can OBSERVE about the shared ~/.config/cliproxyapi state dir
// (#398) — never management state it cannot see, never auth-file contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

const noForeignConsumers = async () => ({ checked: true, consumers: [], probe: 'ok' });

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-managed-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeService(t, root, options = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const service = new ModelDeckService(store, {
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    detectForeignUsageConsumers: noForeignConsumers,
    ...options,
  });
  return { service, store };
}

test('/api/state carries a managed-proxy block describing the shared state dir', async (t) => {
  const root = makeRoot(t);
  const { service } = makeService(t, root, {
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    cliproxyBaseUrl: 'http://127.0.0.1:8317',
  });
  const configDir = path.join(root, '.config', 'cliproxyapi');
  fs.mkdirSync(path.join(configDir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), 'port: 8317\n');

  const state = await service.state();
  assert.deepEqual(state.managedProxy, {
    baseUrl: 'http://127.0.0.1:8317',
    configDir,
    configPresent: true,
    authDirPresent: true,
    lastQueueContactAt: null,
  });
});

test('a proxy that was never installed reports absence rather than guessing', async (t) => {
  const root = makeRoot(t);
  const { service } = makeService(t, root, {
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
  });
  const state = await service.state();
  assert.equal(state.managedProxy.configPresent, false);
  assert.equal(state.managedProxy.authDirPresent, false);
  assert.equal(state.managedProxy.configDir, path.join(root, '.config', 'cliproxyapi'));
});

test('an unwired config dir reports unknown, never a developer\'s real install', async (t) => {
  const { service } = makeService(t, makeRoot(t));
  const state = await service.state();
  // Same no-homedir-default rule as cliproxyAuthDir: a fixture observes nothing.
  assert.equal(state.managedProxy.configDir, null);
  assert.equal(state.managedProxy.configPresent, null);
  assert.equal(state.managedProxy.authDirPresent, null);
  assert.equal(typeof state.managedProxy.baseUrl, 'string');
});

test('the block checks presence only — it never opens an auth file', async (t) => {
  const checked = [];
  const root = makeRoot(t);
  const { service } = makeService(t, root, {
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    cliproxyPathExists: (target) => {
      checked.push(target);
      return true;
    },
  });
  const configDir = path.join(root, '.config', 'cliproxyapi');

  await service.state();

  assert.deepEqual(checked, [
    path.join(configDir, 'config.yaml'),
    path.join(configDir, 'auth'),
  ]);
  // The auth DIRECTORY may be looked at; nothing inside it ever is.
  assert.ok(!checked.some((target) => path.dirname(target).endsWith(`${path.sep}auth`)));
});

test('an unreadable state dir degrades to absent instead of throwing', async (t) => {
  const root = makeRoot(t);
  const { service } = makeService(t, root, {
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    cliproxyPathExists: () => { throw new Error('EPERM'); },
  });
  const state = await service.state();
  assert.equal(state.managedProxy.configPresent, false);
  assert.equal(state.managedProxy.authDirPresent, false);
});

test('the block surfaces when the daemon last actually talked to the proxy', async (t) => {
  const root = makeRoot(t);
  const { service } = makeService(t, root, {
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    usageQueueConsumer: { pull: async () => ({ records: 0, inserted: 0 }) },
    now: () => Date.parse('2026-08-14T12:00:00.000Z'),
  });
  await service.pullUsageQueue();
  const state = await service.state();
  assert.equal(state.managedProxy.lastQueueContactAt, '2026-08-14T12:00:00.000Z');
});

// TRIPWIRE managed-proxy-guard-stays-loud (#421 / #400): slice C adds an
// observed-facts block beside the usage-queue guard. The guard's own logic is
// untouched, and it must stay just as loud with a managed proxy installed —
// a second consumer silently halving analytics is the named failure mode.
test('TRIPWIRE managed-proxy-guard-stays-loud — a managed instance never softens the foreign-consumer guard', async (t) => {
  const logs = [];
  let pulls = 0;
  const root = makeRoot(t);
  const { service, store } = makeService(t, root, {
    cliproxyConfigDir: path.join(root, '.config', 'cliproxyapi'),
    usageQueueConsumer: { pull: async () => { pulls += 1; } },
    detectForeignUsageConsumers: async () => ({
      checked: true,
      consumers: ['ai.hermes.modeldeck.ingest'],
      probe: 'ok',
    }),
    logUsageQueueGuard: (message) => logs.push(message),
  });
  t.after(async () => { await service.stopUsageQueueConsumer(); });
  // A fully-installed managed proxy: config written, auth dir present.
  const configDir = path.join(root, '.config', 'cliproxyapi');
  fs.mkdirSync(path.join(configDir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), 'port: 8317\n');

  await service.startUsageQueueConsumer();
  await service.rescheduleUsageQueueConsumer(
    store.saveSettings({ usageQueueConsumerEnabled: true }),
  );

  const state = await service.state();
  // The guard verbatim: blocked, named, logged — exactly as 0.4.6 shipped it.
  assert.equal(pulls, 0, 'the queue is never read while the foreign job is loaded');
  assert.deepEqual(logs, [
    'USAGE QUEUE FOREIGN CONSUMER DETECTED: still loaded: ai.hermes.modeldeck.ingest; daemon consumer blocked',
  ]);
  assert.deepEqual(state.usageQueue.guard, {
    status: 'blocked',
    checkedAt: state.usageQueue.guard.checkedAt,
    foreignConsumers: ['ai.hermes.modeldeck.ingest'],
    message: logs[0],
  });
  assert.equal(state.usageQueue.configured, true);
  assert.equal(state.usageQueue.running, false);
  // And the new block reports the install honestly at the same time.
  assert.equal(state.managedProxy.configPresent, true);
});

// PR #430 review: overriding ONLY the config dir must move the default auth
// dir with it — otherwise the daemon reports on one install while reading
// auth metadata from another. Paths resolve at import time from env, so the
// assertion runs in a subprocess. TRIPWIRE cliproxy-auth-dir-follows-config.
test('CLIPROXY_AUTH_DIR follows a config-dir-only override (#430 review)', async () => {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { CLIPROXY_CONFIG_DIR, CLIPROXY_AUTH_DIR } from './src/paths.mjs'; process.stdout.write(JSON.stringify({ CLIPROXY_CONFIG_DIR, CLIPROXY_AUTH_DIR }));",
  ], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    env: { ...process.env, MODELDECK_CLIPROXY_CONFIG_DIR: '/placeholder/proxy-state', MODELDECK_CLIPROXY_AUTH_DIR: '' },
  });
  assert.equal(probe.status, 0, probe.stderr);
  const paths = JSON.parse(probe.stdout);
  assert.equal(paths.CLIPROXY_CONFIG_DIR, '/placeholder/proxy-state');
  assert.equal(paths.CLIPROXY_AUTH_DIR, '/placeholder/proxy-state/auth');
});
