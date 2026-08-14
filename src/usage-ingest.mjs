import fs from 'node:fs';
import path from 'node:path';

function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value, label, { integer = false, defaultValue = null } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return number;
}

function boolean(value, label, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new Error(`${label} must be a boolean`);
}

function observedTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error('usage record timestamp must be an ISO timestamp');
  return new Date(timestamp).toISOString();
}

export function classifyUserAgent(value) {
  const userAgent = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!userAgent) return 'unknown';
  if (userAgent.includes('codex')) return 'codex';
  if (userAgent.includes('claude')) return 'claude-code';
  if (userAgent.includes('curl')) return 'curl';
  if (userAgent.includes('python')) return 'python';
  if (userAgent.includes('node')) return 'node';
  return 'other';
}

const USER_AGENT_CLASSES = new Set(['claude-code', 'codex', 'curl', 'python', 'node', 'other', 'unknown']);

function userAgentClass(record) {
  const supplied = optionalText(firstDefined(record.user_agent_class, record.userAgentClass))?.toLowerCase();
  if (supplied) return USER_AGENT_CLASSES.has(supplied) ? supplied : 'other';
  return classifyUserAgent(record.user_agent);
}

/// Convert one proxy archive record into the warehouse's explicit allowlist.
/// Unknown fields are intentionally discarded; in particular api_key,
/// access_token_sha256, response_headers, raw user-agent/IP data, and failure
/// bodies can never reach this returned object or SQLite.
export function parseUsageRecord(input, { machine = 'studio' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('usage record must be an object');
  const record = input;
  const breakdown = object(record.token_breakdown);
  const breakdownInput = object(breakdown.input);
  const breakdownOutput = object(breakdown.output);
  const legacyTokens = object(record.tokens);
  const failure = object(record.fail);

  const statusCode = nonNegativeNumber(
    firstDefined(record.status_code, record.statusCode, failure.status_code, failure.statusCode),
    'usage record status_code',
    { integer: true },
  );
  const inputUncached = nonNegativeNumber(
    firstDefined(record.input_uncached, record.inputUncached, breakdownInput.uncached_tokens, legacyTokens.input_tokens),
    'usage record input_uncached',
    { integer: true, defaultValue: 0 },
  );
  const inputCacheRead = nonNegativeNumber(
    firstDefined(record.input_cache_read, record.inputCacheRead, breakdownInput.cache_read_tokens, legacyTokens.cache_read_tokens, legacyTokens.cached_tokens),
    'usage record input_cache_read',
    { integer: true, defaultValue: 0 },
  );
  const inputCacheWrite = nonNegativeNumber(
    firstDefined(record.input_cache_write, record.inputCacheWrite, breakdownInput.cache_write_tokens, legacyTokens.cache_creation_tokens),
    'usage record input_cache_write',
    { integer: true, defaultValue: 0 },
  );
  const outputTotal = nonNegativeNumber(
    firstDefined(record.output_total, record.outputTotal, breakdownOutput.total_tokens, legacyTokens.output_tokens),
    'usage record output_total',
    { integer: true, defaultValue: 0 },
  );
  const outputReasoning = nonNegativeNumber(
    firstDefined(record.output_reasoning, record.outputReasoning, breakdownOutput.reasoning_tokens, legacyTokens.reasoning_tokens),
    'usage record output_reasoning',
    { integer: true, defaultValue: 0 },
  );
  const total = nonNegativeNumber(
    firstDefined(record.total, breakdown.total_tokens, legacyTokens.total_tokens),
    'usage record total',
    { integer: true, defaultValue: inputUncached + inputCacheRead + inputCacheWrite + outputTotal },
  );
  const failed = boolean(record.failed, 'usage record failed', statusCode != null && statusCode >= 400);
  const provider = requiredText(record.provider, 'usage record provider').toLowerCase();
  if (!['claude', 'codex'].includes(provider)) throw new Error('usage record provider must be claude or codex');

  return {
    requestId: requiredText(firstDefined(record.request_id, record.requestId), 'usage record request_id'),
    machine: requiredText(machine, 'usage record machine'),
    observedAt: observedTimestamp(firstDefined(record.timestamp, record.observed_at, record.observedAt)),
    source: requiredText(firstDefined(record.source, record.source_email_hash, record.sourceEmailHash), 'usage record source'),
    provider,
    model: requiredText(record.model, 'usage record model'),
    alias: optionalText(record.alias),
    reasoningEffort: optionalText(firstDefined(record.reasoning_effort, record.reasoningEffort)),
    endpoint: optionalText(record.endpoint),
    userAgentClass: userAgentClass(record),
    failed,
    statusCode,
    latencyMs: nonNegativeNumber(firstDefined(record.latency_ms, record.latencyMs), 'usage record latency_ms'),
    ttftMs: nonNegativeNumber(firstDefined(record.ttft_ms, record.ttftMs), 'usage record ttft_ms'),
    inputUncached,
    inputCacheRead,
    inputCacheWrite,
    outputTotal,
    outputReasoning,
    total,
  };
}

export function parseUsagePull(input, options = {}) {
  let document = input;
  if (Buffer.isBuffer(document)) document = document.toString('utf8');
  if (typeof document === 'string') {
    try { document = JSON.parse(document); }
    catch { throw new Error('usage pull is not valid JSON'); }
  }
  // The live CLIProxyAPI management endpoint answers with a BARE ARRAY of
  // records; the {usage: [...]} envelope exists only in archive files. Both
  // are one queue batch (0.4.6 go-live field find — the daemon's first real
  // pull counted malformedBodies on every tick and consumed nothing).
  if (Array.isArray(document)) document = { usage: document };
  if (!document || typeof document !== 'object') {
    throw new Error('usage pull must be a JSON object or array');
  }
  if (!Object.hasOwn(document, 'usage') && Object.hasOwn(document, 'instances')) {
    return { kind: 'instances', records: [] };
  }
  if (!Object.hasOwn(document, 'usage')) throw new Error('usage pull is missing usage');
  if (document.usage == null) return { kind: 'empty', records: [] };
  if (!Array.isArray(document.usage)) throw new Error('usage pull usage must be an array or null');
  if (document.usage.length === 0) return { kind: 'empty', records: [] };
  const records = [];
  const malformedRecords = [];
  document.usage.forEach((record, index) => {
    try { records.push(parseUsageRecord(record, options)); }
    catch (error) { malformedRecords.push({ index, message: error.message }); }
  });
  return { kind: 'usage', records, malformedRecords };
}

/// Read pull-*.json files without writing, renaming, or deleting the archive.
/// Valid records are collected before the Store transaction begins; malformed
/// files and records are counted and skipped without blocking the rest.
export function ingestUsageArchive({ store, directory, machine = 'studio', warn = () => {} } = {}) {
  if (!store?.ingestRequestUsage) throw new Error('usage archive ingest requires a Store');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('usage archive directory is required');
  const resolvedDirectory = path.resolve(directory);
  if (!fs.existsSync(resolvedDirectory)) throw new Error(`usage archive directory does not exist: ${resolvedDirectory}`);
  if (!fs.statSync(resolvedDirectory).isDirectory()) throw new Error(`usage archive path must be a directory: ${resolvedDirectory}`);

  const files = fs.readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^pull-.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const records = [];
  const summary = {
    files: files.length,
    usageFiles: 0,
    records: 0,
    inserted: 0,
    duplicates: 0,
    resolved: 0,
    unresolved: 0,
    warnings: { emptyUsageFiles: 0, instancesFiles: 0, malformedFiles: 0, malformedRecords: 0 },
  };

  for (const name of files) {
    let pull;
    try {
      pull = parseUsagePull(fs.readFileSync(path.join(resolvedDirectory, name), 'utf8'), { machine });
    } catch (error) {
      summary.warnings.malformedFiles += 1;
      warn(`usage-ingest: skipped ${name}: malformed file: ${error.message}`);
      continue;
    }
    if (pull.kind === 'empty') {
      summary.warnings.emptyUsageFiles += 1;
      warn(`usage-ingest: skipped ${name}: usage is empty`);
      continue;
    }
    if (pull.kind === 'instances') {
      summary.warnings.instancesFiles += 1;
      warn(`usage-ingest: skipped ${name}: instances payload is not request usage`);
      continue;
    }
    summary.usageFiles += 1;
    for (const malformed of pull.malformedRecords) {
      summary.warnings.malformedRecords += 1;
      warn(`usage-ingest: skipped ${name} record ${malformed.index}: ${malformed.message}`);
    }
    summary.records += pull.records.length;
    records.push(...pull.records);
  }

  Object.assign(summary, store.ingestRequestUsage(records));
  return summary;
}
