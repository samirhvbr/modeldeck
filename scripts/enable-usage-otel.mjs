#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProfileScript = fileURLToPath(new URL('./enable-otel-profiles.sh', import.meta.url));

function receiverRequest(base, token, enabled) {
  return {
    url: new URL('/api/settings', base),
    options: {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-ModelDeck-Token': token,
        Cookie: `modeldeck_session=${encodeURIComponent(token)}`,
      },
      body: JSON.stringify({ otelReceiverEnabled: enabled }),
      redirect: 'error',
    },
  };
}

export async function enableUsageOtel({
  base = process.env.MODELDECK_BASE_URL || 'http://127.0.0.1:3867',
  token = process.env.MODELDECK_MUTATION_TOKEN,
  fetcher = globalThis.fetch,
  exec = execFileSync,
  env = process.env,
  profileScript = defaultProfileScript,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!token) throw new Error('MODELDECK_MUTATION_TOKEN is required');
  // Preflight all seven profile documents before changing the daemon setting.
  try {
    exec('/bin/sh', [profileScript, '--preflight'], { stdio: 'inherit', env });
  } catch {
    throw new Error('seven-profile OTEL preflight failed');
  }
  let previousReceiverEnabled;
  try {
    const previousResponse = await fetcher(new URL('/api/settings', base), { redirect: 'error' });
    if (!previousResponse.ok) throw new Error(`settings read failed (HTTP ${previousResponse.status})`);
    const previousSettings = await previousResponse.json();
    if (typeof previousSettings?.otelReceiverEnabled !== 'boolean') {
      throw new Error('settings read did not return otelReceiverEnabled');
    }
    previousReceiverEnabled = previousSettings.otelReceiverEnabled;
  } catch (error) {
    throw new Error(`could not snapshot OTEL receiver setting: ${error.message}`);
  }

  let profileRolloutAttempted = false;
  try {
    const enable = receiverRequest(base, token, true);
    const response = await fetcher(enable.url, enable.options);
    if (!response.ok) throw new Error(`daemon settings update failed (HTTP ${response.status})`);
    const settings = await response.json();
    if (settings.otelReceiverEnabled !== true) {
      throw new Error('daemon did not confirm otelReceiverEnabled=true');
    }
    profileRolloutAttempted = true;
    exec('/bin/sh', [profileScript], { stdio: 'inherit', env });
    stdout.write('OTEL enabled: daemon receiver + all seven Claude profiles\n');
  } catch (error) {
    // Restore both halves when the seven-profile rollout fails. The profile
    // script snapshots every managed key before changing it.
    let profileRollbackFailed = false;
    if (profileRolloutAttempted) {
      try { exec('/bin/sh', [profileScript, '--rollback'], { stdio: 'inherit', env }); }
      catch {
        profileRollbackFailed = true;
        stderr.write('enable-usage-otel.mjs: profile rollback failed\n');
      }
    }
    let rollbackFailed = false;
    if (!previousReceiverEnabled) {
      try {
        const rollback = receiverRequest(base, token, false);
        const rollbackResponse = await fetcher(rollback.url, rollback.options);
        if (!rollbackResponse.ok) {
          rollbackFailed = true;
          stderr.write(`enable-usage-otel.mjs: receiver rollback failed (HTTP ${rollbackResponse.status})\n`);
        } else {
          const rollbackSettings = await rollbackResponse.json();
          if (rollbackSettings.otelReceiverEnabled !== false) {
            rollbackFailed = true;
            stderr.write('enable-usage-otel.mjs: receiver rollback was not confirmed\n');
          }
        }
      } catch {
        rollbackFailed = true;
        stderr.write('enable-usage-otel.mjs: receiver rollback failed\n');
      }
    }
    const suffix = `${profileRollbackFailed ? '; one or more profile settings may still be changed' : ''}`
      + `${rollbackFailed ? '; receiver may still be enabled' : ''}`;
    const phase = profileRolloutAttempted
      ? 'seven-profile OTEL rollout failed'
      : 'OTEL receiver enable failed';
    const failure = new Error(`${phase}${suffix}`);
    failure.status = 1;
    throw failure;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  enableUsageOtel().catch((error) => {
    process.stderr.write(`enable-usage-otel.mjs: ${error.message}\n`);
    process.exitCode = Number.isInteger(error.status) ? error.status : 1;
  });
}
