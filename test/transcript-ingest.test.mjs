import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import {
  enumerateTranscriptFiles,
  ingestTranscriptArchive,
} from '../src/transcript-ingest.mjs';
import { parseArgs, usageText } from '../scripts/ingest-transcripts.mjs';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/claude-transcripts', import.meta.url));
const subagentLabelsFixtureDirectory = fileURLToPath(
  new URL('./fixtures/claude-subagent-labels', import.meta.url),
);
const multiAgentResultsFixtureDirectory = fileURLToPath(
  new URL('./fixtures/claude-multi-agent-results', import.meta.url),
);

function bumpMtime(file) {
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2_000));
}

test('TRIPWIRE #480: legacy ingest state migrates with reconciliation clear', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-ingest-state-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE ingest_file_state (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      ino INTEGER NOT NULL,
      parser TEXT,
      parser_version INTEGER,
      last_ingested_at TEXT NOT NULL
    );
    INSERT INTO ingest_file_state(
      path, size, mtime_ms, ino, parser, parser_version, last_ingested_at
    ) VALUES ('/placeholder/transcript.jsonl', 10, 20, 30, 'claude-transcript', 1,
      '2026-08-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new Store(database);
  t.after(() => store.close());
  const migratedState = store.getIngestFileState('/placeholder/transcript.jsonl');
  assert.equal(migratedState.reconcilePending, false);
  assert.equal(
    migratedState.recordCount,
    null,
    'legacy rows keep an unknown count until their next natural re-parse backfills provenance',
  );
  assert.deepEqual(
    store.db.prepare('PRAGMA index_info(ingest_file_state_session_parser_path)').all()
      .map((column) => column.name),
    ['session_id', 'parser', 'path'],
    'legacy databases gain the session-source lookup index after its columns are migrated',
  );
  store.markIngestFileReconcilePending('/placeholder/transcript.jsonl');
  assert.equal(store.getIngestFileState('/placeholder/transcript.jsonl').reconcilePending, true);
  store.recordIngestFileState('/placeholder/transcript.jsonl', {
    size: 11,
    mtimeMs: 21,
    ino: 30,
  }, { parser: 'claude-transcript', parserVersion: 1, recordCount: 1 });
  const backfilledState = store.getIngestFileState('/placeholder/transcript.jsonl');
  assert.equal(backfilledState.reconcilePending, false);
  assert.equal(backfilledState.recordCount, 1);
});

test('TRIPWIRE #480: canceling a transcript replay cannot roll back unrelated writes', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  store.beginTranscriptReconcile([{
    sessionId: 'session-placeholder',
    profileSlug: 'profile-placeholder',
  }]);
  store.saveSettings({ layout: 'single-column' });
  store.cancelTranscriptReconcile();

  assert.equal(
    store.getSettings().layout,
    'single-column',
    'reconcile staging never owns an unrelated write on the shared Store connection',
  );
});

test('tripwire: transcript ingest keeps typed and source-fallback subagent labels', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const summary = await ingestTranscriptArchive({
    store,
    directory: subagentLabelsFixtureDirectory,
    machine: 'placeholder-machine',
  });
  assert.equal(summary.subagents, 3);
  assert.deepEqual(
    store.db.prepare(`
      SELECT agent_id, agent_type FROM transcript_subagents ORDER BY agent_id
    `).all().map((row) => ({ agentId: row.agent_id, agentType: row.agent_type })),
    [
      { agentId: 'description-placeholder', agentType: 'description: placeholder description fallback' },
      { agentId: 'prompt-placeholder', agentType: 'prompt: placeholder prompt fallback' },
      { agentId: 'typed-placeholder', agentType: 'placeholder-typed-agent' },
    ],
  );
  assert.deepEqual(
    store.db.prepare(`
      SELECT DISTINCT agent_id FROM transcript_requests WHERE is_sidechain = 1 ORDER BY agent_id
    `).all().map((row) => row.agent_id),
    ['description-placeholder', 'prompt-placeholder', 'typed-placeholder'],
  );

  const replay = await ingestTranscriptArchive({
    store,
    directory: subagentLabelsFixtureDirectory,
    machine: 'placeholder-machine',
  });
  assert.equal(replay.subagents, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM transcript_subagents').get().count, 3);
});

test('tool results in one record keep their block-specific agent IDs', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());

  const summary = await ingestTranscriptArchive({
    store,
    directory: multiAgentResultsFixtureDirectory,
    machine: 'placeholder-machine',
  });

  assert.equal(summary.subagents, 2);
  assert.deepEqual(
    store.db.prepare(`
      SELECT agent_id, agent_type, total_tokens FROM transcript_subagents ORDER BY agent_id
    `).all().map((row) => ({
      agentId: row.agent_id,
      agentType: row.agent_type,
      totalTokens: row.total_tokens,
    })),
    [
      {
        agentId: 'agent-multi-placeholder-a',
        agentType: 'placeholder-agent-type-a',
        totalTokens: null,
      },
      {
        agentId: 'agent-multi-placeholder-b',
        agentType: 'placeholder-agent-type-b',
        totalTokens: null,
      },
    ],
  );
});

test('Claude transcript ingest handles both eras, dedupes API calls, and single-counts subagents', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const warnings = [];

  const first = await ingestTranscriptArchive({
    store,
    directory: fixtureDirectory,
    machine: 'placeholder-machine',
    warn: (message) => warnings.push(message),
    batchLines: 3,
  });
  assert.deepEqual(first, {
    profiles: 2,
    extraRootsScanned: 0,
    extraRootsSkipped: 0,
    files: 3,
    filesSkipped: 0,
    sessions: 2,
    requests: 5,
    subagents: 1,
    skills: 2,
    warnings: 1,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /malformed JSON.*profile-placeholder-01/);
  assert.doesNotMatch(warnings[0], /deliberately malformed/);
  assert.deepEqual(
    store.db.prepare('SELECT DISTINCT parser, parser_version FROM ingest_file_state').all()
      .map((row) => ({ ...row })),
    [{ parser: 'claude-transcript', parser_version: 1 }],
    'replay state records the transcript parser provenance',
  );

  const sessions = store.db.prepare('SELECT * FROM transcript_sessions ORDER BY session_id').all();
  assert.equal(sessions.length, 2);
  const currentSession = sessions.find((row) => row.session_id === 'session-current-placeholder');
  assert.deepEqual({
    profile: currentSession.profile_slug,
    machine: currentSession.machine,
    cwd: currentSession.cwd,
    branch: currentSession.git_branch,
    entrypoint: currentSession.entrypoint,
    version: currentSession.client_version,
    firstAt: currentSession.first_at,
    lastAt: currentSession.last_at,
    title: currentSession.title,
    titleSource: currentSession.title_source,
  }, {
    profile: 'profile-placeholder-02',
    machine: 'placeholder-machine',
    cwd: '/workspace/placeholder-project',
    branch: 'issue-placeholder-current',
    entrypoint: 'cli',
    version: '2.1.220',
    firstAt: '2026-08-08T12:00:00.000Z',
    lastAt: '2026-08-08T12:00:05.000Z',
    title: 'Placeholder current session',
    titleSource: 'custom-title',
  });
  const oldSession = sessions.find((row) => row.session_id === 'session-old-placeholder');
  assert.equal(oldSession.title, 'Placeholder legacy session');
  assert.equal(oldSession.title_source, 'last-prompt');

  const oldRequests = store.db.prepare(`
    SELECT * FROM transcript_requests
    WHERE session_id = 'session-old-placeholder'
    ORDER BY request_id
  `).all();
  assert.equal(oldRequests.length, 2, 'five repeated legacy records represent two API calls');
  assert.deepEqual(oldRequests.map((row) => row.request_id), [
    'request-old-placeholder-1',
    'request-old-placeholder-2',
  ]);
  assert.equal(oldRequests[0].effort, null, 'the requestId era does not invent effort');
  assert.equal(oldRequests[0].cache_creation_input_tokens, 3);
  assert.equal(oldRequests[0].cache_creation_ephemeral_5m_input_tokens, 2);
  assert.equal(oldRequests[0].cache_creation_ephemeral_1h_input_tokens, 1);

  const current = store.db.prepare(`
    SELECT * FROM transcript_requests
    WHERE message_id = 'message-current-placeholder-1'
  `).all();
  assert.equal(current.length, 1, 'requestId-less repeated content records dedupe by session and message ID');
  assert.equal(current[0].request_id, null);
  assert.equal(current[0].effort, 'medium');
  assert.equal(current[0].dedupe_key, 'message:session-current-placeholder:message-current-placeholder-1');

  const subagent = store.db.prepare(`
    SELECT * FROM transcript_subagents WHERE agent_id = 'agent-placeholder-1'
  `).get();
  assert.equal(subagent.session_id, 'session-current-placeholder');
  assert.equal(subagent.agent_type, 'placeholder-agent-type');
  assert.equal(subagent.resolved_model, 'claude-placeholder-subagent');
  assert.equal(subagent.total_tokens, 50);
  assert.equal(subagent.duration_ms, 3000);
  assert.deepEqual(JSON.parse(subagent.tool_stats_json), { totalToolUseCount: 2 });
  const subagentRequests = store.db.prepare(`
    SELECT * FROM transcript_requests WHERE agent_id = 'agent-placeholder-1'
  `).all();
  assert.equal(subagentRequests.length, 1);
  assert.equal(subagentRequests[0].output_tokens, 10);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM transcript_requests').get().count,
    5,
    'the parent rollup does not create a second token-counted request',
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM transcript_requests WHERE model = '<synthetic>'").get().count,
    0,
  );

  assert.deepEqual(
    store.db.prepare(`
      SELECT skill, command_name FROM transcript_skill_events
      ORDER BY COALESCE(skill, command_name)
    `).all().map((row) => ({ skill: row.skill, command_name: row.command_name })),
    [
      { skill: null, command_name: '/placeholder-command' },
      { skill: 'placeholder-skill', command_name: null },
    ],
  );

  store.migrate();
  store.migrate();
  const second = await ingestTranscriptArchive({
    store,
    directory: fixtureDirectory,
    machine: 'placeholder-machine',
    batchLines: 4,
  });
  assert.deepEqual(second, {
    profiles: 2,
    extraRootsScanned: 0,
    extraRootsSkipped: 0,
    files: 3,
    filesSkipped: 3,
    sessions: 0,
    requests: 0,
    subagents: 0,
    skills: 0,
    warnings: 0,
  });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM transcript_sessions').get().count, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM transcript_requests').get().count, 5);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM transcript_subagents').get().count, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM transcript_skill_events').get().count, 2);
});

test('TRIPWIRE #476: transcript ingest skips unchanged files and re-parses only appended or shrunk files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-incremental-'));
  fs.cpSync(fixtureDirectory, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const currentFile = path.join(
    root,
    'profile-placeholder-02',
    'projects',
    '-workspace-placeholder',
    'session-current-placeholder.jsonl',
  );
  const oldFile = path.join(
    root,
    'profile-placeholder-01',
    'projects',
    '-workspace-placeholder',
    'session-old-placeholder.jsonl',
  );

  const shrinkOnlyRecords = [
    {
      type: 'assistant',
      sessionId: 'session-old-placeholder',
      uuid: 'record-shrink-agent-invoke-placeholder',
      timestamp: '2026-08-06T10:00:05.000Z',
      message: {
        id: 'message-shrink-agent-invoke-placeholder',
        model: 'claude-placeholder-old',
        content: [{
          type: 'tool_use',
          id: 'agent-tool-shrink-placeholder',
          name: 'Agent',
          input: { subagent_type: 'placeholder-shrink-agent' },
        }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    },
    {
      type: 'user',
      sessionId: 'session-old-placeholder',
      uuid: 'record-shrink-agent-result-placeholder',
      timestamp: '2026-08-06T10:00:06.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'agent-tool-shrink-placeholder',
          content: 'agentId: agent-shrink-placeholder',
        }],
      },
      toolUseResult: {
        agentId: 'agent-shrink-placeholder',
        totalTokens: 15,
      },
    },
  ];
  fs.appendFileSync(oldFile, `${shrinkOnlyRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  await t.test('unchanged second pass performs zero parses and zero row updates', async () => {
    const changesBefore = store.db.prepare('SELECT total_changes() AS count').get().count;
    const summary = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.files, 3);
    assert.equal(summary.filesSkipped, 3, 'every enumerated file is skipped before parsing');
    assert.equal(summary.sessions, 0);
    assert.equal(summary.requests, 0);
    assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  });

  await t.test('TRIPWIRE #480: upgrade skips unchanged legacy Claude files and lazily backfills one changed file', async () => {
    store.db.exec('UPDATE ingest_file_state SET session_id = NULL, record_count = NULL');
    const unchanged = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(unchanged.filesSkipped, 3, 'legacy rows with matching stats skip without parsing');
    assert.equal(unchanged.sessions, 0);
    assert.equal(unchanged.requests, 0, 'the first post-upgrade scan parses zero Claude files');
    assert.ok(
      store.db.prepare('SELECT session_id, record_count FROM ingest_file_state').all()
        .every((state) => state.session_id == null && state.record_count == null),
      'skipping does not eagerly backfill any legacy provenance',
    );

    store.db.exec(`
      CREATE TABLE legacy_transcript_reconcile_audit(deleted_session INTEGER NOT NULL);
      CREATE TRIGGER legacy_transcript_reconcile_delete
      AFTER DELETE ON transcript_sessions
      BEGIN
        INSERT INTO legacy_transcript_reconcile_audit(deleted_session) VALUES (1);
      END;
    `);
    bumpMtime(oldFile);
    const changed = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(changed.filesSkipped, 2, 'only the naturally changed legacy file is parsed');
    assert.equal(store.getIngestFileState(oldFile).sessionId, 'session-old-placeholder');
    assert.ok(store.getIngestFileState(oldFile).recordCount > 0);
    assert.equal(store.getIngestFileState(currentFile).sessionId, null);
    assert.equal(store.getIngestFileState(currentFile).recordCount, null);
    assert.ok(
      store.db.prepare('SELECT session_id, record_count FROM ingest_file_state WHERE path <> ?')
        .all(oldFile)
        .every((state) => state.session_id == null && state.record_count == null),
      'unchanged legacy files remain untouched while provenance phases in per file',
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM legacy_transcript_reconcile_audit').get().count,
      0,
      'a same-size legacy change uses size-only shrink detection until provenance is backfilled',
    );
    store.db.exec(`
      DROP TRIGGER legacy_transcript_reconcile_delete;
      DROP TABLE legacy_transcript_reconcile_audit;
    `);
  });

  await t.test('append plus mtime bump re-parses exactly one file and lands the new request', async () => {
    const appendedRecord = {
      type: 'assistant',
      sessionId: 'session-current-placeholder',
      cwd: '/workspace/placeholder-project',
      uuid: 'record-incremental-placeholder',
      timestamp: '2026-08-08T12:01:00.000Z',
      message: {
        id: 'message-incremental-placeholder',
        model: 'claude-placeholder-current',
        content: [{ type: 'text', text: 'placeholder incremental request' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    };
    fs.appendFileSync(currentFile, `${JSON.stringify(appendedRecord)}\n`);
    bumpMtime(currentFile);

    const summary = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 2);
    assert.equal(summary.requests, 1);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM transcript_requests WHERE message_id = ?')
        .get('message-incremental-placeholder').count,
      1,
    );
  });

  await t.test('TRIPWIRE #480: an append during an earlier replay lands in the same pass', async () => {
    const triggerRecord = {
      type: 'assistant',
      sessionId: 'session-old-placeholder',
      uuid: 'record-race-trigger-placeholder',
      timestamp: '2026-08-06T10:00:07.000Z',
      message: {
        id: 'message-race-trigger-placeholder',
        model: 'claude-placeholder-old',
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const laterRecord = {
      type: 'assistant',
      sessionId: 'session-current-placeholder',
      uuid: 'record-race-later-placeholder',
      timestamp: '2026-08-08T12:02:00.000Z',
      message: {
        id: 'message-race-later-placeholder',
        model: 'claude-placeholder-current',
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    fs.appendFileSync(oldFile, `${JSON.stringify(triggerRecord)}\n`);
    bumpMtime(oldFile);
    const ingestBatch = store.ingestTranscriptBatch.bind(store);
    let appendedLater = false;
    store.ingestTranscriptBatch = (batch) => {
      if (!appendedLater) {
        appendedLater = true;
        fs.appendFileSync(currentFile, `${JSON.stringify(laterRecord)}\n`);
        bumpMtime(currentFile);
      }
      return ingestBatch(batch);
    };
    try {
      await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
    } finally {
      store.ingestTranscriptBatch = ingestBatch;
    }
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM transcript_requests WHERE message_id = ?')
        .get('message-race-later-placeholder').count,
      1,
      'later files are statted when reached instead of from a stale archive-wide snapshot',
    );
  });

  await t.test('TRIPWIRE #480: shrink removes derived rows and leaves unrelated sessions untouched', async () => {
    store.db.exec(`
      CREATE TABLE transcript_update_audit(table_name TEXT NOT NULL);
      CREATE TRIGGER transcript_session_update_audit
      AFTER UPDATE ON transcript_sessions
      BEGIN
        INSERT INTO transcript_update_audit(table_name) VALUES ('session');
      END;
      CREATE TRIGGER transcript_subagent_update_audit
      AFTER UPDATE ON transcript_subagents
      BEGIN
        INSERT INTO transcript_update_audit(table_name) VALUES ('subagent');
      END;
    `);
    const lines = fs.readFileSync(oldFile, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(oldFile, `${lines.slice(0, 5).join('\n')}\n`);
    bumpMtime(oldFile);

    const summary = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 2);
    assert.equal(summary.sessions, 0);
    assert.equal(summary.requests, 0);
    assert.deepEqual(
      store.db.prepare(`
        SELECT request_id FROM transcript_requests
        WHERE session_id = 'session-old-placeholder'
        ORDER BY request_id
      `).all().map((row) => row.request_id),
      ['request-old-placeholder-1'],
      'the request found only beyond the new end of file is removed',
    );
    assert.deepEqual(
      store.db.prepare(`
        SELECT skill, command_name FROM transcript_skill_events
        WHERE session_id = 'session-old-placeholder'
        ORDER BY event_key
      `).all().map((row) => ({ ...row })),
      [{ skill: 'placeholder-skill', command_name: null }],
      'the removed command event is gone while the replayed skill remains',
    );
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM transcript_subagents
        WHERE session_id = 'session-old-placeholder'
      `).get().count,
      0,
      'the removed Agent result no longer leaves a phantom subagent',
    );
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM transcript_requests
        WHERE session_id = 'session-current-placeholder'
      `).get().count,
      5,
      'the current session, including both appended requests and its subagent request, is untouched',
    );
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM transcript_subagents
        WHERE session_id = 'session-current-placeholder'
      `).get().count,
      1,
      'the unrelated session subagent is untouched',
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM transcript_update_audit').get().count,
      0,
      'the full-file replay issues no no-op session or subagent updates',
    );
  });

  await t.test('TRIPWIRE PR #513: a parser-version bump replays an unchanged file', async () => {
    store.db.prepare('UPDATE ingest_file_state SET parser_version = 0 WHERE path = ?').run(currentFile);

    const summary = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 2, 'the file whose stored parser version is stale is not skipped');
    assert.deepEqual(
      { ...store.db.prepare('SELECT parser, parser_version FROM ingest_file_state WHERE path = ?').get(currentFile) },
      { parser: 'claude-transcript', parser_version: 1 },
      'the replay records the current parser provenance',
    );
  });

  await t.test('a main-file shrink preserves rows replayed from its sibling subagent file', async () => {
    const lines = fs.readFileSync(currentFile, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(currentFile, `${lines.slice(0, 2).join('\n')}\n`);
    bumpMtime(currentFile);

    await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM transcript_requests
        WHERE session_id = 'session-current-placeholder'
          AND agent_id = 'agent-placeholder-1'
      `).get().count,
      1,
      'the subagent request is replayed from the unchanged sibling file',
    );
    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count FROM transcript_subagents
        WHERE session_id = 'session-current-placeholder'
          AND agent_id = 'agent-placeholder-1'
      `).get().count,
      1,
      'the sibling file keeps ownership of the subagent row',
    );
  });
});

test('TRIPWIRE #480: an unstable Claude shrink stays pending until a stable reconcile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-shrink-race-'));
  fs.cpSync(fixtureDirectory, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = path.join(
    root,
    'profile-placeholder-01',
    'projects',
    '-workspace-placeholder',
    'session-old-placeholder.jsonl',
  );
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  const originalSize = fs.statSync(file).size;
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, `${lines.slice(0, 5).join('\n')}\n`);
  bumpMtime(file);

  const statSync = fs.statSync;
  let targetStats = 0;
  fs.statSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(file)) {
      targetStats += 1;
      if (targetStats === 2) fs.appendFileSync(file, `${' '.repeat(originalSize + 50)}\n`);
    }
    return statSync(target, ...args);
  };
  try {
    await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  } finally {
    fs.statSync = statSync;
  }

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  assert.deepEqual(
    store.db.prepare(`
      SELECT request_id FROM transcript_requests
      WHERE session_id = 'session-old-placeholder'
      ORDER BY request_id
    `).all().map((row) => row.request_id),
    ['request-old-placeholder-1'],
    'growth during the first read cannot turn an unfinished shrink into an append-only replay',
  );
});

test('TRIPWIRE #480: interleaved Claude shrink groups suppress every replayed original', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-interleaved-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  fs.mkdirSync(project, { recursive: true });
  const store = new Store(':memory:');
  t.after(() => store.close());

  const record = (sessionId, suffix, second) => JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: `record-${suffix}`,
    timestamp: `2026-08-06T10:00:${String(second).padStart(2, '0')}.000Z`,
    message: {
      id: `message-${suffix}`,
      model: 'claude-placeholder',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const sessions = [
    { id: 'session-placeholder', agent: 'agent-session-placeholder', second: 1 },
    { id: 'session-placeholder-child', agent: 'agent-child-placeholder', second: 11 },
  ];
  const subagentFiles = [];
  for (const session of sessions) {
    const mainFile = path.join(project, `${session.id}.jsonl`);
    const subagentDirectory = path.join(project, session.id, 'subagents');
    const subagentFile = path.join(subagentDirectory, `${session.agent}.jsonl`);
    fs.mkdirSync(subagentDirectory, { recursive: true });
    fs.writeFileSync(mainFile, `${record(session.id, `${session.id}-main`, session.second)}\n`);
    fs.writeFileSync(subagentFile, [
      record(session.id, `${session.id}-subagent-one`, session.second + 1),
      record(session.id, `${session.id}-subagent-two`, session.second + 2),
    ].join('\n') + '\n');
    subagentFiles.push({ file: subagentFile, firstLine: record(
      session.id,
      `${session.id}-subagent-one`,
      session.second + 1,
    ) });
  }

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  for (const { file, firstLine } of subagentFiles) {
    fs.writeFileSync(file, `${firstLine}\n`);
    bumpMtime(file);
  }
  const summary = await ingestTranscriptArchive({
    store,
    directory: root,
    machine: 'placeholder-machine',
  });

  assert.equal(
    summary.filesSkipped,
    0,
    'every original file replayed inside a shrink group is suppressed when later reached',
  );
});

test('TRIPWIRE #480: a pure-fork transcript shrink replays every stored session source', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-pure-fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  fs.mkdirSync(project, { recursive: true });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessionId = 'session-original-placeholder';
  const request = (suffix, second) => JSON.stringify({
    type: 'assistant',
    sessionId,
    requestId: `request-${suffix}`,
    uuid: `record-${suffix}`,
    timestamp: `2026-08-06T10:00:0${second}.000Z`,
    message: {
      id: `message-${suffix}`,
      model: 'claude-placeholder',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const originalFile = path.join(project, `${sessionId}.jsonl`);
  const forkFile = path.join(project, 'session-fork-placeholder.jsonl');
  const first = request('original-one-placeholder', 1);
  const second = request('original-two-placeholder', 2);
  const third = request('original-three-placeholder', 3);
  fs.writeFileSync(originalFile, `${first}\n${second}\n${third}\n`);
  fs.writeFileSync(forkFile, `${first}\n${second}\n`);

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  assert.equal(store.getIngestFileState(forkFile).sessionId, sessionId);
  fs.writeFileSync(forkFile, `${first}\n`);
  bumpMtime(forkFile);
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT request_id FROM transcript_requests
      WHERE session_id = ? ORDER BY request_id
    `).all(sessionId).map((row) => row.request_id),
    [
      'request-original-one-placeholder',
      'request-original-three-placeholder',
      'request-original-two-placeholder',
    ],
    'shrinking the pure fork cannot erase a request retained by the original file',
  );
});

test('TRIPWIRE #480: Claude shrink refreshes values for requests that survive replay', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-refresh-values-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  fs.mkdirSync(project, { recursive: true });
  const store = new Store(':memory:');
  t.after(() => store.close());

  const request = ({ sessionId, suffix, model, inputTokens, outputTokens, effort }) => JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: `record-${suffix}`,
    timestamp: '2026-08-06T10:00:01.000Z',
    effort,
    message: {
      id: `message-${suffix}`,
      model,
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  });
  const sessionId = 'session-refresh-placeholder';
  const file = path.join(project, `${sessionId}.jsonl`);
  const oldRequest = request({
    sessionId,
    suffix: 'survivor-placeholder',
    model: 'claude-old-placeholder',
    inputTokens: 10,
    outputTokens: 2,
    effort: 'high',
  });
  const newRequest = request({
    sessionId,
    suffix: 'survivor-placeholder',
    model: 'claude-new-placeholder',
    inputTokens: 99,
    outputTokens: 7,
  });
  fs.writeFileSync(file, `${oldRequest}\n${request({
    sessionId,
    suffix: 'removed-placeholder',
    model: 'claude-old-placeholder',
    inputTokens: 5,
    outputTokens: 1,
  })}\n`);
  const unrelatedFile = path.join(project, 'session-unrelated-placeholder.jsonl');
  fs.writeFileSync(unrelatedFile, `${request({
    sessionId: 'session-unrelated-placeholder',
    suffix: 'unrelated-placeholder',
    model: 'claude-unrelated-placeholder',
    inputTokens: 3,
    outputTokens: 1,
    effort: 'low',
  })}\n`);

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  fs.writeFileSync(file, `${newRequest}\n`);
  bumpMtime(file);
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    { ...store.db.prepare(`
      SELECT model, effort, input_tokens, output_tokens
      FROM transcript_requests WHERE session_id = ?
    `).get(sessionId) },
    {
      model: 'claude-new-placeholder',
      effort: null,
      input_tokens: 99,
      output_tokens: 7,
    },
    'reconcile publishes the surviving source observation, including cleared nullable fields',
  );
  assert.deepEqual(
    { ...store.db.prepare(`
      SELECT model, effort, input_tokens, output_tokens
      FROM transcript_requests WHERE session_id = 'session-unrelated-placeholder'
    `).get() },
    {
      model: 'claude-unrelated-placeholder',
      effort: 'low',
      input_tokens: 3,
      output_tokens: 1,
    },
    'the unrelated session is untouched',
  );
});

test('TRIPWIRE #480: fewer Claude records reconcile even when the file does not lose bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-record-count-shrink-'));
  fs.cpSync(fixtureDirectory, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const file = path.join(
    root,
    'profile-placeholder-01',
    'projects',
    '-workspace-placeholder',
    'session-old-placeholder.jsonl',
  );

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  const originalSize = fs.statSync(file).size;
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const kept = `${lines.slice(0, 5).join('\n')}\n`;
  fs.writeFileSync(file, `${kept}${' '.repeat(originalSize - Buffer.byteLength(kept))}`);
  bumpMtime(file);
  store.db.prepare('UPDATE ingest_file_state SET parser_version = 0 WHERE path = ?').run(file);

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  assert.equal(fs.statSync(file).size, originalSize);
  assert.deepEqual(
    store.db.prepare(`
      SELECT request_id FROM transcript_requests
      WHERE session_id = 'session-old-placeholder' ORDER BY request_id
    `).all().map((row) => row.request_id),
    ['request-old-placeholder-1'],
    'record-count shrink and parser-version replay compose without retaining the removed request',
  );
  assert.equal(store.getIngestFileState(file).parserVersion, 1);
});

test('TRIPWIRE #480: Claude shrink clears vanished subagent rollup values', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-subagent-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  const sessionId = 'session-subagent-refresh-placeholder';
  const mainFile = path.join(project, `${sessionId}.jsonl`);
  const subagentDirectory = path.join(project, sessionId, 'subagents');
  const subagentFile = path.join(subagentDirectory, 'agent-refresh-placeholder.jsonl');
  fs.mkdirSync(subagentDirectory, { recursive: true });
  const invocation = JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: 'record-agent-invocation-placeholder',
    timestamp: '2026-08-06T10:00:01.000Z',
    message: {
      id: 'message-agent-invocation-placeholder',
      model: 'claude-placeholder',
      content: [{
        type: 'tool_use',
        id: 'tool-agent-refresh-placeholder',
        name: 'Agent',
        input: { subagent_type: 'reviewer-placeholder' },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const result = JSON.stringify({
    type: 'user',
    sessionId,
    uuid: 'record-agent-result-placeholder',
    timestamp: '2026-08-06T10:00:02.000Z',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-agent-refresh-placeholder',
        content: 'agentId: agent-refresh-placeholder',
      }],
    },
    toolUseResult: {
      agentId: 'agent-refresh-placeholder',
      resolvedModel: 'claude-rich-placeholder',
      totalTokens: 99,
      toolStats: { totalToolUseCount: 4 },
      durationMs: 123,
    },
  });
  fs.writeFileSync(mainFile, `${invocation}\n${result}\n`);
  fs.writeFileSync(subagentFile, `${JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: 'record-subagent-placeholder',
    timestamp: '2026-08-06T10:00:03.000Z',
    message: {
      id: 'message-subagent-placeholder',
      model: 'claude-placeholder',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })}\n`);
  const store = new Store(':memory:');
  t.after(() => store.close());

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  fs.writeFileSync(mainFile, `${invocation}\n`);
  bumpMtime(mainFile);
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    { ...store.db.prepare(`
      SELECT agent_type, resolved_model, total_tokens, tool_stats_json, duration_ms
      FROM transcript_subagents WHERE agent_id = 'agent-refresh-placeholder'
    `).get() },
    {
      agent_type: null,
      resolved_model: null,
      total_tokens: null,
      tool_stats_json: null,
      duration_ms: null,
    },
    'the sibling file preserves existence without preserving rollup data from a removed result',
  );
});

test('TRIPWIRE #480: unstable Claude path repurposing never publishes the transient session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-unstable-repurpose-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'session-a-placeholder.jsonl');
  const record = (sessionId, suffix) => JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: `record-${suffix}`,
    timestamp: '2026-08-06T10:00:01.000Z',
    message: {
      id: `message-${suffix}`,
      model: 'claude-placeholder',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const sessionA = 'session-a-placeholder';
  const sessionB = 'session-b-placeholder';
  const sessionC = 'session-c-placeholder';
  fs.writeFileSync(file, `${record(sessionA, 'a-one-placeholder')}\n${record(
    sessionA,
    `a-two-${'padding-placeholder-'.repeat(20)}`,
  )}\n`);
  const store = new Store(':memory:');
  t.after(() => store.close());
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  fs.writeFileSync(file, `${record(sessionB, 'b-placeholder')}\n`);
  bumpMtime(file);
  const sessionBStat = fs.statSync(file);
  const statSync = fs.statSync;
  let targetStats = 0;
  fs.statSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(file)) {
      targetStats += 1;
      if (targetStats === 2) {
        fs.writeFileSync(file, `${record(sessionC, 'c-placeholder')}\n`);
        fs.utimesSync(file, sessionBStat.atime, new Date(sessionBStat.mtimeMs + 2_000));
      }
    }
    return statSync(target, ...args);
  };
  try {
    await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  } finally {
    fs.statSync = statSync;
  }
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare('SELECT session_id FROM transcript_sessions ORDER BY session_id').all()
      .map((row) => row.session_id),
    [sessionC],
    'a session parsed from an unstable intermediate snapshot never reaches the warehouse',
  );
});

test('TRIPWIRE #480: a larger-byte logical shrink never publishes an unstable replacement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-logical-shrink-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'session-a-placeholder.jsonl');
  const record = (sessionId, suffix, padding = '') => JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: `record-${suffix}`,
    timestamp: '2026-08-06T10:00:01.000Z',
    message: {
      id: `message-${suffix}`,
      model: 'claude-placeholder',
      content: padding ? [{ type: 'text', text: padding }] : [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const sessionA = 'session-a-placeholder';
  const sessionB = 'session-b-placeholder';
  const sessionC = 'session-c-placeholder';
  fs.writeFileSync(file, `${[
    record(sessionA, 'a-one-placeholder'),
    record(sessionA, 'a-two-placeholder'),
    record(sessionA, 'a-three-placeholder'),
  ].join('\n')}\n`);
  const store = new Store(':memory:');
  t.after(() => store.close());
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  const sessionAState = store.getIngestFileState(file);

  fs.writeFileSync(file, `${[
    record(sessionB, 'b-one-placeholder', 'padding-placeholder-'.repeat(40)),
    record(sessionB, 'b-two-placeholder', 'padding-placeholder-'.repeat(40)),
  ].join('\n')}\n`);
  bumpMtime(file);
  const sessionBStat = fs.statSync(file);
  assert.ok(sessionBStat.size > sessionAState.size, 'the logical shrink grows in bytes');

  const statSync = fs.statSync;
  let targetStats = 0;
  fs.statSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(file)) {
      targetStats += 1;
      if (targetStats === 2) {
        fs.writeFileSync(file, `${record(sessionC, 'c-placeholder')}\n`);
        fs.utimesSync(file, sessionBStat.atime, new Date(sessionBStat.mtimeMs + 2_000));
      }
    }
    return statSync(target, ...args);
  };
  try {
    await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  } finally {
    fs.statSync = statSync;
  }
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare('SELECT session_id FROM transcript_sessions ORDER BY session_id').all()
      .map((row) => row.session_id),
    [sessionC],
    'neither the old session nor an unstable replacement survives the authoritative retry',
  );
  assert.deepEqual(
    store.db.prepare('SELECT message_id FROM transcript_requests ORDER BY message_id').all()
      .map((row) => row.message_id),
    ['message-c-placeholder'],
  );
  assert.equal(store.getIngestFileState(file).reconcilePending, false);
});

test('TRIPWIRE #480: a repurposed Claude path cannot reconcile its replacement session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-repurposed-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'profile-placeholder', 'projects', 'project-placeholder');
  fs.mkdirSync(project, { recursive: true });
  const store = new Store(':memory:');
  t.after(() => store.close());

  const request = (sessionId, suffix, inputTokens = 1) => JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: `record-${suffix}`,
    timestamp: `2026-08-06T10:00:0${inputTokens}.000Z`,
    message: {
      id: `message-${suffix}`,
      model: 'claude-placeholder',
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  const sessionA = 'session-a-placeholder';
  const sessionB = 'session-b-placeholder';
  const fileA = path.join(project, `${sessionA}.jsonl`);
  const fileB = path.join(project, `${sessionB}.jsonl`);
  fs.writeFileSync(fileA, `${request(sessionA, 'a-one-placeholder')}\n${request(
    sessionA,
    'a-two-placeholder',
    2,
  )}\n`);
  const bOne = request(sessionB, 'b-one-placeholder');
  const bTwo = request(sessionB, 'b-two-placeholder', 2);
  fs.writeFileSync(fileB, `${bOne}\n${bTwo}\n`);

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  fs.writeFileSync(fileA, `${bOne}\n`);
  bumpMtime(fileA);
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.equal(
    store.db.prepare(`
      SELECT COUNT(*) AS count FROM transcript_sessions WHERE session_id = ?
    `).get(sessionA).count,
    0,
    'the session formerly owned by the path is removed',
  );
  assert.deepEqual(
    store.db.prepare(`
      SELECT message_id FROM transcript_requests
      WHERE session_id = ? ORDER BY message_id
    `).all(sessionB).map((row) => row.message_id),
    ['message-b-one-placeholder', 'message-b-two-placeholder'],
    'replaying one replacement record cannot delete rows from the replacement session canonical file',
  );
});

test('blank custom titles still block later last-prompt titles', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const session = {
    sessionId: 'session-blank-title-placeholder',
    profileSlug: 'profile-placeholder',
    machine: 'placeholder-machine',
  };

  store.ingestTranscriptBatch({ sessions: [{ ...session, title: null, titleSource: null }] });
  store.ingestTranscriptBatch({
    sessions: [{ ...session, title: null, titleSource: 'custom-title' }],
  });
  assert.deepEqual(
    { ...store.db.prepare(`
      SELECT title, title_source FROM transcript_sessions WHERE session_id = ?
    `).get(session.sessionId) },
    { title: null, title_source: 'custom-title' },
  );

  store.ingestTranscriptBatch({
    sessions: [{ ...session, title: 'Placeholder real text', titleSource: 'last-prompt' }],
  });
  assert.deepEqual(
    { ...store.db.prepare(`
      SELECT title, title_source FROM transcript_sessions WHERE session_id = ?
    `).get(session.sessionId) },
    { title: null, title_source: 'custom-title' },
  );
});

test('transcript enumeration does not follow profile or nested project symlinks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(fixtureDirectory, 'profile-placeholder-01'), path.join(root, 'active-profile'));
  const profile = path.join(root, 'profile-placeholder');
  fs.mkdirSync(path.join(profile, 'projects'), { recursive: true });
  fs.symlinkSync(
    path.join(fixtureDirectory, 'profile-placeholder-01', 'projects'),
    path.join(profile, 'projects', 'linked-projects'),
  );

  const result = await enumerateTranscriptFiles(root);
  assert.equal(result.profiles, 1, 'the symlinked profile root is not a profile');
  assert.equal(result.files.length, 0);
  assert.equal(result.skippedSymlinks, 1);
});

// Issue #605: extra scan roots are standalone Claude homes attributed to a
// profile label. The managed-root symlink discipline holds for them whole:
// a symlinked root, an overlap with the managed directory, a duplicate, and
// a missing path are all skipped with a reason, never scanned.
test('TRIPWIRE #605: extra scan roots hold the symlink and overlap rules', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-extra-roots-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const managedRoot = path.join(base, 'claude-profiles');
  fs.mkdirSync(path.join(managedRoot, 'profile-placeholder', 'projects'), { recursive: true });
  const extraHome = path.join(base, 'extra-home');
  const extraProjects = path.join(extraHome, 'projects', '-workspace-placeholder');
  fs.mkdirSync(extraProjects, { recursive: true });
  fs.writeFileSync(path.join(extraProjects, 'session-extra-placeholder.jsonl'), '{}\n');
  const outsideProjects = path.join(base, 'outside', 'projects');
  fs.mkdirSync(outsideProjects, { recursive: true });
  fs.writeFileSync(path.join(outsideProjects, 'session-outside-placeholder.jsonl'), '{}\n');
  fs.symlinkSync(path.join(base, 'outside', 'projects'), path.join(extraHome, 'projects', 'linked'));
  fs.symlinkSync(extraHome, path.join(base, 'linked-home'));
  fs.symlinkSync(base, path.join(base, 'alias-base'));

  const result = await enumerateTranscriptFiles(managedRoot, [
    { path: extraHome, profileSlug: 'profile-placeholder' },
    { path: extraHome, profileSlug: 'other-placeholder' },
    { path: path.join(base, 'linked-home'), profileSlug: 'profile-placeholder' },
    { path: managedRoot, profileSlug: 'profile-placeholder' },
    { path: path.join(managedRoot, 'profile-placeholder'), profileSlug: 'profile-placeholder' },
    { path: path.join(base, 'absent-home'), profileSlug: 'profile-placeholder' },
    { profileSlug: 'profile-placeholder' },
    // Symlinked PARENT components: lstat sees a real directory, so only the
    // canonical-path comparison can catch these aliases.
    { path: path.join(base, 'alias-base', 'extra-home'), profileSlug: 'profile-placeholder' },
    { path: path.join(base, 'alias-base', 'claude-profiles'), profileSlug: 'profile-placeholder' },
  ]);
  assert.equal(result.extraRootsScanned, 1);
  assert.deepEqual(result.extraRootsSkipped.map((skipped) => skipped.reason), [
    'duplicate root',
    'root is a symlink',
    'overlaps the managed profiles directory',
    'overlaps the managed profiles directory',
    'does not exist',
    'entry must carry a path and a profileSlug',
    'duplicate root',
    'overlaps the managed profiles directory',
  ]);
  const canonicalExtraHome = fs.realpathSync(extraHome);
  assert.deepEqual(result.files.map((file) => file.path), [
    path.join(canonicalExtraHome, 'projects', '-workspace-placeholder', 'session-extra-placeholder.jsonl'),
  ], 'the symlinked directory inside the extra root is never traversed');
  assert.equal(result.files[0].profileSlug, 'profile-placeholder');
  assert.equal(
    result.files[0].relativePath,
    path.join(canonicalExtraHome, 'projects', '-workspace-placeholder', 'session-extra-placeholder.jsonl'),
    'extra-root files are labeled by root path so they can never shadow managed files of the same slug',
  );
  assert.equal(result.skippedSymlinks, 1);
});

// Issue #605 read-only guarantee (insight-fleet standing rule): ingesting an
// extra root attributes its rows to the configured profile and leaves the
// scanned tree untouched — no writes, no renames, no mtime churn.
test('TRIPWIRE #605: extra scan root ingest is read-only and profile-attributed', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-extra-ingest-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const managedRoot = path.join(base, 'claude-profiles');
  fs.mkdirSync(path.join(managedRoot, 'lend-management', 'projects'), { recursive: true });
  const extraHome = path.join(base, 'insight-home');
  const extraProjects = path.join(extraHome, 'projects', '-workspace-placeholder');
  fs.mkdirSync(extraProjects, { recursive: true });
  fs.writeFileSync(path.join(extraProjects, 'session-insight-placeholder.jsonl'), `${JSON.stringify({
    type: 'assistant',
    sessionId: 'session-insight-placeholder',
    uuid: 'record-insight-placeholder',
    timestamp: '2026-08-29T10:00:00.000Z',
    cwd: '/workspace/placeholder',
    message: {
      id: 'message-insight-placeholder',
      model: 'claude-placeholder',
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  })}\n`);

  function snapshotTree(directory) {
    const rows = [];
    (function collect(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const target = path.join(current, entry.name);
        const stat = fs.lstatSync(target);
        rows.push({
          path: path.relative(directory, target),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode,
          digest: stat.isFile()
            ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
            : null,
        });
        if (entry.isDirectory()) collect(target);
      }
    })(directory);
    return rows;
  }
  const before = snapshotTree(extraHome);

  const store = new Store(':memory:');
  t.after(() => store.close());
  const warnings = [];
  const summary = await ingestTranscriptArchive({
    store,
    directory: managedRoot,
    extraRoots: [
      { path: extraHome, profileSlug: 'lend-management' },
      { path: path.join(base, 'absent-home'), profileSlug: 'lend-management' },
    ],
    warn: (message) => warnings.push(message),
  });
  assert.equal(summary.extraRootsScanned, 1);
  assert.equal(summary.extraRootsSkipped, 1);
  assert.equal(summary.requests, 1);
  assert.equal(summary.warnings, 1);
  assert.match(warnings[0], /skipped extra scan root .*absent-home: does not exist/);
  assert.deepEqual(
    store.db.prepare('SELECT session_id, profile_slug FROM transcript_sessions').all()
      .map((row) => ({ sessionId: row.session_id, profileSlug: row.profile_slug })),
    [{ sessionId: 'session-insight-placeholder', profileSlug: 'lend-management' }],
  );
  assert.deepEqual(
    store.db.prepare('SELECT profile_slug FROM transcript_requests').all()
      .map((row) => row.profile_slug),
    ['lend-management'],
  );
  assert.deepEqual(snapshotTree(extraHome), before, 'the extra root is scanned strictly read-only');

  const second = await ingestTranscriptArchive({
    store,
    directory: managedRoot,
    extraRoots: [{ path: extraHome, profileSlug: 'lend-management' }],
  });
  assert.equal(second.filesSkipped, 1, 'ingest state keyed by absolute path skips the unchanged file');
  assert.deepEqual(snapshotTree(extraHome), before);
});

test('legacy non-assistant request IDs and requestId-less uuid fallback remain countable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'profile-placeholder', 'projects', '-workspace-placeholder');
  fs.mkdirSync(projects, { recursive: true });
  const refusal = JSON.stringify({
    type: 'system',
    sessionId: 'session-fallback-placeholder',
    requestId: 'request-refusal-placeholder',
    uuid: 'record-refusal-placeholder',
    timestamp: '2026-08-07T10:00:00.000Z',
    message: {
      id: 'message-refusal-placeholder',
      model: 'claude-placeholder-refusal',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });
  const uuidFallback = JSON.stringify({
    type: 'assistant',
    sessionId: 'session-fallback-placeholder',
    uuid: 'record-uuid-fallback-placeholder',
    timestamp: '2026-08-08T10:00:00.000Z',
    message: {
      model: 'claude-placeholder-current',
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  });
  fs.writeFileSync(
    path.join(projects, 'session-fallback-placeholder.jsonl'),
    `${refusal}\n${uuidFallback}\n${uuidFallback}\n`,
  );
  const store = new Store(':memory:');
  t.after(() => store.close());

  const summary = await ingestTranscriptArchive({ store, directory: root });
  assert.equal(summary.requests, 2);
  assert.deepEqual(
    store.db.prepare('SELECT dedupe_key FROM transcript_requests ORDER BY dedupe_key').all()
      .map((row) => row.dedupe_key),
    [
      'record:session-fallback-placeholder:record-uuid-fallback-placeholder',
      'request:request-refusal-placeholder',
    ],
  );
});

test('the same session and child IDs remain attributed to each source profile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = 'session-shared-placeholder';
  const records = [
    {
      type: 'assistant',
      sessionId,
      requestId: 'request-shared-placeholder',
      uuid: 'record-shared-placeholder',
      timestamp: '2026-08-08T10:00:00.000Z',
      message: {
        id: 'message-shared-placeholder',
        model: 'claude-placeholder',
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{
          type: 'tool_use',
          id: 'skill-use-shared-placeholder',
          name: 'Skill',
          input: { skill: 'shared-placeholder-skill' },
        }],
      },
    },
    {
      type: 'user',
      sessionId,
      uuid: 'rollup-shared-placeholder',
      timestamp: '2026-08-08T10:00:01.000Z',
      message: { content: [] },
      toolUseResult: {
        agentId: 'agent-shared-placeholder',
        totalTokens: 3,
      },
    },
  ];
  for (const profile of ['profile-placeholder-a', 'profile-placeholder-b']) {
    const projects = path.join(root, profile, 'projects', '-workspace-placeholder');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, `${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  }
  const store = new Store(':memory:');
  t.after(() => store.close());

  const summary = await ingestTranscriptArchive({ store, directory: root });
  assert.deepEqual(
    {
      sessions: summary.sessions,
      requests: summary.requests,
      subagents: summary.subagents,
      skills: summary.skills,
    },
    { sessions: 2, requests: 2, subagents: 2, skills: 2 },
  );
  for (const table of [
    'transcript_sessions',
    'transcript_requests',
    'transcript_subagents',
    'transcript_skill_events',
  ]) {
    assert.deepEqual(
      store.db.prepare(`SELECT profile_slug FROM ${table} ORDER BY profile_slug`).all()
        .map((row) => row.profile_slug),
      ['profile-placeholder-a', 'profile-placeholder-b'],
      `${table} keeps one correctly attributed row per profile`,
    );
  }
});

test('TRIPWIRE #480: Claude shrink deletion stays scoped to the source profile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-profile-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessionId = 'session-shared-reconcile-placeholder';
  const request = (profile, suffix, second) => JSON.stringify({
    type: 'assistant',
    sessionId,
    requestId: `request-${profile}-${suffix}`,
    uuid: `record-${profile}-${suffix}`,
    timestamp: `2026-08-08T10:00:0${second}.000Z`,
    message: {
      id: `message-${profile}-${suffix}`,
      model: 'claude-placeholder',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const files = new Map();
  for (const profile of ['profile-placeholder-a', 'profile-placeholder-b']) {
    const projects = path.join(root, profile, 'projects', '-workspace-placeholder');
    fs.mkdirSync(projects, { recursive: true });
    const first = request(profile, 'one', 1);
    const second = request(profile, 'two', 2);
    const file = path.join(projects, `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${first}\n${second}\n`);
    files.set(profile, { file, first });
  }

  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });
  const profileA = files.get('profile-placeholder-a');
  fs.writeFileSync(profileA.file, `${profileA.first}\n`);
  bumpMtime(profileA.file);
  await ingestTranscriptArchive({ store, directory: root, machine: 'placeholder-machine' });

  assert.deepEqual(
    store.db.prepare(`
      SELECT request_id FROM transcript_requests
      WHERE session_id = ? AND profile_slug = 'profile-placeholder-a'
      ORDER BY request_id
    `).all(sessionId).map((row) => row.request_id),
    ['request-profile-placeholder-a-one'],
  );
  assert.deepEqual(
    store.db.prepare(`
      SELECT request_id FROM transcript_requests
      WHERE session_id = ? AND profile_slug = 'profile-placeholder-b'
      ORDER BY request_id
    `).all(sessionId).map((row) => row.request_id),
    ['request-profile-placeholder-b-one', 'request-profile-placeholder-b-two'],
    'profile A reconciliation cannot delete profile B rows with the same session id',
  );
});

test('fallback skill event keys distinguish parent and subagent files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-event-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = 'session-event-key-placeholder';
  const projects = path.join(root, 'profile-placeholder', 'projects', '-workspace-placeholder');
  const subagents = path.join(projects, sessionId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const event = JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: '2026-08-08T10:00:00.000Z',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Skill',
        input: { skill: 'file-scoped-placeholder-skill' },
      }],
    },
  });
  fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), `${event}\n`);
  fs.writeFileSync(path.join(subagents, 'agent-event-key-placeholder.jsonl'), `${event}\n`);
  const store = new Store(':memory:');
  t.after(() => store.close());

  const summary = await ingestTranscriptArchive({ store, directory: root });
  assert.equal(summary.skills, 2);
  const keys = store.db.prepare(`
    SELECT event_key FROM transcript_skill_events ORDER BY event_key
  `).all().map((row) => row.event_key);
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every((key) => key.includes('profile-placeholder/projects/')));
});

test('a SQLite flush failure destroys the active transcript read stream', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-transcript-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'profile-placeholder', 'projects', '-workspace-placeholder');
  fs.mkdirSync(projects, { recursive: true });
  const record = JSON.stringify({
    type: 'user',
    sessionId: 'session-stream-placeholder',
    timestamp: '2026-08-08T10:00:00.000Z',
    message: { content: [] },
  });
  fs.writeFileSync(
    path.join(projects, 'session-stream-placeholder.jsonl'),
    `${record}\n${' '.repeat(2 * 1024 * 1024)}\n`,
  );
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.exec(`
    CREATE TRIGGER transcript_session_failure_placeholder
    BEFORE INSERT ON transcript_sessions
    BEGIN
      SELECT RAISE(ABORT, 'placeholder SQLite flush failure');
    END;
  `);
  const originalCreateReadStream = fs.createReadStream;
  let activeInput;
  fs.createReadStream = (...args) => {
    activeInput = originalCreateReadStream(...args);
    return activeInput;
  };
  t.after(() => { fs.createReadStream = originalCreateReadStream; });

  await assert.rejects(
    ingestTranscriptArchive({ store, directory: root, batchLines: 1 }),
    /placeholder SQLite flush failure/,
  );
  assert.equal(activeInput.destroyed, true);
});

test('transcript ingest CLI exposes explicit source, database, and machine overrides', () => {
  assert.deepEqual(parseArgs([
    '--profiles-dir', '/profiles/placeholder',
    '--db', '/database/placeholder.sqlite',
    '--machine', 'placeholder-machine',
  ]), {
    directory: '/profiles/placeholder',
    dbPath: '/database/placeholder.sqlite',
    machine: 'placeholder-machine',
  });
  assert.match(usageText(), /ingest-transcripts\.mjs/);
  assert.throws(() => parseArgs(['--profiles-dir']), /requires a value/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
});
