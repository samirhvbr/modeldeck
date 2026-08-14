// Issue #347: lane-issue tagging for the session explorer.
//
// scripts/lane-codex.sh appends one JSON line per lane lifecycle event to
// .claude/lane-logs/manifest.jsonl: a `launched` record (issue, runner, model,
// effort, pid, log, ts) and later an `exited` record for the same run. Pairing
// those gives a [startedAt, endedAt] window per issue.
//
// The manifest records NO session id and NO profile — so this is a HEURISTIC,
// and every tag it produces says so. A session is tagged when its provider
// matches the run's runner, its activity overlaps the run window, and (where
// the session knows its model/effort) those corroborate. Anything less certain
// than one corroborated overlapping run is additionally marked ambiguous, and
// the candidate count travels with the tag so the view can say "maybe".
import fs from 'node:fs';

// A launched record with no exited partner (crash, kill -9, a lane still
// running) would otherwise have an infinite window. Cap it — a lane that ran
// longer than this is not evidence about a session three days later.
export const LANE_OPEN_RUN_MAX_MS = 12 * 3600 * 1000;

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/// Parse the manifest into paired runs. Unreadable file → no runs (tagging is
/// an enrichment; its absence must never fail a leaderboard read). Malformed
/// lines are skipped individually for the same reason.
export function readLaneRuns(manifestPath) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) return [];
  let text;
  try { text = fs.readFileSync(manifestPath, 'utf8'); }
  catch { return []; }
  return parseLaneRuns(text);
}

export function parseLaneRuns(text) {
  const runs = [];
  // The log path is unique per run (it carries the launch timestamp), so it is
  // the run key; a manifest written before logs were named that way falls back
  // to the pid, which is unique among concurrently live runs.
  const open = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { continue; }
    if (!record || typeof record !== 'object') continue;
    const at = isoOrNull(record.ts);
    if (!at) continue;
    const key = record.log || (record.pid == null ? null : `pid:${record.pid}`);
    if (!key) continue;
    if (record.phase === 'launched') {
      const run = {
        issue: Number.isInteger(record.issue) ? record.issue : Number(record.issue) || null,
        runner: typeof record.runner === 'string' ? record.runner : null,
        model: typeof record.model === 'string' ? record.model : null,
        effort: typeof record.effort === 'string' ? record.effort : null,
        log: typeof record.log === 'string' ? record.log : null,
        pid: Number.isInteger(record.pid) ? record.pid : null,
        startedAt: at,
        endedAt: null,
        exit: null,
      };
      open.set(key, run);
      runs.push(run);
    } else if (record.phase === 'exited') {
      const run = open.get(key);
      if (!run) continue;
      run.endedAt = at;
      run.exit = Number.isInteger(record.exit) ? record.exit : null;
      open.delete(key);
    }
  }
  return runs.filter((run) => run.issue != null);
}

function runWindow(run) {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : start + LANE_OPEN_RUN_MAX_MS;
  return { start, end, open: !run.endedAt };
}

// A lane runner only ever drives its own provider's CLI, so a codex lane can
// never explain a Claude transcript session and vice versa.
function runnerProvider(runner) {
  if (runner === 'codex') return 'codex';
  if (runner === 'claude' || runner === 'fable') return 'claude';
  return null;
}

function looseMatch(left, right) {
  if (!left || !right) return false;
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

/// Tag one session row (as returned by Store#usageSessions) with the lane run
/// that best explains it, or null. Never throws; never mutates the input.
export function laneTagForSession(session, runs) {
  if (!session || !Array.isArray(runs) || !runs.length) return null;
  const first = Date.parse(session.firstAt || session.lastAt || '');
  const last = Date.parse(session.lastAt || session.firstAt || '');
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

  const candidates = [];
  for (const run of runs) {
    if (runnerProvider(run.runner) !== session.provider) continue;
    const window = runWindow(run);
    if (!Number.isFinite(window.start)) continue;
    const overlap = Math.min(last, window.end) - Math.max(first, window.start);
    if (overlap < 0) continue;
    const models = Array.isArray(session.models) ? session.models : [];
    const efforts = Array.isArray(session.efforts) ? session.efforts : [];
    const modelMatch = models.some((model) => looseMatch(model, run.model));
    const effortMatch = efforts.some((effort) => looseMatch(effort, run.effort));
    // A session that states a model the run did not use is not that run.
    if (models.length && run.model && !modelMatch) continue;
    candidates.push({ run, window, overlap, modelMatch, effortMatch });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(b.modelMatch) - Number(a.modelMatch))
    || (Number(b.effortMatch) - Number(a.effortMatch))
    || (b.overlap - a.overlap)
    || (a.window.start - b.window.start));

  const best = candidates[0];
  const issues = new Set(candidates.map((candidate) => candidate.run.issue));
  // Ambiguous whenever more than one issue could explain the session, when the
  // run window had to be capped because no exit was ever recorded, or when
  // neither model nor effort corroborates the time overlap.
  const ambiguous = issues.size > 1 || best.window.open || !(best.modelMatch && best.effortMatch);
  return {
    issue: best.run.issue,
    runner: best.run.runner,
    model: best.run.model,
    effort: best.run.effort,
    startedAt: best.run.startedAt,
    endedAt: best.run.endedAt,
    // Never inferred-as-fact: the manifest cannot name a session.
    heuristic: true,
    ambiguous,
    modelMatch: best.modelMatch,
    effortMatch: best.effortMatch,
    candidates: candidates.length,
    candidateIssues: [...issues].sort((a, b) => a - b),
  };
}

/// Return a copy of the rows with a `lane` field (tag or null).
export function tagSessionsWithLaneRuns(sessions, runs) {
  if (!Array.isArray(sessions)) return [];
  return sessions.map((session) => ({ ...session, lane: laneTagForSession(session, runs) }));
}
