// The two rules the dashboard ARTIFACT has to satisfy, in one place so the build
// and the test that guards it can never enforce different ones.
//
// src/dashboard-app.mjs is a COMMITTED build output: the daemon serves it and
// the SEA bundle carries it, so nothing at runtime rebuilds it — or fetches
// anything alongside it. That makes two failures silent: "edited dashboard/src,
// forgot to run npm run dashboard:build" (the page serves yesterday's code) and
// an asset reference the page cannot load (a chunk of the page is simply
// missing, since the daemon ships no assets and the CSP allows no fetches).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DASHBOARD_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'dashboard');

/** Every file the vite build reads, hashed, keyed by its path inside dashboard/. */
export function fingerprintSources() {
  const files = ['index.html', 'vite.config.js'];
  for (const name of fs.readdirSync(path.join(DASHBOARD_DIR, 'src')).sort()) {
    files.push(path.join('src', name));
  }
  const out = {};
  for (const name of files) {
    const body = fs.readFileSync(path.join(DASHBOARD_DIR, name));
    out[name] = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  }
  return out;
}

/*
 * SELF-CONTAINMENT. Anything the page would LOAD is rejected — not only http(s)
 * URLs: `src="/assets/chart.svg"` is just as broken here, because the daemon
 * serves one HTML string and nothing beside it.
 *
 * `data:` values are fine (they are the page). Anchor navigation is fine: an
 * <a href> is somewhere the reader can go, not something the page pulls in.
 *
 * The attribute rules are applied to the MARKUP only — script bodies are dropped
 * first (their opening tags survive, so a script src is still caught). A bundled
 * library's own strings are text, not references, and matching inside them would
 * fail builds over documentation links in error messages. <style> bodies are
 * kept, since a stylesheet genuinely can pull in a resource.
 */
const RESOURCE_RULES = [
  [/<script[^>]+\ssrc=/i, 'an external <script src>'],
  [/<link[^>]+rel=["']?stylesheet/i, 'an external stylesheet <link>'],
  [/\ssrc(?:set)?=["']\s*(?!data:)/i, 'an element loading a resource'],
  [/<link[^>]+\shref=["']\s*(?!data:)/i, 'a <link> loading a resource'],
  [/url\(\s*["']?\s*(?!data:)/i, 'a CSS url() resource'],
  [/@import\b/i, 'a CSS @import'],
];

export function assertSelfContained(page) {
  const markup = String(page).replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  for (const [pattern, what] of RESOURCE_RULES) {
    if (pattern.test(markup)) throw new Error('the dashboard page references ' + what);
  }
}
