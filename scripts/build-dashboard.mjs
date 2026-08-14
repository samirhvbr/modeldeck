#!/usr/bin/env node
// build-dashboard.mjs — compile dashboard/ into the module the daemon serves.
//
// Usage: npm run dashboard:build [-- --check]
//
// The Overview landing is React + Vite (charter amendment decision 7), but the
// daemon must keep its two shipping properties: ONE self-contained page, and no
// asset read from disk at runtime (the SEA bundle has no filesystem to read).
// So the vite build's single HTML file is inlined into src/dashboard-app.mjs,
// which is committed and imported like any other source file. Running this
// script is the only way that file changes.
//
// --check rebuilds into a temporary directory and fails if the committed module
// does not match, which is how CI/tests can tell a stale artifact from a fresh
// one without running vite themselves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assertSelfContained, fingerprintSources } from './dashboard-artifact.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = path.join(REPO_ROOT, 'dashboard', 'vite.config.js');
const OUTPUT = path.join(REPO_ROOT, 'src', 'dashboard-app.mjs');
const CHECK = process.argv.includes('--check');

async function compile() {
  const outDir = path.join(REPO_ROOT, 'dist', 'dashboard');
  await build({ configFile: CONFIG, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  const page = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assertSelfContained(page);
  return page;
}

function moduleSource(page) {
  return [
    '// GENERATED FILE — do not edit. Run `npm run dashboard:build` to regenerate.',
    '//',
    '// The Overview landing (issue #385): dashboard/ compiled by Vite into ONE',
    '// self-contained HTML page and inlined here, so the daemon can serve it with',
    '// no asset on disk and the esbuild SEA bundle carries it unchanged.',
    '//',
    '// DASHBOARD_APP_SOURCES fingerprints the files this page was compiled from;',
    '// test/dashboard-overview.test.mjs recomputes them, so an edit that never got',
    '// rebuilt fails the suite instead of quietly serving yesterday.',
    'export const DASHBOARD_APP_SOURCES = ' + JSON.stringify(fingerprintSources(), null, 2) + ';',
    '',
    'export const DASHBOARD_APP_HTML = ' + JSON.stringify(page) + ';',
    '',
  ].join('\n');
}

const source = moduleSource(await compile());
if (CHECK) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (current !== source) {
    process.stderr.write('src/dashboard-app.mjs is stale — run `npm run dashboard:build`\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('src/dashboard-app.mjs is up to date\n');
  }
} else {
  fs.writeFileSync(OUTPUT, source);
  process.stdout.write('wrote ' + path.relative(REPO_ROOT, OUTPUT)
    + ' (' + Math.round(source.length / 1024) + ' KB)\n');
}
