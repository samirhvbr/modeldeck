import {
  attributionEvidence,
  emptyAttribution,
  findingId,
  finiteTokens as finite,
  hash,
  median,
  mergeAttribution,
} from './detectors/shared.mjs';

export const RETRY_STORM = 'retry-storm';
export const SWARM_BURST = 'swarm-burst';

export const RETRY_STORM_THRESHOLDS = Object.freeze({
  minimumBaselineIntervals: 5,
  maximumBaselineIntervals: 32,
  minimumFailureRequests: 3,
  minimumCadenceMultiple: 8,
  maximumFallbackOutputShare: 0.1,
});

export const SWARM_BURST_THRESHOLDS = Object.freeze({
  minimumBaselineIntervals: 5,
  maximumBaselineIntervals: 32,
  minimumBurstRequests: 6,
  minimumRequestRateMultiple: 8,
  maximumFailedRequestShare: 0.2,
  maximumFallbackOutputShare: 0.1,
});

const RETRY_FIX = 'wait for the rate-limit window instead of retrying immediately';
const SWARM_FIX = 'cap concurrent agents near the session\'s normal request rate';

function pointTokens(point) {
  if (point.tokens != null && Number.isFinite(Number(point.tokens))) return finite(point.tokens);
  return finite(point.uncached) + finite(point.cached) + finite(point.output);
}

function wireStatus(point) {
  const value = point.statusCode ?? point.status_code;
  if (value == null || value === '') return null;
  const statusCode = Number(value);
  return Number.isInteger(statusCode) && statusCode >= 0 ? statusCode : null;
}

function wireFailureValue(point) {
  if (typeof point.failed === 'boolean') return point.failed;
  if (point.failed === 0 || point.failed === 1) return Boolean(point.failed);
  return null;
}

function failureShape(point, baselineOutput, maximumFallbackOutputShare) {
  const failed = wireFailureValue(point);
  const statusCode = wireStatus(point);
  if (failed != null || statusCode != null) {
    return {
      failed: failed === true || (statusCode != null && statusCode >= 400),
      signalGrade: 'wire',
      rateLimited: statusCode === 429,
      statusCode,
    };
  }
  return {
    failed: baselineOutput > 0
      && finite(point.output) <= baselineOutput * maximumFallbackOutputShare,
    signalGrade: 'corpus',
    rateLimited: false,
    statusCode: null,
  };
}

function baseline(points, start, thresholds) {
  const first = Math.max(0, start - thresholds.maximumBaselineIntervals - 1);
  const prior = points.slice(first, start);
  return baselineFromPrior(prior, thresholds);
}

function baselineFromPrior(prior, thresholds) {
  const intervals = [];
  for (let index = 1; index < prior.length; index += 1) {
    const interval = prior[index].atMs - prior[index - 1].atMs;
    if (interval > 0) intervals.push(interval);
  }
  if (intervals.length < thresholds.minimumBaselineIntervals) return null;
  return {
    cadenceMs: median(intervals),
    outputTokens: median(prior.map((point) => finite(point.output))),
  };
}

function comparePoints(left, right) {
  return left.atMs - right.atMs
    || String(left.key || '').localeCompare(String(right.key || ''));
}

function latestPointIndex(points, atMs) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].atMs <= atMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function evidenceIdentity(session) {
  return {
    provider: session.provider,
    profileSlug: session.profileSlug,
    sessionId: session.sessionId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...attributionEvidence(session),
  };
}

function followsSessionBaseline(session, attributedPoints, baselineCache, atMs) {
  let sessionPointIndex = latestPointIndex(session.points, atMs);
  let attributedPointIndex = attributedPoints.length - 1;
  const cacheKey = `${sessionPointIndex}\0${attributedPointIndex}`;
  let cached = baselineCache.get(cacheKey);
  if (!cached) {
    const prior = [];
    const maximumPoints = RETRY_STORM_THRESHOLDS.maximumBaselineIntervals + 1;
    while (prior.length < maximumPoints
      && (sessionPointIndex >= 0 || attributedPointIndex >= 0)) {
      const sessionPoint = session.points[sessionPointIndex];
      const attributedPoint = attributedPoints[attributedPointIndex];
      if (attributedPoint && (!sessionPoint || comparePoints(attributedPoint, sessionPoint) >= 0)) {
        prior.push(attributedPoint);
        attributedPointIndex -= 1;
      } else {
        prior.push(sessionPoint);
        sessionPointIndex -= 1;
      }
    }
    prior.reverse();
    cached = {
      latestPrior: prior.at(-1),
      baselineMetrics: baselineFromPrior(prior, RETRY_STORM_THRESHOLDS),
    };
    baselineCache.set(cacheKey, cached);
  }
  const { latestPrior, baselineMetrics } = cached;
  if (!baselineMetrics || baselineMetrics.cadenceMs <= 0) return false;
  return atMs - latestPrior.atMs <= baselineMetrics.cadenceMs;
}

function rateSessions(corpus) {
  const grouped = new Map();
  for (const session of Array.isArray(corpus?.sessions) ? corpus.sessions : []) {
    const key = `${session.provider}\0${session.profileSlug}\0${session.sessionId}`;
    if (!grouped.has(key)) grouped.set(key, {
      provider: session.provider,
      profileSlug: session.profileSlug,
      sessionId: session.sessionId,
      points: [],
      attribution: emptyAttribution(),
    });
    const target = grouped.get(key);
    // Agent streams are separate corpus sessions but one receipt row here, so
    // their attribution folds together (#524).
    mergeAttribution(target.attribution, session.attribution);
    if (Array.isArray(session.points)) {
      for (const point of session.points) {
        const atMs = Date.parse(point?.at);
        if (Number.isFinite(atMs)) target.points.push({ ...point, atMs });
      }
    }
  }
  const sessions = [...grouped.values()];
  for (const session of sessions) {
    session.points.sort(comparePoints);
  }

  const sessionsByProvider = new Map();
  const sessionsByProviderProfile = new Map();
  const attributedBySession = new Map();
  const baselineCacheBySession = new Map();
  for (const session of sessions) {
    if (!sessionsByProvider.has(session.provider)) sessionsByProvider.set(session.provider, []);
    sessionsByProvider.get(session.provider).push(session);
    const profileKey = `${session.provider}\0${session.profileSlug}`;
    if (!sessionsByProviderProfile.has(profileKey)) sessionsByProviderProfile.set(profileKey, []);
    sessionsByProviderProfile.get(profileKey).push(session);
    attributedBySession.set(session, []);
    baselineCacheBySession.set(session, new Map());
  }

  // A wire failure's attribution is kept OFF the point it becomes: these
  // objects are pushed into `session.points`, and the corpus fingerprint hashes
  // whole points — a new field there would re-revision every open finding
  // (#524). It is folded into the session instead, once the failure is
  // attributed to exactly one session.
  const wireAttribution = new Map();
  const wireFailures = (Array.isArray(corpus?.wireFailures) ? corpus.wireFailures : [])
    .map((raw) => {
      const { attribution, ...wireFailure } = raw && typeof raw === 'object' ? raw : {};
      const point = { ...wireFailure, atMs: Date.parse(raw?.at) };
      if (attribution) wireAttribution.set(point, attribution);
      return point;
    })
    .filter((wireFailure) => Number.isFinite(wireFailure.atMs))
    .sort(comparePoints);
  for (const wireFailure of wireFailures) {
    const indexedSessions = wireFailure.profileSlug
      ? sessionsByProviderProfile.get(`${wireFailure.provider}\0${wireFailure.profileSlug}`)
      : sessionsByProvider.get(wireFailure.provider);
    const candidates = (indexedSessions || []).filter((session) => followsSessionBaseline(
      session,
      attributedBySession.get(session),
      baselineCacheBySession.get(session),
      wireFailure.atMs,
    ));
    if (candidates.length !== 1) continue;
    attributedBySession.get(candidates[0]).push(wireFailure);
    mergeAttribution(candidates[0].attribution, wireAttribution.get(wireFailure));
  }

  return sessions.map((session) => {
    session.points.push(...attributedBySession.get(session));
    session.points.sort(comparePoints);
    const fingerprintPoints = session.points.map(({ atMs, ...point }) => point);
    return {
      ...session,
      corpusFingerprint: hash(JSON.stringify({
        provider: session.provider,
        profileSlug: session.profileSlug,
        sessionId: session.sessionId,
        points: fingerprintPoints,
      })),
    };
  });
}

function measuredWindow(session, points, baselineMetrics, shapes) {
  const intervals = points.slice(1).map((point, index) => (
    point.atMs - points[index].atMs
  ));
  const observedCadenceMs = median(intervals);
  const simultaneousIntervals = intervals.filter((interval) => interval === 0).length;
  return {
    ...evidenceIdentity(session),
    requestCount: points.length,
    firstAt: points[0].at,
    lastAt: points.at(-1).at,
    windowDurationSeconds: (points.at(-1).atMs - points[0].atMs) / 1_000,
    baselineMedianCadenceSeconds: baselineMetrics.cadenceMs / 1_000,
    medianCadenceSeconds: observedCadenceMs / 1_000,
    requestRateMultiple: observedCadenceMs === 0
      ? null
      : Number((baselineMetrics.cadenceMs / observedCadenceMs).toFixed(6)),
    ...(simultaneousIntervals > 0 ? { simultaneousIntervals } : {}),
    tokensBurned: Math.round(points.reduce((sum, point) => sum + pointTokens(point), 0)),
    uncachedInputTokens: Math.round(points.reduce((sum, point) => sum + finite(point.uncached), 0)),
    cacheReadTokens: Math.round(points.reduce((sum, point) => sum + finite(point.cached), 0)),
    outputTokens: Math.round(points.reduce((sum, point) => sum + finite(point.output), 0)),
    wireFailures: shapes.filter((shape) => shape.failed && shape.signalGrade === 'wire').length,
    corpusFailures: shapes.filter((shape) => shape.failed && shape.signalGrade === 'corpus').length,
    rateLimitFailures: shapes.filter((shape) => shape.failed && shape.rateLimited).length,
  };
}

function retryStormEvidence(session, thresholds) {
  const { points } = session;
  let best = null;
  let start = thresholds.minimumBaselineIntervals + 1;
  while (start < points.length) {
    const baselineMetrics = baseline(points, start, thresholds);
    if (!baselineMetrics) {
      start += 1;
      continue;
    }
    const firstShape = failureShape(
      points[start],
      baselineMetrics.outputTokens,
      thresholds.maximumFallbackOutputShare,
    );
    if (!firstShape.failed) {
      start += 1;
      continue;
    }

    const maximumInterval = baselineMetrics.cadenceMs / thresholds.minimumCadenceMultiple;
    const shapes = [firstShape];
    let end = start;
    while (end + 1 < points.length) {
      const interval = points[end + 1].atMs - points[end].atMs;
      if (interval < 0 || interval > maximumInterval) break;
      const shape = failureShape(
        points[end + 1],
        baselineMetrics.outputTokens,
        thresholds.maximumFallbackOutputShare,
      );
      if (!shape.failed) break;
      shapes.push(shape);
      end += 1;
    }

    if (shapes.length >= thresholds.minimumFailureRequests) {
      const windowPoints = points.slice(start, end + 1);
      const evidence = measuredWindow(session, windowPoints, baselineMetrics, shapes);
      const wireSignals = shapes.filter((shape) => shape.signalGrade === 'wire').length;
      evidence.signalGrade = wireSignals === shapes.length
        ? 'wire'
        : wireSignals > 0 ? 'mixed' : 'corpus';
      if (!best
        || evidence.tokensBurned > best.tokensBurned
        || (evidence.tokensBurned === best.tokensBurned
          && evidence.requestCount > best.requestCount)) best = evidence;
    }
    start = end + 1;
  }
  return best;
}

function swarmBurstEvidence(session, thresholds) {
  const { points } = session;
  let best = null;
  let start = thresholds.minimumBaselineIntervals + 1;
  while (start + thresholds.minimumBurstRequests <= points.length) {
    const baselineMetrics = baseline(points, start, thresholds);
    if (!baselineMetrics) {
      start += 1;
      continue;
    }
    const maximumInterval = baselineMetrics.cadenceMs / thresholds.minimumRequestRateMultiple;
    let end = start;
    while (end + 1 < points.length) {
      const interval = points[end + 1].atMs - points[end].atMs;
      if (interval < 0 || interval > maximumInterval) break;
      end += 1;
    }
    const requestCount = end - start + 1;
    if (requestCount < thresholds.minimumBurstRequests) {
      start += 1;
      continue;
    }

    const windowPoints = points.slice(start, end + 1);
    const shapes = windowPoints.map((point) => failureShape(
      point,
      baselineMetrics.outputTokens,
      thresholds.maximumFallbackOutputShare,
    ));
    const failures = shapes.filter((shape) => shape.failed).length;
    const evidence = measuredWindow(session, windowPoints, baselineMetrics, shapes);
    if (failures / requestCount <= thresholds.maximumFailedRequestShare
      && evidence.tokensBurned > 0
      && (!best
        || evidence.tokensBurned > best.tokensBurned
        || (evidence.tokensBurned === best.tokensBurned
          && evidence.requestRateMultiple > best.requestRateMultiple))) best = evidence;
    start = end + 1;
  }
  return best;
}

function detectorFinding(detector, corpus, evidenceForSession, fix) {
  const affected = [];
  for (const session of rateSessions(corpus)) {
    const evidence = evidenceForSession(session, detector.thresholds);
    if (evidence) affected.push({
      evidence,
      corpusFingerprint: session.corpusFingerprint || hash(JSON.stringify(session)),
    });
  }
  if (!affected.length) return [];
  affected.sort((left, right) => (
    right.evidence.tokensBurned - left.evidence.tokensBurned
      || String(left.evidence.provider).localeCompare(String(right.evidence.provider))
      || String(left.evidence.profileSlug).localeCompare(String(right.evidence.profileSlug))
      || String(left.evidence.sessionId).localeCompare(String(right.evidence.sessionId))
      || String(left.evidence.agentId || '').localeCompare(String(right.evidence.agentId || ''))
  ));
  const scopeKey = 'all-affected-sessions';
  const sessionKeys = new Set(affected.map(({ evidence }) => (
    `${evidence.provider}\0${evidence.profileSlug}\0${evidence.sessionId}`
  )));
  return [{
    id: findingId(detector.kind, scopeKey),
    scopeKey,
    corpusFingerprint: hash(affected.map((entry) => entry.corpusFingerprint).sort().join('\0')),
    evidence: {
      affectedSessions: sessionKeys.size,
      tokensBurned: affected.reduce((sum, entry) => sum + entry.evidence.tokensBurned, 0),
      fix,
      sessions: affected.map((entry) => entry.evidence),
    },
  }];
}

export const retryStormDetector = Object.freeze({
  kind: RETRY_STORM,
  thresholds: RETRY_STORM_THRESHOLDS,
  detect(corpus) {
    return detectorFinding(this, corpus, retryStormEvidence, RETRY_FIX);
  },
});

export const swarmBurstDetector = Object.freeze({
  kind: SWARM_BURST,
  thresholds: SWARM_BURST_THRESHOLDS,
  detect(corpus) {
    return detectorFinding(this, corpus, swarmBurstEvidence, SWARM_FIX);
  },
});

export const RATE_PATHOLOGY_DETECTORS = Object.freeze([
  retryStormDetector,
  swarmBurstDetector,
]);
