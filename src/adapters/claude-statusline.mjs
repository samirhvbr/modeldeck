import { spawnSync as nodeSpawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Issue #174 — statusline rate-limits capture (winner of spike #173).
//
// Claude Code >= 2.1 pipes a JSON payload to the user-configured statusLine
// command on every render; for Claude.ai subscribers (Pro/Max) it includes
// `rate_limits.five_hour/{used_percentage,resets_at}` and
// `rate_limits.seven_day.{...}` — server-truth window data, credential-free,
// with zero extra API calls (official field table:
// code.claude.com/docs/en/statusline). ModelDeck's opt-in tee:
//
//   statusline stdin ──> [chain the user's own statusLine, output untouched]
//                    └─> [upsert a per-profile capture file under DATA_DIR]
//
// Safety contract (issue #174): this script never sees or touches
// credentials, never makes a network call, and treats an absent
// `rate_limits` object as NORMAL (non-Pro/Max plans, and the moments before
// the first API response of a session) — it writes nothing and never errors.
// A statusline that exits non-zero would degrade the user's own statusline
// experience, so the CLI entry point below always exits 0.
// ---------------------------------------------------------------------------

// The SEA daemon binary doubles as the statusline executable via this argv
// marker (same pattern as modeldeck-internal-claude-usage-probe); it is also
// the substring install/uninstall use to recognize ModelDeck's own command in
// a profile's settings.json.
export const STATUSLINE_SEA_COMMAND = 'modeldeck-internal-claude-statusline';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function resetIso(value) {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function captureWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedPercentage = number(window.used_percentage ?? window.usedPercentage ?? window.utilization);
  if (usedPercentage == null) return null;
  return {
    used_percentage: usedPercentage,
    resets_at: resetIso(window.resets_at ?? window.resetsAt),
  };
}

/// Extract the two documented windows from the statusline stdin payload.
/// Returns null when the payload carries no usable rate-limit data — which
/// is a NORMAL state, never an error (Pro/Max-only field; absent before the
/// session's first API response).
export function parseStatuslineRateLimits(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload); } catch { return null; }
  }
  const rateLimits = data?.rate_limits ?? data?.rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const fiveHour = captureWindow(rateLimits.five_hour ?? rateLimits.fiveHour);
  const sevenDay = captureWindow(rateLimits.seven_day ?? rateLimits.sevenDay);
  if (!fiveHour && !sevenDay) return null;
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

/// Convert a capture-file document into ModelDeck usage snapshots. Scope
/// labels match the probe parser's exactly ('5-hour' / 'weekly',
/// src/adapters/claude.mjs windowLabel) so the deck renders one continuous
/// window regardless of which source observed it — but `source` is always
/// 'claude-statusline', the provenance label the #65/#108 fingerprint
/// machinery and the presentation layer key off.
export function statuslineSnapshotsFromCapture(capture) {
  if (!capture || typeof capture !== 'object') return [];
  const observedAt = typeof capture.observedAt === 'string' && !Number.isNaN(Date.parse(capture.observedAt))
    ? new Date(Date.parse(capture.observedAt)).toISOString()
    : null;
  if (!observedAt) return [];
  const snapshots = [];
  for (const [key, scope] of [['five_hour', '5-hour'], ['seven_day', 'weekly']]) {
    const window = captureWindow(capture[key]);
    if (!window) continue;
    snapshots.push({
      scope,
      usedPercent: window.used_percentage,
      resetsAt: window.resets_at,
      observedAt,
      source: 'claude-statusline',
      detail: {},
    });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Issue #377 — the session's CURRENT MODEL, from the same payload.
//
// A session that drops Fable → Opus mid-flight changes nothing ModelDeck
// could previously see: the transcript archive only proves it 15 minutes
// later at the next warehouse pass, and usage windows never name the session
// at all. The statusline payload names both (`session_id`, `model.id`) and
// arrives on every render, so it is the only substrate that can make the drop
// loud AT the moment it happens. This adds a second, tiny per-session marker
// file beside the #174 capture; the rate-limits capture above is untouched.
//
// The command string is deliberately NOT changed — the marker directory is
// derived from `--out` — so tees installed by older builds start recording
// models with no re-install and no settings.json rewrite.
// ---------------------------------------------------------------------------

/// Session ids become file names, and the payload is external input, so the
/// id is admitted only in the shape Claude Code actually emits (a UUID).
/// Anything else is dropped rather than sanitized — there is no legitimate
/// session id with a path separator in it.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isUsableStatuslineSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) && !value.includes('..');
}

/// Extract `{ sessionId, model, modelDisplayName, cwd }` from a statusline
/// payload, or null when either half is missing — which is normal (the
/// moments before Claude Code has resolved a model, or a future payload
/// shape) and never an error.
export function parseStatuslineSessionModel(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  const sessionId = text(data.session_id ?? data.sessionId);
  if (!isUsableStatuslineSessionId(sessionId)) return null;
  const model = data.model;
  const modelId = typeof model === 'string'
    ? text(model)
    : text(model?.id ?? model?.model_id ?? model?.modelId);
  if (!modelId) return null;
  return {
    sessionId,
    model: modelId,
    modelDisplayName: typeof model === 'string'
      ? null
      : text(model?.display_name ?? model?.displayName),
    cwd: text(data.workspace?.current_dir ?? data.workspace?.currentDir ?? data.cwd),
  };
}

/// Where one account's per-session model markers live, derived from its #174
/// capture file: `<statusline>/<accountId>.json` →
/// `<statusline>/sessions/<accountId>/`.
export function statuslineSessionDir(captureFile) {
  return path.join(
    path.dirname(captureFile),
    'sessions',
    path.basename(captureFile).replace(/\.json$/iu, ''),
  );
}

/// Markers older than this are pruned on the next write. A session that has
/// not rendered a statusline in a day is over; keeping its marker would only
/// let a resumed session inherit a stale "previous model".
export const STATUSLINE_SESSION_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/// Housekeeping against the REAL clock (file mtimes), never the payload's
/// timestamp — a test or a machine whose payload clock differs must not be
/// able to sweep away live markers. The marker just written is always kept.
function pruneSessionMarkers(directory, keepFile) {
  let entries;
  try { entries = fs.readdirSync(directory); } catch { return; }
  const nowMs = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(directory, entry);
    if (target === keepFile) continue;
    try {
      if (nowMs - fs.statSync(target).mtimeMs > STATUSLINE_SESSION_MARKER_TTL_MS) fs.unlinkSync(target);
    } catch { /* best effort: a marker we cannot stat or remove is harmless */ }
  }
}

/// How often an unchanged session refreshes its marker.
///
/// The marker's `observedAt` is what tells the daemon the session is still
/// ALIVE — a closed session can never report the recovery that clears its own
/// drop, so the notice's lifetime is bounded by that liveness (CodeRabbit, PR
/// #472). Without a heartbeat the timestamp would instead mean "time of the
/// last model change", and a long-running session's drop would expire while
/// the session was still open and still wrong. Five minutes costs ~12 tiny
/// writes an hour per session, two orders of magnitude finer than the bound.
export const STATUSLINE_SESSION_HEARTBEAT_MS = 5 * 60 * 1000;

/// Write the session's model marker when the model changed, when the marker
/// is new, or when the stored one is a heartbeat old. Every render would
/// otherwise rewrite the file and wake the daemon's watcher continuously for
/// no new information. Returns the marker written, or null.
function writeSessionMarkerSync(directory, session, observedAt, writeFile) {
  const file = path.join(directory, `${session.sessionId}.json`);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new or unreadable */ }
  // A NEGATIVE age means the stored marker is stamped in the future — the
  // system clock moved backward (an NTP correction, a manual change, a bad RTC
  // on wake). Suppressing on that would freeze the marker until the clock
  // climbed back past the stale stamp, and the daemon reads this timestamp as
  // the session's liveness, so the drop state it bounds would outlive its TTL
  // intent (CodeRabbit, PR #472). Only a real, forward, sub-heartbeat age
  // suppresses the write.
  const previousMs = Date.parse(previous?.observedAt ?? '');
  const observedMs = Date.parse(observedAt);
  const ageMs = observedMs - previousMs;
  const withinHeartbeat = Number.isFinite(previousMs)
    && Number.isFinite(observedMs)
    && ageMs >= 0
    && ageMs < STATUSLINE_SESSION_HEARTBEAT_MS;
  if (previous?.model === session.model && withinHeartbeat) return null;
  const marker = { ...session, observedAt };
  writeFile(file, marker);
  pruneSessionMarkers(directory, file);
  return marker;
}

/// The statusLine command string written into a profile's settings.json.
/// Absolute paths only — the statusline runs inside Claude Code's shell with
/// an unknown PATH. `chainCommand` is the user's pre-existing statusLine
/// command, carried as base64 so its own quoting survives ours untouched.
export function buildStatuslineCommand({ execPath, scriptPath, captureFile, chainCommand, sea = isSea() } = {}) {
  if (!execPath) throw new Error('statusline executable path is required');
  if (!captureFile) throw new Error('statusline capture file path is required');
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  const parts = [quote(execPath)];
  if (sea) parts.push(STATUSLINE_SEA_COMMAND);
  else {
    if (!scriptPath) throw new Error('statusline script path is required outside SEA mode');
    parts.push(quote(scriptPath));
  }
  parts.push('--out', quote(captureFile));
  if (chainCommand) parts.push('--chain-b64', quote(Buffer.from(chainCommand, 'utf8').toString('base64')));
  return parts.join(' ');
}

/// Whether a settings.json statusLine command is ModelDeck's own tee (either
/// launch mode). Uninstall and idempotent re-install both key off this.
export function isModelDeckStatuslineCommand(command) {
  if (typeof command !== 'string') return false;
  return command.includes(STATUSLINE_SEA_COMMAND) || command.includes('claude-statusline.mjs');
}

/// The executable path embedded in a ModelDeck tee command (its first
/// shell word), or null for anything that is not our tee. The startup
/// reconcile (issue #189, same bug class as #185) compares this against the
/// live daemon's executable to catch tees still pointing at a deleted or
/// moved binary.
export function execPathFromStatuslineCommand(command) {
  if (!isModelDeckStatuslineCommand(command)) return null;
  const match = command.match(/^((?:'[^']*'|\\')+)(?:\s|$)/);
  if (!match) return null;
  return match[1]
    .replaceAll(`'\\''`, '\u0000')
    .replaceAll("'", '')
    .replaceAll('\u0000', "'");
}

/// The user's original chained command out of a ModelDeck tee command, or
/// null when the tee has no chain.
export function chainCommandFromStatuslineCommand(command) {
  const match = typeof command === 'string' && command.match(/--chain-b64 '([A-Za-z0-9+/=]+)'/);
  if (!match) return null;
  try { return Buffer.from(match[1], 'base64').toString('utf8'); } catch { return null; }
}

function argvValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/// Atomic (temp + rename) owner-only write, mirroring the daemon's shell-env
/// file discipline: a daemon read racing a statusline render never sees a
/// half-written capture.
function writeCaptureFileSync(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

/// The statusline tee entry point. Contract:
///   1. Chain first: when the user had their own statusLine command, run it
///      with the SAME stdin bytes and pass its stdout through UNTOUCHED —
///      opting into ModelDeck capture must never change what the user sees.
///   2. Then upsert: when the payload carries rate_limits windows, write the
///      per-profile capture file; otherwise leave it exactly as it was.
///   3. Never fail: malformed stdin, a broken chain command, or an
///      unwritable capture file must not surface as a statusline error.
/// Always returns 0.
export async function runStatuslineCli({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  spawnSync = nodeSpawnSync,
  writeCapture = writeCaptureFileSync,
  now = () => new Date(),
} = {}) {
  let input = Buffer.alloc(0);
  try { input = await readAll(stdin); } catch { /* no stdin: still exit 0 */ }

  const chainB64 = argvValue(argv, '--chain-b64');
  if (chainB64) {
    try {
      const chainCommand = Buffer.from(chainB64, 'base64').toString('utf8');
      const result = spawnSync('/bin/sh', ['-c', chainCommand], {
        input,
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      if (result?.stdout?.length) stdout.write(result.stdout);
    } catch { /* the chain is best-effort; capture continues below */ }
  }

  const out = argvValue(argv, '--out');
  if (!out) return 0;
  const payload = input.toString('utf8');
  const observedAt = now().toISOString();

  try {
    const rateLimits = parseStatuslineRateLimits(payload);
    // Absence of rate_limits is normal (non-Pro/Max plans; first API
    // response pending) — write nothing, never error.
    if (rateLimits) writeCapture(out, { ...rateLimits, observedAt });
  } catch { /* capture is best-effort; the statusline must never break */ }

  // Issue #377: independent of the rate-limits capture — a session on a plan
  // that reports no rate_limits must still be watched for a model drop.
  try {
    const session = parseStatuslineSessionModel(payload);
    if (session) writeSessionMarkerSync(statuslineSessionDir(out), session, observedAt, writeCapture);
  } catch { /* same contract: the statusline must never break */ }
  return 0;
}

const isMain = !isSea() && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runStatuslineCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
