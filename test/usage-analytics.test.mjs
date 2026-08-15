import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import {
  ingestUsageArchive,
  parseUsagePull,
  parseUsageRecord,
} from '../src/usage-ingest.mjs';

function proxyRecord(overrides = {}) {
  return {
    timestamp: '2026-08-01T10:00:00-07:00',
    latency_ms: 120.5,
    ttft_ms: 40,
    source: 'user1@example.com',
    auth_index: 'placeholder-auth-index',
    access_token_sha256: 'access-token-hash-placeholder',
    client_ip: '192.0.2.1',
    x_forwarded_for: '192.0.2.2',
    user_agent: 'claude-cli/2.0 placeholder-raw-agent',
    tokens: {
      input_tokens: 999,
      output_tokens: 999,
      reasoning_tokens: 999,
      cached_tokens: 999,
      cache_read_tokens: 999,
      cache_creation_tokens: 999,
      total_tokens: 999,
    },
    failed: false,
    generate: true,
    fail: { status_code: 200, body: 'failure-body-placeholder' },
    response_headers: { Authorization: ['response-header-secret-placeholder'] },
    token_breakdown: {
      schema_version: 1,
      quality: 'exact',
      total_tokens: 116,
      input: {
        total_tokens: 95,
        uncached_tokens: 10,
        cache_read_tokens: 80,
        cache_write_tokens: 5,
      },
      output: {
        total_tokens: 20,
        non_reasoning_tokens: 15,
        reasoning_tokens: 5,
      },
      unclassified_tokens: 1,
    },
    provider: 'claude',
    executor_type: 'anthropic',
    model: 'claude-placeholder-model',
    alias: 'placeholder-alias',
    endpoint: '/v1/messages',
    auth_type: 'oauth',
    api_key: 'api-key-placeholder',
    request_id: 'request-placeholder-1',
    reasoning_effort: 'high',
    service_tier: 'default',
    ...overrides,
  };
}

function normalizedRecord({
  requestId,
  timestamp,
  source,
  provider = 'claude',
  model,
  reasoningEffort,
  failed = false,
  statusCode = 200,
  latencyMs,
  ttftMs,
  inputUncached,
  inputCacheRead,
  inputCacheWrite,
  outputTotal,
  outputReasoning,
  total,
}) {
  return parseUsageRecord({
    request_id: requestId,
    timestamp,
    source,
    provider,
    model,
    reasoning_effort: reasoningEffort,
    endpoint: '/v1/placeholder',
    user_agent_class: provider === 'claude' ? 'claude-code' : 'codex',
    failed,
    status_code: statusCode,
    latency_ms: latencyMs,
    ttft_ms: ttftMs,
    input_uncached: inputUncached,
    input_cache_read: inputCacheRead,
    input_cache_write: inputCacheWrite,
    output_total: outputTotal,
    output_reasoning: outputReasoning,
    total,
  });
}

test('proxy pull parser maps the archive token breakdown and drops every secret-shaped field', () => {
  const pull = parseUsagePull(JSON.stringify({
    pulled_at: '2026-08-01T17:01:00.000Z',
    usage: [proxyRecord()],
  }));

  assert.equal(pull.kind, 'usage');
  assert.deepEqual(pull.records, [{
    requestId: 'request-placeholder-1',
    machine: 'studio',
    observedAt: '2026-08-01T17:00:00.000Z',
    source: 'user1@example.com',
    provider: 'claude',
    model: 'claude-placeholder-model',
    alias: 'placeholder-alias',
    reasoningEffort: 'high',
    endpoint: '/v1/messages',
    userAgentClass: 'claude-code',
    failed: false,
    statusCode: 200,
    latencyMs: 120.5,
    ttftMs: 40,
    inputUncached: 10,
    inputCacheRead: 80,
    inputCacheWrite: 5,
    outputTotal: 20,
    outputReasoning: 5,
    total: 116,
  }]);

  const normalized = JSON.stringify(pull.records);
  for (const forbidden of [
    'api_key',
    'api-key-placeholder',
    'access_token_sha256',
    'access-token-hash-placeholder',
    'response_headers',
    'response-header-secret-placeholder',
    'failure-body-placeholder',
    'placeholder-raw-agent',
  ]) {
    assert.equal(normalized.includes(forbidden), false, `${forbidden} must be dropped`);
  }

  const suppliedRawClass = parseUsageRecord(proxyRecord({
    user_agent: null,
    user_agent_class: 'Mozilla/5.0 raw-client-detail-placeholder',
  }));
  assert.equal(suppliedRawClass.userAgentClass, 'other');
  assert.equal(JSON.stringify(suppliedRawClass).includes('raw-client-detail-placeholder'), false);
  assert.throws(() => parseUsageRecord(proxyRecord({ provider: 'unsupported-placeholder' })), /provider must be claude or codex/);
});

/*
 * TRIPWIRE usage-pull-bare-array (0.4.6 go-live field find): the LIVE
 * CLIProxyAPI management endpoint answers with a bare JSON array — the
 * {usage: [...]} envelope exists only in archive files. The daemon's first
 * production pull counted malformedBodies on every tick and consumed nothing.
 * Both shapes must parse to the same batch, and an empty array is 'empty',
 * never an error.
 */
test('TRIPWIRE usage-pull-bare-array — the live endpoint bare-array shape parses like the envelope', () => {
  const enveloped = parseUsagePull(JSON.stringify({ usage: [proxyRecord()] }));
  const bare = parseUsagePull(JSON.stringify([proxyRecord()]));
  assert.equal(bare.kind, 'usage');
  assert.deepEqual(bare.records, enveloped.records);
  assert.deepEqual(bare.malformedRecords, []);

  assert.deepEqual(parseUsagePull('[]'), { kind: 'empty', records: [] });
});

test('archive ingest counts skipped envelopes, resolves Claude accounts, and is replay-idempotent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-ingest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Placeholder One',
    identity: 'user1@example.com',
    profileRef: 'claude-placeholder-one',
  });
  const claude = proxyRecord({ request_id: 'request-claude', source: 'USER1@example.com' });
  const codex = proxyRecord({
    request_id: 'request-codex',
    timestamp: '2026-08-01T18:00:00.000Z',
    source: 'codex-source-placeholder-hash',
    provider: 'codex',
    model: 'gpt-placeholder-model',
    alias: null,
    user_agent: 'codex_cli_rs/1.0',
    reasoning_effort: 'medium',
  });
  fs.writeFileSync(path.join(root, 'pull-001.json'), JSON.stringify({ usage: [claude, codex] }));
  fs.writeFileSync(path.join(root, 'pull-002.json'), JSON.stringify({ usage: [claude] }));
  fs.writeFileSync(path.join(root, 'pull-003.json'), JSON.stringify({ usage: null }));
  fs.writeFileSync(path.join(root, 'pull-004.json'), JSON.stringify({ instances: [] }));
  fs.writeFileSync(path.join(root, 'ignored.json'), JSON.stringify({ usage: [proxyRecord({ request_id: 'ignored' })] }));
  const archiveBytes = Object.fromEntries(fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name))]));

  const warnings = [];
  const first = ingestUsageArchive({ store, directory: root, warn: (message) => warnings.push(message) });
  assert.deepEqual(first, {
    files: 4,
    usageFiles: 2,
    records: 3,
    inserted: 2,
    duplicates: 1,
    resolved: 1,
    unresolved: 1,
    warnings: { emptyUsageFiles: 1, instancesFiles: 1, malformedFiles: 0, malformedRecords: 0 },
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /pull-003\.json: usage is empty/);
  assert.match(warnings[1], /pull-004\.json: instances payload/);

  const rows = store.db.prepare('SELECT * FROM request_usage ORDER BY request_id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].request_id, 'request-claude');
  assert.equal(rows[0].account_id, account.id);
  assert.equal(rows[0].source_raw, null, 'resolved email is not duplicated');
  assert.equal(rows[1].request_id, 'request-codex');
  assert.equal(rows[1].account_id, null);
  assert.equal(rows[1].source_raw, 'codex-source-placeholder-hash');

  const schemaColumns = store.db.prepare('PRAGMA table_info(request_usage)').all().map((column) => column.name);
  assert.equal(schemaColumns.includes('source_raw'), true);
  assert.equal(schemaColumns.includes('source_email_hash'), false);
  for (const secretColumn of ['api_key', 'access_token_sha256', 'response_headers']) {
    assert.equal(schemaColumns.includes(secretColumn), false);
  }
  assert.throws(
    () => store.db.prepare('UPDATE request_usage SET account_id = ? WHERE request_id = ?').run(account.id, 'request-codex'),
    /CHECK constraint failed/,
    'SQLite itself refuses a raw source beside a resolved account',
  );
  const persisted = JSON.stringify(rows);
  for (const secretValue of ['api-key-placeholder', 'access-token-hash-placeholder', 'response-header-secret-placeholder']) {
    assert.equal(persisted.includes(secretValue), false);
  }

  const second = ingestUsageArchive({ store, directory: root });
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM request_usage').get().count, 2);
  for (const [name, bytes] of Object.entries(archiveBytes)) {
    assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, `${name} remains byte-exact`);
  }

  store.migrate();
  store.migrate();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM request_usage').get().count, 2);
  const indexes = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='request_usage'").all().map((row) => row.name));
  for (const name of [
    'request_usage_observed',
    'request_usage_account_observed',
    'request_usage_model',
    'request_usage_reasoning_effort',
  ]) assert.equal(indexes.has(name), true);
});

test('archive ingest skips malformed files and records while retaining valid files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-malformed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());

  fs.writeFileSync(path.join(root, 'pull-001.json'), JSON.stringify({
    usage: [proxyRecord({ request_id: 'valid-before-torn' })],
  }));
  fs.writeFileSync(path.join(root, 'pull-002.json'), '{"usage": [');
  fs.writeFileSync(path.join(root, 'pull-003.json'), JSON.stringify({
    usage: [{ provider: 'claude' }],
  }));
  fs.writeFileSync(path.join(root, 'pull-004.json'), JSON.stringify({
    usage: [proxyRecord({ request_id: 'valid-after-torn', timestamp: '2026-08-01T18:00:00.000Z' })],
  }));

  const warnings = [];
  const summary = ingestUsageArchive({ store, directory: root, warn: (message) => warnings.push(message) });
  assert.deepEqual(summary, {
    files: 4,
    usageFiles: 3,
    records: 2,
    inserted: 2,
    duplicates: 0,
    resolved: 0,
    unresolved: 2,
    warnings: { emptyUsageFiles: 0, instancesFiles: 0, malformedFiles: 1, malformedRecords: 1 },
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /pull-002\.json: malformed file/);
  assert.match(warnings[1], /pull-003\.json record 0/);
  assert.deepEqual(
    store.db.prepare('SELECT request_id FROM request_usage ORDER BY observed_at').all().map((row) => row.request_id),
    ['valid-before-torn', 'valid-after-torn'],
  );
});

test('unresolved Claude usage re-resolves after its account is added', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ingestRequestUsage([normalizedRecord({
    requestId: 'late-account-request',
    timestamp: '2026-08-01T10:00:00.000Z',
    source: 'late-account@example.com',
    model: 'late-account-model',
  })]);
  const unresolved = store.db.prepare('SELECT account_id, source_raw FROM request_usage WHERE request_id = ?').get('late-account-request');
  assert.equal(unresolved.account_id, null);
  assert.equal(unresolved.source_raw, 'late-account@example.com');

  const account = store.saveAccount({
    provider: 'claude', label: 'Late Account', identity: 'LATE-ACCOUNT@example.com', profileRef: 'late-account-profile',
  });
  assert.equal(store.resolveRequestUsageAccounts(), 1);
  const resolved = store.db.prepare('SELECT account_id, source_raw FROM request_usage WHERE request_id = ?').get('late-account-request');
  assert.equal(resolved.account_id, account.id);
  assert.equal(resolved.source_raw, null);
});

test('ambiguous Claude account identities leave request usage unresolved', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveAccount({
    provider: 'claude', label: 'Ambiguous One', identity: 'ambiguous@example.com', profileRef: 'ambiguous-one',
  });
  store.saveAccount({
    provider: 'claude', label: 'Ambiguous Two', identity: 'AMBIGUOUS@example.com', profileRef: 'ambiguous-two',
  });
  store.ingestRequestUsage([normalizedRecord({
    requestId: 'ambiguous-request',
    timestamp: '2026-08-01T10:00:00.000Z',
    source: 'ambiguous@example.com',
    model: 'ambiguous-model',
  })]);
  const unresolved = store.db.prepare('SELECT account_id, source_raw FROM request_usage WHERE request_id = ?').get('ambiguous-request');
  assert.equal(unresolved.account_id, null);
  assert.equal(unresolved.source_raw, 'ambiguous@example.com');
  assert.equal(store.resolveRequestUsageAccounts(), 0);
});

function summaryFixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const accountOne = store.saveAccount({
    provider: 'claude', label: 'Account One', identity: 'user1@example.com', profileRef: 'summary-claude-one',
  });
  const accountTwo = store.saveAccount({
    provider: 'claude', label: 'Account Two', identity: 'user2@example.com', profileRef: 'summary-claude-two',
  });
  store.ingestRequestUsage([
    normalizedRecord({
      requestId: 'summary-1', timestamp: '2026-08-01T10:00:00.000Z', source: 'user1@example.com',
      model: 'model-a', reasoningEffort: 'high', latencyMs: 100, ttftMs: 10,
      inputUncached: 10, inputCacheRead: 20, inputCacheWrite: 1, outputTotal: 5, outputReasoning: 2, total: 36,
    }),
    normalizedRecord({
      requestId: 'summary-2', timestamp: '2026-08-01T20:00:00.000Z', source: 'codex-source-placeholder-hash',
      provider: 'codex', model: 'model-b', reasoningEffort: 'low', failed: true, statusCode: 429,
      latencyMs: 200, ttftMs: 20, inputUncached: 3, inputCacheRead: 7, inputCacheWrite: 0,
      outputTotal: 4, outputReasoning: 1, total: 14,
    }),
    normalizedRecord({
      requestId: 'summary-3', timestamp: '2026-08-02T00:00:00.000Z', source: 'user2@example.com',
      model: 'model-a', reasoningEffort: 'high', latencyMs: 300, ttftMs: 30,
      inputUncached: 6, inputCacheRead: 4, inputCacheWrite: 2, outputTotal: 8, outputReasoning: 3, total: 20,
    }),
  ]);
  return { store, accountOne, accountTwo };
}

test('usage summary reader calculates totals, all grouping dimensions, and half-open time bounds', (t) => {
  const { store, accountOne, accountTwo } = summaryFixture(t);
  const totals = {
    requests: 3,
    failed: 1,
    latencyMs: 600,
    ttftMs: 60,
    inputUncached: 19,
    inputCacheRead: 31,
    inputCacheWrite: 3,
    outputTotal: 17,
    outputReasoning: 6,
    total: 70,
  };
  assert.deepEqual(store.usageSummary(), { totals, groupBy: null, groups: [] });

  const byModel = store.usageSummary({ groupBy: 'model' });
  assert.equal(byModel.groups.length, 2);
  assert.deepEqual(byModel.groups.map(({ model, requests, total }) => ({ model, requests, total })), [
    { model: 'model-a', requests: 2, total: 56 },
    { model: 'model-b', requests: 1, total: 14 },
  ]);

  const byEffort = store.usageSummary({ groupBy: 'reasoning_effort' });
  assert.deepEqual(byEffort.groups.map(({ reasoningEffort, requests, outputReasoning }) => ({ reasoningEffort, requests, outputReasoning })), [
    { reasoningEffort: 'high', requests: 2, outputReasoning: 5 },
    { reasoningEffort: 'low', requests: 1, outputReasoning: 1 },
  ]);

  const byDay = store.usageSummary({ groupBy: 'day' });
  assert.deepEqual(byDay.groups.map(({ day, requests, total }) => ({ day, requests, total })), [
    { day: '2026-08-01', requests: 2, total: 50 },
    { day: '2026-08-02', requests: 1, total: 20 },
  ]);

  const byAccount = store.usageSummary({ groupBy: 'account' });
  const unresolvedLabel = `unresolved-${crypto.createHash('sha256').update('codex-source-placeholder-hash').digest('hex').slice(0, 8)}`;
  assert.deepEqual(byAccount.groups.map(({ accountId, accountLabel, source, provider, requests }) => ({ accountId, accountLabel, source, provider, requests })), [
    { accountId: accountOne.id, accountLabel: 'Account One', source: null, provider: 'claude', requests: 1 },
    { accountId: accountTwo.id, accountLabel: 'Account Two', source: null, provider: 'claude', requests: 1 },
    { accountId: null, accountLabel: null, source: unresolvedLabel, provider: 'codex', requests: 1 },
  ]);
  assert.equal(JSON.stringify(byAccount.groups).includes('@'), false);

  const bounded = store.usageSummary({
    since: '2026-08-01T00:00:00.000Z',
    until: '2026-08-02T00:00:00.000Z',
    groupBy: 'day',
  });
  assert.equal(bounded.totals.requests, 2);
  assert.equal(bounded.totals.total, 50);
  assert.deepEqual(bounded.groups.map(({ day, requests }) => ({ day, requests })), [
    { day: '2026-08-01', requests: 2 },
  ]);

  assert.throws(() => store.usageSummary({ groupBy: 'provider' }), /groupBy must be/);
  assert.throws(() => store.usageSummary({ since: '2026-08-01' }), /canonical ISO timestamp/);
  assert.throws(() => store.usageSummary({
    since: '2026-08-02T00:00:00.000Z', until: '2026-08-01T00:00:00.000Z',
  }), /since must be earlier/);
});

// Issue #344: local-time bucket keys are derived here the same way the browser
// derives them (JS local getters), so the assertions hold in any host timezone.
function localHourKey(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

function sumOf(groups, field) {
  return groups.reduce((sum, group) => sum + group[field], 0);
}

test('burn-timeline groupings bucket in local time and reconcile with the totals beside them', (t) => {
  const { store } = summaryFixture(t);
  const stamps = ['2026-08-01T10:00:00.000Z', '2026-08-01T20:00:00.000Z', '2026-08-02T00:00:00.000Z'];

  const byHour = store.usageSummary({ groupBy: 'hour' });
  assert.deepEqual(
    byHour.groups.map((group) => group.hour),
    [...new Set(stamps.map(localHourKey))].sort(),
  );
  assert.equal(sumOf(byHour.groups, 'total'), byHour.totals.total);
  assert.equal(sumOf(byHour.groups, 'requests'), byHour.totals.requests);

  const byLocalDay = store.usageSummary({ groupBy: 'local_day' });
  assert.deepEqual(
    byLocalDay.groups.map((group) => group.localDay),
    [...new Set(stamps.map((iso) => localHourKey(iso).slice(0, 10)))].sort(),
  );
  assert.equal(sumOf(byLocalDay.groups, 'total'), byLocalDay.totals.total);

  // The 24-bucket fold: hours are numbers, and every request lands in exactly
  // one bucket regardless of which calendar day it came from.
  const byHourOfDay = store.usageSummary({ groupBy: 'hour_of_day' });
  assert.deepEqual(
    byHourOfDay.groups.map((group) => group.hourOfDay),
    [...new Set(stamps.map((iso) => new Date(iso).getHours()))].sort((a, b) => a - b),
  );
  for (const group of byHourOfDay.groups) assert.equal(Number.isInteger(group.hourOfDay), true);
  assert.equal(sumOf(byHourOfDay.groups, 'requests'), 3);
  assert.equal(sumOf(byHourOfDay.groups, 'total'), byHourOfDay.totals.total);

  // The pre-existing UTC day grouping is unchanged by the local-time additions.
  assert.deepEqual(store.usageSummary({ groupBy: 'day' }).groups.map((group) => group.day), [
    '2026-08-01', '2026-08-02',
  ]);
});

test('burn-timeline filters narrow totals and groups together, and are validated', (t) => {
  const { store, accountOne } = summaryFixture(t);

  const filtered = store.usageSummary({ groupBy: 'hour', accountId: accountOne.id });
  assert.equal(filtered.totals.requests, 1);
  assert.equal(filtered.totals.total, 36);
  assert.equal(sumOf(filtered.groups, 'total'), filtered.totals.total, 'chart aggregate reconciles with filtered totals');

  const byModel = store.usageSummary({ groupBy: 'hour_of_day', model: 'model-a' });
  assert.equal(byModel.totals.requests, 2);
  assert.equal(sumOf(byModel.groups, 'requests'), 2);

  const byProvider = store.usageSummary({ groupBy: 'local_day', provider: 'codex' });
  assert.equal(byProvider.totals.requests, 1);
  assert.equal(byProvider.totals.total, 14);
  assert.equal(sumOf(byProvider.groups, 'total'), 14);

  // Filters compose, and an impossible combination is empty rather than wrong.
  const composed = store.usageSummary({ groupBy: 'hour', provider: 'claude', model: 'model-b' });
  assert.equal(composed.totals.requests, 0);
  assert.deepEqual(composed.groups, []);

  assert.throws(() => store.usageSummary({ provider: 'bedrock' }), /provider must be claude or codex/);
  assert.throws(() => store.usageSummary({ accountId: '' }), /accountId must be a non-empty string/);
  assert.throws(() => store.usageSummary({ model: '   ' }), /model must be a non-empty string/);
  assert.throws(() => store.usageSummary({ groupBy: 'hourofday' }), /groupBy must be/);
});

test('account usage grouping never exposes an unresolved raw email', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ingestRequestUsage([normalizedRecord({
    requestId: 'private-unresolved-request',
    timestamp: '2026-08-01T10:00:00.000Z',
    source: 'private-unresolved@example.com',
    model: 'private-model',
  })]);
  const summary = store.usageSummary({ groupBy: 'account' });
  const label = `unresolved-${crypto.createHash('sha256').update('private-unresolved@example.com').digest('hex').slice(0, 8)}`;
  assert.deepEqual(summary.groups.map(({ accountId, accountLabel, source }) => ({ accountId, accountLabel, source })), [
    { accountId: null, accountLabel: null, source: label },
  ]);
  assert.equal(JSON.stringify(summary.groups).includes('@'), false);
});

test('usage summary totals and groups share one snapshot during a concurrent ingest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-summary-snapshot-'));
  const dbPath = path.join(root, 'modeldeck.sqlite');
  const reader = new Store(dbPath);
  const writer = new Store(dbPath);
  t.after(() => {
    writer.close();
    reader.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  reader.ingestRequestUsage([normalizedRecord({
    requestId: 'snapshot-1', timestamp: '2026-08-01T10:00:00.000Z', source: 'snapshot-source-one',
    provider: 'codex', model: 'model-a', reasoningEffort: 'high', latencyMs: 10, ttftMs: 1,
    inputUncached: 1, inputCacheRead: 2, inputCacheWrite: 0, outputTotal: 1, outputReasoning: 0, total: 4,
  })]);
  const secondRecord = normalizedRecord({
    requestId: 'snapshot-2', timestamp: '2026-08-01T11:00:00.000Z', source: 'snapshot-source-two',
    provider: 'codex', model: 'model-b', reasoningEffort: 'low', latencyMs: 20, ttftMs: 2,
    inputUncached: 2, inputCacheRead: 3, inputCacheWrite: 0, outputTotal: 2, outputReasoning: 1, total: 7,
  });

  const prepare = reader.db.prepare.bind(reader.db);
  let insertedBetweenReads = false;
  reader.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!insertedBetweenReads && sql.includes('FROM request_usage ru') && typeof statement.get === 'function') {
      const get = statement.get.bind(statement);
      statement.get = (...params) => {
        const row = get(...params);
        writer.ingestRequestUsage([secondRecord]);
        insertedBetweenReads = true;
        return row;
      };
    }
    return statement;
  };

  const snapshot = reader.usageSummary({ groupBy: 'model' });
  reader.db.prepare = prepare;
  assert.equal(insertedBetweenReads, true);
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.groups.reduce((sum, group) => sum + group.requests, 0), 1);
  assert.equal(reader.usageSummary({ groupBy: 'model' }).totals.requests, 2, 'the next snapshot sees the committed row');
});

const ROUTE_PORT = 43337;

async function routeRequest(app, route, { host = `127.0.0.1:${ROUTE_PORT}` } = {}) {
  const req = Readable.from([]);
  Object.assign(req, { socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: route, headers: { host } });
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(value, nextHeaders) { status = value; headers = nextHeaders; },
    end(value) { payload = value == null || value === '' ? null : JSON.parse(String(value)); },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, headers, body: payload };
}

test('GET /api/usage/summary uses loopback GET auth and returns reader validation errors as JSON', async (t) => {
  const { store } = summaryFixture(t);
  store.saveSettings({ usageAnalyticsEnabled: true });
  const service = {
    projectsRoot: '/tmp/modeldeck-placeholder-projects',
    startAutoRefresh() {},
    stopAutoRefresh() {},
  };
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: ROUTE_PORT,
    mutationToken: 'usage-route-placeholder-token',
  });

  const result = await routeRequest(
    app,
    '/api/usage/summary?since=2026-08-01T00%3A00%3A00.000Z&until=2026-08-02T00%3A00%3A00.000Z&groupBy=model',
  );
  assert.equal(result.status, 200, 'pure GET requires no mutation token');
  assert.match(result.headers['Content-Type'], /^application\/json\b/);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.totals.requests, 2);
  assert.deepEqual(result.body.groups.map(({ model, requests }) => ({ model, requests })), [
    { model: 'model-a', requests: 1 },
    { model: 'model-b', requests: 1 },
  ]);

  store.ingestRequestUsage([normalizedRecord({
    requestId: 'route-private-unresolved',
    timestamp: '2026-08-03T00:00:00.000Z',
    source: 'route-private@example.com',
    model: 'route-private-model',
  })]);
  const byAccount = await routeRequest(app, '/api/usage/summary?groupBy=account');
  assert.equal(byAccount.status, 200);
  assert.equal(JSON.stringify(byAccount.body.groups).includes('@'), false);

  const invalid = await routeRequest(app, '/api/usage/summary?groupBy=provider');
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, {
    error: 'usage summary groupBy must be account, model, model_effort, reasoning_effort, day, local_day, hour, or hour_of_day',
  });

  // Issue #344: the burn-timeline params reach the reader and validate there.
  const timeline = await routeRequest(app, '/api/usage/summary?groupBy=hour_of_day&provider=codex');
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.groupBy, 'hour_of_day');
  assert.equal(timeline.body.totals.requests, 1);
  assert.equal(
    timeline.body.groups.reduce((sum, group) => sum + group.total, 0),
    timeline.body.totals.total,
  );

  const badProvider = await routeRequest(app, '/api/usage/summary?provider=bedrock');
  assert.equal(badProvider.status, 400);
  assert.deepEqual(badProvider.body, { error: 'usage summary provider must be claude or codex' });

  const badAccount = await routeRequest(app, '/api/usage/summary?accountId=');
  assert.equal(badAccount.status, 400);
  assert.deepEqual(badAccount.body, { error: 'usage summary accountId must be a non-empty string' });

  const hostile = await routeRequest(app, '/api/usage/summary', { host: 'attacker.example' });
  assert.equal(hostile.status, 403);
  assert.deepEqual(hostile.body, { error: 'unexpected host header' });
});
