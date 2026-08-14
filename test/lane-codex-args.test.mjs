import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../scripts/lane-codex.sh', import.meta.url));

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-lane-codex-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const repo = path.join(temporary, 'repo');
  const worktree = path.join(repo, '.claude', 'worktrees', 'lane');
  const script = path.join(worktree, 'scripts', 'lane-codex.sh');
  const prompt = path.join(repo, '.claude', 'lane-prompts', 'issue-392.md');
  const bin = path.join(temporary, 'bin');
  const shell = path.join(bin, 'bash');
  const codexCall = path.join(temporary, 'codex-call.json');
  const ghCall = path.join(temporary, 'gh-called');
  const cdCall = path.join(temporary, 'cd-called');
  const modelRead = path.join(temporary, 'model-read');

  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(path.dirname(prompt), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(sourceScript, script);
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(prompt, 'Lane prompt from the repository root.\n');

  fs.symlinkSync('/bin/bash', shell);
  writeExecutable(path.join(bin, 'realpath'), `#!/bin/sh
if [ "$1" = "$TEST_MISSING_WORKTREE" ]; then
  printf "called\\n" >> "$TEST_CD_CALL"
fi
/bin/realpath "$@"
`);
  writeExecutable(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$TEST_GIT_COMMON_DIR"\n');
  writeExecutable(path.join(bin, 'gh'), '#!/bin/sh\nprintf "called\\n" >> "$TEST_GH_CALL"\nexit 1\n');
  writeExecutable(path.join(bin, 'sed'), `#!/bin/sh
printf "called\\n" >> "$TEST_MODEL_READ"
case "$1" in
  *model_reasoning_effort*) printf "medium\\n" ;;
  *model*) printf "test-model\\n" ;;
esac
`);
  writeExecutable(path.join(bin, 'codex-stub'), `#!/bin/sh
node -e 'const fs = require("fs"); fs.writeFileSync(process.env.TEST_CODEX_CALL, JSON.stringify({ args: process.argv.slice(1), stdin: fs.readFileSync(0, "utf8") }));' "$@"
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CODEX_BIN: path.join(bin, 'codex-stub'),
    MDLANE_NO_GIT: '1',
    TEST_CODEX_CALL: codexCall,
    TEST_CD_CALL: cdCall,
    TEST_GH_CALL: ghCall,
    TEST_GIT_COMMON_DIR: path.relative(worktree, path.join(repo, '.git')),
    TEST_MISSING_WORKTREE: path.join(repo, 'missing-worktree'),
    TEST_MODEL_READ: modelRead,
  };

  return { repo, worktree, script, shell, prompt, env, codexCall, cdCall, ghCall, modelRead };
}

function manifest(repo) {
  const file = path.join(repo, '.claude', 'lane-logs', 'manifest.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('lane-codex resolves a repo-root-relative prompt before launching from a worktree', (t) => {
  const data = fixture(t);
  const result = spawnSync(data.shell, [
    data.script,
    '392',
    data.worktree,
    '.claude/lane-prompts/issue-392.md',
    '--effort',
    'high',
  ], { cwd: data.repo, env: data.env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(fs.readFileSync(data.codexCall, 'utf8'));
  assert.deepEqual(call.args, [
    'exec', '--cd', data.worktree, '--sandbox', 'workspace-write',
    '-c', 'model_reasoning_effort="high"', '-',
  ]);
  assert.equal(call.stdin, 'Lane prompt from the repository root.\n');

  const records = manifest(data.repo);
  assert.deepEqual(records.map(({ phase }) => phase), ['launched', 'exited']);
  assert.ok(records.every(({ log }) => path.isAbsolute(log) && log.startsWith(`${data.repo}${path.sep}`)));
  assert.equal(fs.existsSync(path.join(data.worktree, '.claude', 'lane-logs')), false);
});

test('lane-codex rejects a missing prompt before cd and records launch_failed centrally', (t) => {
  const data = fixture(t);
  const relativePrompt = '.claude/lane-prompts/missing.md';
  const result = spawnSync(data.shell, [
    data.script,
    '392',
    path.join(data.repo, 'missing-worktree'),
    relativePrompt,
  ], { cwd: data.repo, env: data.env, encoding: 'utf8' });

  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), `ERROR: prompt file does not exist or is unreadable: ${relativePrompt}`);
  assert.equal(fs.existsSync(data.codexCall), false, 'codex must not run after prompt validation fails');
  assert.equal(fs.existsSync(data.cdCall), false, 'worktree cd must not run after prompt validation fails');
  assert.equal(fs.existsSync(data.ghCall), false, 'GitHub lookup must not run after prompt validation fails');
  assert.equal(fs.existsSync(data.modelRead), false, 'model config must not be read after prompt validation fails');

  const records = manifest(data.repo);
  assert.equal(records.length, 1);
  assert.equal(records[0].phase, 'launch_failed');
  assert.equal(records[0].model, 'unknown');
  assert.equal(records[0].effort, 'unknown');
  assert.equal(records[0].reason, 'prompt file missing or unreadable');
  assert.ok(path.isAbsolute(records[0].log) && records[0].log.startsWith(`${data.repo}${path.sep}`));
  assert.equal(fs.existsSync(path.join(data.worktree, '.claude', 'lane-logs')), false);
});

test('lane-codex keeps absolute prompts and resume argument order unchanged', (t) => {
  const data = fixture(t);
  const result = spawnSync(data.shell, [
    data.script,
    '392',
    data.worktree,
    data.prompt,
    '--resume',
    '--effort',
    'ultra',
  ], { cwd: data.worktree, env: data.env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(fs.readFileSync(data.codexCall, 'utf8'));
  assert.deepEqual(call.args, [
    'exec', '--cd', data.worktree,
    '-c', 'model_reasoning_effort="ultra"',
    'resume', '--last', '-',
  ]);
  assert.equal(call.stdin, 'Continue the lane task where you left off. Re-read the original instructions in the session if needed.\n');
});
