// Issue #377 — a silent mid-session Fable → Opus drop must become loud state.
//
// TRIPWIRE model-drop-notice (MUTATION-VERIFIED): the fixture drives the REAL
// statusline tee (`runStatuslineCli`) with the payload Claude Code pipes to
// it, then the REAL daemon ingest, then reads `/api/state`. It pins the whole
// chain the notice depends on: the tee records the session's model, a
// downgrade raises a drop, the drop states WHY and WHEN the model returns,
// and getting back on the model clears it. No provider traffic, no running
// session touched, placeholder identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  runStatuslineCli,
  STATUSLINE_SESSION_HEARTBEAT_MS,
  STATUSLINE_SESSION_MARKER_TTL_MS,
  statuslineSessionDir,
} from '../src/adapters/claude-statusline.mjs';
import { Store } from '../src/db.mjs';
import { claudeModelTier, isModelDowngrade } from '../src/model-tier.mjs';
import { createApp } from '../src/server.mjs';
import { MODEL_DROP_QUOTA_PERCENT, ModelDeckService } from '../src/service.mjs';

const TEST_PORT = 18377;
const TOKEN = 'model-drop-placeholder-token';
const SESSION = 'aaaaaaaa-0000-4000-8000-placeholder1';
const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-5';
// CALENDAR-INDEPENDENCE TRIPWIRE: marker fixtures live decades in the past,
// so any accidental return to the real clock expires them immediately.
const FIXTURE_NOW_MS = Date.parse('2000-08-15T10:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-model-drop-'));
  const profileRef = path.join(root, 'claude-placeholder-profile');
  fs.mkdirSync(profileRef, { mode: 0o700 });
  const store = new Store(path.join(root, 'modeldeck.sqlite'));
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Drop Placeholder',
    identity: 'model-drop@example.invalid',
    profileRef,
  });
  const service = new ModelDeckService(store, {
    now: () => FIXTURE_NOW_MS,
    projectsRoot: root,
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    claudeStatuslineDir: path.join(root, 'statusline'),
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    claudeCredentialsPresent: async () => true,
    platform: 'linux',
  });
  const app = createApp({
    store,
    service,
    host: '127.0.0.1',
    port: TEST_PORT,
    mutationToken: TOKEN,
    laneManifestPath: path.join(root, 'absent-lane-manifest.jsonl'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { account, app, service, store };
}

/// One statusline render, through the real tee entry point — the same code
/// path a live session's `statusLine` command runs.
async function render(service, accountId, { model, at, sessionId = SESSION }) {
  const payload = JSON.stringify({
    session_id: sessionId,
    model: { id: model, display_name: model === FABLE ? 'Fable 5' : 'Opus 5' },
    workspace: { current_dir: '/placeholder/workspace' },
  });
  const code = await runStatuslineCli({
    argv: ['--out', service.claudeStatuslineCaptureFile(accountId)],
    stdin: Readable.from([Buffer.from(payload)]),
    stdout: { write() {} },
    now: () => new Date(at),
  });
  assert.equal(code, 0, 'the statusline tee always exits 0');
  await service.ingestClaudeStatuslineSessionModels();
}

async function apiState(app) {
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/api/state',
    headers: { host: `127.0.0.1:${TEST_PORT}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let payload;
  const res = {
    writeHead(value) { status = value; },
    end(value) { payload = String(value); },
  };
  await app.server.listeners('request')[0](req, res);
  assert.equal(status, 200);
  return JSON.parse(payload);
}

test('TRIPWIRE model-drop-notice — a mid-session drop reaches /api/state with why, when, and a way back', async (t) => {
  const data = fixture(t);
  assert.equal(MODEL_DROP_QUOTA_PERCENT, 95, 'the reviewed quota-cause bar stays explicit');

  // 1. The session is on Fable. Nothing to say.
  await render(data.service, data.account.id, { model: FABLE, at: '2000-08-15T10:00:00.000Z' });
  assert.deepEqual((await apiState(data.app)).modelDrop, { quotaPercent: 95, drops: [] });

  // The tee recorded the model where the daemon can see it, without any
  // change to the installed statusLine command.
  const markerDir = statuslineSessionDir(data.service.claudeStatuslineCaptureFile(data.account.id));
  assert.deepEqual(fs.readdirSync(markerDir), [`${SESSION}.json`]);

  // 2. The Fable weekly is spent — that is the WHY and the WHEN.
  data.store.recordUsage(data.account.id, {
    scope: 'Fable weekly',
    usedPercent: 100,
    resetsAt: '2000-08-18T00:00:00.000Z',
    observedAt: '2000-08-15T10:04:00.000Z',
    source: 'claude-oauth-api',
    detail: {},
  });

  // 3. The session silently lands on Opus.
  await render(data.service, data.account.id, { model: OPUS, at: '2000-08-15T10:05:00.000Z' });
  const state = await apiState(data.app);
  assert.equal(state.modelDrop.drops.length, 1, 'the drop is loud, not silent');
  assert.deepEqual(state.modelDrop.drops[0], {
    sessionId: SESSION,
    accountId: data.account.id,
    accountLabel: 'Drop Placeholder',
    fromModel: FABLE,
    fromModelDisplay: 'Fable 5',
    toModel: OPUS,
    toModelDisplay: 'Opus 5',
    droppedAt: '2000-08-15T10:05:00.000Z',
    cwd: '/placeholder/workspace',
    reason: 'quota-exhausted',
    windowScope: 'Fable weekly',
    windowUsedPercent: 100,
    returnsAt: '2000-08-18T00:00:00.000Z',
    available: false,
    remedy: `Run /model ${FABLE} in that session once the window resets.`,
  });

  // 4. Re-reading the same marker is idempotent — a watcher fires per write
  //    and every startup re-reads them all.
  await data.service.ingestClaudeStatuslineSessionModels();
  assert.equal((await apiState(data.app)).modelDrop.drops.length, 1);

  // 5. A further downgrade keeps the ORIGINAL story ("you were on Fable").
  await render(data.service, data.account.id, {
    model: 'claude-sonnet-5',
    at: '2000-08-15T10:06:00.000Z',
  });
  const deeper = (await apiState(data.app)).modelDrop.drops[0];
  assert.equal(deeper.fromModel, FABLE);
  assert.equal(deeper.toModel, 'claude-sonnet-5');
  assert.equal(deeper.droppedAt, '2000-08-15T10:05:00.000Z');

  // 6. Once the window has reset, the notice says the model is back. The
  //    session is still open across those days, so its statusline keeps
  //    rendering — the heartbeat write is what proves it is still alive and
  //    keeps the notice inside the lifetime bound below.
  await render(data.service, data.account.id, {
    model: 'claude-sonnet-5',
    at: '2000-08-18T00:00:30.000Z',
  });
  data.service.now = () => Date.parse('2000-08-18T00:01:00.000Z');
  const back = (await apiState(data.app)).modelDrop.drops[0];
  assert.equal(back.available, true);
  assert.equal(back.remedy, `Run /model ${FABLE} in that session to switch back.`);

  // 7. The user switches back inside the session — the drop clears itself.
  await render(data.service, data.account.id, { model: FABLE, at: '2000-08-18T00:02:00.000Z' });
  assert.deepEqual((await apiState(data.app)).modelDrop.drops, [], 'getting back on Fable clears the notice');

  // 8. A disabled account is benched, same as the #395 blackout alert.
  await render(data.service, data.account.id, { model: OPUS, at: '2000-08-18T00:03:00.000Z' });
  assert.equal((await apiState(data.app)).modelDrop.drops.length, 1);
  data.store.saveAccount({ ...data.account, enabled: false });
  assert.deepEqual((await apiState(data.app)).modelDrop.drops, []);
});

// CodeRabbit (PR #472, major): an unresolved drop had no lifetime bound in any
// layer. A session the user has CLOSED never renders another statusline, so it
// can never report the recovery that clears its drop — the row kept dropped_at
// forever and the non-dismissible header banner kept rendering it, one more
// permanent line per ended session.
//
// The rule: a drop is reported only while its session is still alive, which is
// exactly as long as that session's own statusline marker lives
// (STATUSLINE_SESSION_MARKER_TTL_MS) — a drop in a session nobody can return
// to is not actionable, so it must stop alarming. ONE constant bounds both the
// marker on disk and the row in the database, so the two cannot drift apart.
test('TRIPWIRE model-drop-notice — a drop from a session that has gone quiet ages out', async (t) => {
  const data = fixture(t);
  await render(data.service, data.account.id, { model: FABLE, at: '2000-08-15T10:00:00.000Z' });
  await render(data.service, data.account.id, { model: OPUS, at: '2000-08-15T10:05:00.000Z' });
  assert.equal((await apiState(data.app)).modelDrop.drops.length, 1);

  // A minute short of the bound the session may still come back — the notice
  // it would need is still there.
  const droppedMs = Date.parse('2000-08-15T10:05:00.000Z');
  data.service.now = () => droppedMs + STATUSLINE_SESSION_MARKER_TTL_MS - 60_000;
  assert.equal((await apiState(data.app)).modelDrop.drops.length, 1, 'a live session keeps its notice');

  // Past the bound with no further observation: the notice clears itself.
  data.service.now = () => droppedMs + STATUSLINE_SESSION_MARKER_TTL_MS + 60_000;
  assert.deepEqual((await apiState(data.app)).modelDrop.drops, [], 'a dead session stops alarming');

  // And the row does not linger in the database either — an API-side bound
  // alone would leave session_model_state growing without limit.
  await data.service.ingestClaudeStatuslineSessionModels();
  assert.deepEqual(data.store.listSessionModelDrops(), [], 'the stale row is pruned, not just hidden');
  assert.equal(data.store.sessionModelState(data.account.id, SESSION), null);
});

// The bound above is only honest if `observed_at` means "this session was
// alive at this instant". The tee writes on model CHANGE, so without a
// heartbeat the timestamp would mean "time of the last model change" and a
// still-open session's drop would expire underneath it while it was still
// wrong. This pins the heartbeat that makes observed_at a liveness signal.
test('TRIPWIRE model-drop-notice — an open session heartbeats its marker, keeping its drop alive', async (t) => {
  const data = fixture(t);
  await render(data.service, data.account.id, { model: FABLE, at: '2000-08-15T10:00:00.000Z' });
  await render(data.service, data.account.id, { model: OPUS, at: '2000-08-15T10:05:00.000Z' });
  const observedAfterDrop = data.store.sessionModelState(data.account.id, SESSION).observedAt;

  // A render inside the heartbeat window writes nothing — the disk and the
  // daemon's watcher must not churn on every statusline render.
  await render(data.service, data.account.id, { model: OPUS, at: '2000-08-15T10:06:00.000Z' });
  assert.equal(
    data.store.sessionModelState(data.account.id, SESSION).observedAt,
    observedAfterDrop,
    'an unchanged model inside the heartbeat window is not rewritten',
  );

  // A render past it refreshes the timestamp, unchanged model and all.
  const beat = Date.parse('2000-08-15T10:05:00.000Z') + STATUSLINE_SESSION_HEARTBEAT_MS + 1_000;
  await render(data.service, data.account.id, { model: OPUS, at: new Date(beat).toISOString() });
  assert.equal(
    data.store.sessionModelState(data.account.id, SESSION).observedAt,
    new Date(beat).toISOString(),
    'a live session refreshes its own liveness',
  );
  // The drop itself survives the heartbeat untouched.
  assert.equal((await apiState(data.app)).modelDrop.drops[0].droppedAt, '2000-08-15T10:05:00.000Z');

  // And that liveness is what carries the notice past the bound.
  data.service.now = () => beat + STATUSLINE_SESSION_MARKER_TTL_MS - 60_000;
  assert.equal((await apiState(data.app)).modelDrop.drops.length, 1);

  // CodeRabbit (PR #472, round 3): a BACKWARD system clock (an NTP correction,
  // a manual change, a bad RTC on wake) makes the age negative, and a negative
  // age also reads as "inside the heartbeat window". The marker would then
  // stay frozen at its future stamp until the clock climbed back past it —
  // and that stamp is exactly what the daemon reads as the session's liveness,
  // so the drop state it bounds would outlive the TTL intent. Asserted on the
  // marker FILE, since the daemon separately (and correctly) refuses an
  // observation older than the one it already holds.
  const markerFile = path.join(
    statuslineSessionDir(data.service.claudeStatuslineCaptureFile(data.account.id)),
    `${SESSION}.json`,
  );
  assert.equal(JSON.parse(fs.readFileSync(markerFile, 'utf8')).observedAt, new Date(beat).toISOString());
  const backward = new Date(beat - 60 * 60_000).toISOString();
  await render(data.service, data.account.id, { model: OPUS, at: backward });
  assert.equal(
    JSON.parse(fs.readFileSync(markerFile, 'utf8')).observedAt,
    backward,
    'a clock that moved backward never freezes the marker',
  );
});

test('model-drop-notice — an unknown model never alarms, and an upgrade is not a drop', async (t) => {
  const data = fixture(t);
  // Fail-closed: a model id carrying no known family token has no rank, so
  // neither leaving it nor arriving on it can raise a drop. The alternative —
  // ranking by a pinned id table — goes stale silently, which is the very
  // failure mode this issue exists to end.
  assert.equal(claudeModelTier('some-future-model-id'), null);
  assert.equal(isModelDowngrade(FABLE, 'some-future-model-id'), false);
  assert.equal(isModelDowngrade('some-future-model-id', OPUS), false);
  assert.equal(isModelDowngrade(OPUS, FABLE), false, 'an upgrade is never a drop');

  await render(data.service, data.account.id, { model: FABLE, at: '2000-08-15T10:00:00.000Z' });
  await render(data.service, data.account.id, {
    model: 'some-future-model-id',
    at: '2000-08-15T10:01:00.000Z',
  });
  assert.deepEqual((await apiState(data.app)).modelDrop.drops, []);
});

test('model-drop-notice — concurrent sessions on one account are tracked apart', async (t) => {
  const data = fixture(t);
  const other = 'bbbbbbbb-0000-4000-8000-placeholder2';
  await render(data.service, data.account.id, { model: FABLE, at: '2000-08-15T10:00:00.000Z' });
  await render(data.service, data.account.id, {
    model: FABLE, at: '2000-08-15T10:00:01.000Z', sessionId: other,
  });
  await render(data.service, data.account.id, { model: OPUS, at: '2000-08-15T10:05:00.000Z' });

  const drops = (await apiState(data.app)).modelDrop.drops;
  assert.deepEqual(drops.map((drop) => drop.sessionId), [SESSION], 'only the session that dropped is reported');
  // The untouched session keeps its own model — one session's drop must never
  // be attributed to its neighbour on the same subscription.
  assert.equal(data.store.sessionModelState(data.account.id, other).model, FABLE);
});

test('model-drop-notice — a hostile session id never escapes the marker directory', async (t) => {
  const data = fixture(t);
  const captureFile = data.service.claudeStatuslineCaptureFile(data.account.id);
  for (const sessionId of ['../../escape', 'a/b', '..', '']) {
    const code = await runStatuslineCli({
      argv: ['--out', captureFile],
      stdin: Readable.from([Buffer.from(JSON.stringify({
        session_id: sessionId,
        model: { id: FABLE },
      }))]),
      stdout: { write() {} },
      now: () => new Date('2000-08-15T10:00:00.000Z'),
    });
    assert.equal(code, 0);
  }
  assert.equal(fs.existsSync(statuslineSessionDir(captureFile)), false, 'no marker was written at all');
});
