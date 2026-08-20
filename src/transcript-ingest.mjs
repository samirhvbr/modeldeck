import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_BATCH_LINES = 1_000;
const COMMAND_NAME_PATTERN = /<command-name>\s*([^<]+?)\s*<\/command-name>/gu;
const TRANSCRIPT_PARSER = 'claude-transcript';
const TRANSCRIPT_PARSER_VERSION = 1;

function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstLine(value) {
  return typeof value === 'string'
    ? value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || null
    : null;
}

function nonNegativeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function compareNames(left, right) {
  return left.name.localeCompare(right.name);
}

function fileMetadata(projectsDir, filePath, profileSlug) {
  const relativeSegments = path.relative(projectsDir, filePath).split(path.sep);
  const subagentsIndex = relativeSegments.lastIndexOf('subagents');
  const isSubagent = subagentsIndex >= 0;
  return {
    path: filePath,
    relativePath: path.join(profileSlug, 'projects', ...relativeSegments),
    profileSlug,
    isSubagent,
    agentId: isSubagent ? path.basename(filePath, '.jsonl') : null,
    fallbackSessionId: isSubagent && subagentsIndex > 0
      ? relativeSegments[subagentsIndex - 1]
      : path.basename(filePath, '.jsonl'),
  };
}

/// Enumerate managed profile directories directly and never traverse a
/// symlink. In particular, ~/.claude is not a scan root, so an active-profile
/// symlink cannot duplicate a profile's transcript rows.
export async function enumerateTranscriptFiles(profilesDirectory) {
  if (typeof profilesDirectory !== 'string' || !profilesDirectory.trim()) {
    throw new Error('Claude profiles directory is required');
  }
  const root = path.resolve(profilesDirectory);
  let stat;
  try { stat = await fs.promises.stat(root); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Claude profiles directory does not exist: ${root}`);
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`Claude profiles path must be a directory: ${root}`);

  const rootEntries = (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort(compareNames);
  const files = [];
  let skippedSymlinks = 0;

  async function walk(directory, projectsDir, profileSlug) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    entries.sort(compareNames);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (entry.isDirectory()) {
        await walk(target, projectsDir, profileSlug);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fileMetadata(projectsDir, target, profileSlug));
      }
    }
  }

  for (const entry of rootEntries) {
    const projectsDir = path.join(root, entry.name, 'projects');
    await walk(projectsDir, projectsDir, entry.name);
  }
  return { root, profiles: rootEntries.length, files, skippedSymlinks };
}

function recordSessionId(record, file) {
  return text(record.sessionId) || text(record.session_id) || text(file.fallbackSessionId);
}

function titleFields(record) {
  if (record.type === 'custom-title') {
    return { title: text(record.customTitle) || text(record.title), titleSource: 'custom-title' };
  }
  if (record.type === 'last-prompt') {
    return { title: text(record.lastPrompt) || text(record.prompt), titleSource: 'last-prompt' };
  }
  return { title: null, titleSource: null };
}

function mergeSession(current, incoming) {
  if (!current) return incoming;
  for (const key of ['cwd', 'gitBranch', 'entrypoint', 'clientVersion']) {
    if (incoming[key] != null) current[key] = incoming[key];
  }
  if (incoming.firstAt != null && (current.firstAt == null || incoming.firstAt < current.firstAt)) {
    current.firstAt = incoming.firstAt;
  }
  if (incoming.lastAt != null && (current.lastAt == null || incoming.lastAt > current.lastAt)) {
    current.lastAt = incoming.lastAt;
  }
  const priority = { 'last-prompt': 1, 'custom-title': 2 };
  if (incoming.title != null
      && (priority[incoming.titleSource] ?? 0) >= (priority[current.titleSource] ?? 0)) {
    current.title = incoming.title;
    current.titleSource = incoming.titleSource;
  }
  return current;
}

function sessionRecord(record, file, machine, sessionId, timestamp) {
  const title = titleFields(record);
  return {
    sessionId,
    profileSlug: file.profileSlug,
    machine,
    cwd: text(record.cwd),
    gitBranch: text(record.gitBranch),
    entrypoint: text(record.entrypoint),
    clientVersion: text(record.version),
    firstAt: timestamp,
    lastAt: timestamp,
    ...title,
  };
}

function transcriptRequest(record, file, sessionId, timestamp) {
  // A tiny legacy refusal population carries requestId and usage on a
  // non-assistant record. Include those API calls too; requestId-less rows
  // still require the normal assistant record shape.
  if (record.type !== 'assistant' && !text(record.requestId)) return null;
  const message = object(record.message);
  const model = text(message.model);
  if (model === '<synthetic>') return null;
  if (!model || !timestamp) return null;
  const requestId = text(record.requestId);
  const messageId = text(message.id);
  const recordUuid = text(record.uuid);
  let dedupeKey;
  if (requestId) dedupeKey = `request:${requestId}`;
  else if (messageId) dedupeKey = `message:${sessionId}:${messageId}`;
  else if (recordUuid) dedupeKey = `record:${sessionId}:${recordUuid}`;
  else return null;

  const usage = object(message.usage);
  const cacheCreation = object(usage.cache_creation);
  const ephemeral5m = nonNegativeInteger(cacheCreation.ephemeral_5m_input_tokens);
  const ephemeral1h = nonNegativeInteger(cacheCreation.ephemeral_1h_input_tokens);
  return {
    dedupeKey,
    requestId,
    sessionId,
    profileSlug: file.profileSlug,
    messageId,
    recordUuid,
    model,
    // The two transcript eras are intentionally independent: old records
    // commonly have requestId and no effort; current records have effort and
    // no requestId.
    effort: text(record.effort),
    observedAt: timestamp,
    inputTokens: nonNegativeInteger(usage.input_tokens),
    cacheCreationInputTokens: nonNegativeInteger(
      usage.cache_creation_input_tokens,
      ephemeral5m + ephemeral1h,
    ),
    cacheReadInputTokens: nonNegativeInteger(usage.cache_read_input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
    cacheCreationEphemeral5mInputTokens: ephemeral5m,
    cacheCreationEphemeral1hInputTokens: ephemeral1h,
    isSidechain: typeof record.isSidechain === 'boolean' ? record.isSidechain : file.isSubagent,
    agentId: file.agentId,
  };
}

function contentBlocks(message) {
  return Array.isArray(message.content) ? message.content : [];
}

function commandText(message) {
  if (typeof message.content === 'string') return [message.content];
  return contentBlocks(message)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
}

function agentInvocation(block) {
  if (block?.type !== 'tool_use' || !['Agent', 'Task'].includes(block.name)) return null;
  const toolUseId = text(block.id);
  if (!toolUseId) return null;
  const input = object(block.input);
  return {
    toolUseId,
    agentType: text(input.subagent_type) || text(input.agentType) || text(input.agent_type),
    description: firstLine(input.description),
    prompt: firstLine(input.prompt),
    requestedModel: text(input.model),
  };
}

function toolResultIds(message) {
  return contentBlocks(message)
    .filter((block) => block?.type === 'tool_result')
    .map((block) => text(block.tool_use_id))
    .filter(Boolean);
}

function toolResultAgentId(block) {
  if (block?.type !== 'tool_result') return null;
  const values = typeof block.content === 'string'
    ? [block.content]
    : Array.isArray(block.content)
      ? block.content.map((part) => part?.text).filter((value) => typeof value === 'string')
      : [];
  let agentId = null;
  for (const value of values) {
    for (const match of value.matchAll(/^\s*agentId:\s*(\S+)/gmu)) agentId = text(match[1]);
  }
  return agentId;
}

function resolvedModel(result, invocation) {
  const explicit = text(result.resolvedModel) || text(result.resolved_model);
  if (explicit) return explicit;
  const modelUsage = object(result.modelUsage || result.model_usage);
  const models = Object.keys(modelUsage).filter((model) => text(model));
  if (models.length === 1) return models[0];
  return /^claude-/u.test(invocation?.requestedModel || '') ? invocation.requestedModel : null;
}

function toolStatsJson(result) {
  const stats = result.toolStats ?? result.tool_stats;
  if (stats != null && (typeof stats === 'object' || Array.isArray(stats))) return JSON.stringify(stats);
  const totalToolUseCount = optionalNonNegativeInteger(result.totalToolUseCount ?? result.total_tool_use_count);
  return totalToolUseCount == null ? null : JSON.stringify({ totalToolUseCount });
}

function recordedAgentLabel(result, invocation) {
  const agentType = text(result.agentType) || text(result.agent_type) || invocation?.agentType;
  if (agentType) return agentType;
  const description = firstLine(result.description) || invocation?.description;
  if (description) return `description: ${description}`;
  const prompt = firstLine(result.prompt) || invocation?.prompt;
  return prompt ? `prompt: ${prompt}` : null;
}

function subagentRollup(record, file, sessionId, timestamp, invocation, linkedAgentId = null, useRecordResult = true) {
  const result = useRecordResult ? object(record.toolUseResult || record.tool_use_result) : {};
  const agentId = text(linkedAgentId) || text(result.agentId) || text(result.agent_id);
  if (!agentId) return null;
  return {
    agentId,
    sessionId,
    profileSlug: file.profileSlug,
    // Prefix fallback text with its source so agent_type never implies that
    // Claude supplied a real type when the spawn style did not record one.
    agentType: recordedAgentLabel(result, invocation),
    resolvedModel: resolvedModel(result, invocation),
    totalTokens: optionalNonNegativeInteger(result.totalTokens ?? result.total_tokens),
    toolStatsJson: toolStatsJson(result),
    durationMs: optionalNonNegativeInteger(
      result.durationMs ?? result.duration_ms ?? result.totalDurationMs ?? result.total_duration_ms,
    ),
    observedAt: timestamp,
  };
}

function createBatch() {
  return { sessions: new Map(), requests: [], subagents: [], skills: [] };
}

function batchSize(batch) {
  return batch.sessions.size + batch.requests.length + batch.subagents.length + batch.skills.length;
}

function queueSession(batch, session) {
  const key = JSON.stringify([session.sessionId, session.profileSlug]);
  batch.sessions.set(key, mergeSession(batch.sessions.get(key), session));
}

function flushBatch(store, batch, summary, reconcile = false) {
  if (batchSize(batch) === 0) return createBatch();
  const rows = {
    sessions: [...batch.sessions.values()],
    requests: batch.requests,
    subagents: batch.subagents,
    skills: batch.skills,
  };
  if (reconcile) {
    store.stageTranscriptReplayBatch(rows);
    return createBatch();
  }
  const inserted = store.ingestTranscriptBatch(rows);
  summary.sessions += inserted.sessions;
  summary.requests += inserted.requests;
  summary.subagents += inserted.subagents;
  summary.skills += inserted.skills;
  return createBatch();
}

/// Stream Claude JSONL into the warehouse in bounded transactions. Source
/// files are opened read-only and are never renamed, deleted, or rewritten.
export async function ingestTranscriptArchive({
  store,
  directory,
  machine = 'studio',
  warn = () => {},
  batchLines = DEFAULT_BATCH_LINES,
} = {}) {
  if (!store?.ingestTranscriptBatch) throw new Error('transcript ingest requires a Store');
  if (!text(machine)) throw new Error('transcript ingest machine is required');
  if (!Number.isInteger(batchLines) || batchLines < 1) throw new Error('transcript ingest batchLines must be a positive integer');
  const enumeration = await enumerateTranscriptFiles(directory);
  const summary = {
    profiles: enumeration.profiles,
    files: enumeration.files.length,
    filesSkipped: 0,
    sessions: 0,
    requests: 0,
    subagents: 0,
    skills: 0,
    warnings: 0,
  };
  const agentInvocations = new Map();
  let batch = createBatch();
  let linesSinceFlush = 0;

  function warning(message) {
    summary.warnings += 1;
    warn(`transcript-ingest: ${message}`);
  }

  let work = enumeration.files;
  let suppressedPaths = null;
  let activeGroup = null;
  const filesByPath = new Map(enumeration.files.map((file) => [file.path, file]));

  function beginReconcileGroup(file, sourceSessionId, workIndex) {
    const affectedSessions = [{
      sessionId: sourceSessionId,
      profileSlug: file.profileSlug,
    }];
    const replayPaths = new Set(enumeration.files
      .filter((candidate) => (
        candidate.profileSlug === file.profileSlug
        && candidate.fallbackSessionId === file.fallbackSessionId
      ))
      .map((candidate) => candidate.path));
    for (const affected of affectedSessions) {
      for (const storedPath of store.getIngestFilePathsForSession(
        affected.sessionId,
        TRANSCRIPT_PARSER,
      )) {
        const storedFile = filesByPath.get(storedPath);
        if (storedFile?.profileSlug === affected.profileSlug) replayPaths.add(storedPath);
      }
    }
    const files = enumeration.files.filter((candidate) => replayPaths.has(candidate.path));
    const group = { files, remaining: files.length, stableStates: [] };
    store.markIngestFilesReconcilePending(files.map((member) => member.path));
    store.beginTranscriptReconcile(affectedSessions);
    activeGroup = group;
    const siblings = files.filter((candidate) => candidate.path !== file.path);
    if (work === enumeration.files) work = [...work];
    work.splice(workIndex + 1, 0, ...siblings.map((sibling) => ({
      file: sibling,
      group,
    })));
    const itemOriginalIndex = enumeration.files.indexOf(file);
    suppressedPaths ??= new Set();
    for (const sibling of siblings) {
      if (enumeration.files.indexOf(sibling) > itemOriginalIndex) suppressedPaths.add(sibling.path);
    }
    return group;
  }

  try {
    for (let workIndex = 0; workIndex < work.length; workIndex += 1) {
    const item = work[workIndex];
    const file = item.group ? item.file : item;
    if (!item.group && suppressedPaths?.delete(file.path)) continue;
    const fileStat = fs.statSync(file.path);
    const ingestState = store.getIngestFileState(file.path);
    const sourceSessionId = ingestState?.sessionId || file.fallbackSessionId;
    let group = item.group || null;
    const sameStats = ingestState?.size === fileStat.size
      && ingestState.mtimeMs === fileStat.mtimeMs
      && ingestState.ino === fileStat.ino;
    const hasReconcileProvenance = Boolean(ingestState?.sessionId)
      && ingestState.recordCount != null;
    const shrinking = ingestState?.reconcilePending
      || (ingestState != null && (
        fileStat.size < ingestState.size
        || (hasReconcileProvenance && !sameStats && fileStat.size === ingestState.size)
      ));
    if (!group && shrinking) {
      group = beginReconcileGroup(file, sourceSessionId, workIndex);
    }
    if (!group
      && sameStats
      && ingestState.parser === TRANSCRIPT_PARSER
      && ingestState.parserVersion === TRANSCRIPT_PARSER_VERSION) {
      summary.filesSkipped += 1;
      continue;
    }
    let queuedFileSubagent = false;
    let fileAgentId = file.agentId;
    const input = fs.createReadStream(file.path, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
    const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    let lineNumber = 0;
    let recordCount = 0;
    let observedSessionId = null;
    let mixedSessionIds = false;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        linesSinceFlush += 1;
        if (!line.trim()) continue;
        recordCount += 1;
        let record;
        try { record = JSON.parse(line); }
        catch {
          warning(`skipped malformed JSON at ${file.relativePath}:${lineNumber}`);
          continue;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          warning(`skipped non-object JSON at ${file.relativePath}:${lineNumber}`);
          continue;
        }

        const sessionId = recordSessionId(record, file);
        if (!sessionId) continue;
        if (!group && ingestState && observedSessionId == null && sessionId !== sourceSessionId) {
          group = beginReconcileGroup(file, sourceSessionId, workIndex);
        }
        if (observedSessionId == null) observedSessionId = sessionId;
        else if (sessionId !== observedSessionId) mixedSessionIds = true;
        const timestamp = canonicalTimestamp(record.timestamp);
        queueSession(batch, sessionRecord(record, file, text(machine), sessionId, timestamp));

        if (file.isSubagent) {
          fileAgentId = text(record.agentId) || text(record.agent_id) || fileAgentId;
        }
        const currentFile = fileAgentId === file.agentId ? file : { ...file, agentId: fileAgentId };

        if (currentFile.isSubagent && currentFile.agentId && !queuedFileSubagent) {
          batch.subagents.push({
            agentId: currentFile.agentId,
            sessionId,
            profileSlug: currentFile.profileSlug,
            observedAt: timestamp,
          });
          queuedFileSubagent = true;
        }

        const synthetic = record?.message?.model === '<synthetic>';
        if (!synthetic) {
          const request = transcriptRequest(record, currentFile, sessionId, timestamp);
          if (request) batch.requests.push(request);
          else if ((record.type === 'assistant' || text(record.requestId))
              && text(record?.message?.model) && !timestamp) {
            warning(`skipped request record with invalid timestamp at ${file.relativePath}:${lineNumber}`);
          }

          const message = object(record.message);
          for (let blockIndex = 0; blockIndex < contentBlocks(message).length; blockIndex += 1) {
            const block = contentBlocks(message)[blockIndex];
            const invocation = agentInvocation(block);
            if (invocation) agentInvocations.set(invocation.toolUseId, invocation);
            if (block?.type === 'tool_use' && block.name === 'Skill') {
              const skill = text(object(block.input).skill) || text(object(block.input).name);
              if (skill && timestamp) {
                const stableId = text(block.id)
                  || `${text(record.uuid) || `${file.relativePath}:${lineNumber}`}:${blockIndex}`;
                batch.skills.push({
                  eventKey: `skill:${sessionId}:${stableId}`,
                  sessionId,
                  profileSlug: file.profileSlug,
                  skill,
                  observedAt: timestamp,
                });
              }
            }
          }

          if (record.type === 'user' && timestamp) {
            let commandIndex = 0;
            for (const value of commandText(message)) {
              COMMAND_NAME_PATTERN.lastIndex = 0;
              for (const match of value.matchAll(COMMAND_NAME_PATTERN)) {
                const commandName = text(match[1]);
                if (!commandName) continue;
                batch.skills.push({
                  eventKey: `command:${sessionId}:${text(record.uuid) || `${file.relativePath}:${lineNumber}`}:${commandIndex}`,
                  sessionId,
                  profileSlug: file.profileSlug,
                  commandName,
                  observedAt: timestamp,
                });
                commandIndex += 1;
              }
            }
          }

          const resultIds = toolResultIds(message);
          const matchingResultCount = resultIds
            .map((id) => agentInvocations.get(id))
            .filter(Boolean).length;
          const recordResult = object(record.toolUseResult || record.tool_use_result);
          const recordResultId = text(recordResult.toolUseId) || text(recordResult.tool_use_id);
          let queuedResult = false;
          for (const block of contentBlocks(message)) {
            if (block?.type !== 'tool_result') continue;
            const id = text(block.tool_use_id);
            const invocation = id ? agentInvocations.get(id) : null;
            if (!invocation) continue;
            const rollup = subagentRollup(
              record,
              currentFile,
              sessionId,
              timestamp,
              invocation,
              toolResultAgentId(block),
              recordResultId ? recordResultId === id : matchingResultCount === 1,
            );
            if (rollup) {
              batch.subagents.push(rollup);
              queuedResult = true;
            }
          }
          if (!queuedResult && matchingResultCount === 0
              && (record.toolUseResult || record.tool_use_result)) {
            const invocation = resultIds.map((id) => agentInvocations.get(id)).find(Boolean) || null;
            const rollup = subagentRollup(record, currentFile, sessionId, timestamp, invocation);
            if (rollup) batch.subagents.push(rollup);
          }
          if (resultIds.length) {
            for (const id of resultIds) agentInvocations.delete(id);
          }
        }

        if (linesSinceFlush >= batchLines) {
          batch = flushBatch(store, batch, summary, Boolean(group));
          linesSinceFlush = 0;
        }
      }
    } finally {
      try { lines.close(); }
      finally { input.destroy(); }
    }
    batch = flushBatch(store, batch, summary, Boolean(group));
    linesSinceFlush = 0;
    const finalStat = fs.statSync(file.path);
    const stable = finalStat.size === fileStat.size && finalStat.mtimeMs === fileStat.mtimeMs
      && finalStat.ino === fileStat.ino;
    const fileSessionId = observedSessionId != null && !mixedSessionIds
      ? observedSessionId
      : sourceSessionId;
    const shrankByRecords = !group && hasReconcileProvenance
      && recordCount < ingestState.recordCount;
    if (stable) {
      if (group) group.stableStates.push({ file, finalStat, recordCount, sessionId: fileSessionId });
      else if (shrankByRecords) {
        store.markIngestFileReconcilePending(file.path);
        if (work === enumeration.files) work = [...work];
        work.splice(workIndex + 1, 0, file);
      }
      else {
        store.recordIngestFileState(file.path, finalStat, {
          parser: TRANSCRIPT_PARSER,
          parserVersion: TRANSCRIPT_PARSER_VERSION,
          sessionId: fileSessionId,
          recordCount,
        });
      }
    } else if (shrankByRecords) {
      store.markIngestFileReconcilePending(file.path);
      if (work === enumeration.files) work = [...work];
      work.splice(workIndex + 1, 0, file);
    }
    if (group) {
      group.remaining -= 1;
      if (group.remaining === 0) {
        if (group.stableStates.length === group.files.length) {
          activeGroup = null;
          store.finishTranscriptReconcile();
          store.recordIngestFileStates(group.stableStates.map((stable) => ({
            filePath: stable.file.path,
            stat: stable.finalStat,
            sessionId: stable.sessionId,
            recordCount: stable.recordCount,
          })), {
            parser: TRANSCRIPT_PARSER,
            parserVersion: TRANSCRIPT_PARSER_VERSION,
          });
        } else {
          activeGroup = null;
          store.cancelTranscriptReconcile();
          store.markIngestFilesReconcilePending(group.files.map((member) => member.path));
        }
      }
    }
  }
  } catch (error) {
    if (activeGroup) {
      const files = activeGroup.files.map((member) => member.path);
      store.cancelTranscriptReconcile();
      store.markIngestFilesReconcilePending(files);
    }
    throw error;
  }
  flushBatch(store, batch, summary);
  return summary;
}
