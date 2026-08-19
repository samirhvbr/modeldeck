import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { installFetch } from '../dashboard/test-support/index.mjs';

test('reset calendar API returns every account and preserves unknown reset times', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-reset-calendar-'));
  const codexProfile = path.join(root, 'codex-profile');
  const emptyProfile = path.join(root, 'empty-profile');
  fs.mkdirSync(codexProfile, { mode: 0o700 });
  fs.mkdirSync(emptyProfile, { mode: 0o700 });
  const store = new Store(':memory:');
  store.saveSettings({ usageAnalyticsEnabled: true });
  const claude = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder Claude',
    profileRef: '/placeholder/claude-profile',
  });
  const codex = store.saveAccount({
    provider: 'codex',
    label: 'Placeholder Codex',
    profileRef: codexProfile,
  });
  const empty = store.saveAccount({
    provider: 'codex',
    label: 'Placeholder Empty',
    profileRef: emptyProfile,
  });
  store.recordUsage(claude.id, {
    scope: '5-hour',
    usedPercent: 40,
    resetsAt: '2026-08-18T20:30:00.000Z',
    observedAt: '2026-08-17T20:00:00.000Z',
    source: 'reset-calendar-fixture',
  });
  store.recordUsage(claude.id, {
    scope: 'weekly',
    usedPercent: 60,
    resetsAt: null,
    observedAt: '2026-08-17T20:00:00.000Z',
    source: 'reset-calendar-fixture',
  });
  store.recordUsage(codex.id, {
    scope: 'weekly',
    usedPercent: 25,
    resetsAt: '2026-08-22T17:00:00.000Z',
    observedAt: '2026-08-17T20:00:00.000Z',
    source: 'reset-calendar-fixture',
  });

  const service = { projectsRoot: '/placeholder', startAutoRefresh() {}, stopAutoRefresh() {} };
  const app = createApp({ store, service, host: '127.0.0.1', port: 3867 });
  installFetch(app);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch('/api/usage/resets');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  assert.deepEqual(payload.accounts, [
    {
      accountId: claude.id,
      label: 'Placeholder Claude',
      provider: 'claude',
      windows: [
        {
          scope: '5-hour',
          resetsAt: '2026-08-18T20:30:00.000Z',
          observedAt: '2026-08-17T20:00:00.000Z',
        },
        {
          scope: 'weekly',
          resetsAt: null,
          observedAt: '2026-08-17T20:00:00.000Z',
        },
      ],
    },
    {
      accountId: codex.id,
      label: 'Placeholder Codex',
      provider: 'codex',
      windows: [{
        scope: 'weekly',
        resetsAt: '2026-08-22T17:00:00.000Z',
        observedAt: '2026-08-17T20:00:00.000Z',
      }],
    },
    {
      accountId: empty.id,
      label: 'Placeholder Empty',
      provider: 'codex',
      windows: [],
    },
  ]);
});
