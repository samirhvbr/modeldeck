#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/db.mjs';
import { DB_PATH } from '../src/paths.mjs';
import { refitUsageEstimates } from '../src/usage-estimate.mjs';

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = { dbPath: DB_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.dbPath = nextValue(argv, index++, arg);
    else if (arg === '--help') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function usageText() {
  return [
    'Usage: node scripts/refit-usage-estimates.mjs [--db <sqlite-path>]',
    '',
    `Default database: ${DB_PATH}`,
  ].join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`usage-estimate-refit: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }

  let store;
  try {
    store = new Store(options.dbPath);
    const summary = refitUsageEstimates(store);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`usage-estimate-refit: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}

const entryHref = (() => {
  if (!process.argv[1]) return null;
  try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; }
  catch { return null; }
})();
if (entryHref === import.meta.url) await main();
