// Throwaway field-test harness for issue #344: boots the daemon HTTP app on a
// scratch database seeded with PLACEHOLDER accounts and synthetic request
// usage, with the usage-analytics flag on, so the burn timeline can be clicked
// in a browser. Never touches the real ModelDeck database. Not part of npm test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { parseUsageRecord } from '../src/usage-ingest.mjs';

const PORT = Number(process.env.FIELD_PORT || 43399);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-field-344-'));
const store = new Store(path.join(root, 'modeldeck.sqlite'));
store.saveSettings({ usageAnalyticsEnabled: true });

const accounts = [
  store.saveAccount({ provider: 'claude', label: 'Placeholder Claude One', identity: 'placeholder-one@example.com', profileRef: 'field-one' }),
  store.saveAccount({ provider: 'claude', label: 'Placeholder Claude Two', identity: 'placeholder-two@example.com', profileRef: 'field-two' }),
];
const models = ['claude-placeholder-workhorse', 'claude-placeholder-small'];

// 14 days of synthetic traffic with a working-hours shape, so the hour-of-day
// fold has something to say. Deterministic (seeded LCG), no real data.
let seed = 20260809;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const records = [];
const now = Date.now();
for (let hour = 0; hour < 24 * 14; hour += 1) {
  const at = new Date(now - hour * 3600 * 1000);
  const localHour = at.getHours();
  const busy = localHour >= 9 && localHour <= 18 ? 1 : localHour >= 19 && localHour <= 23 ? 0.45 : 0.08;
  const count = Math.round(busy * (1 + rand() * 4));
  for (let index = 0; index < count; index += 1) {
    const source = rand() < 0.6 ? 'placeholder-one@example.com' : 'placeholder-two@example.com';
    const model = rand() < 0.7 ? models[0] : models[1];
    const total = Math.round(20000 + rand() * 180000);
    records.push(parseUsageRecord({
      request_id: 'field-' + hour + '-' + index,
      timestamp: new Date(at.getTime() - index * 60000).toISOString(),
      source,
      provider: 'claude',
      model,
      reasoning_effort: rand() < 0.6 ? 'high' : 'medium',
      endpoint: '/v1/messages',
      user_agent_class: 'claude-code',
      failed: false,
      status_code: 200,
      latency_ms: 100 + rand() * 900,
      ttft_ms: 10 + rand() * 200,
      input_uncached: Math.round(total * 0.03),
      input_cache_read: Math.round(total * 0.9),
      input_cache_write: Math.round(total * 0.04),
      output_total: Math.round(total * 0.03),
      output_reasoning: Math.round(total * 0.015),
      total,
    }));
  }
}
// A little Codex traffic so the provider filter has two sides.
for (let hour = 0; hour < 24 * 14; hour += 6) {
  records.push(parseUsageRecord({
    request_id: 'field-codex-' + hour,
    timestamp: new Date(now - hour * 3600 * 1000).toISOString(),
    source: 'placeholder-codex-source',
    provider: 'codex',
    model: 'gpt-placeholder-sol',
    reasoning_effort: 'high',
    endpoint: '/v1/responses',
    user_agent_class: 'codex',
    failed: false,
    status_code: 200,
    latency_ms: 200,
    ttft_ms: 20,
    input_uncached: 4000,
    input_cache_read: 30000,
    input_cache_write: 1000,
    output_total: 2000,
    output_reasoning: 900,
    total: 37000,
  }));
}
store.ingestRequestUsage(records);

// Window snapshots so the Account headroom view still has something to draw.
for (const account of accounts) {
  for (let step = 0; step < 48; step += 1) {
    const observedAt = new Date(now - step * 1800 * 1000).toISOString();
    store.recordUsage(account.id, {
      scope: '5-hour',
      source: 'field-placeholder',
      usedPercent: Math.min(99, 12 + step * 1.4 + rand() * 5),
      observedAt,
      resetsAt: new Date(now + 3 * 3600 * 1000).toISOString(),
    });
  }
}

const service = {
  projectsRoot: root,
  startAutoRefresh() {},
  stopAutoRefresh() {},
  async state() {
    return { accounts: accounts.map((account) => ({ ...account, enabled: true })), usage: store.latestUsage() };
  },
};
const app = createApp({ store, service, host: '127.0.0.1', port: PORT, mutationToken: 'field-placeholder-token' });
app.listen(() => {
  console.log('field test on http://127.0.0.1:' + PORT + '/dashboard  (db: ' + root + ')');
});
