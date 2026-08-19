import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CODEX_ROLLOUT_PARSER = 'codex-rollout';
const CODEX_ROLLOUT_PARSER_VERSION = 1;

const TOKEN_FIELDS = Object.freeze({
  input_tokens: 'inputTokens',
  cached_input_tokens: 'cachedInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens',
  output_tokens: 'outputTokens',
  reasoning_output_tokens: 'reasoningOutputTokens',
  total_tokens: 'totalTokens',
});

function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonicalTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function optionalNonNegativeNumber(value, label) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

function serializedSource(value) {
  const text = optionalText(value);
  if (text) return text;
  if (!object(value)) return null;
  return JSON.stringify(value);
}

function sessionIdFromFilename(file) {
  return path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] || null;
}

function normalizedTokenUsage(usage, { strict = false, label = 'token_count usage' } = {}) {
  if (!object(usage)) return null;
  const normalized = {};
  let sawTokenField = false;
  for (const [source, destination] of Object.entries(TOKEN_FIELDS)) {
    const present = Object.hasOwn(usage, source);
    if (present) sawTokenField = true;
    const value = present ? usage[source] : 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      if (!strict) return null;
      throw new Error(`${label} ${source} must be a non-negative safe integer`);
    }
    normalized[destination] = value;
  }
  return sawTokenField ? normalized : null;
}

function childDirectory(parent, entries, name, onUnreadable) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  const directory = path.join(parent, name);
  if (entry.isDirectory()) return directory;
  if (!entry.isSymbolicLink()) return null;
  try {
    return fs.statSync(directory).isDirectory() ? directory : null;
  } catch (error) {
    onUnreadable(directory, error);
    return null;
  }
}

function directoryEntries(directory, onUnreadable) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    onUnreadable(directory, error);
    return null;
  }
}

function activeRolloutFiles(profilePath, profileEntries, onUnreadable) {
  const sessions = childDirectory(profilePath, profileEntries, 'sessions', onUnreadable);
  if (!sessions) return [];
  const files = [];
  const years = (directoryEntries(sessions, onUnreadable) || [])
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const year of years) {
    const yearPath = path.join(sessions, year.name);
    const months = (directoryEntries(yearPath, onUnreadable) || [])
      .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const month of months) {
      const monthPath = path.join(yearPath, month.name);
      const days = (directoryEntries(monthPath, onUnreadable) || [])
        .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const day of days) {
        const dayPath = path.join(monthPath, day.name);
        for (const entry of (directoryEntries(dayPath, onUnreadable) || [])
          .filter((candidate) => candidate.isFile() && /^rollout-.*\.jsonl$/.test(candidate.name))
          .sort((left, right) => left.name.localeCompare(right.name))) {
          files.push({ file: path.join(dayPath, entry.name), archived: false });
        }
      }
    }
  }
  return files;
}

function archivedRolloutFiles(profilePath, profileEntries, onUnreadable) {
  const archived = childDirectory(profilePath, profileEntries, 'archived_sessions', onUnreadable);
  if (!archived) return [];
  // Archived rollouts are flat instead of YYYY/MM/DD-nested, and historical
  // Codex versions have not used one stable filename prefix. The directory is
  // already purpose-specific, so accept every direct JSONL child.
  return (directoryEntries(archived, onUnreadable) || [])
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ file: path.join(archived, entry.name), archived: true }));
}

export async function parseCodexRolloutFile({
  file,
  profileSlug,
  machine = 'studio',
  archived = false,
  warn = () => {},
} = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('Codex rollout file is required');
  if (typeof profileSlug !== 'string' || !profileSlug.trim()) throw new Error('Codex rollout profile slug is required');
  if (typeof machine !== 'string' || !machine.trim()) throw new Error('Codex rollout machine is required');

  let metadata = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let lineNumber = 0;
  let malformedLines = 0;
  let unattachedTokenCounts = 0;
  let previousCumulative = null;
  let activeContextTurn = null;
  let lastStartedTurn = null;
  let sessionCatchAllTurn = null;
  let nextAnonymous = 0;
  const turns = [];
  const turnsById = new Map();
  const settings = { model: null, reasoningEffort: null };

  function observeTimestamp(value) {
    const timestamp = canonicalTimestamp(value);
    if (!timestamp) return null;
    if (firstTimestamp == null || timestamp < firstTimestamp) firstTimestamp = timestamp;
    if (lastTimestamp == null || timestamp > lastTimestamp) lastTimestamp = timestamp;
    return timestamp;
  }

  function ensureTurn(turnId = null, timestamp = null) {
    turnId = optionalText(turnId);
    if (turnId && turnsById.has(turnId)) {
      const existing = turnsById.get(turnId);
      if (!existing.timestamp && timestamp) existing.timestamp = timestamp;
      return existing;
    }
    const turn = {
      turnIndex: turns.length,
      turnId,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      durationMs: null,
      timeToFirstTokenMs: null,
      timestamp,
      hasContext: false,
      completed: false,
      anonymousKey: turnId ? null : nextAnonymous++,
    };
    turns.push(turn);
    if (turnId) turnsById.set(turnId, turn);
    return turn;
  }

  function applySettings(payload) {
    const threadSettings = object(payload.thread_settings) || {};
    const model = optionalText(threadSettings.model);
    const reasoningEffort = optionalText(threadSettings.reasoning_effort ?? threadSettings.effort);
    if (model) settings.model = model;
    if (reasoningEffort) settings.reasoningEffort = reasoningEffort;
    const explicitTurnId = optionalText(payload.turn_id ?? threadSettings.turn_id);
    const target = explicitTurnId ? ensureTurn(explicitTurnId) : (activeContextTurn || lastStartedTurn);
    if (target && !target.completed) {
      if (model) target.model = model;
      if (reasoningEffort) target.reasoningEffort = reasoningEffort;
    }
  }

  function applyTokenCount(record, timestamp) {
    const info = object(object(record.payload)?.info) || {};
    const lastUsage = normalizedTokenUsage(info.last_token_usage);
    const observed = normalizedTokenUsage(info.total_token_usage, {
      strict: !lastUsage,
      label: 'token_count total_token_usage',
    });
    let delta;
    // total_token_usage is Codex's session-cumulative source of truth.
    // last_token_usage can be repeated on an emission where the cumulative
    // counter did not advance, so use it only when no cumulative value exists.
    if (!observed && !lastUsage) {
      throw new Error('token_count has no usable last_token_usage or total_token_usage');
    } else if (!observed) {
      delta = lastUsage;
    } else if (!previousCumulative) {
      delta = { ...observed };
    } else {
      const differences = Object.fromEntries(Object.keys(TOKEN_FIELDS).map((source) => {
        const field = TOKEN_FIELDS[source];
        return [field, observed[field] - previousCumulative[field]];
      }));
      // Codex token_count counters are cumulative per session, not per event
      // or turn. Diff successive observations and assign each delta to the
      // nearest preceding turn. If ANY counter goes backwards after
      // compaction/restart, all counters begin a new baseline: the observed
      // values are that baseline's cumulative floor and become this event's
      // non-negative delta. We never persist a negative token row.
      const reset = Object.values(differences).some((value) => value < 0);
      delta = reset ? { ...observed } : differences;
    }
    if (observed) {
      previousCumulative = observed;
    } else if (previousCumulative && lastUsage) {
      const estimated = {};
      for (const field of Object.values(TOKEN_FIELDS)) {
        const value = previousCumulative[field] + lastUsage[field];
        if (!Number.isSafeInteger(value)) {
          previousCumulative = null;
          break;
        }
        estimated[field] = value;
      }
      if (previousCumulative) previousCumulative = estimated;
    } else if (lastUsage) {
      previousCumulative = { ...lastUsage };
    }
    // token_count carries no turn_id. Keeping the preceding context active
    // even after task_complete also handles trailing counters deterministically.
    let target = activeContextTurn || lastStartedTurn;
    if (!target) {
      unattachedTokenCounts += 1;
      warn(`codex-rollout-ingest: ${file} line ${lineNumber}: token_count has no preceding turn; attached to session catch-all`);
      if (!sessionCatchAllTurn) {
        sessionCatchAllTurn = ensureTurn(null, timestamp);
        // A NULL turn_id/model/effort is the persisted marker for this
        // synthesized session-level catch-all; never invent model metadata.
        sessionCatchAllTurn.model = null;
        sessionCatchAllTurn.reasoningEffort = null;
      }
      target = sessionCatchAllTurn;
    }
    if (!target.timestamp && timestamp) target.timestamp = timestamp;
    for (const field of Object.values(TOKEN_FIELDS)) target[field] += delta[field];
  }

  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
      if (!object(record)) throw new Error('line must contain a JSON object');
    } catch (error) {
      malformedLines += 1;
      warn(`codex-rollout-ingest: skipped ${file} line ${lineNumber}: ${error.message}`);
      continue;
    }
    const recordTimestamp = observeTimestamp(record.timestamp);
    try {
      const payload = object(record.payload) || {};
      observeTimestamp(payload.timestamp);
      observeTimestamp(payload.started_at);
      observeTimestamp(payload.completed_at);

      if (record.type === 'session_meta') {
        if (!metadata) metadata = payload;
        continue;
      }
      if (record.type === 'turn_context') {
        let turn;
        const turnId = optionalText(payload.turn_id);
        if (turnId) turn = ensureTurn(turnId, recordTimestamp);
        else if (lastStartedTurn && !lastStartedTurn.hasContext) turn = lastStartedTurn;
        else turn = ensureTurn(null, recordTimestamp);
        turn.hasContext = true;
        turn.model = optionalText(payload.model) || turn.model;
        turn.reasoningEffort = optionalText(payload.effort ?? payload.reasoning_effort) || turn.reasoningEffort;
        activeContextTurn = turn;
        continue;
      }
      if (record.type !== 'event_msg') continue;
      if (payload.type === 'thread_settings_applied') {
        applySettings(payload);
      } else if (payload.type === 'task_started') {
        const timestamp = observeTimestamp(payload.started_at) || recordTimestamp;
        lastStartedTurn = ensureTurn(payload.turn_id, timestamp);
        // A new task invalidates an older turn_context. Until a matching
        // context arrives, token_count belongs to this newly started turn.
        activeContextTurn = null;
      } else if (payload.type === 'task_complete') {
        const timestamp = observeTimestamp(payload.started_at) || recordTimestamp;
        const turn = optionalText(payload.turn_id)
          ? ensureTurn(payload.turn_id, timestamp)
          : (activeContextTurn || lastStartedTurn || ensureTurn(null, timestamp));
        turn.durationMs = optionalNonNegativeNumber(payload.duration_ms, 'task_complete duration_ms');
        turn.timeToFirstTokenMs = optionalNonNegativeNumber(payload.time_to_first_token_ms, 'task_complete time_to_first_token_ms');
        if (turn.durationMs == null) {
          const started = canonicalTimestamp(payload.started_at) || turn.timestamp;
          const completed = canonicalTimestamp(payload.completed_at);
          if (started && completed && completed >= started) turn.durationMs = Date.parse(completed) - Date.parse(started);
        }
        turn.completed = true;
      } else if (payload.type === 'token_count') {
        applyTokenCount(record, recordTimestamp);
      }
    } catch (error) {
      malformedLines += 1;
      warn(`codex-rollout-ingest: skipped ${file} line ${lineNumber}: ${error.message}`);
    }
  }

  const sessionId = optionalText(metadata?.id) || optionalText(metadata?.session_id) || sessionIdFromFilename(file);
  if (!sessionId) throw new Error('rollout has no session id in session_meta or filename');
  if (!firstTimestamp || !lastTimestamp) throw new Error('rollout has no valid timestamps');
  const git = object(metadata?.git) || {};
  return {
    session: {
      sessionId,
      profileSlug: profileSlug.trim(),
      machine: machine.trim(),
      cwd: optionalText(metadata?.cwd),
      originator: optionalText(metadata?.originator),
      source: serializedSource(metadata?.source),
      cliVersion: optionalText(metadata?.cli_version),
      gitBranch: optionalText(git.branch),
      gitRepo: optionalText(git.repository_url ?? git.repo ?? git.repository),
      gitCommit: optionalText(git.commit_hash ?? git.commit),
      firstTimestamp,
      lastTimestamp,
      archived: Boolean(archived),
    },
    turns: turns.map(({ hasContext, completed, anonymousKey, ...turn }) => turn),
    malformedLines,
    unattachedTokenCounts,
    lines: lineNumber,
  };
}

export async function ingestCodexRollouts({
  store,
  profilesRoot,
  machine = 'studio',
  warn = () => {},
} = {}) {
  if (!store?.ingestCodexSession) throw new Error('Codex rollout ingest requires a Store');
  if (typeof profilesRoot !== 'string' || !profilesRoot.trim()) throw new Error('Codex profiles root is required');
  const resolvedRoot = path.resolve(profilesRoot);
  if (!fs.existsSync(resolvedRoot)) throw new Error(`Codex profiles root does not exist: ${resolvedRoot}`);
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new Error(`Codex profiles root must be a directory: ${resolvedRoot}`);

  const profileEntries = fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try { return fs.statSync(path.join(resolvedRoot, entry.name)).isDirectory(); }
      catch { return false; }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const summary = {
    profiles: profileEntries.length,
    files: 0,
    filesSkipped: 0,
    sessions: 0,
    turns: 0,
    sessionsInserted: 0,
    sessionsUpdated: 0,
    turnsInserted: 0,
    turnsUpdated: 0,
    warnings: { malformedLines: 0, malformedFiles: 0, unattachedTokenCounts: 0, unreadableDirs: 0 },
  };

  const recordUnreadableDirectory = (directory, error) => {
    summary.warnings.unreadableDirs += 1;
    warn(`codex-rollout-ingest: skipped unreadable directory ${directory}: ${error.message}`);
  };

  for (const profile of profileEntries) {
    const profilePath = path.join(resolvedRoot, profile.name);
    let files;
    try {
      const entries = fs.readdirSync(profilePath, { withFileTypes: true });
      files = [
        ...activeRolloutFiles(profilePath, entries, recordUnreadableDirectory),
        ...archivedRolloutFiles(profilePath, entries, recordUnreadableDirectory),
      ];
    } catch (error) {
      recordUnreadableDirectory(profilePath, error);
      continue;
    }
    summary.files += files.length;
    for (const item of files) {
      try {
        const fileStat = fs.statSync(item.file);
        const ingestState = store.getIngestFileState(item.file);
        if (ingestState?.size === fileStat.size && ingestState.mtimeMs === fileStat.mtimeMs
          && ingestState.ino === fileStat.ino) {
          summary.filesSkipped += 1;
          continue;
        }
        const parsed = await parseCodexRolloutFile({
          ...item,
          profileSlug: profile.name,
          machine,
          warn,
        });
        summary.warnings.malformedLines += parsed.malformedLines;
        summary.warnings.unattachedTokenCounts += parsed.unattachedTokenCounts;
        summary.sessions += 1;
        summary.turns += parsed.turns.length;
        const stored = store.ingestCodexSession(parsed.session, parsed.turns);
        for (const [key, value] of Object.entries(stored)) summary[key] += value;
        const finalStat = fs.statSync(item.file);
        if (finalStat.size === fileStat.size && finalStat.mtimeMs === fileStat.mtimeMs
          && finalStat.ino === fileStat.ino) {
          store.recordIngestFileState(item.file, finalStat, {
            parser: CODEX_ROLLOUT_PARSER,
            parserVersion: CODEX_ROLLOUT_PARSER_VERSION,
          });
        }
      } catch (error) {
        summary.warnings.malformedFiles += 1;
        warn(`codex-rollout-ingest: skipped ${item.file}: ${error.message}`);
      }
    }
  }
  return summary;
}
