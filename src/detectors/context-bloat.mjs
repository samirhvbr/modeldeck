import {
  attributionEvidence,
  diagnosticPointTotalInput,
  findingId,
  finiteTokens,
  hash,
  median,
} from './shared.mjs';

export const CONTEXT_BLOAT = 'context-bloat';
/** Corpus heuristics over measured input; none reads or represents a configured window. */
export const CONTEXT_BLOAT_THRESHOLDS = Object.freeze({
  windowDays: 7,
  minimumTurns: 4,
  minimumHighInputShare: 0.75,
  claudeMinimumAverageInputTokens: 150_000,
  codexMinimumAverageInputTokens: 200_000,
  grokMinimumAverageInputTokens: 200_000,
  codexLongContextInputTokens: 272_000,
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const FIX = 'start a fresh session when accumulated context no longer helps the task';
const BASIS = 'inferred from the measured turn distribution';

function explicitTokens(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
}

function roundedShare(part, whole) {
  return whole > 0 ? Number((part / whole).toFixed(6)) : 0;
}

function minimumAverageInputTokens(provider, thresholds) {
  if (provider === 'claude') return thresholds.claudeMinimumAverageInputTokens;
  if (provider === 'codex') return thresholds.codexMinimumAverageInputTokens;
  if (provider === 'grok') return thresholds.grokMinimumAverageInputTokens;
  return null;
}

/** Normalize the shared corpus points and Session Explorer contextTrend shape. */
function measuredTurns(session) {
  const points = Array.isArray(session.contextTrend) ? session.contextTrend : session.points;
  if (!Array.isArray(points)) return [];
  return points.flatMap((point, index) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return [];
    const at = point.at ?? point.observedAt;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return [];
    const cached = finiteTokens(point.cached ?? point.cacheReadTokens ?? point.cachedInputTokens);
    const cacheWrite = finiteTokens(point.cacheWrite ?? point.cacheWriteTokens ?? point.cacheWriteInputTokens);
    const explicitInput = explicitTokens(point.totalInput ?? point.inputTokens);
    const inputTokens = explicitInput ?? diagnosticPointTotalInput(
      point.uncached ?? point.uncachedInputTokens,
      cached,
    );
    return [{
      key: String(point.key ?? point.turnId ?? index),
      at: new Date(atMs).toISOString(),
      atMs,
      inputTokens,
      uncachedInputTokens: Math.max(0, inputTokens - cached),
      cacheReadTokens: Math.min(cached, inputTokens),
      cacheWriteTokens: cacheWrite,
    }];
  }).sort((left, right) => left.atMs - right.atMs || left.key.localeCompare(right.key));
}

function sessionEvidence(session, turns, providerWeekInputTokens, thresholds) {
  const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
  const avgInputTokens = inputTokens / turns.length;
  const minimumInput = minimumAverageInputTokens(session.provider, thresholds);
  const highInputTurns = turns.filter((turn) => turn.inputTokens >= minimumInput);
  if (turns.length < thresholds.minimumTurns) return null;
  if (avgInputTokens < minimumInput) return null;
  if (highInputTurns.length / turns.length < thresholds.minimumHighInputShare) return null;

  const longContextTurns = session.provider === 'codex'
    ? turns.filter((turn) => turn.inputTokens > thresholds.codexLongContextInputTokens)
    : [];
  return {
    provider: session.provider,
    profileSlug: session.profileSlug,
    sessionId: session.sessionId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...attributionEvidence(session),
    turnCount: turns.length,
    firstAt: turns[0].at,
    lastAt: turns.at(-1).at,
    avgInputTokens: Math.round(avgInputTokens),
    medianInputTokens: Math.round(median(turns.map((turn) => turn.inputTokens))),
    peakInputTokens: turns.reduce((peak, turn) => Math.max(peak, turn.inputTokens), 0),
    highInputTurnCount: highInputTurns.length,
    highInputTurnShare: roundedShare(highInputTurns.length, turns.length),
    inputTokens,
    uncachedInputTokens: turns.reduce((sum, turn) => sum + turn.uncachedInputTokens, 0),
    cacheReadTokens: turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0),
    cacheWriteTokens: turns.reduce((sum, turn) => sum + turn.cacheWriteTokens, 0),
    inputShareOfWeek: roundedShare(inputTokens, providerWeekInputTokens),
    ...(longContextTurns.length ? {
      longContextTurnCount: longContextTurns.length,
      longContextInputTokens: longContextTurns.reduce((sum, turn) => sum + turn.inputTokens, 0),
    } : {}),
  };
}

function providerFinding(provider, sessions, thresholds) {
  const latestAtMs = sessions.reduce(
    (latest, session) => session.turns.reduce((value, turn) => Math.max(value, turn.atMs), latest),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestAtMs)) return null;
  const windowStartedAtMs = latestAtMs - thresholds.windowDays * DAY_MS;
  const measured = sessions.map((session) => ({
    ...session,
    turns: session.turns.filter((turn) => turn.atMs >= windowStartedAtMs && turn.atMs <= latestAtMs),
  })).filter((session) => session.turns.length);
  const providerWeekInputTokens = measured.reduce(
    (sum, session) => sum + session.turns.reduce((turnSum, turn) => turnSum + turn.inputTokens, 0),
    0,
  );
  if (!(providerWeekInputTokens > 0)) return null;

  const affected = measured.flatMap((session) => {
    const evidence = sessionEvidence(session, session.turns, providerWeekInputTokens, thresholds);
    return evidence ? [evidence] : [];
  }).sort((left, right) => (
    right.inputTokens - left.inputTokens
      || left.profileSlug.localeCompare(right.profileSlug)
      || left.sessionId.localeCompare(right.sessionId)
      || String(left.agentId || '').localeCompare(String(right.agentId || ''))
  ));
  if (!affected.length) return null;

  const inputTokens = affected.reduce((sum, session) => sum + session.inputTokens, 0);
  const turnCount = affected.reduce((sum, session) => sum + session.turnCount, 0);
  const longContextTurnCount = affected.reduce(
    (sum, session) => sum + finiteTokens(session.longContextTurnCount),
    0,
  );
  const longContextInputTokens = affected.reduce(
    (sum, session) => sum + finiteTokens(session.longContextInputTokens),
    0,
  );
  const evidence = {
    provider,
    affectedSessions: affected.length,
    turnCount,
    avgInputTokens: Math.round(inputTokens / turnCount),
    inputTokens,
    providerWeekInputTokens,
    inputShareOfWeek: roundedShare(inputTokens, providerWeekInputTokens),
    windowStartedAt: new Date(windowStartedAtMs).toISOString(),
    windowEndedAt: new Date(latestAtMs).toISOString(),
    basis: BASIS,
    fix: FIX,
    ...(longContextTurnCount ? {
      longContextMultiplier: {
        thresholdInputTokens: thresholds.codexLongContextInputTokens,
        turnCount: longContextTurnCount,
        inputTokens: longContextInputTokens,
        inputMultiplier: 2,
        outputMultiplier: 1.5,
        appliesToWholeRequest: true,
      },
    } : {}),
    sessions: affected,
  };
  const scopeKey = `provider:${provider}`;
  const corpusFingerprint = hash(JSON.stringify(measured.map((session) => ({
    provider: session.provider,
    profileSlug: session.profileSlug,
    sessionId: session.sessionId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    turns: session.turns.map((turn) => ({
      key: turn.key,
      at: turn.at,
      inputTokens: turn.inputTokens,
      uncachedInputTokens: turn.uncachedInputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
    })),
  }))));
  return {
    id: findingId(CONTEXT_BLOAT, scopeKey),
    scopeKey,
    corpusFingerprint,
    evidence,
  };
}

export const contextBloatDetector = Object.freeze({
  kind: CONTEXT_BLOAT,
  thresholds: CONTEXT_BLOAT_THRESHOLDS,
  detect(corpus) {
    if (!Array.isArray(corpus?.sessions)) return [];
    const byProvider = new Map();
    for (const session of corpus.sessions) {
      if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
      if (minimumAverageInputTokens(session.provider, this.thresholds) == null) continue;
      const turns = measuredTurns(session);
      if (!turns.length) continue;
      if (!byProvider.has(session.provider)) byProvider.set(session.provider, []);
      byProvider.get(session.provider).push({
        provider: session.provider,
        profileSlug: String(session.profileSlug || ''),
        sessionId: String(session.sessionId || ''),
        ...(session.agentId ? { agentId: session.agentId } : {}),
        attribution: session.attribution,
        turns,
      });
    }
    return [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([provider, sessions]) => {
        const finding = providerFinding(provider, sessions, this.thresholds);
        return finding ? [finding] : [];
      });
  },
});
