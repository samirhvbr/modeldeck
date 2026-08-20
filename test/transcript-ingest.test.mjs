import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  await t.test('shrunk file re-ingests from scratch without rewriting unchanged rows', async () => {
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
    fs.writeFileSync(oldFile, `${lines.slice(0, -1).join('\n')}\n`);
    bumpMtime(oldFile);

    const summary = await ingestTranscriptArchive({
      store,
      directory: root,
      machine: 'placeholder-machine',
    });
    assert.equal(summary.filesSkipped, 2);
    assert.equal(summary.sessions, 0);
    assert.equal(summary.requests, 0);
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
