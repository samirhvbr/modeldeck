// Test support for the Overview landing — NOT part of the shipped page (nothing
// in dashboard/src imports it, so the vite build never sees it).
//
// It exists because the landing is JSX and node --test is not: loadModule
// transforms a dashboard module with esbuild (already a repo devDependency, and
// the same bundler the daemon's SEA build uses) into something node can import,
// and installDom gives a click-test a jsdom window recharts can measure.
//
// Lives outside test/ on purpose: node --test treats every file under test/ as a
// test file, so a helper module placed there would be run as one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

export const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DASHBOARD_DIR = path.join(SUPPORT_DIR, '..');

/** Bundle one dashboard module (path relative to dashboard/) and import it. */
export async function loadModule(relativePath) {
  const outfile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-dashboard-test-')),
    'module.mjs',
  );
  await esbuild.build({
    entryPoints: [path.join(DASHBOARD_DIR, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

/**
 * A jsdom window the landing can render into.
 *
 * The two stubs are both about layout: jsdom performs none, and both the
 * treemap's legibility fold and recharts' plot geometry are decided in real
 * pixels. So every element reports the given size, and the ResizeObserver
 * reports it immediately rather than never.
 */
export function installDom({ width = 1040, height = 340, hash = '' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    // `hash` is the app window's deep link (#424): the route rides the
    // fragment, so an arrival test is just this page opened at a URL.
    url: 'http://127.0.0.1:3867/dashboard' + hash,
  });
  const { window } = dom;
  for (const name of [
    'window', 'document', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'Event',
    'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'localStorage',
  ]) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  // The tests wait on the DOM rather than driving act() — see mount.jsx.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;

  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => width, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => height, configurable: true });
  window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    return {
      width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
    };
  };
  class ResizeObserverStub {
    constructor(callback) { this.callback = callback; }
    observe(target) {
      this.callback([{ target, contentRect: { width, height, top: 0, left: 0 } }], this);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
  window.ResizeObserver = ResizeObserverStub;
  return dom;
}

/**
 * Boot the BUILT page — the exact bytes the daemon serves — in its own jsdom,
 * with its fetches answered by a real daemon app. This is the one check that
 * covers the compile step itself: a minified bundle that throws on load renders
 * an empty page in a browser and passes every source-level test.
 */
export function bootPage(
  html, app, { width = 1040, height = 340, host = '127.0.0.1:3867', hash = '', now = null } = {},
) {
  const dom = new JSDOM(html, {
    // jsdom does not execute <script type="module">, so the page's own script is
    // evaluated below instead — after parsing, which is exactly when a module
    // script runs in a browser. The bytes themselves are never edited.
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://' + host + '/dashboard' + hash,
    beforeParse(window) {
      Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => width, configurable: true });
      Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => height, configurable: true });
      window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
        return {
          width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
        };
      };
      window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target) {
          this.callback([{ target, contentRect: { width, height, top: 0, left: 0 } }], this);
        }
        unobserve() {}
        disconnect() {}
      };
      window.fetch = requestThrough(app, host);
      // `now` pins the page's clock. The page derives its query window from
      // `new Date()` (boundsFor), so a test seeding fixed-date fixtures MUST
      // pin the clock beside them — seeded against the wall clock instead,
      // the fixtures age out of the window and the test starts failing the
      // day they do (the 2026-08-24 breakage). Pinning also makes the revert
      // loud: an unpinned page filters those same stale fixtures out
      // immediately, not next week.
      if (now != null) {
        const fixedNow = new Date(now).getTime();
        const PageDate = window.Date;
        window.Date = class extends PageDate {
          constructor(...args) {
            if (args.length === 0) super(fixedNow);
            else super(...args);
          }

          static now() { return fixedNow; }
        };
      }
    },
  });
  const scripts = [...dom.window.document.querySelectorAll('script')];
  if (scripts.length !== 1) throw new Error('expected one inline script, found ' + scripts.length);
  dom.window.eval(scripts[0].textContent);
  return dom;
}

/**
 * Wait until the page satisfies a predicate, or fail with the reason. Every
 * async thing this page does — its fetches, its effects, its measurements —
 * ends in the DOM, so that is the one thing worth waiting on.
 */
export async function waitFor(predicate, what, { timeoutMs = 5000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const value = predicate();
      if (value) return value;
      last = null;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for ' + what + (last ? ': ' + last.message : ''));
    }
    await new Promise((resolve) => { setTimeout(resolve, everyMs); });
  }
}

/**
 * Point the page's fetch at a real daemon app object, through its request
 * listener rather than a socket — so a click test exercises the actual
 * flag-gated readers and their parameter validation, with no port to bind.
 */
export function installFetch(app, { host = '127.0.0.1:3867' } = {}) {
  globalThis.fetch = requestThrough(app, host);
}

function requestThrough(app, host) {
  return async (url) => {
    const req = Object.assign(Readable.from([]), {
      method: 'GET',
      url: String(url),
      headers: { host },
      socket: { remoteAddress: '127.0.0.1' },
    });
    let status = 500;
    let payload = null;
    const res = {
      writeHead(value) { status = value; },
      end(value) { payload = value == null ? null : String(value); },
    };
    await app.server.listeners('request')[0](req, res);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload == null ? null : JSON.parse(payload); },
    };
  };
}
