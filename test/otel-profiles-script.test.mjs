import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableUsageOtel } from '../scripts/enable-usage-otel.mjs';

const script = fileURLToPath(new URL('../scripts/enable-otel-profiles.sh', import.meta.url));
const managedKeys = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
];

function ensureSevenProfiles(home) {
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  fs.mkdirSync(profiles, { recursive: true });
  const directories = fs.readdirSync(profiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).length;
  for (let index = directories; index < 7; index += 1) {
    fs.mkdirSync(path.join(profiles, `placeholder-extra-${index + 1}`));
  }
}

function run(home, args = []) {
  ensureSevenProfiles(home);
  return execFileSync('/bin/sh', [script, ...args], {
    env: { HOME: home, PATH: process.env.PATH },
  }).toString();
}

function runResult(home, args = []) {
  ensureSevenProfiles(home);
  return spawnSync('/bin/sh', [script, ...args], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

test('OTEL profile rollout snapshots values, preserves modes, and restores the pre-enable state', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-profiles-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  const first = path.join(profiles, 'placeholder one');
  const second = path.join(profiles, 'placeholder-two');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const firstSettings = path.join(first, 'settings.json');
  fs.writeFileSync(firstSettings, JSON.stringify({
    theme: 'dark',
    env: { USER_OWN_SETTING: 'preserved', OTEL_METRICS_EXPORTER: 'none' },
  }, null, 2), { mode: 0o640 });
  fs.writeFileSync(path.join(profiles, 'not-a-profile'), 'ignored');

  const enabledOutput = run(home);
  assert.match(enabledOutput, /WARNING: overwriting existing OTEL_METRICS_EXPORTER; --revert will restore the value saved in settings.json.otel-backup/);
  assert.doesNotMatch(enabledOutput, /placeholder one|placeholder-two|OTEL_METRICS_EXPORTER=none/);
  assert.match(enabledOutput, /profile 1: .*~OTEL_METRICS_EXPORTER/);
  assert.match(enabledOutput, /profile 2: .*\+CLAUDE_CODE_ENABLE_TELEMETRY/);
  const firstEnabled = fs.readFileSync(firstSettings);
  const firstJson = JSON.parse(firstEnabled);
  assert.equal(firstJson.theme, 'dark');
  assert.equal(firstJson.env.USER_OWN_SETTING, 'preserved');
  assert.deepEqual(Object.fromEntries(managedKeys.map((key) => [key, firstJson.env[key]])), {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:3867/otlp',
  });
  assert.equal(fs.statSync(firstSettings).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(second, 'settings.json')).mode & 0o777, 0o600);

  const firstBackup = path.join(first, 'settings.json.otel-backup');
  const secondBackup = path.join(second, 'settings.json.otel-backup');
  const firstBackupJson = JSON.parse(fs.readFileSync(firstBackup, 'utf8'));
  assert.equal(fs.statSync(firstBackup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(secondBackup).mode & 0o777, 0o600);
  assert.equal(firstBackupJson.settingsExisted, true);
  assert.equal(firstBackupJson.envState, 'object');
  assert.deepEqual(Object.keys(firstBackupJson.values).sort(), managedKeys.toSorted());
  assert.deepEqual(firstBackupJson.values.OTEL_METRICS_EXPORTER, {
    present: true,
    value: 'none',
  });
  assert.deepEqual(firstBackupJson.values.OTEL_LOGS_EXPORTER, { present: false });
  assert.equal(JSON.parse(fs.readFileSync(secondBackup, 'utf8')).settingsExisted, false);

  const secondOutput = run(home);
  assert.match(secondOutput, /profile 1: unchanged/);
  assert.doesNotMatch(secondOutput, /placeholder one|placeholder-two/);
  assert.deepEqual(fs.readFileSync(firstSettings), firstEnabled, 'idempotent run leaves bytes untouched');

  const revertOutput = run(home, ['--revert']);
  assert.match(revertOutput, /profile 1: .*\-CLAUDE_CODE_ENABLE_TELEMETRY/);
  const reverted = JSON.parse(fs.readFileSync(firstSettings, 'utf8'));
  assert.equal(reverted.theme, 'dark');
  assert.deepEqual(reverted.env, {
    USER_OWN_SETTING: 'preserved',
    OTEL_METRICS_EXPORTER: 'none',
  });
  assert.equal(fs.statSync(firstSettings).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(path.join(second, 'settings.json')), false);
  assert.equal(fs.existsSync(firstBackup), false);
  assert.equal(fs.existsSync(secondBackup), false);
});

test('OTEL rollout requires all seven profiles before writing any settings', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-seven-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  const profile = path.join(profiles, 'placeholder-only');
  fs.mkdirSync(profile, { recursive: true });
  const settings = path.join(profile, 'settings.json');
  fs.writeFileSync(settings, '{"theme":"placeholder"}\n');
  const before = fs.readFileSync(settings);

  const result = spawnSync('/bin/sh', [script], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected 7 profile directories, found 1; no profiles were changed/);
  assert.deepEqual(fs.readFileSync(settings), before);
  assert.equal(fs.existsSync(`${settings}.otel-backup`), false);
});

test('OTEL profile revert restores absent and null env states', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-env-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  const absentProfile = path.join(profiles, 'placeholder-absent-env');
  const nullProfile = path.join(profiles, 'placeholder-null-env');
  fs.mkdirSync(absentProfile, { recursive: true });
  fs.mkdirSync(nullProfile, { recursive: true });
  const absentSettings = path.join(absentProfile, 'settings.json');
  const nullSettings = path.join(nullProfile, 'settings.json');
  fs.writeFileSync(absentSettings, '{"theme":"placeholder-absent"}\n');
  fs.writeFileSync(nullSettings, '{"theme":"placeholder-null","env":null}\n');

  run(home);

  assert.equal(JSON.parse(fs.readFileSync(`${absentSettings}.otel-backup`, 'utf8')).envState, 'absent');
  assert.equal(JSON.parse(fs.readFileSync(`${nullSettings}.otel-backup`, 'utf8')).envState, 'null');

  run(home, ['--revert']);

  const absentReverted = JSON.parse(fs.readFileSync(absentSettings, 'utf8'));
  const nullReverted = JSON.parse(fs.readFileSync(nullSettings, 'utf8'));
  assert.equal(Object.hasOwn(absentReverted, 'env'), false);
  assert.equal(Object.hasOwn(nullReverted, 'env'), true);
  assert.equal(nullReverted.env, null);
});

test('snapshot-only rollback preserves profiles a failed rollout never changed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-rollback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  for (const name of ['placeholder-one', 'placeholder-two']) {
    const profile = path.join(profiles, name);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      env: { OTEL_METRICS_EXPORTER: 'preexisting-placeholder' },
    }));
  }
  const before = fs.readFileSync(path.join(profiles, 'placeholder-one', 'settings.json'));

  const output = run(home, ['--rollback']);

  assert.match(output, /profile 1: unchanged \(no rollout snapshot\)/);
  assert.deepEqual(fs.readFileSync(path.join(profiles, 'placeholder-one', 'settings.json')), before);
});

test('OTEL preflight validates all profiles without consuming existing backups', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  for (const name of ['placeholder-one', 'placeholder-two']) {
    const profile = path.join(profiles, name);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'settings.json'), '{"env":{}}\n');
  }
  const backup = path.join(profiles, 'placeholder-one', 'settings.json.otel-backup');
  fs.writeFileSync(backup, '{"placeholder":"existing-backup"}\n');
  const before = fs.readFileSync(backup);

  const output = run(home, ['--preflight']);

  assert.match(output, /preflight OK \(7 profiles; no changes\)/);
  assert.deepEqual(fs.readFileSync(backup), before);
});

test('OTEL check proves all seven profiles carry the exact exporter settings', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-verify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  const first = path.join(profiles, 'placeholder-one');
  const second = path.join(profiles, 'placeholder-two');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  const before = runResult(home, ['--check']);
  assert.equal(before.status, 1);
  assert.match(before.stderr, /OTEL exporter settings are not enabled/);

  run(home);
  const output = run(home, ['--check']);
  assert.match(output, /OTEL verified \(7 profiles; no changes\)/);
});

test('malformed settings in any profile abort preflight without writing any profile', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-preflight-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  const valid = path.join(profiles, 'placeholder valid');
  const malformed = path.join(profiles, 'placeholder malformed');
  fs.mkdirSync(valid, { recursive: true });
  fs.mkdirSync(malformed, { recursive: true });
  const validSettings = path.join(valid, 'settings.json');
  const malformedSettings = path.join(malformed, 'settings.json');
  fs.writeFileSync(validSettings, '{"theme":"light"}\n', { mode: 0o640 });
  fs.writeFileSync(malformedSettings, '{"env":', { mode: 0o600 });
  const validBefore = fs.readFileSync(validSettings);
  const malformedBefore = fs.readFileSync(malformedSettings);

  const result = runResult(home);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /profile 1: ERROR \(settings\.json is not valid JSON\)/);
  assert.doesNotMatch(result.stderr, /placeholder malformed|placeholder valid/);
  assert.match(result.stderr, /preflight failed; no profiles were changed/);
  assert.deepEqual(fs.readFileSync(validSettings), validBefore);
  assert.deepEqual(fs.readFileSync(malformedSettings), malformedBefore);
  assert.equal(fs.existsSync(path.join(valid, 'settings.json.otel-backup')), false);
  assert.equal(fs.existsSync(path.join(malformed, 'settings.json.otel-backup')), false);
});

test('one-motion OTEL enable arms the receiver before all seven profiles', async () => {
  const fetches = [];
  const execs = [];
  const output = [];
  await enableUsageOtel({
    token: 'mutation-token-placeholder',
    fetcher: async (url, options) => {
      fetches.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          otelReceiverEnabled: options?.body
            ? JSON.parse(options.body).otelReceiverEnabled
            : false,
        }),
      };
    },
    exec: (...args) => execs.push(args),
    profileScript: '/placeholder/enable-otel-profiles.sh',
    env: { PLACEHOLDER: '1' },
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(fetches.length, 2);
  assert.equal(fetches[0].url, 'http://127.0.0.1:3867/api/settings');
  assert.equal(fetches[0].options.method, undefined);
  assert.deepEqual(JSON.parse(fetches[1].options.body), { otelReceiverEnabled: true });
  assert.equal(fetches[1].options.headers['X-ModelDeck-Token'], 'mutation-token-placeholder');
  assert.deepEqual(execs.map((call) => call.slice(0, 2)), [
    ['/bin/sh', ['/placeholder/enable-otel-profiles.sh', '--preflight']],
    ['/bin/sh', ['/placeholder/enable-otel-profiles.sh']],
  ]);
  assert.deepEqual(output, ['OTEL enabled: daemon receiver + all seven Claude profiles\n']);
});

test('one-motion OTEL enable rolls both halves back when profile rollout fails', async () => {
  const bodies = [];
  const execs = [];
  let enablePass = false;
  await assert.rejects(() => enableUsageOtel({
    token: 'mutation-token-placeholder',
    fetcher: async (_url, options) => {
      if (options?.body) bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          otelReceiverEnabled: options?.body
            ? JSON.parse(options.body).otelReceiverEnabled
            : false,
        }),
      };
    },
    exec: (_binary, args) => {
      execs.push(args);
      if (args.length === 1) {
        enablePass = true;
        const error = new Error('simulated profile rollout failure');
        error.status = 1;
        throw error;
      }
    },
    profileScript: '/placeholder/enable-otel-profiles.sh',
    stdout: { write() {} },
    stderr: { write() {} },
  }), /seven-profile OTEL rollout failed/);

  assert.deepEqual(bodies, [
    { otelReceiverEnabled: true },
    { otelReceiverEnabled: false },
  ]);
  assert.deepEqual(execs, [
    ['/placeholder/enable-otel-profiles.sh', '--preflight'],
    ['/placeholder/enable-otel-profiles.sh'],
    ['/placeholder/enable-otel-profiles.sh', '--rollback'],
  ]);
  assert.equal(enablePass, true);
});

test('one-motion OTEL enable rolls back an applied receiver update it cannot confirm', async () => {
  const bodies = [];
  const execs = [];
  await assert.rejects(() => enableUsageOtel({
    token: 'mutation-token-placeholder',
    fetcher: async (_url, options) => {
      if (!options?.body) {
        return { ok: true, status: 200, json: async () => ({ otelReceiverEnabled: false }) };
      }
      const body = JSON.parse(options.body);
      bodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => body.otelReceiverEnabled ? ({}) : ({ otelReceiverEnabled: false }),
      };
    },
    exec: (_binary, args) => execs.push(args),
    profileScript: '/placeholder/enable-otel-profiles.sh',
    stdout: { write() {} },
    stderr: { write() {} },
  }), /OTEL receiver enable failed/);

  assert.deepEqual(bodies, [
    { otelReceiverEnabled: true },
    { otelReceiverEnabled: false },
  ]);
  assert.deepEqual(execs, [
    ['/placeholder/enable-otel-profiles.sh', '--preflight'],
  ]);
});

test('one-motion OTEL enable refuses to mutate without an explicit boolean snapshot', async () => {
  let fetches = 0;
  const execs = [];
  await assert.rejects(() => enableUsageOtel({
    token: 'mutation-token-placeholder',
    fetcher: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
    exec: (_binary, args) => execs.push(args),
    profileScript: '/placeholder/enable-otel-profiles.sh',
  }), /could not snapshot OTEL receiver setting: settings read did not return otelReceiverEnabled/);
  assert.equal(fetches, 1);
  assert.deepEqual(execs, [
    ['/placeholder/enable-otel-profiles.sh', '--preflight'],
  ]);
});

/*
 * TRIPWIRE otel-revert-not-count-gated (#388 adversarial-review blocker):
 * the exact-seven guard protects ENABLE only. Adding an eighth profile after
 * enablement must never strand OTEL on — revert operates on whatever exists.
 */
test('TRIPWIRE otel-revert-not-count-gated — revert succeeds with an eighth profile present', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-eighth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  run(home); // enable across the seven placeholder profiles

  const profiles = path.join(home, 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
  // Prove the enable half really ran — a no-op enable would let a no-op revert
  // pass the absence assertions below without exercising the guard at all.
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(profiles, 'placeholder-extra-1', 'settings.json'), 'utf8'))
      .env.OTEL_METRICS_EXPORTER,
    'otlp',
    'enable must write managed keys before the revert half runs',
  );
  fs.mkdirSync(path.join(profiles, 'placeholder-eighth'));

  const result = spawnSync('/bin/sh', [script, '--revert'], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `revert must not be count-gated: ${result.stderr}`);
  const first = path.join(profiles, 'placeholder-extra-1', 'settings.json');
  assert.equal(fs.existsSync(`${first}.otel-backup`), false, 'backup sidecars consumed');
  // The enable wrote managed keys into every profile it created; revert must
  // have removed them again (settings absent pre-enable are deleted outright).
  for (const entry of fs.readdirSync(profiles)) {
    const settings = path.join(profiles, entry, 'settings.json');
    if (!fs.existsSync(settings)) continue;
    const json = JSON.parse(fs.readFileSync(settings, 'utf8'));
    for (const key of managedKeys) {
      assert.equal(json.env?.[key], undefined, `${entry} still carries ${key}`);
    }
  }
});
