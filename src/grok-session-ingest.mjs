import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const GROK_UPDATES_PARSER = 'grok-updates';
export const GROK_UPDATES_PARSER_VERSION = 1;

const RECORD_FIELDS = new Set([
  'timestamp', 'createdAt', 'sessionId', 'type', 'update', 'turn_completed',
]);
const TURN_FIELDS = new Set([
  'type', 'turnId', 'timestamp', 'completedAt', 'cwd', 'usage',
]);
const USAGE_FIELDS = new Set([
  'inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens',
  'cacheCreationTokens', 'reasoningTokens', 'modelCalls', 'apiDurationMs',
  'costUsdTicks', 'modelUsage', 'numTurns',
]);

function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function usageNumber(source, key, fieldPath, invalidFields, { integer = true } = {}) {
  if (!Object.hasOwn(source, key)) return null;
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (!integer || Number.isSafeInteger(value))) return value;
  invalidFields.add(fieldPath);
  return null;
}

function reportedTotal(source, fieldPath, inputTokens, outputTokens, invalidFields) {
  const explicit = usageNumber(source, 'totalTokens', fieldPath, invalidFields);
  if (explicit != null) return explicit;
  const derived = inputTokens + outputTokens;
  if (Number.isSafeInteger(derived)) return derived;
  invalidFields.add(fieldPath);
  return 0;
}

function collectUnknown(source, allowed, prefix, unknownFields) {
  if (!object(source)) return;
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) unknownFields.add(prefix ? `${prefix}.${key}` : key);
  }
}

function completedUpdate(record) {
  if (object(record.turn_completed)) {
    return {
      turn: record.turn_completed,
      prefix: 'turn_completed',
      layers: [[record, RECORD_FIELDS, ''], [record.turn_completed, TURN_FIELDS, 'turn_completed']],
    };
  }
  const update = object(record.update);
  if (object(update?.turn_completed)) {
    return {
      turn: update.turn_completed,
      prefix: 'update.turn_completed',
      layers: [
        [record, RECORD_FIELDS, ''],
        [update, new Set(['turn_completed', 'type', 'timestamp']), 'update'],
        [update.turn_completed, TURN_FIELDS, 'update.turn_completed'],
      ],
    };
  }
  if (record.type === 'turn_completed') {
    return { turn: record, prefix: 'turn_completed', layers: [[record, TURN_FIELDS, 'turn_completed']] };
  }
  if (update?.type === 'turn_completed') {
    return {
      turn: update,
      prefix: 'update.turn_completed',
      layers: [[record, RECORD_FIELDS, ''], [update, TURN_FIELDS, 'update.turn_completed']],
    };
  }
  return null;
}

function modelUsageRows(value, prefix, unknownFields, invalidFields) {
  if (value == null) return [];
  const models = object(value);
  if (!models) {
    invalidFields.add(prefix);
    return [];
  }
  return Object.entries(models).flatMap(([model, raw]) => {
    if (!model.trim()) {
      invalidFields.add(prefix);
      return [];
    }
    const source = object(raw);
    const modelPath = `${prefix}.${model}`;
    if (!source) invalidFields.add(modelPath);
    const usage = source || {};
    collectUnknown(usage, USAGE_FIELDS, modelPath, unknownFields);
    const inputTokens = usageNumber(usage, 'inputTokens', `${modelPath}.inputTokens`, invalidFields) ?? 0;
    const outputTokens = usageNumber(usage, 'outputTokens', `${modelPath}.outputTokens`, invalidFields) ?? 0;
    return [{
      model,
      inputTokens,
      outputTokens,
      totalTokens: reportedTotal(usage, `${modelPath}.totalTokens`, inputTokens, outputTokens, invalidFields),
      cachedReadTokens: usageNumber(usage, 'cachedReadTokens', `${modelPath}.cachedReadTokens`, invalidFields) ?? 0,
      cacheCreationTokens: usageNumber(usage, 'cacheCreationTokens', `${modelPath}.cacheCreationTokens`, invalidFields) ?? 0,
      reasoningTokens: usageNumber(usage, 'reasoningTokens', `${modelPath}.reasoningTokens`, invalidFields) ?? 0,
      costUsdTicks: usageNumber(usage, 'costUsdTicks', `${modelPath}.costUsdTicks`, invalidFields) ?? 0,
      sourceJson: JSON.stringify(raw),
    }];
  });
}

function parseCompletedTurn(record, { file, line, turnIndex }) {
  const matched = completedUpdate(record);
  if (!matched) return null;
  const unknownFields = new Set();
  const invalidFields = new Set();
  for (const layer of matched.layers) collectUnknown(...layer, unknownFields);

  const usagePath = `${matched.prefix}.usage`;
  const usage = object(matched.turn.usage);
  if (!usage) invalidFields.add(usagePath);
  const source = usage || {};
  collectUnknown(source, USAGE_FIELDS, usagePath, unknownFields);
  const inputTokens = usageNumber(source, 'inputTokens', `${usagePath}.inputTokens`, invalidFields) ?? 0;
  const outputTokens = usageNumber(source, 'outputTokens', `${usagePath}.outputTokens`, invalidFields) ?? 0;
  const modelUsage = modelUsageRows(
    source.modelUsage,
    `${usagePath}.modelUsage`,
    unknownFields,
    invalidFields,
  );
  const candidates = [matched.turn.timestamp, matched.turn.completedAt, record.timestamp];
  const observedAt = candidates.map(timestamp).find(Boolean) || null;
  if (!observedAt && candidates.some((value) => value != null)) {
    invalidFields.add(`${matched.prefix}.timestamp`);
  }
  const turnId = optionalText(matched.turn.turnId);
  if (matched.turn.turnId != null && !turnId) invalidFields.add(`${matched.prefix}.turnId`);
  const rawCwd = matched.turn.cwd ?? record.cwd;
  const cwd = optionalText(rawCwd);
  if (rawCwd != null && !cwd) invalidFields.add(`${matched.prefix}.cwd`);

  const totalTokens = reportedTotal(source, `${usagePath}.totalTokens`, inputTokens, outputTokens, invalidFields);
  const cachedReadTokens = usageNumber(source, 'cachedReadTokens', `${usagePath}.cachedReadTokens`, invalidFields) ?? 0;
  const cacheCreationTokens = usageNumber(source, 'cacheCreationTokens', `${usagePath}.cacheCreationTokens`, invalidFields) ?? 0;
  const reasoningTokens = usageNumber(source, 'reasoningTokens', `${usagePath}.reasoningTokens`, invalidFields) ?? 0;
  const modelCalls = usageNumber(source, 'modelCalls', `${usagePath}.modelCalls`, invalidFields);
  const apiDurationMs = usageNumber(source, 'apiDurationMs', `${usagePath}.apiDurationMs`, invalidFields, { integer: false });
  const costUsdTicks = usageNumber(source, 'costUsdTicks', `${usagePath}.costUsdTicks`, invalidFields) ?? 0;
  const numTurns = usageNumber(source, 'numTurns', `${usagePath}.numTurns`, invalidFields);

  const provenance = {
    parser: GROK_UPDATES_PARSER,
    parserVersion: GROK_UPDATES_PARSER_VERSION,
    source: { file, line },
    unknownFields: [...unknownFields].sort(),
    invalidFields: [...invalidFields].sort(),
  };
  return {
    turn: {
      turnIndex,
      turnId,
      timestamp: observedAt,
      inputTokens,
      outputTokens,
      totalTokens,
      cachedReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      modelCalls,
      apiDurationMs,
      costUsdTicks,
      numTurns,
      modelUsage,
      sourceLine: line,
      provenanceJson: null,
      sourceJson: JSON.stringify(record),
    },
    cwd,
    provenance,
  };
}

export async function parseGrokUpdatesFile({ file, cwdKey, sessionId, machine = 'studio', warn = () => {} } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('Grok updates file is required');
  if (typeof cwdKey !== 'string' || !cwdKey.trim()) throw new Error('Grok cwd key is required');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Grok session id is required');
  if (typeof machine !== 'string' || !machine.trim()) throw new Error('Grok session machine is required');

  const turns = [];
  let cwd = null;
  let lineNumber = 0;
  let malformedLines = 0;
  let schemaDriftFields = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const input = fs.createReadStream(file, { encoding: 'utf8', flags: 'r' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const sourceLine of lines) {
      lineNumber += 1;
      if (!sourceLine.trim()) continue;
      let record;
      try {
        record = JSON.parse(sourceLine);
        if (!object(record)) throw new Error('line must contain a JSON object');
      } catch (error) {
        malformedLines += 1;
        warn(`grok-session-ingest: skipped ${file} line ${lineNumber}: ${error.message}`);
        continue;
      }
      const parsed = parseCompletedTurn(record, { file, line: lineNumber, turnIndex: turns.length });
      if (!parsed) continue;
      const drift = [...parsed.provenance.unknownFields, ...parsed.provenance.invalidFields];
      schemaDriftFields += drift.length;
      if (drift.length) warn(`grok-session-ingest: schema drift ${file} line ${lineNumber}: ${drift.join(', ')}`);
      parsed.turn.provenanceJson = JSON.stringify(parsed.provenance);
      cwd ||= parsed.cwd;
      const at = parsed.turn.timestamp;
      if (at && (firstTimestamp == null || at < firstTimestamp)) firstTimestamp = at;
      if (at && (lastTimestamp == null || at > lastTimestamp)) lastTimestamp = at;
      turns.push(parsed.turn);
    }
  } finally {
    try { lines.close(); }
    finally { input.destroy(); }
  }
  return {
    session: {
      sessionId: sessionId.trim(),
      profileSlug: cwdKey.trim(),
      cwdKey: cwdKey.trim(),
      machine: machine.trim(),
      cwd,
      firstTimestamp,
      lastTimestamp,
      sourceFile: file,
      parserVersion: GROK_UPDATES_PARSER_VERSION,
    },
    turns,
    malformedLines,
    schemaDriftFields,
  };
}

function emptySummary() {
  return {
    cwdDirectories: 0,
    sessionDirectories: 0,
    files: 0,
    filesSkipped: 0,
    sessions: 0,
    turns: 0,
    modelUsageRows: 0,
    sessionsInserted: 0,
    sessionsUpdated: 0,
    turnsInserted: 0,
    turnsUpdated: 0,
    modelUsageInserted: 0,
    modelUsageUpdated: 0,
    warnings: {
      malformedLines: 0,
      malformedFiles: 0,
      schemaDriftFields: 0,
      unreadableDirs: 0,
      skippedSymlinks: 0,
    },
  };
}

function entries(directory, summary, warn) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    summary.warnings.unreadableDirs += 1;
    warn(`grok-session-ingest: skipped unreadable directory ${directory}: ${error.message}`);
    return [];
  }
}

function updateFiles(root, summary, warn) {
  const files = [];
  for (const cwd of entries(root, summary, warn).sort((a, b) => a.name.localeCompare(b.name))) {
    if (cwd.isSymbolicLink()) { summary.warnings.skippedSymlinks += 1; continue; }
    if (!cwd.isDirectory()) continue;
    summary.cwdDirectories += 1;
    const cwdPath = path.join(root, cwd.name);
    for (const session of entries(cwdPath, summary, warn).sort((a, b) => a.name.localeCompare(b.name))) {
      if (session.isSymbolicLink()) { summary.warnings.skippedSymlinks += 1; continue; }
      if (!session.isDirectory()) continue;
      summary.sessionDirectories += 1;
      const sessionPath = path.join(cwdPath, session.name);
      const update = entries(sessionPath, summary, warn).find((entry) => entry.name === 'updates.jsonl');
      if (update?.isSymbolicLink()) { summary.warnings.skippedSymlinks += 1; continue; }
      if (update?.isFile()) files.push({ file: path.join(sessionPath, update.name), cwdKey: cwd.name, sessionId: session.name });
    }
  }
  return files;
}

/// Stream the external Grok store read-only; all writes go to ModelDeck's DB.
export async function ingestGrokSessions({ store, sessionsRoot, machine = 'studio', warn = () => {} } = {}) {
  if (!store?.ingestGrokSession) throw new Error('Grok session ingest requires a Store');
  if (typeof sessionsRoot !== 'string' || !sessionsRoot.trim()) throw new Error('Grok sessions root is required');
  const root = path.resolve(sessionsRoot);
  const summary = emptySummary();
  if (!fs.existsSync(root)) return summary;
  if (!fs.statSync(root).isDirectory()) throw new Error(`Grok sessions root must be a directory: ${root}`);

  const files = updateFiles(root, summary, warn);
  summary.files = files.length;
  for (const item of files) {
    try {
      const before = fs.statSync(item.file);
      const state = store.getIngestFileState(item.file);
      if (state?.size === before.size && state.mtimeMs === before.mtimeMs && state.ino === before.ino
          && state.parser === GROK_UPDATES_PARSER && state.parserVersion === GROK_UPDATES_PARSER_VERSION) {
        summary.filesSkipped += 1;
        continue;
      }
      const parsed = await parseGrokUpdatesFile({ ...item, machine, warn });
      summary.warnings.malformedLines += parsed.malformedLines;
      summary.warnings.schemaDriftFields += parsed.schemaDriftFields;
      if (parsed.turns.length) {
        summary.sessions += 1;
        summary.turns += parsed.turns.length;
        summary.modelUsageRows += parsed.turns.reduce((total, turn) => total + turn.modelUsage.length, 0);
        const stored = store.ingestGrokSession(parsed.session, parsed.turns);
        for (const [key, value] of Object.entries(stored)) summary[key] += value;
      }
      const after = fs.statSync(item.file);
      if (after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino) {
        store.recordIngestFileState(item.file, after, {
          parser: GROK_UPDATES_PARSER,
          parserVersion: GROK_UPDATES_PARSER_VERSION,
        });
      }
    } catch (error) {
      summary.warnings.malformedFiles += 1;
      warn(`grok-session-ingest: skipped ${item.file}: ${error.message}`);
    }
  }
  return summary;
}
