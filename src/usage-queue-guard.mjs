import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RETIRED_USAGE_CONSUMER_LABELS = Object.freeze([
  'com.cliproxyapi.poller',
  'ai.hermes.modeldeck.ingest',
]);

export function classifyLaunchctlPrint({ code } = {}) {
  const exitCode = Number(code);
  if (exitCode === 0) return 'loaded';
  if (exitCode === 113 || exitCode === 3) return 'not-found';
  return 'unknown';
}

async function launchctlPrint(label, { exec = execFileAsync, uid = process.getuid?.() } = {}) {
  if (!Number.isInteger(uid)) return 'unknown';
  try {
    await exec('/bin/launchctl', ['print', `gui/${uid}/${label}`], {
      timeout: 5_000,
      maxBuffer: 65_536,
    });
    return 'loaded';
  } catch (error) {
    return classifyLaunchctlPrint(error);
  }
}

/// Read-only startup check for the two retired destructive-read jobs. The
/// daemon never unloads launchd services; a loaded job blocks queue pulls and
/// is reported by label, while an unavailable probe fails closed as unknown.
export async function detectForeignUsageConsumers(options = {}) {
  const labels = options.labels || RETIRED_USAGE_CONSUMER_LABELS;
  const states = await Promise.all(labels.map(async (label) => ({
    label,
    state: await launchctlPrint(label, options),
  })));
  return {
    checked: true,
    consumers: states.filter(({ state }) => state === 'loaded').map(({ label }) => label),
    probe: states.some(({ state }) => state === 'unknown') ? 'unknown' : 'ok',
  };
}
