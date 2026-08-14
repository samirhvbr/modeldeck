#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_PROXY_DIR = path.join(
  os.homedir(),
  '.config',
  'cliproxyapi',
  'static',
  'modeldeck-test-pulls',
);
const DEFAULT_PROFILES_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'ModelDeck',
  'claude-profiles',
);

// The archive is live. Freeze the spike at the last complete UTC day available
// when issue #336 was investigated so a later run has the same population.
const DEFAULT_THROUGH_EXCLUSIVE = '2026-08-10T00:00:00.000Z';
const MIN_CLAUDE_SAMPLE = 1_000;
const MIN_ACCOUNTS = 3;
const MIN_DAYS = 2;
const MISSING_SOURCE = '\u0000missing-source';
const numberFormatter = new Intl.NumberFormat('en-US');

function parseArguments(argv) {
  const options = {
    proxyDir: DEFAULT_PROXY_DIR,
    profilesDir: DEFAULT_PROFILES_DIR,
    throughExclusive: DEFAULT_THROUGH_EXCLUSIVE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--proxy-dir') {
      options.proxyDir = requireValue(argv, ++index, argument);
    } else if (argument === '--profiles-dir') {
      options.profilesDir = requireValue(argv, ++index, argument);
    } else if (argument === '--through') {
      options.throughExclusive = requireValue(argv, ++index, argument);
    } else if (argument === '--all') {
      options.throughExclusive = null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.throughExclusive !== null) {
    const cutoff = Date.parse(options.throughExclusive);
    if (!Number.isFinite(cutoff)) {
      throw new Error(`Invalid --through timestamp: ${options.throughExclusive}`);
    }
    options.throughMs = cutoff;
    options.throughExclusive = new Date(cutoff).toISOString();
  } else {
    options.throughMs = Number.POSITIVE_INFINITY;
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/spike/336-requestid-join.mjs [options]

Options:
  --proxy-dir <path>     Override the CLIProxyAPI pull archive directory
  --profiles-dir <path>  Override the ModelDeck Claude profiles directory
  --through <ISO time>   Include proxy rows strictly before this timestamp
  --all                  Include the live archive without a time cutoff
  -h, --help             Show this help

The default cutoff is ${DEFAULT_THROUGH_EXCLUSIVE}. No source data is modified.`);
}

function formatNumber(value) {
  return numberFormatter.format(value);
}

function formatRate(numerator, denominator) {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(3)}%`;
}

function formatTimestamp(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : 'n/a';
}

function printTable(title, columns, rows) {
  console.log(`\n${title}`);
  const normalized = rows.map((row) => columns.map((column) => String(row[column.key] ?? '')));
  const widths = columns.map((column, columnIndex) => Math.max(
    column.label.length,
    ...normalized.map((row) => row[columnIndex].length),
  ));
  const render = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;
  console.log(render(columns.map((column) => column.label)));
  console.log(`|-${widths.map((width) => '-'.repeat(width)).join('-|-')}-|`);
  for (const row of normalized) console.log(render(row));
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function observeRange(range, value) {
  if (!Number.isFinite(value)) return;
  range.min = Math.min(range.min, value);
  range.max = Math.max(range.max, value);
}

function createDimension() {
  return { hasValue: false, value: undefined, conflict: false };
}

function observeDimension(dimension, value) {
  if (value === undefined || value === null) return;
  if (!dimension.hasValue) {
    dimension.hasValue = true;
    dimension.value = value;
  } else if (!Object.is(dimension.value, value)) {
    dimension.conflict = true;
  }
}

async function enumerateTranscriptFiles(profilesDir) {
  const rootEntries = (await readdir(profilesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareStrings(left.name, right.name));
  const files = [];
  let skippedSymlinks = 0;
  let emptyProfiles = 0;

  async function walk(directory, profileKey, projectsDir) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (entry.isDirectory()) {
        await walk(target, profileKey, projectsDir);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const segments = path.relative(projectsDir, target).split(path.sep);
        files.push({
          path: target,
          profileKey,
          isSubagent: segments.includes('subagents'),
        });
      }
    }
  }

  for (const entry of rootEntries) {
    const projectsDir = path.join(profilesDir, entry.name, 'projects');
    const filesBeforeProfile = files.length;
    await walk(projectsDir, entry.name, projectsDir);
    if (files.length === filesBeforeProfile) emptyProfiles += 1;
  }

  return {
    profileCount: rootEntries.length,
    files,
    skippedSymlinks,
    emptyProfiles,
  };
}

function createTranscriptEntry() {
  return {
    lines: 0,
    assistantLines: 0,
    otherLines: 0,
    topLevelLines: 0,
    subagentLines: 0,
    firstFileOrdinal: null,
    fileConflict: false,
    profile: createDimension(),
    sessionId: createDimension(),
    cwd: createDimension(),
    gitBranch: createDimension(),
    model: createDimension(),
    timestampRange: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
  };
}

async function scanTranscripts(profilesDir) {
  const enumeration = await enumerateTranscriptFiles(profilesDir);
  const requestIds = new Map();
  const messageIds = new Set();
  const stats = {
    profiles: enumeration.profileCount,
    files: enumeration.files.length,
    topLevelFiles: enumeration.files.filter((file) => !file.isSubagent).length,
    subagentFiles: enumeration.files.filter((file) => file.isSubagent).length,
    skippedSymlinks: enumeration.skippedSymlinks,
    emptyProfiles: enumeration.emptyProfiles,
    lines: 0,
    blankLines: 0,
    parsedLines: 0,
    malformedLines: 0,
    assistantLines: 0,
    assistantLinesWithRequestId: 0,
    assistantLinesWithoutRequestId: 0,
    nonAssistantLinesWithRequestId: 0,
    sidechainPathMismatches: 0,
    requestTimestampRange: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
  };

  for (let fileOrdinal = 0; fileOrdinal < enumeration.files.length; fileOrdinal += 1) {
    const file = enumeration.files[fileOrdinal];
    const input = createReadStream(file.path, {
      encoding: 'utf8',
      highWaterMark: 1024 * 1024,
    });
    const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of lines) {
      stats.lines += 1;
      if (line.trim().length === 0) {
        stats.blankLines += 1;
        continue;
      }

      let record;
      try {
        record = JSON.parse(line);
        stats.parsedLines += 1;
      } catch {
        stats.malformedLines += 1;
        continue;
      }

      const isAssistant = record?.type === 'assistant';
      if (isAssistant) stats.assistantLines += 1;
      const messageId = validId(record?.message?.id);
      if (messageId) messageIds.add(messageId);
      const requestId = validId(record?.requestId);
      if (!requestId) {
        if (isAssistant) stats.assistantLinesWithoutRequestId += 1;
        continue;
      }

      if (isAssistant) stats.assistantLinesWithRequestId += 1;
      else stats.nonAssistantLinesWithRequestId += 1;

      if (typeof record.isSidechain === 'boolean' && record.isSidechain !== file.isSubagent) {
        stats.sidechainPathMismatches += 1;
      }

      let entry = requestIds.get(requestId);
      if (!entry) {
        entry = createTranscriptEntry();
        requestIds.set(requestId, entry);
      }

      entry.lines += 1;
      if (isAssistant) entry.assistantLines += 1;
      else entry.otherLines += 1;
      if (file.isSubagent) entry.subagentLines += 1;
      else entry.topLevelLines += 1;

      if (entry.firstFileOrdinal === null) entry.firstFileOrdinal = fileOrdinal;
      else if (entry.firstFileOrdinal !== fileOrdinal) entry.fileConflict = true;

      observeDimension(entry.profile, file.profileKey);
      observeDimension(entry.sessionId, record.sessionId);
      observeDimension(entry.cwd, record.cwd);
      observeDimension(entry.gitBranch, record.gitBranch);
      observeDimension(entry.model, record.message?.model);

      const timestamp = parseTimestamp(record.timestamp);
      observeRange(entry.timestampRange, timestamp);
      observeRange(stats.requestTimestampRange, timestamp);
    }
  }

  const derived = {
    uniqueRequestIds: requestIds.size,
    duplicateRequestIdLines: 0,
    idsOnMultipleLines: 0,
    topLevelOnlyIds: 0,
    subagentOnlyIds: 0,
    topAndSubagentIds: 0,
    assistantBackedIds: 0,
    nonAssistantOnlyIds: 0,
    idsAcrossFiles: 0,
    idsWithAnyMetadataConflict: 0,
    idsWithProjectSessionConflict: 0,
    conflicts: {
      profile: 0,
      sessionId: 0,
      cwd: 0,
      gitBranch: 0,
      model: 0,
    },
  };

  for (const entry of requestIds.values()) {
    derived.duplicateRequestIdLines += entry.lines - 1;
    if (entry.lines > 1) derived.idsOnMultipleLines += 1;
    if (entry.topLevelLines > 0 && entry.subagentLines > 0) derived.topAndSubagentIds += 1;
    else if (entry.subagentLines > 0) derived.subagentOnlyIds += 1;
    else derived.topLevelOnlyIds += 1;
    if (entry.assistantLines > 0) derived.assistantBackedIds += 1;
    else derived.nonAssistantOnlyIds += 1;
    if (entry.fileConflict) derived.idsAcrossFiles += 1;
    if ([entry.profile, entry.sessionId, entry.cwd, entry.gitBranch, entry.model]
      .some((dimension) => dimension.conflict)) {
      derived.idsWithAnyMetadataConflict += 1;
    }
    if ([entry.profile, entry.sessionId, entry.cwd].some((dimension) => dimension.conflict)) {
      derived.idsWithProjectSessionConflict += 1;
    }
    for (const field of Object.keys(derived.conflicts)) {
      if (entry[field].conflict) derived.conflicts[field] += 1;
    }
  }

  return { requestIds, messageIds, stats, derived };
}

function extractResponseRequestId(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return { id: null, ambiguous: false };
  }

  const values = [];
  for (const [name, rawValue] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'request-id') continue;
    const candidates = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const candidate of candidates) {
      const id = validId(candidate);
      if (id) values.push(id);
    }
  }

  const unique = [...new Set(values)];
  return {
    id: unique.length === 1 ? unique[0] : null,
    ambiguous: unique.length > 1,
  };
}

function isFailedProxyRecord(record) {
  return [record.failed, record.fail].some((value) => (
    value === true || value === 1 || value === 'true' || value === '1'
  ));
}

async function scanProxyArchive(proxyDir, throughMs) {
  const entries = (await readdir(proxyDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^pull-.*\.json$/.test(entry.name))
    .sort((left, right) => compareStrings(left.name, right.name));
  const records = [];
  const stats = {
    files: entries.length,
    filesWithUsageArrays: 0,
    filesWithoutUsageArrays: 0,
    rawUsageRows: 0,
    invalidTimestampRows: 0,
    rowsAtOrAfterCutoff: 0,
    includedTimestampRange: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
    ambiguousResponseRequestIds: 0,
  };

  for (let fileOrdinal = 0; fileOrdinal < entries.length; fileOrdinal += 1) {
    const entry = entries[fileOrdinal];
    let document;
    try {
      document = JSON.parse(await readFile(path.join(proxyDir, entry.name), 'utf8'));
    } catch {
      throw new Error(`Proxy pull file ${fileOrdinal + 1} of ${entries.length} is not valid JSON`);
    }

    if (!Array.isArray(document?.usage)) {
      stats.filesWithoutUsageArrays += 1;
      continue;
    }
    stats.filesWithUsageArrays += 1;
    stats.rawUsageRows += document.usage.length;

    for (const record of document.usage) {
      const timestampMs = parseTimestamp(record?.timestamp);
      if (!Number.isFinite(timestampMs)) {
        stats.invalidTimestampRows += 1;
        continue;
      }
      if (timestampMs >= throughMs) {
        stats.rowsAtOrAfterCutoff += 1;
        continue;
      }

      const responseRequestId = extractResponseRequestId(record.response_headers);
      if (responseRequestId.ambiguous) stats.ambiguousResponseRequestIds += 1;
      observeRange(stats.includedTimestampRange, timestampMs);
      records.push({
        provider: typeof record.provider === 'string' ? record.provider.toLowerCase() : '<missing>',
        sourceKey: typeof record.source === 'string' && record.source.length > 0
          ? record.source
          : MISSING_SOURCE,
        timestampMs,
        day: new Date(timestampMs).toISOString().slice(0, 10),
        userAgent: typeof record.user_agent === 'string' ? record.user_agent : '',
        model: typeof record.model === 'string' ? record.model : '',
        topLevelRequestId: validId(record.request_id),
        responseRequestId: responseRequestId.id,
        failed: isFailedProxyRecord(record),
        fileOrdinal,
      });
    }
  }

  return { records, stats };
}

function resolveJoin(record, transcriptIds) {
  const topLevelMatch = record.topLevelRequestId
    ? transcriptIds.get(record.topLevelRequestId) ?? null
    : null;
  const responseHeaderMatch = record.responseRequestId
    ? transcriptIds.get(record.responseRequestId) ?? null
    : null;
  const matchedIds = new Set();
  if (topLevelMatch) matchedIds.add(record.topLevelRequestId);
  if (responseHeaderMatch) matchedIds.add(record.responseRequestId);

  const exact = matchedIds.size === 1;
  const matchId = exact ? matchedIds.values().next().value : null;
  return {
    topLevelMatched: Boolean(topLevelMatch),
    responseHeaderMatched: Boolean(responseHeaderMatch),
    candidateConflict: matchedIds.size > 1,
    exact,
    matchId,
    entry: exact ? transcriptIds.get(matchId) : null,
  };
}

function isClaudeAgentSdk(record) {
  return record.provider === 'claude'
    && /claude-cli\//i.test(record.userAgent)
    && /agent-sdk\//i.test(record.userAgent);
}

function isClaudeCli(record) {
  return /claude-cli\//i.test(record.userAgent);
}

function matchSummary(label, records) {
  const topLevelMatches = records.filter((record) => record.join.topLevelMatched).length;
  const responseHeaderMatches = records.filter((record) => record.join.responseHeaderMatched).length;
  const exactMatches = records.filter((record) => record.join.exact).length;
  const candidateConflicts = records.filter((record) => record.join.candidateConflict).length;
  return {
    scope: label,
    records: formatNumber(records.length),
    top: formatNumber(topLevelMatches),
    header: formatNumber(responseHeaderMatches),
    exact: formatNumber(exactMatches),
    conflicts: formatNumber(candidateConflicts),
    rate: formatRate(exactMatches, records.length),
  };
}

function candidateStats(records, field, transcriptIds) {
  const occurrences = new Map();
  for (const record of records) {
    const id = record[field];
    if (!id) continue;
    let occurrence = occurrences.get(id);
    if (!occurrence) {
      occurrence = { count: 0, files: new Set() };
      occurrences.set(id, occurrence);
    }
    occurrence.count += 1;
    occurrence.files.add(record.fileOrdinal);
  }

  let duplicateGroups = 0;
  let excessRows = 0;
  let crossFileGroups = 0;
  for (const occurrence of occurrences.values()) {
    if (occurrence.count > 1) {
      duplicateGroups += 1;
      excessRows += occurrence.count - 1;
      if (occurrence.files.size > 1) crossFileGroups += 1;
    }
  }

  const ids = [...occurrences.keys()];
  let shape;
  if (ids.length === 0) shape = 'n/a';
  else if (ids.every((id) => /^[0-9a-f]{8}$/i.test(id))) shape = '8-hex';
  else if (ids.every((id) => /^req_[A-Za-z0-9]+$/.test(id) && id.length === 28)) shape = 'req_… / 28 chars';
  else shape = 'mixed';

  return {
    present: records.filter((record) => Boolean(record[field])).length,
    distinct: occurrences.size,
    duplicateGroups,
    excessRows,
    crossFileGroups,
    transcriptMatches: records.filter((record) => {
      const id = record[field];
      return Boolean(id && transcriptIds.has(id));
    }).length,
    shape,
  };
}

function intersectionSize(values, candidates) {
  let matches = 0;
  for (const value of values) {
    if (candidates.has(value)) matches += 1;
  }
  return matches;
}

const UNMATCHED_CLASSES = [
  'Codex provider (no Claude transcript expected)',
  'Claude failed/retry attempt: response Request-Id present',
  'Claude failed/retry attempt: response Request-Id absent',
  'Claude other-client traffic (not claude-cli)',
  'Claude CLI traffic before global transcript requestId horizon',
  'Claude CLI traffic after indexed transcript horizon',
  'Claude CLI inside global time envelope: response Request-Id absent',
  'Claude CLI inside global time envelope: no exact ID match',
  'Conflicting candidate IDs matched different transcripts',
  'Other/unknown provider',
];

function classifyUnmatched(record, transcriptRange) {
  if (record.join.exact) return null;
  if (record.join.candidateConflict) return 'Conflicting candidate IDs matched different transcripts';
  if (record.provider === 'codex') return 'Codex provider (no Claude transcript expected)';
  if (record.provider !== 'claude') return 'Other/unknown provider';
  if (record.failed) {
    return record.responseRequestId
      ? 'Claude failed/retry attempt: response Request-Id present'
      : 'Claude failed/retry attempt: response Request-Id absent';
  }
  if (!isClaudeCli(record)) return 'Claude other-client traffic (not claude-cli)';
  if (record.timestampMs < transcriptRange.min) {
    return 'Claude CLI traffic before global transcript requestId horizon';
  }
  if (record.timestampMs > transcriptRange.max) {
    return 'Claude CLI traffic after indexed transcript horizon';
  }
  if (!record.responseRequestId) {
    return 'Claude CLI inside global time envelope: response Request-Id absent';
  }
  return 'Claude CLI inside global time envelope: no exact ID match';
}

function locationLabel(entry) {
  if (entry.topLevelLines > 0 && entry.subagentLines > 0) return 'Top-level and subagent transcript';
  if (entry.subagentLines > 0) return 'Subagent-only transcript';
  if (entry.topLevelLines > 0) return 'Top-level transcript only';
  return 'Unknown transcript location';
}

function dimensionSummary(label, records, field) {
  let exact = 0;
  let missing = 0;
  let conflict = 0;
  for (const record of records) {
    const dimension = record.join.entry[field];
    if (!dimension.hasValue) missing += 1;
    else if (dimension.conflict) conflict += 1;
    else exact += 1;
  }
  return {
    dimension: label,
    exact: formatNumber(exact),
    missing: formatNumber(missing),
    conflict: formatNumber(conflict),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const [transcripts, proxy] = await Promise.all([
    scanTranscripts(options.profilesDir),
    scanProxyArchive(options.proxyDir, options.throughMs),
  ]);

  for (const record of proxy.records) {
    record.join = resolveJoin(record, transcripts.requestIds);
  }

  const claudeRecords = proxy.records.filter((record) => record.provider === 'claude');
  const codexRecords = proxy.records.filter((record) => record.provider === 'codex');
  const agentSdkRecords = claudeRecords.filter(isClaudeAgentSdk);
  const responseIdClaudeRecords = claudeRecords.filter((record) => record.responseRequestId);
  const successfulResponseIdClaudeRecords = responseIdClaudeRecords.filter((record) => !record.failed);
  const claudeSources = [...new Set(claudeRecords.map((record) => record.sourceKey))]
    .sort(compareStrings);
  const accountLabels = new Map(
    claudeSources.map((sourceKey, index) => [sourceKey, `account-${index + 1}`]),
  );
  const claudeDays = new Set(claudeRecords.map((record) => record.day));

  console.log('Issue #336 — proxy request ID ↔ Claude transcript requestId join spike');
  console.log(`Proxy population: valid-timestamp rows before ${options.throughExclusive ?? 'live archive end'}`);
  console.log(`Claude-provider sample: ${formatNumber(claudeRecords.length)} records, ${formatNumber(claudeSources.length)} redacted accounts, ${formatNumber(claudeDays.size)} UTC days`);
  console.log(`Proxy timestamp range: ${formatTimestamp(proxy.stats.includedTimestampRange.min)} .. ${formatTimestamp(proxy.stats.includedTimestampRange.max)}`);
  console.log(`Transcript requestId range: ${formatTimestamp(transcripts.stats.requestTimestampRange.min)} .. ${formatTimestamp(transcripts.stats.requestTimestampRange.max)}`);

  printTable('Source inventory and quality (file inventory is live; analysis rows use the cutoff)', [
    { key: 'source', label: 'Source' },
    { key: 'files', label: 'Files' },
    { key: 'rows', label: 'Rows/lines' },
    { key: 'notes', label: 'Quality notes' },
  ], [
    {
      source: 'Proxy pull archive',
      files: formatNumber(proxy.stats.files),
      rows: formatNumber(proxy.stats.rawUsageRows),
      notes: `${formatNumber(proxy.stats.filesWithoutUsageArrays)} non-array usage files; ${formatNumber(proxy.stats.invalidTimestampRows)} invalid timestamps; ${formatNumber(proxy.stats.rowsAtOrAfterCutoff)} rows after cutoff`,
    },
    {
      source: 'Claude transcripts',
      files: formatNumber(transcripts.stats.files),
      rows: formatNumber(transcripts.stats.lines),
      notes: `${formatNumber(transcripts.stats.malformedLines)} malformed; ${formatNumber(transcripts.stats.blankLines)} blank; ${formatNumber(transcripts.stats.skippedSymlinks)} symlinks skipped`,
    },
  ]);

  printTable('Exact ID match rates', [
    { key: 'scope', label: 'Scope' },
    { key: 'records', label: 'Records' },
    { key: 'top', label: 'Top request_id' },
    { key: 'header', label: 'Header Request-Id' },
    { key: 'exact', label: 'Exact ID hit' },
    { key: 'conflicts', label: 'ID candidate conflicts' },
    { key: 'rate', label: 'ID match rate' },
  ], [
    matchSummary('All proxy providers (overall)', proxy.records),
    matchSummary('Claude provider sample', claudeRecords),
    matchSummary('Claude CLI + agent-SDK UA', agentSdkRecords),
    matchSummary('Claude with response Request-Id', responseIdClaudeRecords),
    matchSummary('Successful Claude with response ID', successfulResponseIdClaudeRecords),
    matchSummary('Codex provider', codexRecords),
  ]);

  const topStats = candidateStats(claudeRecords, 'topLevelRequestId', transcripts.requestIds);
  const headerStats = candidateStats(claudeRecords, 'responseRequestId', transcripts.requestIds);
  const bothPresent = claudeRecords.filter((record) => (
    record.topLevelRequestId && record.responseRequestId
  ));
  const equalCandidates = bothPresent.filter((record) => (
    record.topLevelRequestId === record.responseRequestId
  )).length;

  printTable('Claude candidate-ID diagnostics', [
    { key: 'field', label: 'Candidate field' },
    { key: 'shape', label: 'Observed shape' },
    { key: 'present', label: 'Present rows' },
    { key: 'distinct', label: 'Distinct IDs' },
    { key: 'duplicates', label: 'Duplicate groups / excess' },
    { key: 'crossFile', label: 'Cross-file groups' },
    { key: 'matches', label: 'Transcript matches' },
  ], [
    {
      field: 'top-level request_id',
      shape: topStats.shape,
      present: formatNumber(topStats.present),
      distinct: formatNumber(topStats.distinct),
      duplicates: `${formatNumber(topStats.duplicateGroups)} / ${formatNumber(topStats.excessRows)}`,
      crossFile: formatNumber(topStats.crossFileGroups),
      matches: formatNumber(topStats.transcriptMatches),
    },
    {
      field: 'response_headers Request-Id',
      shape: headerStats.shape,
      present: formatNumber(headerStats.present),
      distinct: formatNumber(headerStats.distinct),
      duplicates: `${formatNumber(headerStats.duplicateGroups)} / ${formatNumber(headerStats.excessRows)}`,
      crossFile: formatNumber(headerStats.crossFileGroups),
      matches: formatNumber(headerStats.transcriptMatches),
    },
  ]);
  console.log(`Both Claude candidate fields were present on ${formatNumber(bothPresent.length)} rows: ${formatNumber(equalCandidates)} equal, ${formatNumber(bothPresent.length - equalCandidates)} different; ${formatNumber(proxy.stats.ambiguousResponseRequestIds)} response headers contained multiple distinct Request-Id values.`);
  const normalizedTranscriptRequestIds = new Set(
    [...transcripts.requestIds.keys()].map((id) => id.trim().toLowerCase()),
  );
  const normalizedHeaderIds = new Set(
    responseIdClaudeRecords.map((record) => record.responseRequestId.trim().toLowerCase()),
  );
  const headerMessageMatches = intersectionSize(
    new Set(responseIdClaudeRecords.map((record) => record.responseRequestId)),
    transcripts.messageIds,
  );
  console.log(`Falsification checks: lowercase/trim-normalized header Request-Id ↔ transcript requestId matches = ${formatNumber(intersectionSize(normalizedHeaderIds, normalizedTranscriptRequestIds))}; exact header Request-Id ↔ transcript message.id matches = ${formatNumber(headerMessageMatches)}.`);

  printTable('Transcript requestId index (deduplicated across all profiles)', [
    { key: 'metric', label: 'Metric' },
    { key: 'value', label: 'Value' },
  ], [
    { metric: 'Profile directories enumerated', value: formatNumber(transcripts.stats.profiles) },
    { metric: 'Profiles with no JSONL files', value: formatNumber(transcripts.stats.emptyProfiles) },
    { metric: 'Top-level / subagent JSONL files', value: `${formatNumber(transcripts.stats.topLevelFiles)} / ${formatNumber(transcripts.stats.subagentFiles)}` },
    { metric: 'Assistant lines with / without requestId', value: `${formatNumber(transcripts.stats.assistantLinesWithRequestId)} / ${formatNumber(transcripts.stats.assistantLinesWithoutRequestId)}` },
    { metric: 'Non-assistant lines with requestId', value: formatNumber(transcripts.stats.nonAssistantLinesWithRequestId) },
    { metric: 'Unique requestIds', value: formatNumber(transcripts.derived.uniqueRequestIds) },
    { metric: 'Duplicate requestId lines removed', value: formatNumber(transcripts.derived.duplicateRequestIdLines) },
    { metric: 'IDs on multiple lines / files', value: `${formatNumber(transcripts.derived.idsOnMultipleLines)} / ${formatNumber(transcripts.derived.idsAcrossFiles)}` },
    { metric: 'Top-level-only / subagent-only / both IDs', value: `${formatNumber(transcripts.derived.topLevelOnlyIds)} / ${formatNumber(transcripts.derived.subagentOnlyIds)} / ${formatNumber(transcripts.derived.topAndSubagentIds)}` },
    { metric: 'Assistant-backed / non-assistant-only IDs', value: `${formatNumber(transcripts.derived.assistantBackedIds)} / ${formatNumber(transcripts.derived.nonAssistantOnlyIds)}` },
    { metric: 'IDs with any metadata conflict', value: formatNumber(transcripts.derived.idsWithAnyMetadataConflict) },
    { metric: 'Profile/session/cwd conflict IDs', value: formatNumber(transcripts.derived.idsWithProjectSessionConflict) },
    { metric: 'Profile/session/cwd/branch/model conflicts', value: `${formatNumber(transcripts.derived.conflicts.profile)} / ${formatNumber(transcripts.derived.conflicts.sessionId)} / ${formatNumber(transcripts.derived.conflicts.cwd)} / ${formatNumber(transcripts.derived.conflicts.gitBranch)} / ${formatNumber(transcripts.derived.conflicts.model)}` },
    { metric: 'Path vs isSidechain mismatches', value: formatNumber(transcripts.stats.sidechainPathMismatches) },
  ]);

  const exactClaudeMatches = claudeRecords.filter((record) => record.join.exact);
  const locations = new Map([
    ['Top-level transcript only', 0],
    ['Subagent-only transcript', 0],
    ['Top-level and subagent transcript', 0],
    ['Unknown transcript location', 0],
  ]);
  for (const record of exactClaudeMatches) increment(locations, locationLabel(record.join.entry));
  printTable('Where exact Claude ID matches were found', [
    { key: 'location', label: 'Transcript location' },
    { key: 'records', label: 'Matched proxy records' },
    { key: 'sampleRate', label: '% of Claude sample' },
  ], [...locations].map(([location, count]) => ({
    location,
    records: formatNumber(count),
    sampleRate: formatRate(count, claudeRecords.length),
  })));

  const exactProjectSession = exactClaudeMatches.filter((record) => {
    const { profile, sessionId, cwd } = record.join.entry;
    return profile.hasValue && !profile.conflict
      && sessionId.hasValue && !sessionId.conflict
      && cwd.hasValue && !cwd.conflict;
  }).length;
  printTable('Attribution integrity for exact Claude ID matches', [
    { key: 'dimension', label: 'Transcript dimension' },
    { key: 'exact', label: 'Present + unambiguous' },
    { key: 'missing', label: 'Missing' },
    { key: 'conflict', label: 'Conflicting values' },
  ], [
    dimensionSummary('Profile path', exactClaudeMatches, 'profile'),
    dimensionSummary('sessionId', exactClaudeMatches, 'sessionId'),
    dimensionSummary('cwd (project)', exactClaudeMatches, 'cwd'),
    dimensionSummary('gitBranch', exactClaudeMatches, 'gitBranch'),
    dimensionSummary('message.model', exactClaudeMatches, 'model'),
  ]);
  console.log(`Exact profile + sessionId + cwd attribution: ${formatNumber(exactProjectSession)} / ${formatNumber(exactClaudeMatches.length)} matched Claude records (${formatRate(exactProjectSession, exactClaudeMatches.length)}).`);

  const accountRows = claudeSources.map((sourceKey) => {
    const rows = claudeRecords.filter((record) => record.sourceKey === sourceKey);
    const matches = rows.filter((record) => record.join.exact).length;
    return {
      account: accountLabels.get(sourceKey),
      records: formatNumber(rows.length),
      days: formatNumber(new Set(rows.map((record) => record.day)).size),
      agentSdk: formatNumber(rows.filter(isClaudeAgentSdk).length),
      matches: formatNumber(matches),
      rate: formatRate(matches, rows.length),
    };
  });
  printTable('Claude sample by redacted account', [
    { key: 'account', label: 'Account' },
    { key: 'records', label: 'Records' },
    { key: 'days', label: 'UTC days' },
    { key: 'agentSdk', label: 'Agent-SDK UA' },
    { key: 'matches', label: 'Exact ID hits' },
    { key: 'rate', label: 'ID match rate' },
  ], accountRows);

  const unmatchedCounts = new Map(UNMATCHED_CLASSES.map((label) => [label, 0]));
  const unmatchedFailures = new Map(UNMATCHED_CLASSES.map((label) => [label, 0]));
  for (const record of proxy.records) {
    const classification = classifyUnmatched(record, transcripts.stats.requestTimestampRange);
    if (!classification) continue;
    increment(unmatchedCounts, classification);
    if (record.failed) increment(unmatchedFailures, classification);
  }
  const unmatchedTotal = [...unmatchedCounts.values()].reduce((sum, value) => sum + value, 0);
  printTable('Mutually exclusive unmatched classes (full two-field join)', [
    { key: 'classification', label: 'Class' },
    { key: 'records', label: 'Records' },
    { key: 'failed', label: 'Failed records' },
    { key: 'share', label: '% unmatched' },
  ], UNMATCHED_CLASSES.map((classification) => ({
    classification,
    records: formatNumber(unmatchedCounts.get(classification)),
    failed: formatNumber(unmatchedFailures.get(classification)),
    share: formatRate(unmatchedCounts.get(classification), unmatchedTotal),
  })));
  console.log('Global-horizon buckets are descriptive timestamp envelopes, not profile-specific retention classifications; unmatched proxy rows cannot be mapped to profiles without a shared key.');

  const expectedUnmatched = proxy.records.length - proxy.records.filter((record) => record.join.exact).length;
  const checks = [
    {
      check: `Claude sample ≥ ${formatNumber(MIN_CLAUDE_SAMPLE)}`,
      pass: claudeRecords.length >= MIN_CLAUDE_SAMPLE,
      observed: formatNumber(claudeRecords.length),
    },
    {
      check: `Claude sample spans ≥ ${MIN_ACCOUNTS} accounts`,
      pass: claudeSources.length >= MIN_ACCOUNTS,
      observed: formatNumber(claudeSources.length),
    },
    {
      check: `Claude sample spans ≥ ${MIN_DAYS} UTC days`,
      pass: claudeDays.size >= MIN_DAYS,
      observed: formatNumber(claudeDays.size),
    },
    {
      check: 'Unmatched classes reconcile to denominator',
      pass: unmatchedTotal === expectedUnmatched,
      observed: `${formatNumber(unmatchedTotal)} / ${formatNumber(expectedUnmatched)}`,
    },
    {
      check: 'Transcript requestIds deduplicated',
      pass: transcripts.derived.duplicateRequestIdLines >= 0
        && transcripts.requestIds.size === transcripts.derived.uniqueRequestIds,
      observed: `${formatNumber(transcripts.derived.uniqueRequestIds)} unique`,
    },
  ];
  printTable('Run checks', [
    { key: 'check', label: 'Check' },
    { key: 'status', label: 'Status' },
    { key: 'observed', label: 'Observed' },
  ], checks.map((check) => ({
    check: check.check,
    status: check.pass ? 'PASS' : 'FAIL',
    observed: check.observed,
  })));

  const failedChecks = checks.filter((check) => !check.pass);
  if (failedChecks.length > 0) {
    throw new Error(`${failedChecks.length} required run check(s) failed`);
  }
}

main().catch((error) => {
  console.error(`Join spike failed: ${error.message}`);
  process.exitCode = 1;
});
