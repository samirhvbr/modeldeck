#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyUsageQueueGuard({
  base = process.env.MODELDECK_BASE_URL || 'http://127.0.0.1:3867',
  fetcher = globalThis.fetch,
  stdout = process.stdout,
} = {}) {
  const response = await fetcher(new URL('/api/state', base), { redirect: 'error' });
  if (!response.ok) throw new Error(`state read failed (HTTP ${response.status})`);
  const state = await response.json();
  const queue = state.usageQueue;
  if (queue?.configured !== true || queue?.running !== true || queue?.guard?.status !== 'clear') {
    throw new Error(queue?.guard?.message || 'usage queue consumer is not running with a clear guard');
  }
  if (typeof queue?.lastPull?.at !== 'string') {
    throw new Error('usage queue consumer has not completed its first pull');
  }
  if (Number(queue.lastPull.warnings) !== 0) {
    throw new Error(`latest usage-queue pull reported warnings=${Number(queue.lastPull.warnings)}`);
  }
  stdout.write('Usage queue guard clear; latest daemon pull completed without warnings\n');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyUsageQueueGuard().catch((error) => {
    process.stderr.write(`verify-usage-queue-guard.mjs: ${error.message}\n`);
    process.exitCode = 1;
  });
}
