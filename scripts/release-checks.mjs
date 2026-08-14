#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// TRIPWIRE version-sources-agree (0.4.6 go-live field find): the app bundle
// stamps VERSION while the daemon inlines package.json's version — bumping
// only one shipped a 0.4.6 app whose daemon reported 0.4.5 and failed the
// runbook's health check. A release cannot proceed with the two out of step.
const fileVersion = (await import('node:fs')).readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
const packageVersion = JSON.parse(
  (await import('node:fs')).readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
).version;
if (fileVersion !== packageVersion) {
  process.stderr.write(`release-checks: VERSION file (${fileVersion}) and package.json (${packageVersion}) disagree — bump both\n`);
  process.exit(1);
}
process.stdout.write(`==> version sources agree: ${fileVersion}\n`);

const checks = [
  ['prototype chart round-trip click-test', 'test/dashboard-overview-clicktest.test.mjs'],
  ['#374 fit-floor boundary test', 'test/usage-estimate.test.mjs'],
];

for (const [name, file] of checks) {
  process.stdout.write(`==> ${name}\n`);
  const result = spawnSync(process.execPath, ['--test', file], { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write('==> release analytics checks passed\n');
