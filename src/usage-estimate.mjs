// Issue #348: translate warehouse token flows into provider-window burn.
// Provider snapshots remain the ground truth; every value produced here is an
// explicitly labeled estimate learned independently for each pool/scope.

export const ESTIMATE_SCOPES = Object.freeze(['weekly', '5-hour']);
export const TOKEN_CLASSES = Object.freeze([
  'inputUncached',
  'inputCacheRead',
  'inputCacheWrite',
  'outputTotal',
]);

// Four weights are fitted. Requiring twice that many usable observations is a
// deliberately small but documented floor: below it, the endpoint returns a
// null estimate with a reason instead of exposing an underdetermined fit.
export const MIN_USABLE_INTERVALS = 8;
export const ESTIMATE_METHOD = 'nnls-active-set-v1';
export const CLAUDE_POOL_ID = 'claude';
export const MIN_FIT_QUALITY = 0.3;
// QR operates on unit-norm feature columns, making this R-diagonal ratio
// scale-independent. Below 1e-8, roughly eight decimal digits of separation
// have been lost and per-token-class attribution is not safe to publish.
export const IDENTIFIABILITY_RATIO_FLOOR = 1e-8;

const FEATURE_COLUMNS = Object.freeze([
  'input_uncached',
  'input_cache_read',
  'input_cache_write',
  'output_total',
]);
const WEIGHT_COLUMNS = Object.freeze([
  'input_uncached_weight',
  'input_cache_read_weight',
  'input_cache_write_weight',
  'output_total_weight',
]);

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`usage estimate ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

// Real snapshots recompute resets_at on every poll, so it drifts by sub-second
// amounts (observed median ~344ms, occasionally a few seconds, in either
// direction) throughout a single window. A genuine reset moves resets_at by
// the window size (5 hours or 7 days). The tolerance sits far above poll
// jitter and far below any real window jump; exact-equality comparison here
// misclassified ~99.9% of real intervals as resets and starved the fit.
const RESET_MARKER_TOLERANCE_MS = 5 * 60 * 1000;
// One provider refresh writes the pool's account snapshots a few milliseconds
// apart. Collapse those writes into one pool observation; incomplete batches
// are not pool ground truth and therefore do not train the model.
const POOL_OBSERVATION_BATCH_MS = 60 * 1000;

function resetMarkerChanged(previous, current) {
  if (previous == null || current == null) return previous !== current;
  const previousTime = Date.parse(previous);
  const currentTime = Date.parse(current);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
    return Math.abs(currentTime - previousTime) > RESET_MARKER_TOLERANCE_MS;
  }
  return previous !== current;
}

function tokenFlowObject(values) {
  return Object.fromEntries(TOKEN_CLASSES.map((tokenClass, index) => [tokenClass, Number(values[index] || 0)]));
}

function weightObject(values) {
  return Object.fromEntries(TOKEN_CLASSES.map((tokenClass, index) => [tokenClass, Number(values[index])]));
}

function tokenFlowScore(tokenFlows, weights = null) {
  return TOKEN_CLASSES.reduce((total, tokenClass) => (
    total + finiteNonNegative(Number(tokenFlows?.[tokenClass] || 0), `usage estimate ${tokenClass}`)
      * (weights == null ? 1 : weights[tokenClass])
  ), 0);
}

/**
 * Divide measured provider truth without changing its total. Fitted weights
 * rank the recipients; a weak/unavailable fit falls back to plain token share.
 * Integer printed units are assigned by largest remainder, so the figures a
 * reader can add always equal the printed measured total exactly.
 */
export function apportionMeasuredTotal(items, measuredTotal, fit, { precision = 1 } = {}) {
  if (!Array.isArray(items)) throw new Error('usage estimate apportionment items must be an array');
  finiteNonNegative(measuredTotal, 'usage estimate measuredTotal');
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new Error('usage estimate precision must be an integer from 0 to 6');
  }
  if (!items.length && measuredTotal > 0) {
    throw new Error('usage estimate cannot apportion a positive total without items');
  }
  const scale = 10 ** precision;
  const totalUnits = Math.round(measuredTotal * scale);
  const fitted = fit?.weights != null && fit.fitQuality != null && fit.fitQuality >= MIN_FIT_QUALITY;
  let method = fitted ? 'fitted-token-share' : 'token-share-fallback';
  let scores = items.map((item) => tokenFlowScore(item.tokenFlows, fitted ? fit.weights : null));
  let scoreTotal = scores.reduce((sum, score) => sum + score, 0);
  if (fitted && scoreTotal === 0) {
    method = 'token-share-fallback';
    scores = items.map((item) => tokenFlowScore(item.tokenFlows));
    scoreTotal = scores.reduce((sum, score) => sum + score, 0);
  }
  const rawUnits = scores.map((score) => scoreTotal === 0 ? 0 : totalUnits * score / scoreTotal);
  const allocatedUnits = rawUnits.map(Math.floor);
  const remainder = totalUnits - allocatedUnits.reduce((sum, units) => sum + units, 0);
  const largestRemainders = rawUnits.map((units, index) => ({ index, remainder: units - Math.floor(units) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) {
    allocatedUnits[largestRemainders[index % largestRemainders.length]?.index ?? 0] += 1;
  }
  return {
    method,
    fitQuality: fit?.fitQuality ?? null,
    precision,
    totalUnits,
    total: totalUnits / scale,
    totalPrinted: (totalUnits / scale).toFixed(precision),
    allocations: items.map((item, index) => ({
      id: item.id,
      units: allocatedUnits[index],
      value: allocatedUnits[index] / scale,
      printed: (allocatedUnits[index] / scale).toFixed(precision),
    })),
  };
}

function unavailableFit(
  intervalsUsed,
  reason,
  { identifiability = 'not-assessed', conditionRatio = null } = {},
) {
  return {
    weights: null,
    fitQuality: null,
    identifiability,
    conditionRatio,
    intervalsUsed,
    method: ESTIMATE_METHOD,
    reason,
  };
}

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

// Solve one unconstrained least-squares face with re-orthogonalized modified
// Gram-Schmidt QR. The model has only four columns, so materializing these
// column vectors is both simpler and more stable than normal equations.
function restrictedLeastSquares(matrix, response, columns, singularTolerance) {
  const width = columns.length;
  const orthonormal = [];
  const upper = Array.from({ length: width }, () => Array(width).fill(0));
  let largestDiagonal = 0;
  let smallestDiagonal = Number.POSITIVE_INFINITY;
  for (let column = 0; column < width; column += 1) {
    const vector = matrix.map((row) => row[columns[column]]);
    // A second pass corrects the loss of orthogonality that cache-heavy,
    // nearly collinear token columns otherwise create in finite precision.
    for (let pass = 0; pass < 2; pass += 1) {
      for (let previous = 0; previous < column; previous += 1) {
        const projection = dot(orthonormal[previous], vector);
        upper[previous][column] += projection;
        for (let row = 0; row < vector.length; row += 1) {
          vector[row] -= projection * orthonormal[previous][row];
        }
      }
    }
    const norm = Math.sqrt(dot(vector, vector));
    if (!Number.isFinite(norm)) return { coefficients: null, conditionRatio: 0 };
    largestDiagonal = Math.max(largestDiagonal, norm);
    smallestDiagonal = Math.min(smallestDiagonal, norm);
    const conditionRatio = largestDiagonal > 0 ? smallestDiagonal / largestDiagonal : 0;
    if (norm <= singularTolerance) return { coefficients: null, conditionRatio };
    upper[column][column] = norm;
    orthonormal.push(vector.map((value) => value / norm));
  }

  const projected = orthonormal.map((column) => dot(column, response));
  const coefficients = Array(width).fill(0);
  for (let row = width - 1; row >= 0; row -= 1) {
    let residual = projected[row];
    for (let column = row + 1; column < width; column += 1) {
      residual -= upper[row][column] * coefficients[column];
    }
    coefficients[row] = residual / upper[row][row];
  }
  return {
    coefficients,
    conditionRatio: largestDiagonal > 0 ? smallestDiagonal / largestDiagonal : 0,
  };
}

/**
 * Solve min ||Xw-y||² subject to w >= 0 by enumerating active coefficient
 * sets. With exactly four token classes there are only 16 faces, including
 * the all-zero solution. Every NNLS optimum is the unconstrained least-squares
 * optimum on one of those faces; selecting the lowest-error feasible face is
 * therefore exact (up to floating-point QR tolerance), with no iterative
 * convergence risk on highly correlated cache/input columns.
 */
export function solveNonNegativeLeastSquares(
  features,
  targets,
  { singularTolerance = 1e-12, feasibilityTolerance = 1e-10 } = {},
) {
  if (!Array.isArray(features) || !features.length) throw new Error('NNLS features must be a non-empty array');
  if (!Array.isArray(targets) || targets.length !== features.length) throw new Error('NNLS targets must match feature rows');
  const width = features[0]?.length;
  if (!Number.isInteger(width) || width < 1) throw new Error('NNLS feature rows must not be empty');
  if (width > 20) throw new Error('NNLS active-set solver supports at most 20 feature columns');
  if (!Number.isFinite(singularTolerance) || singularTolerance <= 0) throw new Error('NNLS singularTolerance must be positive');
  if (!Number.isFinite(feasibilityTolerance) || feasibilityTolerance < 0) throw new Error('NNLS feasibilityTolerance must be non-negative');

  const matrix = features.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== width) throw new Error('NNLS feature rows must have equal width');
    return row.map((value, columnIndex) => finiteNonNegative(value, `NNLS feature ${rowIndex}:${columnIndex}`));
  });
  const response = targets.map((value, index) => finiteNonNegative(value, `NNLS target ${index}`));
  const scales = Array.from({ length: width }, (_, column) => Math.sqrt(
    matrix.reduce((sum, row) => sum + row[column] ** 2, 0),
  ));
  const normalized = matrix.map((row) => row.map((value, column) => (
    scales[column] > 0 ? value / scales[column] : 0
  )));
  let bestCoefficients = Array(width).fill(0);
  let bestColumns = [];
  let bestConditionRatio = 1;
  let bestSquaredError = response.reduce((sum, value) => sum + value ** 2, 0);
  let facesEvaluated = 1;
  const faceCount = 2 ** width;
  for (let mask = 1; mask < faceCount; mask += 1) {
    const columns = [];
    for (let column = 0; column < width; column += 1) {
      if ((mask & (2 ** column)) !== 0 && scales[column] > 0) columns.push(column);
    }
    if (!columns.length) continue;
    const restricted = restrictedLeastSquares(normalized, response, columns, singularTolerance);
    if (!restricted.coefficients) continue;
    const coefficientScale = Math.max(1, ...restricted.coefficients.map((value) => Math.abs(value)));
    if (restricted.coefficients.some((value) => value < -feasibilityTolerance * coefficientScale)) continue;
    const candidate = Array(width).fill(0);
    columns.forEach((column, index) => { candidate[column] = Math.max(0, restricted.coefficients[index]); });
    let squaredError = 0;
    for (let row = 0; row < normalized.length; row += 1) {
      let prediction = 0;
      for (let column = 0; column < width; column += 1) {
        prediction += normalized[row][column] * candidate[column];
      }
      squaredError += (response[row] - prediction) ** 2;
    }
    facesEvaluated += 1;
    if (squaredError < bestSquaredError) {
      bestSquaredError = squaredError;
      bestCoefficients = candidate;
      bestColumns = columns;
      bestConditionRatio = restricted.conditionRatio;
    }
  }

  // The enumerator can choose a full-rank boundary face after rejecting a
  // singular larger face. Test every excluded, non-empty token column against
  // that chosen face too: a column that can replace an active column without
  // changing fitted movement makes the per-class attribution non-identifiable
  // even though the smaller face's own QR diagonal looks healthy.
  for (let column = 0; column < width; column += 1) {
    if (scales[column] === 0 || bestColumns.includes(column)) continue;
    const augmented = restrictedLeastSquares(
      normalized,
      response,
      [...bestColumns, column],
      singularTolerance,
    );
    bestConditionRatio = Math.min(bestConditionRatio, augmented.conditionRatio);
  }

  return {
    weights: bestCoefficients.map((value, column) => scales[column] > 0 ? value / scales[column] : 0),
    conditionRatio: bestConditionRatio,
    converged: true,
    iterations: facesEvaluated,
  };
}

/**
 * Build non-reset training rows for one Claude account and one provider scope.
 * A request at exactly the earlier snapshot belongs to the preceding interval;
 * these rows therefore use (previous.observed_at, current.observed_at]. Stale
 * or non-numeric snapshots are not provider truth and never become endpoints.
 */
export function buildUsageEstimateIntervals(store, { accountId, scope }) {
  if (!store?.db) throw new Error('usage estimate store is required');
  if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('usage estimate accountId is required');
  if (!ESTIMATE_SCOPES.includes(scope)) throw new Error('usage estimate scope must be weekly or 5-hour');

  const snapshots = store.db.prepare(`
    SELECT id, used_percent, resets_at, observed_at
    FROM usage_snapshots
    WHERE account_id = ? AND scope = ? AND stale = 0 AND used_percent IS NOT NULL
    ORDER BY julianday(observed_at), id
  `).all(accountId, scope)
    .map((row) => ({
      ...row,
      usedPercent: Number(row.used_percent),
      observedTime: Date.parse(row.observed_at),
    }))
    .filter((row) => Number.isFinite(row.usedPercent) && Number.isFinite(row.observedTime));

  if (snapshots.length < 2) {
    return { intervals: [], resetIntervalsDropped: 0, emptyIntervalsDropped: 0 };
  }

  const firstTime = new Date(snapshots[0].observedTime).toISOString();
  const lastTime = new Date(snapshots.at(-1).observedTime).toISOString();
  const requests = store.db.prepare(`
    SELECT observed_at, input_uncached, input_cache_read, input_cache_write, output_total
    FROM request_usage INDEXED BY request_usage_account_observed
    WHERE account_id = ? AND provider = 'claude'
      AND observed_at > ? AND observed_at <= ?
    ORDER BY observed_at, id
  `).all(accountId, firstTime, lastTime).map((row) => ({
    observedTime: Date.parse(row.observed_at),
    features: FEATURE_COLUMNS.map((column) => Number(row[column] || 0)),
  }));

  const intervals = [];
  let resetIntervalsDropped = 0;
  let emptyIntervalsDropped = 0;
  let requestIndex = 0;
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    if (current.observedTime <= previous.observedTime) {
      emptyIntervalsDropped += 1;
      continue;
    }

    while (requestIndex < requests.length && requests[requestIndex].observedTime <= previous.observedTime) {
      requestIndex += 1;
    }
    const flows = Array(TOKEN_CLASSES.length).fill(0);
    while (requestIndex < requests.length && requests[requestIndex].observedTime <= current.observedTime) {
      for (let column = 0; column < flows.length; column += 1) {
        flows[column] += requests[requestIndex].features[column];
      }
      requestIndex += 1;
    }

    const movement = current.usedPercent - previous.usedPercent;
    if (movement < 0 || resetMarkerChanged(previous.resets_at, current.resets_at)) {
      resetIntervalsDropped += 1;
      continue;
    }
    if (movement === 0 && flows.every((value) => value === 0)) {
      emptyIntervalsDropped += 1;
      continue;
    }
    intervals.push({
      since: new Date(previous.observedTime).toISOString(),
      until: new Date(current.observedTime).toISOString(),
      tokenFlows: tokenFlowObject(flows),
      features: flows,
      observedMovement: movement,
    });
  }

  return { intervals, resetIntervalsDropped, emptyIntervalsDropped };
}

/**
 * Build training rows at Claude's real routing grain: all Claude
 * profiles contribute token flow and all of their utilization movements are
 * summed. Only refresh batches containing every pool account are comparable
 * pool observations.
 */
export function buildPoolUsageEstimateIntervals(store, { poolId = CLAUDE_POOL_ID, scope }) {
  if (!store?.db) throw new Error('usage estimate store is required');
  if (poolId !== CLAUDE_POOL_ID) throw new Error('usage estimate poolId must be claude');
  if (!ESTIMATE_SCOPES.includes(scope)) throw new Error('usage estimate scope must be weekly or 5-hour');

  // Enabled is a deck/UI state, not pool membership. Historical utilization
  // and transcripts from a disabled profile still belong to Claude's pool.
  const accounts = store.listAccounts().filter((account) => account.provider === 'claude');
  if (!accounts.length) return { intervals: [], resetIntervalsDropped: 0, emptyIntervalsDropped: 0 };
  const accountIds = new Set(accounts.map((account) => account.id));
  const placeholders = accounts.map(() => '?').join(', ');
  const snapshots = store.db.prepare(`
    SELECT id, account_id, used_percent, resets_at, observed_at
    FROM usage_snapshots
    WHERE account_id IN (${placeholders}) AND scope = ?
      AND stale = 0 AND used_percent IS NOT NULL
    ORDER BY julianday(observed_at), id
  `).all(...accountIds, scope).map((row) => ({
    ...row,
    usedPercent: Number(row.used_percent),
    observedTime: Date.parse(row.observed_at),
  })).filter((row) => Number.isFinite(row.usedPercent) && Number.isFinite(row.observedTime));

  const batches = [];
  for (const snapshot of snapshots) {
    let batch = batches.at(-1);
    if (!batch || snapshot.observedTime - batch.startedAt > POOL_OBSERVATION_BATCH_MS) {
      batch = { startedAt: snapshot.observedTime, observedTime: snapshot.observedTime, rows: new Map() };
      batches.push(batch);
    }
    batch.observedTime = Math.max(batch.observedTime, snapshot.observedTime);
    batch.rows.set(snapshot.account_id, snapshot);
  }
  const complete = batches.filter((batch) => batch.rows.size === accountIds.size);
  if (complete.length < 2) return { intervals: [], resetIntervalsDropped: 0, emptyIntervalsDropped: 0 };

  const firstTime = new Date(complete[0].observedTime).toISOString();
  const lastTime = new Date(complete.at(-1).observedTime).toISOString();
  const requests = store.db.prepare(`
    SELECT observed_at, input_uncached, input_cache_read, input_cache_write, output_total
    FROM request_usage INDEXED BY request_usage_observed
    WHERE provider = 'claude' AND observed_at > ? AND observed_at <= ?
    ORDER BY observed_at, id
  `).all(firstTime, lastTime).map((row) => ({
    observedTime: Date.parse(row.observed_at),
    features: FEATURE_COLUMNS.map((column) => Number(row[column] || 0)),
  }));

  const intervals = [];
  let resetIntervalsDropped = 0;
  let emptyIntervalsDropped = 0;
  let requestIndex = 0;
  for (let index = 1; index < complete.length; index += 1) {
    const previous = complete[index - 1];
    const current = complete[index];
    const flows = Array(TOKEN_CLASSES.length).fill(0);
    while (requestIndex < requests.length && requests[requestIndex].observedTime <= previous.observedTime) {
      requestIndex += 1;
    }
    while (requestIndex < requests.length && requests[requestIndex].observedTime <= current.observedTime) {
      for (let column = 0; column < flows.length; column += 1) {
        flows[column] += requests[requestIndex].features[column];
      }
      requestIndex += 1;
    }

    let movement = 0;
    let reset = false;
    for (const accountId of accountIds) {
      const before = previous.rows.get(accountId);
      const after = current.rows.get(accountId);
      const accountMovement = after.usedPercent - before.usedPercent;
      if (accountMovement < 0 || resetMarkerChanged(before.resets_at, after.resets_at)) reset = true;
      movement += accountMovement;
    }
    if (reset) {
      resetIntervalsDropped += 1;
      continue;
    }
    if (movement === 0 && flows.every((value) => value === 0)) {
      emptyIntervalsDropped += 1;
      continue;
    }
    intervals.push({
      since: new Date(previous.observedTime).toISOString(),
      until: new Date(current.observedTime).toISOString(),
      tokenFlows: tokenFlowObject(flows),
      features: flows,
      observedMovement: movement,
    });
  }
  return { intervals, resetIntervalsDropped, emptyIntervalsDropped };
}

export function fitUsageEstimateIntervals(intervals, { minimumIntervals = MIN_USABLE_INTERVALS } = {}) {
  if (!Array.isArray(intervals)) throw new Error('usage estimate intervals must be an array');
  if (!Number.isInteger(minimumIntervals) || minimumIntervals < TOKEN_CLASSES.length) {
    throw new Error(`usage estimate minimumIntervals must be at least ${TOKEN_CLASSES.length}`);
  }
  if (intervals.length < minimumIntervals) {
    return unavailableFit(
      intervals.length,
      `insufficient usable intervals: found ${intervals.length}; minimum is ${minimumIntervals}`,
    );
  }

  const features = intervals.map((interval) => interval.features);
  const targets = intervals.map((interval) => interval.observedMovement);
  const featureEnergy = features.reduce(
    (total, row) => total + row.reduce((sum, value) => sum + value ** 2, 0),
    0,
  );
  if (featureEnergy === 0) {
    return unavailableFit(intervals.length, 'usable intervals contain no attributed token flow');
  }
  const observedEnergy = targets.reduce((sum, value) => sum + value ** 2, 0);
  if (observedEnergy === 0) {
    return unavailableFit(intervals.length, 'observed utilization did not move across usable intervals');
  }

  const solved = solveNonNegativeLeastSquares(features, targets);
  if (!solved.converged || solved.weights.some((value) => !Number.isFinite(value))) {
    return unavailableFit(intervals.length, 'non-negative least-squares fit did not converge');
  }
  if (!Number.isFinite(solved.conditionRatio) || solved.conditionRatio < IDENTIFIABILITY_RATIO_FLOOR) {
    return unavailableFit(intervals.length, 'design not identifiable', {
      identifiability: 'ill-conditioned',
      conditionRatio: Number.isFinite(solved.conditionRatio) ? solved.conditionRatio : 0,
    });
  }
  const predictions = features.map((row) => row.reduce(
    (sum, value, column) => sum + value * solved.weights[column],
    0,
  ));
  const squaredError = targets.reduce((sum, target, index) => sum + (target - predictions[index]) ** 2, 0);
  // Fit quality is an uncentered R²-style explained-movement fraction:
  //   1 - sum((observed_delta - fitted_delta)^2) / sum(observed_delta^2).
  // The zero-delta prediction is the baseline because a no-token interval
  // should imply no estimated burn. Clamp to [0,1] so the label remains a
  // literal fraction; a fit worse than the zero baseline is reported as 0.
  const fitQuality = Math.max(0, Math.min(1, 1 - squaredError / observedEnergy));
  return {
    weights: weightObject(solved.weights),
    fitQuality,
    identifiability: 'well-conditioned',
    conditionRatio: solved.conditionRatio,
    intervalsUsed: intervals.length,
    method: ESTIMATE_METHOD,
    reason: null,
  };
}

export function fitUsageEstimateForAccountScope(store, { accountId, scope }) {
  const training = buildUsageEstimateIntervals(store, { accountId, scope });
  return {
    scope,
    ...fitUsageEstimateIntervals(training.intervals),
    resetIntervalsDropped: training.resetIntervalsDropped,
    emptyIntervalsDropped: training.emptyIntervalsDropped,
  };
}

export function fitUsageEstimateForPoolScope(store, { poolId = CLAUDE_POOL_ID, scope }) {
  const training = buildPoolUsageEstimateIntervals(store, { poolId, scope });
  return {
    poolId,
    scope,
    ...fitUsageEstimateIntervals(training.intervals),
    resetIntervalsDropped: training.resetIntervalsDropped,
    emptyIntervalsDropped: training.emptyIntervalsDropped,
  };
}

function selectClaudeAccounts(store, accountId) {
  const accounts = store.listAccounts().filter((account) => account.provider === 'claude');
  if (accountId == null) return accounts;
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('usage estimate accountId must be a non-empty string');
  }
  const normalized = accountId.trim();
  const account = accounts.find((candidate) => candidate.id === normalized);
  if (!account) throw new Error('usage estimate accountId must reference a Claude account');
  return [account];
}

export function refitUsageEstimates(store, { poolId = CLAUDE_POOL_ID, fittedAt = new Date().toISOString() } = {}) {
  if (!store?.db) throw new Error('usage estimate store is required');
  fittedAt = canonicalTimestamp(fittedAt, 'fittedAt');
  if (poolId !== CLAUDE_POOL_ID) throw new Error('usage estimate poolId must be claude');
  const results = [];

  store.db.exec('BEGIN');
  try {
    for (const scope of ESTIMATE_SCOPES) {
      results.push({
        ...fitUsageEstimateForPoolScope(store, { poolId, scope }),
        fittedAt,
      });
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }

  const upsert = store.db.prepare(`
    INSERT INTO usage_estimate_fits(
      pool_id, provider, scope,
      input_uncached_weight, input_cache_read_weight,
      input_cache_write_weight, output_total_weight,
      fit_quality, identifiability, condition_ratio,
      intervals_used, method, reason, fitted_at
    ) VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pool_id, scope) DO UPDATE SET
      input_uncached_weight=excluded.input_uncached_weight,
      input_cache_read_weight=excluded.input_cache_read_weight,
      input_cache_write_weight=excluded.input_cache_write_weight,
      output_total_weight=excluded.output_total_weight,
      fit_quality=excluded.fit_quality,
      identifiability=excluded.identifiability,
      condition_ratio=excluded.condition_ratio,
      intervals_used=excluded.intervals_used,
      method=excluded.method,
      reason=excluded.reason,
      fitted_at=excluded.fitted_at
    WHERE excluded.fitted_at >= usage_estimate_fits.fitted_at
  `);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const result of results) {
      const weights = result.weights;
      upsert.run(
        result.poolId,
        result.scope,
        weights?.inputUncached ?? null,
        weights?.inputCacheRead ?? null,
        weights?.inputCacheWrite ?? null,
        weights?.outputTotal ?? null,
        result.fitQuality,
        result.identifiability,
        result.conditionRatio,
        result.intervalsUsed,
        result.method,
        result.reason,
        fittedAt,
      );
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }

  return {
    pools: 1,
    fitted: results.filter((result) => result.weights != null).length,
    unavailable: results.filter((result) => result.weights == null).length,
    minimumUsableIntervals: MIN_USABLE_INTERVALS,
    method: ESTIMATE_METHOD,
    results,
  };
}

function persistedFit(row, scope) {
  if (!row) {
    return {
      scope,
      ...unavailableFit(0, 'fit has not been computed; run the usage estimate refit command'),
      fittedAt: null,
    };
  }
  return {
    scope,
    weights: row.reason == null ? weightObject(WEIGHT_COLUMNS.map((column) => row[column])) : null,
    fitQuality: row.fit_quality == null ? null : Number(row.fit_quality),
    identifiability: row.identifiability,
    conditionRatio: row.condition_ratio == null ? null : Number(row.condition_ratio),
    intervalsUsed: Number(row.intervals_used),
    method: row.method,
    reason: row.reason,
    fittedAt: row.fitted_at,
  };
}

function rangeTokenFlows(statement, accountId, since, until) {
  const row = statement.get(accountId, since, until);
  return tokenFlowObject(FEATURE_COLUMNS.map((column) => Number(row[column] || 0)));
}

function accountFitPayload(fit) {
  if (fit.weights == null) return fit;
  return {
    ...fit,
    weights: null,
    reason: 'pool fit is available only for measured-total apportionment',
  };
}

/**
 * Read the persisted Claude-pool fits and, when a complete range is supplied,
 * expose each account's component token flow under that one shared model.
 */
export function usageEstimateReport(store, { since = null, until = null, accountId = null } = {}) {
  if (!store?.db) throw new Error('usage estimate store is required');
  const rangeRequested = since != null || until != null;
  if ((since == null) !== (until == null)) {
    throw new Error('usage estimate since and until must be provided together');
  }
  if (rangeRequested) {
    since = canonicalTimestamp(since, 'since');
    until = canonicalTimestamp(until, 'until');
    if (since >= until) throw new Error('usage estimate since must be earlier than until');
  }
  const accounts = selectClaudeAccounts(store, accountId);
  const fitStatement = store.db.prepare(`
    SELECT * FROM usage_estimate_fits WHERE pool_id = ? ORDER BY scope
  `);
  const tokenStatement = rangeRequested ? store.db.prepare(`
    SELECT
      COALESCE(SUM(input_uncached), 0) AS input_uncached,
      COALESCE(SUM(input_cache_read), 0) AS input_cache_read,
      COALESCE(SUM(input_cache_write), 0) AS input_cache_write,
      COALESCE(SUM(output_total), 0) AS output_total
    FROM request_usage INDEXED BY request_usage_account_observed
    WHERE account_id = ? AND provider = 'claude'
      AND observed_at >= ? AND observed_at < ?
  `) : null;

  store.db.exec('BEGIN');
  try {
    const rows = new Map(fitStatement.all(CLAUDE_POOL_ID).map((row) => [row.scope, row]));
    const fits = ESTIMATE_SCOPES.map((scope) => persistedFit(rows.get(scope), scope));
    const accountFits = fits.map(accountFitPayload);
    const accountPayloads = accounts.map((account) => {
      const tokenFlows = rangeRequested ? rangeTokenFlows(tokenStatement, account.id, since, until) : null;
      return {
        accountId: account.id,
        accountLabel: account.label,
        poolId: CLAUDE_POOL_ID,
        fits: accountFits,
        tokenFlows,
        estimates: null,
      };
    });
    store.db.exec('COMMIT');
    return {
      range: rangeRequested ? { since, until, endExclusive: true } : null,
      tokenClasses: [...TOKEN_CLASSES],
      minimumUsableIntervals: MIN_USABLE_INTERVALS,
      minimumFitQuality: MIN_FIT_QUALITY,
      pools: [{ poolId: CLAUDE_POOL_ID, provider: 'claude', fits }],
      accounts: accountPayloads,
    };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
