#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCLIProxyPin } from './cliproxyapi-pin.mjs';
import { parseUsagePull } from '../src/usage-ingest.mjs';
import {
  assertProxyAuthFilesShape,
  assertProxyAuthStatusShape,
  assertProxyAuthUrlShape,
} from '../src/proxy-relogin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CLIPROXY_BINARY = path.join(repoRoot, 'dist', 'cliproxyapi', 'cliproxyapi');
export const CLIPROXY_COMPATIBILITY_EVIDENCE = path.join(
  repoRoot,
  'dist',
  'cliproxyapi',
  'compatibility.json',
);
export const DEFAULT_CLIPROXY_TEST_PORT = 18319;
export const CLIPROXY_COMPATIBILITY_TRIPWIRES = Object.freeze([
  'pin-bump-queue-shape',
  'pin-bump-mgmt-api',
  'pin-bump-auth-format',
  // Issue #396: the in-app credential repair consumes four more management
  // surfaces. A pin bump that changes any of their shapes must not ship a
  // "Fix sign-in" button that quietly stopped working.
  'pin-bump-relogin-api',
]);

/// The state token used to capture the get-auth-status and oauth-session
/// shapes. It is deliberately one the proxy cannot know: the response is then
/// the ERROR/not-cancelled branch, which is deterministic, needs no OAuth
/// session, and is exactly the branch a stale ModelDeck poll would hit.
export const CLIPROXY_PROBE_OAUTH_STATE = 'modeldeck-pin-bump-probe';

const RESERVED_PORTS = new Set([8317, 3867]);
const QUEUE_SHAPES = new Set(['bare-array', 'usage-envelope']);

export function discoverCLIProxyBinary({
  env = process.env,
  cwd = process.cwd(),
  root = repoRoot,
} = {}) {
  const configured = typeof env.MD_CLIPROXYAPI_BINARY === 'string'
    ? env.MD_CLIPROXYAPI_BINARY.trim()
    : '';
  const binaryPath = configured
    ? path.resolve(cwd, configured)
    : path.join(root, 'dist', 'cliproxyapi', 'cliproxyapi');
  let available = false;
  try { available = fs.statSync(binaryPath).isFile(); } catch { /* Missing is a named live-test skip. */ }
  return {
    available,
    binaryPath,
    source: configured ? 'MD_CLIPROXYAPI_BINARY' : 'default build output',
    skipReason: available
      ? null
      : `binary absent at ${binaryPath}; build first with scripts/build-cliproxyapi.sh --fetch-go`,
  };
}

export function assertExecutableCLIProxyBinary(binaryPath) {
  let stat;
  try { stat = fs.statSync(binaryPath); }
  catch { throw new Error(`CLIProxyAPI binary is missing: ${binaryPath}`); }
  if (!stat.isFile()) throw new Error(`CLIProxyAPI binary is not a regular file: ${binaryPath}`);
  try { fs.accessSync(binaryPath, fs.constants.X_OK); }
  catch { throw new Error(`CLIProxyAPI binary is not executable: ${binaryPath}`); }
  return path.resolve(binaryPath);
}

export function parseCLIProxyTestPort(value = DEFAULT_CLIPROXY_TEST_PORT) {
  const text = String(value);
  if (!/^[1-9][0-9]{3,4}$/.test(text)) {
    throw new Error('CLIProxyAPI test port must be an integer from 1024 to 65535');
  }
  const port = Number(text);
  if (port < 1024 || port > 65535) {
    throw new Error('CLIProxyAPI test port must be an integer from 1024 to 65535');
  }
  if (RESERVED_PORTS.has(port)) {
    throw new Error(`CLIProxyAPI test port ${port} is reserved for a live service`);
  }
  return port;
}

export function isolatedCLIProxyConfig({ port, authDir }) {
  const guardedPort = parseCLIProxyTestPort(port);
  if (!path.isAbsolute(authDir)) throw new Error('isolated CLIProxyAPI auth directory must be absolute');
  return [
    'host: "127.0.0.1"',
    `port: ${guardedPort}`,
    'remote-management:',
    '  allow-remote: false',
    '  secret-key: "modeldeck-pin-bump-management-placeholder"',
    '  disable-control-panel: true',
    '  disable-auto-update-panel: true',
    `auth-dir: ${JSON.stringify(authDir)}`,
    'api-keys:',
    '  - "modeldeck-pin-bump-client-placeholder"',
    'debug: false',
    'logging-to-file: false',
    'usage-statistics-enabled: true',
    'plugins:',
    '  enabled: false',
    '',
  ].join('\n');
}

function decodeJSON(input, label) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) return input;
  try { return JSON.parse(String(input)); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

export function assertUsageQueueResponse(input) {
  const document = decodeJSON(input, 'usage-queue response');
  const shape = Array.isArray(document)
    ? 'bare-array'
    : document && typeof document === 'object' && Object.hasOwn(document, 'usage')
      ? 'usage-envelope'
      : null;
  if (!shape) {
    throw new Error('usage-queue response must be a bare array or a usage envelope');
  }
  const parsed = parseUsagePull(document, { machine: 'pin-bump-fixture' });
  if (parsed.kind === 'instances') {
    throw new Error('usage-queue response cannot be an instances envelope');
  }
  if (parsed.malformedRecords?.length) {
    throw new Error(`usage-queue response contains ${parsed.malformedRecords.length} malformed record(s)`);
  }
  return { shape, parsed };
}

export function assertManagementConfigShape(input) {
  const document = decodeJSON(input, 'management config response');
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('management config response must be a JSON object');
  }
  return document;
}

function sha256(binaryPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
}

function sha256OfBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// PR #428 review: #403(d) requires the LIVE response bodies on record — a
// receipt of derived shape fields alone could pass without proving what the
// binary actually answered. Bodies only ever come from the suite's isolated
// placeholder-config instance, never a live service.
const REQUIRED_BODY_CAPTURES = Object.freeze([
  'managementConfig',
  'usageQueue',
  // Issue #396 — the credential-repair surfaces.
  'authFiles',
  'anthropicAuthUrl',
  'codexAuthUrl',
  'authStatusUnknown',
]);
const CAPTURE_FILES = Object.freeze({
  managementConfig: 'captures/management-config.json',
  usageQueue: 'captures/usage-queue.json',
  authFiles: 'captures/auth-files.json',
  anthropicAuthUrl: 'captures/anthropic-auth-url.json',
  codexAuthUrl: 'captures/codex-auth-url.json',
  authStatusUnknown: 'captures/auth-status-unknown.json',
});
// Exact endpoints, not a prefix: an unrelated management response cannot be
// labeled as a capture, and the queue read carries count=1 — the destructive
// read takes ONE record even against the isolated instance, per the runbook
// discipline.
// The two *-auth-url captures deliberately omit the `is_webui=1` the daemon
// sends in production: that parameter's only effect is a SIDE EFFECT — the
// proxy additionally binds the provider's fixed callback port (54545 / 1455)
// for the duration of the flow. The response body is built identically
// either way, and the suite must not seize a well-known port on a developer's
// machine to record a shape it can record without one.
const CAPTURE_ENDPOINTS = Object.freeze({
  managementConfig: '/v0/management/config',
  usageQueue: '/v0/management/usage-queue?count=1',
  authFiles: '/v0/management/auth-files',
  anthropicAuthUrl: '/v0/management/anthropic-auth-url',
  codexAuthUrl: '/v0/management/codex-auth-url',
  authStatusUnknown: `/v0/management/get-auth-status?state=${CLIPROXY_PROBE_OAUTH_STATE}`,
});

// Each body must actually BE what the capture claims: parse it with the same
// validators the suite asserts with, and derive the recorded queue shape from
// the body rather than trusting the caller.
function validateCapturedBody(name, body) {
  if (name === 'managementConfig') {
    assertManagementConfigShape(body);
    return null;
  }
  if (name === 'authFiles') {
    assertProxyAuthFilesShape(body);
    return null;
  }
  if (name === 'anthropicAuthUrl' || name === 'codexAuthUrl') {
    // The same validator the daemon starts a repair with: if a pin bump stops
    // answering an https authorize URL plus a usable state, the "Fix sign-in"
    // action is broken and this fails instead of shipping.
    assertProxyAuthUrlShape(body);
    return null;
  }
  if (name === 'authStatusUnknown') {
    const status = assertProxyAuthStatusShape(body);
    if (status.status !== 'error') {
      throw new Error('a get-auth-status probe for an unknown state must answer the error branch');
    }
    return null;
  }
  return assertUsageQueueResponse(body).shape;
}

function persistCapturedBodies(capturedBodies, evidencePath) {
  const bodies = {};
  let queueShape = null;
  for (const name of REQUIRED_BODY_CAPTURES) {
    const supplied = capturedBodies?.[name];
    if (!supplied
      || supplied.endpoint !== CAPTURE_ENDPOINTS[name]
      || typeof supplied.body !== 'string'
      || supplied.body.length === 0) {
      throw new Error(`a live captured ${name} response body from ${CAPTURE_ENDPOINTS[name]} is required (#403d: fixtures pass is not live pass)`);
    }
    const derived = validateCapturedBody(name, supplied.body);
    if (name === 'usageQueue') queueShape = derived;
    const file = CAPTURE_FILES[name];
    const target = path.join(path.dirname(evidencePath), file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Owner-only (PR #428 review, CWE-200): the suite only ever captures from
    // its isolated placeholder instance, but a management config response CAN
    // carry provider keys — the permission is not the last line of defense,
    // it just refuses to be a hole.
    fs.writeFileSync(target, supplied.body, { mode: 0o600 });
    bodies[name] = {
      endpoint: supplied.endpoint,
      sha256: sha256OfBytes(supplied.body),
      bytes: Buffer.byteLength(supplied.body),
      file,
    };
  }
  return { bodies, queueShape };
}

function validatedCapture(capture) {
  if (!QUEUE_SHAPES.has(capture?.usageQueueShape)) {
    throw new Error('compatibility capture has an unsupported usage-queue shape');
  }
  if (capture?.management?.unauthenticatedStatus !== 401
    || capture?.management?.wrongTokenStatus !== 401
    || capture?.management?.authenticatedStatus !== 200
    || capture?.management?.responseShape !== 'object') {
    throw new Error('compatibility capture has unexpected management API results');
  }
  const providers = capture?.authFileProviders;
  if (!Array.isArray(providers)
    || providers.length !== 2
    || providers[0] !== 'claude'
    || providers[1] !== 'codex') {
    throw new Error('compatibility capture did not validate both fixture auth formats');
  }
  const bodies = {};
  for (const name of REQUIRED_BODY_CAPTURES) {
    const entry = capture?.bodies?.[name];
    if (!entry
      || entry.endpoint !== CAPTURE_ENDPOINTS[name]
      || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')
      || !Number.isInteger(entry.bytes) || entry.bytes <= 0
      || entry.file !== CAPTURE_FILES[name]) {
      throw new Error(`compatibility capture is missing the ${name} live response body record`);
    }
    bodies[name] = {
      endpoint: entry.endpoint, sha256: entry.sha256, bytes: entry.bytes, file: entry.file,
    };
  }
  return {
    usageQueueShape: capture.usageQueueShape,
    management: {
      unauthenticatedStatus: 401,
      wrongTokenStatus: 401,
      authenticatedStatus: 200,
      responseShape: 'object',
    },
    authFileProviders: ['claude', 'codex'],
    bodies,
  };
}

export function writeCLIProxyCompatibilityEvidence({
  binaryPath,
  pin = readCLIProxyPin(),
  capture,
  capturedBodies,
  evidencePath = CLIPROXY_COMPATIBILITY_EVIDENCE,
  passedAt = new Date().toISOString(),
} = {}) {
  const executable = assertExecutableCLIProxyBinary(binaryPath);
  const { bodies, queueShape } = persistCapturedBodies(capturedBodies, evidencePath);
  const evidence = {
    schemaVersion: 1,
    pin: { tag: pin.tag, commit: pin.commit },
    binarySha256: sha256(executable),
    passedAt,
    tripwires: Object.fromEntries(CLIPROXY_COMPATIBILITY_TRIPWIRES.map((name) => [name, true])),
    // The recorded queue shape is DERIVED from the captured body, never
    // trusted from the caller.
    capture: validatedCapture({ ...capture, usageQueueShape: queueShape, bodies }),
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const temporary = `${evidencePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, evidencePath);
  return evidence;
}

export function verifyCLIProxyCompatibilityEvidence({
  binaryPath = DEFAULT_CLIPROXY_BINARY,
  pin = readCLIProxyPin(),
  evidencePath = CLIPROXY_COMPATIBILITY_EVIDENCE,
} = {}) {
  const executable = assertExecutableCLIProxyBinary(binaryPath);
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); }
  catch (error) {
    throw new Error(`CLIProxyAPI compatibility evidence is missing or invalid at ${evidencePath}: ${error.message}`);
  }
  if (evidence?.schemaVersion !== 1) {
    throw new Error('CLIProxyAPI compatibility evidence has an unsupported schema version');
  }
  if (evidence?.pin?.tag !== pin.tag || evidence?.pin?.commit !== pin.commit) {
    throw new Error(`CLIProxyAPI compatibility evidence is stale for ${pin.tag} (${pin.commit})`);
  }
  const actualSha256 = sha256(executable);
  if (evidence.binarySha256 !== actualSha256) {
    throw new Error('CLIProxyAPI compatibility evidence does not match the binary being released');
  }
  for (const name of CLIPROXY_COMPATIBILITY_TRIPWIRES) {
    if (evidence?.tripwires?.[name] !== true) {
      throw new Error(`CLIProxyAPI compatibility evidence is missing tripwire ${name}`);
    }
  }
  const capture = validatedCapture(evidence.capture);
  for (const [name, meta] of Object.entries(capture.bodies)) {
    const target = path.join(path.dirname(evidencePath), meta.file);
    let body;
    try { body = fs.readFileSync(target); }
    catch (error) {
      throw new Error(`CLIProxyAPI compatibility evidence names a captured ${name} body that is missing at ${target}: ${error.message}`);
    }
    if (sha256OfBytes(body) !== meta.sha256 || body.length !== meta.bytes) {
      throw new Error(`captured ${name} response body does not match the evidence digest — rerun npm run test:cliproxyapi-pin`);
    }
    const derived = validateCapturedBody(name, body.toString('utf8'));
    if (name === 'usageQueue' && derived !== capture.usageQueueShape) {
      throw new Error('captured usage-queue body does not produce the shape the evidence records');
    }
  }
  return evidence;
}

function main(args) {
  const [command, ...rest] = args;
  if (command !== 'verify' || rest.length > 2) {
    throw new Error('usage: cliproxyapi-compat.mjs verify [binary] [evidence-file]');
  }
  const discovered = rest[0]
    ? { available: true, binaryPath: path.resolve(rest[0]) }
    : discoverCLIProxyBinary();
  if (!discovered.available) throw new Error(discovered.skipReason);
  const evidence = verifyCLIProxyCompatibilityEvidence({
    binaryPath: discovered.binaryPath,
    ...(rest[1] ? { evidencePath: path.resolve(rest[1]) } : {}),
  });
  process.stdout.write(
    `CLIProxyAPI compatibility evidence OK: ${evidence.pin.tag} ${evidence.binarySha256}\n`,
  );
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`cliproxyapi-compat.mjs: ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
