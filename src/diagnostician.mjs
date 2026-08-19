import path from 'node:path';
import { RATE_PATHOLOGY_DETECTORS } from './rate-pathologies.mjs';
import { contextBloatDetector } from './detectors/context-bloat.mjs';
import {
  attributionEvidence,
  diagnosticPointTotalInput,
  emptyAttribution,
  findingId,
  finiteTokens,
  hash,
  median,
  noteAttribution,
} from './detectors/shared.mjs';

export {
  CONTEXT_BLOAT,
  CONTEXT_BLOAT_THRESHOLDS,
  contextBloatDetector,
} from './detectors/context-bloat.mjs';
export { findingId };
export { attributionEvidence, emptyAttribution, mergeAttribution, noteAttribution } from './detectors/shared.mjs';

export const COLD_CACHE_CHURN = 'cold-cache-churn';
export const COLD_CACHE_CHURN_THRESHOLDS = Object.freeze({
  minimumRequests: 4,
  minimumCadenceMs: 300_000,
  maximumCadenceMs: 420_000,
  maximumCadenceSpreadMs: 60_000,
  maximumCandidateRequests: 64,
  minimumBaselineCacheReadShare: 0.5,
  maximumCacheReadShare: 0.1,
  minimumAverageCacheWriteTokens: 20_000,
  minimumAverageUncachedTokens: 20_000,
  minimumUncachedIncreaseTokens: 20_000,
  minimumEstimatedExcessUncachedTokens: 50_000,
});
export const DIAGNOSTIC_CORPUS_BATCH_SIZE = 500;
export const DIAGNOSTIC_CORPUS_MAX_ROWS_PER_PROVIDER = 100_000;

const FIX = 'keep check-ins under the cache TTL';

function addSession(sessions, identity, streamKey = 'main') {
  const key = `${identity.provider}\0${identity.profileSlug}\0${identity.sessionId}\0${streamKey}`;
  if (!sessions.has(key)) {
    sessions.set(key, { ...identity, points: [], attribution: emptyAttribution() });
  }
  return sessions.get(key);
}

function legacySessionFingerprint(session) {
  return hash(JSON.stringify({
    provider: session.provider,
    profileSlug: session.profileSlug,
    sessionId: session.sessionId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    points: session.points.map((point) => ({
      key: point.key,
      at: point.at,
      uncached: point.uncached,
      cached: point.cached,
      cacheWrite: point.cacheWrite,
      totalInput: point.totalInput,
    })),
  }));
}

async function readBoundedRows({
  firstBatch,
  nextBatch,
  queryParameters = [],
  totalRows,
  maximumRows,
  batchSize,
  yieldToServeLoop,
  consume,
}) {
  let cursor = null;
  let included = 0;
  const target = Math.min(totalRows, maximumRows);
  while (included < target) {
    const limit = Math.min(batchSize, target - included);
    const rows = cursor == null
      ? firstBatch.all(...queryParameters, limit)
      : nextBatch.all(...queryParameters, cursor, limit);
    if (!rows.length) break;
    for (const row of rows) consume(row);
    included += rows.length;
    cursor = rows.at(-1).id;
    if (rows.length < limit) break;
    if (included < target) await yieldToServeLoop();
  }
  return included;
}

/**
 * Read only the daemon-owned, ingested provider corpus into one shape.
 * Point totalInput preserves the provider's full input after provider-specific
 * cached subsets are split out.
 */
export async function readDiagnosticCorpus(store, {
  maximumRowsPerProvider = DIAGNOSTIC_CORPUS_MAX_ROWS_PER_PROVIDER,
  batchSize = DIAGNOSTIC_CORPUS_BATCH_SIZE,
  yieldToServeLoop = () => new Promise((resolve) => setImmediate(resolve)),
  logger = (message) => console.log(`[modeldeck] ${message}`),
} = {}) {
  if (!store?.db) throw new Error('diagnostician requires a Store');
  if (!Number.isInteger(maximumRowsPerProvider)
      || maximumRowsPerProvider < 1
      || maximumRowsPerProvider > DIAGNOSTIC_CORPUS_MAX_ROWS_PER_PROVIDER) {
    throw new Error(`diagnostician maximumRowsPerProvider must be an integer from 1 to ${DIAGNOSTIC_CORPUS_MAX_ROWS_PER_PROVIDER}`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > DIAGNOSTIC_CORPUS_BATCH_SIZE) {
    throw new Error(`diagnostician batchSize must be an integer from 1 to ${DIAGNOSTIC_CORPUS_BATCH_SIZE}`);
  }
  if (typeof yieldToServeLoop !== 'function') throw new Error('diagnostician yieldToServeLoop must be a function');
  if (typeof logger !== 'function') throw new Error('diagnostician logger must be a function');
  const sessions = new Map();
  const joinedWireIds = new Set();
  const claudeCounts = store.db.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COALESCE(SUM(CASE
        WHEN is_sidechain = 1 AND (agent_id IS NULL OR agent_id = '') THEN 1
        ELSE 0
      END), 0) AS skipped_unknown_sidechain_rows
    FROM transcript_requests
  `).get();
  const claudeRows = `
    SELECT
      r.id, r.dedupe_key, r.session_id, r.profile_slug, r.observed_at,
      r.input_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens,
      r.output_tokens, r.is_sidechain, r.agent_id,
      w.id AS wire_id, w.failed AS wire_failed,
      w.status_code AS wire_status_code, w.total AS wire_total,
      w.profile_label AS wire_profile_label
    FROM transcript_requests r
    LEFT JOIN request_usage w
      ON r.request_id IS NOT NULL
      AND w.request_id = r.request_id
      AND w.provider = 'claude'
    WHERE NOT (r.is_sidechain = 1 AND (r.agent_id IS NULL OR r.agent_id = ''))
  `;
  const skippedUnknownSidechainRows = Number(claudeCounts.skipped_unknown_sidechain_rows || 0);
  if (skippedUnknownSidechainRows > 0) {
    logger(`diagnostician corpus skipped provider=claude reason=sidechain-missing-agent-id rows=${skippedUnknownSidechainRows}`);
  }
  const eligibleClaudeRows = Number(claudeCounts.total_rows || 0) - skippedUnknownSidechainRows;
  const includedClaudeRows = await readBoundedRows({
    firstBatch: store.db.prepare(`${claudeRows} ORDER BY r.id DESC LIMIT ?`),
    nextBatch: store.db.prepare(`${claudeRows} AND r.id < ? ORDER BY r.id DESC LIMIT ?`),
    totalRows: eligibleClaudeRows,
    maximumRows: maximumRowsPerProvider,
    batchSize,
    yieldToServeLoop,
    consume(row) {
      const agentId = row.agent_id || null;
      const session = addSession(sessions, {
        provider: 'claude',
        profileSlug: row.profile_slug,
        sessionId: row.session_id,
        ...(agentId ? { agentId } : {}),
      }, agentId ? `agent:${agentId}` : 'main');
      const fresh = finiteTokens(row.input_tokens);
      const cached = finiteTokens(row.cache_read_input_tokens);
      const cacheWrite = finiteTokens(row.cache_creation_input_tokens);
      const uncached = fresh + cacheWrite;
      const output = finiteTokens(row.output_tokens);
      const corpusTokens = uncached + cached + output;
      const point = {
        key: row.dedupe_key,
        at: row.observed_at,
        uncached,
        cached,
        cacheWrite,
        output,
        totalInput: diagnosticPointTotalInput(uncached, cached),
        tokens: row.wire_id != null && finiteTokens(row.wire_total) > 0
          ? finiteTokens(row.wire_total)
          : corpusTokens,
      };
      if (row.wire_id != null) {
        joinedWireIds.add(Number(row.wire_id));
        point.failed = Boolean(row.wire_failed);
        point.statusCode = row.wire_status_code == null ? null : Number(row.wire_status_code);
        // Attribution rides the SESSION, never the point: every corpus
        // fingerprint enumerates point fields, and a new one there would
        // re-revision every open finding (#524).
        noteAttribution(session.attribution, row.wire_profile_label);
      }
      session.points.push(point);
    },
  });
  if (eligibleClaudeRows > includedClaudeRows) {
    logger(`diagnostician corpus capped provider=claude included=${includedClaudeRows} omitted=${eligibleClaudeRows - includedClaudeRows}`);
  }

  const codexRows = `
    SELECT
      t.id, t.turn_index, t.turn_id, t.session_id, c.profile_slug, t.timestamp,
      t.input_tokens, t.cached_input_tokens, t.cache_write_input_tokens,
      t.output_tokens, t.total_tokens,
      w.id AS wire_id, w.failed AS wire_failed,
      w.status_code AS wire_status_code, w.total AS wire_total,
      w.profile_label AS wire_profile_label
    FROM codex_turns t
    JOIN codex_sessions c ON c.session_id = t.session_id
    LEFT JOIN request_usage w
      ON t.turn_id IS NOT NULL
      AND w.request_id = t.turn_id
      AND w.provider = 'codex'
  `;
  const totalCodexRows = Number(store.db.prepare('SELECT COUNT(*) AS count FROM codex_turns').get().count || 0);
  const includedCodexRows = await readBoundedRows({
    firstBatch: store.db.prepare(`${codexRows} ORDER BY t.id DESC LIMIT ?`),
    nextBatch: store.db.prepare(`${codexRows} WHERE t.id < ? ORDER BY t.id DESC LIMIT ?`),
    totalRows: totalCodexRows,
    maximumRows: maximumRowsPerProvider,
    batchSize,
    yieldToServeLoop,
    consume(row) {
      const session = addSession(sessions, {
        provider: 'codex',
        profileSlug: row.profile_slug,
        sessionId: row.session_id,
      });
      const input = finiteTokens(row.input_tokens);
      const cached = finiteTokens(row.cached_input_tokens);
      const cacheWrite = finiteTokens(row.cache_write_input_tokens);
      const uncached = Math.max(0, input - cached) + cacheWrite;
      const output = finiteTokens(row.output_tokens);
      const corpusTokens = Math.max(
        finiteTokens(row.total_tokens),
        uncached + cached + output,
      );
      const point = {
        key: row.turn_id || `turn:${row.turn_index}`,
        at: row.timestamp,
        uncached,
        cached,
        cacheWrite,
        output,
        totalInput: diagnosticPointTotalInput(uncached, cached),
        tokens: row.wire_id != null && finiteTokens(row.wire_total) > 0
          ? finiteTokens(row.wire_total)
          : corpusTokens,
      };
      if (row.wire_id != null) {
        joinedWireIds.add(Number(row.wire_id));
        point.failed = Boolean(row.wire_failed);
        point.statusCode = row.wire_status_code == null ? null : Number(row.wire_status_code);
        // Attribution rides the SESSION, never the point: every corpus
        // fingerprint enumerates point fields, and a new one there would
        // re-revision every open finding (#524).
        noteAttribution(session.attribution, row.wire_profile_label);
      }
      session.points.push(point);
    },
  });
  if (totalCodexRows > includedCodexRows) {
    logger(`diagnostician corpus capped provider=codex included=${includedCodexRows} omitted=${totalCodexRows - includedCodexRows}`);
  }

  const grokRows = `
    SELECT
      t.id, t.turn_index, t.turn_id, t.session_id, g.profile_slug, t.timestamp,
      t.input_tokens, t.cached_read_tokens, t.cache_creation_tokens,
      t.output_tokens, t.total_tokens
    FROM grok_turns t
    JOIN grok_sessions g ON g.session_id = t.session_id
  `;
  const totalGrokRows = Number(store.db.prepare('SELECT COUNT(*) AS count FROM grok_turns').get().count || 0);
  const includedGrokRows = await readBoundedRows({
    firstBatch: store.db.prepare(`${grokRows} ORDER BY t.id DESC LIMIT ?`),
    nextBatch: store.db.prepare(`${grokRows} WHERE t.id < ? ORDER BY t.id DESC LIMIT ?`),
    totalRows: totalGrokRows,
    maximumRows: maximumRowsPerProvider,
    batchSize,
    yieldToServeLoop,
    consume(row) {
      const session = addSession(sessions, {
        provider: 'grok',
        profileSlug: row.profile_slug,
        sessionId: row.session_id,
      });
      const input = finiteTokens(row.input_tokens);
      const cached = finiteTokens(row.cached_read_tokens);
      const cacheWrite = finiteTokens(row.cache_creation_tokens);
      // Grok input is inclusive of both cached reads and cache creation, so
      // subtract each subset once to leave only fresh input.
      const uncached = Math.max(0, input - cached - cacheWrite);
      const output = finiteTokens(row.output_tokens);
      session.points.push({
        key: row.turn_id || `turn:${row.turn_index}`,
        at: row.timestamp,
        uncached,
        cached,
        cacheWrite,
        output,
        totalInput: input,
        tokens: Math.max(finiteTokens(row.total_tokens), input + output),
      });
    },
  });
  if (totalGrokRows > includedGrokRows) {
    logger(`diagnostician corpus capped provider=grok included=${includedGrokRows} omitted=${totalGrokRows - includedGrokRows}`);
  }

  const wireFailures = [];
  const wireRows = `
    SELECT
      ru.id, ru.observed_at, ru.provider, ru.failed, ru.status_code,
      ru.input_uncached, ru.input_cache_read, ru.input_cache_write,
      ru.output_total, ru.total, ru.profile_label, a.profile_ref
    FROM request_usage ru
    LEFT JOIN accounts a ON a.id = ru.account_id
    WHERE ru.provider = ? AND (ru.failed = 1 OR ru.status_code = 429)
  `;
  for (const provider of ['claude', 'codex']) {
    const totalWireRows = Number(store.db.prepare(`
      SELECT COUNT(*) AS count FROM request_usage
      WHERE provider = ? AND (failed = 1 OR status_code = 429)
    `).get(provider).count || 0);
    const includedWireRows = await readBoundedRows({
      firstBatch: store.db.prepare(`${wireRows} ORDER BY ru.id DESC LIMIT ?`),
      nextBatch: store.db.prepare(`${wireRows} AND ru.id < ? ORDER BY ru.id DESC LIMIT ?`),
      queryParameters: [provider],
      totalRows: totalWireRows,
      maximumRows: maximumRowsPerProvider,
      batchSize,
      yieldToServeLoop,
      consume(row) {
        if (joinedWireIds.has(Number(row.id))) return;
        const fresh = finiteTokens(row.input_uncached);
        const cached = finiteTokens(row.input_cache_read);
        const cacheWrite = finiteTokens(row.input_cache_write);
        const uncached = fresh + cacheWrite;
        const output = finiteTokens(row.output_total);
        const corpusTokens = uncached + cached + output;
        const profileSlug = row.profile_ref ? path.basename(String(row.profile_ref)) : null;
        wireFailures.push({
          key: `wire:${row.id}`,
          wireId: Number(row.id),
          provider: row.provider,
          profileSlug: profileSlug || null,
          // A wire failure is a keyed request by construction, so it always
          // carries an attribution verdict — NULL included (#524).
          attribution: noteAttribution(emptyAttribution(), row.profile_label),
          at: row.observed_at,
          uncached,
          cached,
          cacheWrite,
          output,
          totalInput: uncached + cached,
          tokens: finiteTokens(row.total) > 0 ? finiteTokens(row.total) : corpusTokens,
          failed: Boolean(row.failed),
          statusCode: row.status_code == null ? null : Number(row.status_code),
        });
      },
    });
    if (totalWireRows > includedWireRows) {
      logger(`diagnostician corpus capped source=wire provider=${provider} included=${includedWireRows} omitted=${totalWireRows - includedWireRows}`);
    }
  }
  wireFailures.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)
    || left.key.localeCompare(right.key));

  const output = [];
  for (const session of sessions.values()) {
    session.points = session.points
      .filter((point) => Number.isFinite(Date.parse(point.at)))
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.key.localeCompare(right.key));
    session.corpusFingerprint = legacySessionFingerprint(session);
    output.push(session);
  }
  output.sort((left, right) => (
    left.provider.localeCompare(right.provider)
      || left.profileSlug.localeCompare(right.profileSlug)
      || left.sessionId.localeCompare(right.sessionId)
      || String(left.agentId || '').localeCompare(String(right.agentId || ''))
  ));
  return { sessions: output, wireFailures };
}

function coldCacheEvidence(session, thresholds) {
  let best = null;
  const { points } = session;
  const times = points.map((point) => Date.parse(point.at));
  for (let start = 0; start + thresholds.minimumRequests <= points.length; start += 1) {
    const baseline = points[start];
    const baselineInput = baseline.uncached + baseline.cached;
    const baselineCacheReadShare = baselineInput > 0 ? baseline.cached / baselineInput : 0;

    let minimumInterval = Number.POSITIVE_INFINITY;
    let maximumInterval = Number.NEGATIVE_INFINITY;
    let repeatedUncached = 0;
    let repeatedCached = 0;
    let repeatedCacheWrite = 0;
    let estimatedExcessUncachedTokens = 0;
    const maximumEnd = Math.min(
      points.length - 1,
      start + thresholds.maximumCandidateRequests - 1,
    );
    for (let end = start + 1; end <= maximumEnd; end += 1) {
      const interval = times[end] - times[end - 1];
      if (interval < thresholds.minimumCadenceMs || interval > thresholds.maximumCadenceMs) break;
      minimumInterval = Math.min(minimumInterval, interval);
      maximumInterval = Math.max(maximumInterval, interval);
      if (maximumInterval - minimumInterval > thresholds.maximumCadenceSpreadMs) break;

      repeatedUncached += points[end].uncached;
      repeatedCached += points[end].cached;
      repeatedCacheWrite += points[end].cacheWrite;
      estimatedExcessUncachedTokens += Math.min(points[end].uncached, points[end - 1].totalInput);
      const repeatedRequests = end - start;
      if (repeatedRequests + 1 < thresholds.minimumRequests) continue;

      const repeatInput = repeatedUncached + repeatedCached;
      const repeatedCacheReadShare = repeatInput > 0 ? repeatedCached / repeatInput : 0;
      const averageRepeatedUncachedTokens = repeatedUncached / repeatedRequests;
      const averageUncachedIncreaseTokens = averageRepeatedUncachedTokens - baseline.uncached;
      const averageRepeatedCacheWriteTokens = repeatedCacheWrite / repeatedRequests;
      if (repeatedCacheReadShare > thresholds.maximumCacheReadShare) continue;
      if (averageRepeatedUncachedTokens < thresholds.minimumAverageUncachedTokens) continue;
      const warmCacheCollapsed = baselineCacheReadShare >= thresholds.minimumBaselineCacheReadShare
        && averageUncachedIncreaseTokens >= thresholds.minimumUncachedIncreaseTokens;
      const recurringCacheRebuild = baseline.cacheWrite >= thresholds.minimumAverageCacheWriteTokens
        && averageRepeatedCacheWriteTokens >= thresholds.minimumAverageCacheWriteTokens;
      if (!warmCacheCollapsed && !recurringCacheRebuild) continue;
      if (estimatedExcessUncachedTokens < thresholds.minimumEstimatedExcessUncachedTokens) continue;

      const metrics = {
        baselineCacheReadShare,
        repeatedCacheReadShare,
        averageUncachedIncreaseTokens,
        repeatedCacheWrite,
        estimatedExcessUncachedTokens: Math.round(estimatedExcessUncachedTokens),
      };
      const requestCount = repeatedRequests + 1;
      if (!best
        || metrics.estimatedExcessUncachedTokens > best.metrics.estimatedExcessUncachedTokens
        || (metrics.estimatedExcessUncachedTokens === best.metrics.estimatedExcessUncachedTokens
          && requestCount > best.requestCount)) {
        best = { start, end, requestCount, metrics };
      }
    }
  }
  if (!best) return null;
  const bestPoints = points.slice(best.start, best.end + 1);
  const baseline = bestPoints[0];
  const repeated = bestPoints.slice(1);
  const intervals = repeated.map((_, index) => times[best.start + index + 1] - times[best.start + index]);
  const uncachedInputTokens = repeated.reduce((sum, point) => sum + point.uncached, 0);
  const cacheReadTokens = repeated.reduce((sum, point) => sum + point.cached, 0);
  return {
    provider: session.provider,
    profileSlug: session.profileSlug,
    sessionId: session.sessionId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...attributionEvidence(session),
    requestCount: best.requestCount,
    firstAt: bestPoints[0].at,
    lastAt: bestPoints.at(-1).at,
    medianCadenceSeconds: median(intervals) / 1_000,
    baselineUncachedInputTokens: baseline.uncached,
    baselineCacheReadTokens: baseline.cached,
    baselineCacheReadShare: Number(best.metrics.baselineCacheReadShare.toFixed(6)),
    uncachedInputTokens,
    cacheReadTokens,
    cacheReadShare: Number(best.metrics.repeatedCacheReadShare.toFixed(6)),
    ...(best.metrics.repeatedCacheWrite > 0
      ? { cacheWriteTokens: Math.round(best.metrics.repeatedCacheWrite) }
      : {}),
    averageUncachedIncreaseTokens: Math.round(best.metrics.averageUncachedIncreaseTokens),
    estimatedExcessUncachedTokens: best.metrics.estimatedExcessUncachedTokens,
  };
}

export const coldCacheChurnDetector = Object.freeze({
  kind: COLD_CACHE_CHURN,
  thresholds: COLD_CACHE_CHURN_THRESHOLDS,
  detect(corpus) {
    const affected = [];
    for (const session of corpus.sessions) {
      const evidence = coldCacheEvidence(session, this.thresholds);
      if (evidence) affected.push({ evidence, corpusFingerprint: session.corpusFingerprint });
    }
    if (!affected.length) return [];
    affected.sort((left, right) => (
      right.evidence.estimatedExcessUncachedTokens - left.evidence.estimatedExcessUncachedTokens
        || left.evidence.provider.localeCompare(right.evidence.provider)
        || left.evidence.profileSlug.localeCompare(right.evidence.profileSlug)
        || left.evidence.sessionId.localeCompare(right.evidence.sessionId)
        || String(left.evidence.agentId || '').localeCompare(String(right.evidence.agentId || ''))
    ));
    const scopeKey = 'all-affected-sessions';
    const affectedSessionKeys = new Set(affected.map(({ evidence }) => (
      `${evidence.provider}\0${evidence.profileSlug}\0${evidence.sessionId}`
    )));
    return [{
      id: findingId(this.kind, scopeKey),
      scopeKey,
      corpusFingerprint: hash(affected.map((entry) => entry.corpusFingerprint).sort().join('\0')),
      evidence: {
        affectedSessions: affectedSessionKeys.size,
        estimatedExcessUncachedTokens: affected.reduce(
          (sum, entry) => sum + entry.evidence.estimatedExcessUncachedTokens,
          0,
        ),
        fix: FIX,
        sessions: affected.map((entry) => entry.evidence),
      },
    }];
  },
});

export const DIAGNOSTIC_DETECTORS = Object.freeze([
  coldCacheChurnDetector,
  contextBloatDetector,
  ...RATE_PATHOLOGY_DETECTORS,
]);

function diagnosticBound(value, name) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`finding ${name} must be an ISO timestamp`);
  return parsed;
}

/** Narrow session-backed receipts without mutating their persisted suppression state. */
export function scopeFindings(findings, { provider = null, since = null, until = null } = {}) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array');
  if (provider != null && provider !== '' && !['claude', 'codex', 'grok'].includes(provider)) {
    throw new Error('finding provider must be claude, codex, or grok');
  }
  provider = provider || null;
  since = diagnosticBound(since, 'since');
  until = diagnosticBound(until, 'until');
  if (since != null && until != null && since >= until) {
    throw new Error('finding since must be earlier than until');
  }
  if (provider == null && since == null && until == null) return findings;

  const scoped = [];
  for (const finding of findings) {
    const evidence = finding?.evidence;
    if (!evidence || !Array.isArray(evidence.sessions)) continue;
    const sessions = evidence.sessions.filter((session) => {
      if (!session || typeof session !== 'object' || Array.isArray(session)) return false;
      if (provider && session.provider !== provider) return false;
      const firstAt = Date.parse(session.firstAt);
      const lastAt = Date.parse(session.lastAt);
      if (since != null && (!Number.isFinite(lastAt) || lastAt < since)) return false;
      if (until != null && (!Number.isFinite(firstAt) || firstAt >= until)) return false;
      return true;
    });
    if (!sessions.length) continue;
    const affectedSessions = new Set(sessions.map((session) => (
      `${session.provider}\0${session.profileSlug}\0${session.sessionId}`
    ))).size;
    const scopedEvidence = { ...evidence, affectedSessions, sessions };
    if (Object.hasOwn(evidence, 'estimatedExcessUncachedTokens')) {
      scopedEvidence.estimatedExcessUncachedTokens = sessions.reduce(
        (sum, session) => sum + finiteTokens(session.estimatedExcessUncachedTokens),
        0,
      );
    }
    if (Object.hasOwn(evidence, 'tokensBurned')) {
      scopedEvidence.tokensBurned = sessions.reduce(
        (sum, session) => sum + finiteTokens(session.tokensBurned),
        0,
      );
    }
    scoped.push({ ...finding, evidence: scopedEvidence });
  }
  return scoped;
}

/**
 * Detector interface: { kind, thresholds, detect(corpus) -> finding candidates }.
 * The runner supplies the shared ingested corpus and the generic Store owns
 * stable-id/revision suppression; pathology-specific code owns neither.
 */
export async function runDetectors({
  store,
  detectors = DIAGNOSTIC_DETECTORS,
  logger = (message) => console.log(`[modeldeck] ${message}`),
  detectedAt,
  maximumRowsPerProvider,
  batchSize,
  yieldToServeLoop,
} = {}) {
  if (!store?.syncFindings) throw new Error('diagnostician requires a Store');
  if (!Array.isArray(detectors)) throw new Error('diagnostician detectors must be an array');
  const corpus = await readDiagnosticCorpus(store, {
    logger,
    ...(maximumRowsPerProvider == null ? {} : { maximumRowsPerProvider }),
    ...(batchSize == null ? {} : { batchSize }),
    ...(yieldToServeLoop == null ? {} : { yieldToServeLoop }),
  });
  const summary = {
    detectors: detectors.length,
    findings: 0,
    inserted: 0,
    updated: 0,
    resolved: 0,
    unchanged: 0,
  };
  const kinds = new Set();
  for (const detector of detectors) {
    if (!detector || typeof detector.kind !== 'string' || typeof detector.detect !== 'function') {
      throw new Error('invalid diagnostician detector');
    }
    if (kinds.has(detector.kind)) throw new Error(`duplicate diagnostician detector: ${detector.kind}`);
    kinds.add(detector.kind);
    logger(`diagnostician detector=${detector.kind} thresholds=${JSON.stringify(detector.thresholds || {})}`);
    const findings = detector.detect(corpus);
    const synced = store.syncFindings(detector.kind, findings, {
      ...(detectedAt ? { detectedAt } : {}),
    });
    summary.findings += findings.length;
    for (const key of ['inserted', 'updated', 'resolved', 'unchanged']) summary[key] += synced[key];
  }
  return summary;
}

export async function runDiagnostician(options) {
  return runDetectors(options);
}
