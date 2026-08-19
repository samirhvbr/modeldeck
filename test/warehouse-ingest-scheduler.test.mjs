import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import {
  ModelDeckService,
  WAREHOUSE_INGEST_INTERVAL_MS,
} from '../src/service.mjs';

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async flush() {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  }

  async runNext(service) {
    assert.equal(this.timers.size, 1, 'exactly one warehouse tick is armed');
    const [id, timer] = this.timers.entries().next().value;
    assert.equal(timer.delay, WAREHOUSE_INGEST_INTERVAL_MS);
    this.timers.delete(id);
    timer.callback();
    const pass = service.warehouseIngestPromise;
    assert.ok(pass, 'the scheduled callback initiated a warehouse pass');
    const result = await pass;
    await this.flush();
    return result;
  }
}

function schedulerFixture({ store = new Store(':memory:'), ...overrides } = {}) {
  const timers = new FakeTimers();
  const calls = [];
  const service = new ModelDeckService(store, {
    claudeProfilesDir: '/tmp/modeldeck-warehouse-claude-placeholder',
    codexProfilesDir: '/tmp/modeldeck-warehouse-codex-placeholder',
    grokSessionsDir: '/tmp/modeldeck-warehouse-grok-placeholder',
    ingestTranscriptArchive: async (options) => {
      calls.push({ name: 'transcriptArchive', options });
      return { warnings: 0 };
    },
    ingestCodexRollouts: async (options) => {
      calls.push({ name: 'codexRollouts', options });
      return { warnings: { malformedLines: 0 } };
    },
    ingestGrokSessions: async (options) => {
      calls.push({ name: 'grokSessions', options });
      return { warnings: { malformedLines: 0, schemaDriftFields: 0 } };
    },
    runDiagnostician: (options) => {
      calls.push({ name: 'diagnostician', options });
      return { detectors: 1, findings: 0 };
    },
    refitUsageEstimates: (receivedStore) => {
      calls.push({ name: 'usageEstimateRefit', store: receivedStore });
      return { pools: 1, fitted: 0, unavailable: 2 };
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides,
  });
  return { store, service, timers, calls };
}

async function awaitCurrentPass(service, timers) {
  const pass = service.warehouseIngestPromise;
  assert.ok(pass, 'an immediate warehouse pass started');
  const result = await pass;
  await timers.flush();
  return result;
}

test('TRIPWIRE: daemon lifecycle starts and stops the recurring warehouse scheduler', async () => {
  const store = new Store(':memory:');
  const calls = [];
  const service = {
    projectsRoot: '/tmp/modeldeck-warehouse-lifecycle-placeholder',
    startUsageSnapshotRetention() {},
    startUsageQueueConsumer() {},
    startWarehouseIngest: async () => { calls.push('startWarehouseIngest'); },
    stopUsageSnapshotRetention() {},
    stopUsageQueueConsumer() {},
    stopWarehouseIngest: async () => { calls.push('stopWarehouseIngest'); },
    startAutoRefresh() {},
    stopAutoRefresh() {},
  };
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: 0,
    mutationToken: 'warehouse-lifecycle-token-placeholder',
  });
  app.server.listen = (_port, _host, callback) => {
    callback();
    return app.server;
  };
  app.server.close = (callback) => callback();

  try {
    app.listen();
    await Promise.resolve();
    assert.deepEqual(calls, ['startWarehouseIngest']);
    await app.close();
    assert.deepEqual(calls, ['startWarehouseIngest', 'stopWarehouseIngest']);
  } finally {
    store.close();
  }
});

test('TRIPWIRE: settings API immediately reschedules warehouse ingest when analytics is toggled', async () => {
  const store = new Store(':memory:');
  const reschedules = [];
  const service = {
    projectsRoot: '/tmp/modeldeck-warehouse-settings-placeholder',
    applySharedScopeSettings: async () => {},
    rescheduleAutoRefresh() {},
    rescheduleUsageQueueConsumer: async () => {},
    rescheduleWarehouseIngest: async (settings) => { reschedules.push(settings); },
  };
  const port = 43211;
  const token = 'warehouse-settings-token-placeholder';
  const app = createApp({ store, service, host: '127.0.0.1', port, mutationToken: token });
  const request = Readable.from([Buffer.from(JSON.stringify({ usageAnalyticsEnabled: false }))]);
  Object.assign(request, {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'PUT',
    url: '/api/settings',
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-modeldeck-token': token,
      cookie: `modeldeck_session=${token}`,
    },
  });
  let status;
  let payload;
  const completed = new Promise((resolve) => {
    const response = {
      writeHead(value) { status = value; },
      end(value) { payload = JSON.parse(String(value)); resolve(); },
    };
    app.server.emit('request', request, response);
  });

  try {
    await completed;
    assert.equal(status, 200);
    assert.equal(payload.usageAnalyticsEnabled, false);
    assert.equal(reschedules.length, 1);
    assert.equal(reschedules[0].usageAnalyticsEnabled, false);
  } finally {
    store.close();
  }
});

test('TRIPWIRE: every warehouse pass ingests all three corpora, scans findings, and refits usage estimates', async () => {
  const data = schedulerFixture();
  try {
    const starting = data.service.startWarehouseIngest();
    await awaitCurrentPass(data.service, data.timers);
    await starting;

    assert.deepEqual(data.calls.map((call) => call.name), [
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
    ]);
    assert.equal(data.calls[0].options.store, data.store);
    assert.equal(data.calls[0].options.directory, '/tmp/modeldeck-warehouse-claude-placeholder');
    assert.equal(data.calls[1].options.store, data.store);
    assert.equal(data.calls[1].options.profilesRoot, '/tmp/modeldeck-warehouse-codex-placeholder');
    assert.equal(data.calls[2].options.store, data.store);
    assert.equal(data.calls[2].options.sessionsRoot, '/tmp/modeldeck-warehouse-grok-placeholder');
    assert.equal(data.calls[3].options.store, data.store);
    assert.equal(typeof data.calls[3].options.logger, 'function');
    assert.equal(data.calls[3].options.yieldToServeLoop, data.service.yieldToServeLoop);
    assert.equal(data.calls[4].store, data.store);
    assert.equal(data.timers.timers.size, 1);

    const status = data.service.warehouseIngestStatus();
    assert.equal(status.running, true);
    assert.equal(status.intervalSeconds, 900);
    assert.equal(typeof status.lastPass.startedAt, 'string');
    assert.equal(typeof status.lastPass.at, 'string');
    assert.deepEqual(Object.keys(status.lastPass.jobs), [
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
    ]);
    assert.deepEqual((await data.service.state()).warehouseIngest, status,
      'daemon state exposes the recurring-pass record used by go-live verification');

    await data.timers.runNext(data.service);
    assert.deepEqual(data.calls.map((call) => call.name), [
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
    ]);
    assert.equal(data.timers.timers.size, 1, 'the recurring pass re-arms one timer');
  } finally {
    await data.service.stopWarehouseIngest();
    data.store.close();
  }
});

test('TRIPWIRE: an unconfigured Grok root cannot escape an isolated service fixture', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let grokCalls = 0;
  const service = new ModelDeckService(store, {
    claudeProfilesDir: '/tmp/modeldeck-warehouse-isolated-claude-placeholder',
    codexProfilesDir: '/tmp/modeldeck-warehouse-isolated-codex-placeholder',
    ingestTranscriptArchive: async () => ({ warnings: 0 }),
    ingestCodexRollouts: async () => ({ warnings: {} }),
    ingestGrokSessions: async () => { grokCalls += 1; return { warnings: {} }; },
    runDiagnostician: async () => ({ detectors: 0, findings: 0 }),
    refitUsageEstimates: () => ({ pools: 0 }),
  });

  const outcomes = await service.runWarehouseIngestPass();

  assert.equal(grokCalls, 0, 'only an explicitly configured Grok root may be read');
  assert.equal(Object.hasOwn(outcomes, 'grokSessions'), false);
});

test('analytics kill switch disarms warehouse ingest and rejects a stale generation tick', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ usageAnalyticsEnabled: false });
  const data = schedulerFixture({ store });
  try {
    await data.service.startWarehouseIngest();
    assert.equal(data.calls.length, 0);
    assert.equal(data.timers.timers.size, 0);
    assert.equal(data.service.warehouseIngestStatus().running, false);

    const enabling = data.service.rescheduleWarehouseIngest(
      store.saveSettings({ usageAnalyticsEnabled: true }),
    );
    await awaitCurrentPass(data.service, data.timers);
    await enabling;
    assert.equal(data.calls.length, 5);
    assert.equal(data.timers.timers.size, 1);
    const staleTick = data.timers.timers.values().next().value.callback;

    await data.service.rescheduleWarehouseIngest(
      store.saveSettings({ usageAnalyticsEnabled: false }),
    );
    assert.equal(data.timers.timers.size, 0);
    staleTick();
    await data.timers.flush();
    assert.equal(data.calls.length, 5, 'a cleared timer from the old generation cannot run');
    assert.equal(data.timers.timers.size, 0);
  } finally {
    await data.service.stopWarehouseIngest();
    data.store.close();
  }
});

test('disabling warehouse ingest waits for an in-flight pass before completing', async () => {
  const store = new Store(':memory:');
  const timers = new FakeTimers();
  let releaseTranscript;
  const transcriptGate = new Promise((resolve) => { releaseTranscript = resolve; });
  const service = new ModelDeckService(store, {
    ingestTranscriptArchive: () => transcriptGate,
    ingestCodexRollouts: async () => ({ warnings: {} }),
    ingestGrokSessions: async () => ({ warnings: {} }),
    refitUsageEstimates: () => ({ pools: 1 }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  try {
    service.startWarehouseIngest();
    assert.ok(service.warehouseIngestPromise);
    let disabled = false;
    const disabling = service.rescheduleWarehouseIngest(
      store.saveSettings({ usageAnalyticsEnabled: false }),
    ).then(() => { disabled = true; });
    await timers.flush();
    assert.equal(disabled, false);
    assert.equal(timers.timers.size, 0);

    releaseTranscript({ warnings: 0 });
    await disabling;
    assert.equal(disabled, true);
    assert.equal(timers.timers.size, 0);
  } finally {
    releaseTranscript({ warnings: 0 });
    await service.stopWarehouseIngest();
    store.close();
  }
});

test('demo fixture daemon never schedules warehouse ingest', async () => {
  const data = schedulerFixture({ demoFixtures: true });
  try {
    await data.service.startWarehouseIngest();
    assert.equal(data.calls.length, 0);
    assert.equal(data.timers.timers.size, 0);
    assert.equal(data.service.warehouseIngestStatus().running, false);
  } finally {
    await data.service.stopWarehouseIngest();
    data.store.close();
  }
});

test('failed warehouse ingest job logs and the daemon reschedules all five paths', async () => {
  let transcriptAttempts = 0;
  const logs = [];
  const data = schedulerFixture({
    ingestTranscriptArchive: async (options) => {
      data.calls.push({ name: 'transcriptArchive', options });
      transcriptAttempts += 1;
      if (transcriptAttempts === 1) throw new Error('simulated transcript failure');
      return { warnings: 0 };
    },
    logWarehouseIngest: (message) => logs.push(message),
  });
  try {
    const starting = data.service.startWarehouseIngest();
    const first = await awaitCurrentPass(data.service, data.timers);
    await starting;

    assert.deepEqual(data.calls.map((call) => call.name), [
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
    ], 'one failed job does not skip the remaining paths');
    assert.equal(first.transcriptArchive.ok, false);
    assert.deepEqual(logs, [
      'warehouse ingest transcriptArchive failed: simulated transcript failure',
    ]);
    assert.equal(data.timers.timers.size, 1, 'failure still arms the next 15-minute tick');

    const second = await data.timers.runNext(data.service);
    assert.equal(second.transcriptArchive.ok, true);
    assert.deepEqual(data.calls.map((call) => call.name), [
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
      'transcriptArchive',
      'codexRollouts',
      'grokSessions',
      'diagnostician',
      'usageEstimateRefit',
    ]);
    assert.equal(data.timers.timers.size, 1, 'the successful retry keeps the loop recurring');
  } finally {
    await data.service.stopWarehouseIngest();
    data.store.close();
  }
});
