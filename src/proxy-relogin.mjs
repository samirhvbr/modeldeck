// Issue #396 — in-app repair for an expired CLIProxyAPI pool credential.
//
// THE BINDING CONSTRAINT (#398 verdict): ModelDeck manages CONFIG and
// PROCESS, never auth files. CLIProxyAPI stays the sole writer of its own
// credentials. So the re-login here is not a login ModelDeck performs: it is
// ModelDeck asking the PROXY to run the proxy's own OAuth flow, and then
// watching the proxy's own answer. Three management calls, no child process,
// no terminal, and — the tripwire that guards this file — not one filesystem
// write of any kind.
//
// The flow, all against the proxy's loopback management API:
//   1. GET  /v0/management/{anthropic,codex}-auth-url?is_webui=1  -> {url, state}
//      `is_webui=1` makes the PROXY bind the provider's fixed callback port
//      (54545 anthropic / 1455 codex) and hand the exchange to itself. That
//      is the whole reason the user never touches a terminal: ModelDeck only
//      has to open `url` in a browser.
//   2. GET  /v0/management/get-auth-status?state=...  -> {"status":"ok"|"wait"|"error"}
//   3. DELETE /v0/management/oauth-session?state=...  to stop waiting.
//
// The credential health that decides WHICH member is affected comes from
// GET /v0/management/auth-files — the proxy's own verdict. An expired
// credential whose refresh is rejected upstream lands as
// `status: "error", unavailable: true, status_message: "unauthorized"`, and a
// successful re-login clears it back to `active`. That flip is the observable
// recovery signal (#395's detector clears on the same fact).
//
// Field allowlist, deliberately narrow: `name`, `provider`/`type`, `status`,
// `status_message`, `disabled`, `unavailable`, `email`, and the codex
// `id_token.chatgpt_account_id`. Nothing else is read. In particular the
// response's `account` field is NEVER read — for an api-key auth entry
// upstream puts the API KEY there.

import fs from 'node:fs';

export const PROXY_RELOGIN_REQUEST_TIMEOUT_MS = 15_000;
/// The proxy's own callback waiter gives up after 5 minutes; ModelDeck's
/// session must not outlive the flow it is describing.
export const PROXY_RELOGIN_SESSION_TTL_MS = 5 * 60_000;
/// The auth-files probe is a network call on a path the deck reads often.
/// A short cache keeps /api/state cheap without making recovery feel stale.
export const PROXY_CREDENTIAL_HEALTH_TTL_MS = 15_000;

const DEFAULT_CLIPROXY_BASE_URL = 'http://127.0.0.1:8317';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/// Provider -> the management route that starts THAT provider's own OAuth.
/// Only the two providers ModelDeck pools today; anything else is refused
/// with a reason rather than guessed at.
export const PROXY_RELOGIN_AUTH_URL_PATHS = Object.freeze({
  claude: '/v0/management/anthropic-auth-url',
  codex: '/v0/management/codex-auth-url',
});
export const PROXY_RELOGIN_STATUS_PATH = '/v0/management/get-auth-status';
export const PROXY_RELOGIN_SESSION_PATH = '/v0/management/oauth-session';
export const PROXY_AUTH_FILES_PATH = '/v0/management/auth-files';

/// State tokens come back from the proxy and go straight back out in a query
/// string. Upstream restricts them to this charset; so do we, rather than
/// trusting a remote value into a URL.
const STATE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/// Same guard as the usage-queue consumer: the management API is a loopback
/// service, and a base URL that is not loopback HTTP is refused rather than
/// dialed.
export function loopbackManagementUrl(baseUrl, pathname, params = {}) {
  const url = new URL(baseUrl || DEFAULT_CLIPROXY_BASE_URL);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('CLIProxyAPI management URL must be loopback HTTP');
  }
  url.pathname = pathname;
  url.search = '';
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }
  url.hash = '';
  return url;
}

export function isLoopbackManagementBaseUrl(baseUrl) {
  try {
    loopbackManagementUrl(baseUrl, '/');
    return true;
  } catch {
    return false;
  }
}

/// Why the in-app fix is (or is not) offered for this account, in the user's
/// words. Pure: every input is a fact the caller already established, so the
/// decision is unit-testable without a proxy, a key, or a network.
export function decideProxyReloginAvailability({
  provider,
  baseUrl,
  managementKeyPresent,
} = {}) {
  if (!Object.hasOwn(PROXY_RELOGIN_AUTH_URL_PATHS, provider)) {
    return {
      available: false,
      reason: 'In-app proxy sign-in is available for Claude and Codex accounts only.',
    };
  }
  if (!isLoopbackManagementBaseUrl(baseUrl)) {
    return {
      available: false,
      reason: 'The configured CLIProxyAPI address is not a local address, so ModelDeck will not drive a sign-in through it.',
    };
  }
  if (!managementKeyPresent) {
    // Issue #431 owns provisioning. Until it lands, a freshly seeded managed
    // install genuinely has no key — say so plainly instead of failing later
    // with an opaque 401.
    return {
      available: false,
      // Actionable for BOTH cases this covers: a freshly seeded managed
      // install that has no key at all, and an external proxy whose key
      // ModelDeck was never told (it lives in the proxy's own config).
      reason: 'ModelDeck has no management key for this CLIProxyAPI yet (~/.config/cliproxyapi/.mgmt-key), so it cannot ask the proxy to start a sign-in.',
    };
  }
  return { available: true, reason: null };
}

function decode(input, label) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) return input;
  try { return JSON.parse(String(input)); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

/// `{"status":"ok","url":"https://…","state":"…"}` from a *-auth-url route.
/// The URL is the provider's own authorize page: it carries a client id, a
/// PKCE challenge, and the state — no credential. It is returned to the app
/// so a browser can open it, and is never logged.
export function assertProxyAuthUrlShape(input) {
  const document = decode(input, 'auth-url response');
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('auth-url response must be a JSON object');
  }
  if (document.status !== 'ok') throw new Error('auth-url response did not report status ok');
  const url = typeof document.url === 'string' ? document.url.trim() : '';
  const state = typeof document.state === 'string' ? document.state.trim() : '';
  if (!/^https:\/\//.test(url)) throw new Error('auth-url response did not carry an https authorize URL');
  if (!STATE_PATTERN.test(state)) throw new Error('auth-url response did not carry a usable state token');
  return { url, state };
}

/// `{"status":"ok"|"wait"|"error","error":"…"}` from get-auth-status. Upstream
/// answers 200 for every one of these, so the BODY is the whole outcome.
export function assertProxyAuthStatusShape(input) {
  const document = decode(input, 'auth-status response');
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('auth-status response must be a JSON object');
  }
  const status = document.status;
  if (status !== 'ok' && status !== 'wait' && status !== 'error') {
    throw new Error('auth-status response did not report ok, wait, or error');
  }
  const error = typeof document.error === 'string' && document.error.trim()
    ? document.error.trim().slice(0, 200)
    : null;
  return { status, error };
}

/// `{"files":[…]}` from auth-files, reduced to the non-secret allowlist.
/// Entries the allowlist cannot identify are kept with a null identity rather
/// than dropped, so a caller can still count what the proxy holds.
export function assertProxyAuthFilesShape(input) {
  const document = decode(input, 'auth-files response');
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('auth-files response must be a JSON object');
  }
  if (!Array.isArray(document.files)) {
    throw new Error('auth-files response must carry a files array');
  }
  return document.files
    .filter((file) => file && typeof file === 'object' && !Array.isArray(file))
    .map((file) => {
      const provider = typeof file.provider === 'string' && file.provider.trim()
        ? file.provider.trim().toLowerCase()
        : (typeof file.type === 'string' ? file.type.trim().toLowerCase() : '');
      const email = typeof file.email === 'string' && file.email.trim()
        ? file.email.trim().toLowerCase()
        : null;
      // Codex identity: the id_token claim, which is the same chatgpt account
      // id the daemon already joins Codex accounts by. NEVER `file.account` —
      // upstream puts an API key there for api-key auth entries.
      //
      // Live-capture finding (v7.2.130): the claim is present only when the
      // auth file carries id_token metadata, which a real Codex login writes
      // and a hand-made file may not. Codex health then reads as UNKNOWN and
      // the member simply reports no credential state — the repair itself
      // stays available, because it never depended on health.
      const claims = file.id_token;
      const codexAccountId = claims && typeof claims === 'object' && !Array.isArray(claims)
        && typeof claims.chatgpt_account_id === 'string' && claims.chatgpt_account_id.trim()
        ? claims.chatgpt_account_id.trim()
        : null;
      return {
        name: typeof file.name === 'string' ? file.name : '',
        provider,
        email,
        codexAccountId,
        status: typeof file.status === 'string' ? file.status.trim().toLowerCase() : '',
        statusMessage: typeof file.status_message === 'string'
          ? file.status_message.trim().slice(0, 200)
          : '',
        disabled: file.disabled === true,
        unavailable: file.unavailable === true,
      };
    });
}

/// One auth entry's health, in ModelDeck's three words.
/// `disabled` is deliberately separate from `error`: a benched credential is
/// not a broken one, and re-signing in would not un-bench it.
export function proxyCredentialHealthOf(entry) {
  if (entry.disabled || entry.status === 'disabled') return 'disabled';
  if (entry.unavailable || entry.status === 'error') return 'error';
  if (entry.status === 'active' || entry.status === 'refreshing' || entry.status === 'pending') return 'ok';
  return null;
}

/// Fold the auth-file entries into per-identity health, keyed the way the
/// daemon already joins pool members (Claude by lowercased email, Codex by
/// remembered account id).
///
/// Two entries can share one identity — a re-login can leave an older file
/// behind. HEALTHY WINS here, the opposite of the weight reader's benched-wins
/// rule, and for the same reason: both refuse to overstate the problem. If any
/// live file for this identity still serves traffic, the account is not the
/// one to send the user to a browser for.
export function proxyCredentialHealthFromAuthFiles(entries) {
  const byClaudeEmail = new Map();
  const byCodexAccountId = new Map();
  const merge = (map, key, health, detail) => {
    if (!key || !health) return;
    const seen = map.get(key);
    if (seen?.health === 'ok') return;
    if (health === 'ok') { map.set(key, { health, detail: null }); return; }
    if (seen) return;
    map.set(key, { health, detail: detail || null });
  };
  for (const entry of entries) {
    const health = proxyCredentialHealthOf(entry);
    const detail = entry.statusMessage || null;
    if (entry.provider === 'claude' || entry.provider === 'anthropic') {
      merge(byClaudeEmail, entry.email, health, detail);
    } else if (entry.provider === 'codex' || entry.provider === 'openai') {
      merge(byCodexAccountId, entry.codexAccountId, health, detail);
    }
  }
  return { byClaudeEmail, byCodexAccountId };
}

/// The flow's phases, as the app renders them.
export const PROXY_RELOGIN_PHASES = Object.freeze([
  'idle',
  'starting',
  'awaiting-browser',
  'succeeded',
  'failed',
  'cancelled',
]);

/// The whole state machine, pure. Every transition the UI can be in comes
/// from here, so the honest-failure requirement is a table, not a code path
/// nobody exercises.
///
/// Events: `start`, `started`, `poll-wait`, `poll-ok`, `poll-error`,
/// `expired`, `cancel`, `transport-error`.
export function proxyReloginNextPhase(phase, event) {
  switch (phase) {
    case 'idle':
      return event === 'start' ? 'starting' : phase;
    case 'starting':
      if (event === 'started') return 'awaiting-browser';
      if (event === 'transport-error' || event === 'poll-error') return 'failed';
      if (event === 'cancel') return 'cancelled';
      return phase;
    case 'awaiting-browser':
      if (event === 'poll-ok') return 'succeeded';
      if (event === 'poll-error' || event === 'transport-error' || event === 'expired') return 'failed';
      if (event === 'cancel') return 'cancelled';
      if (event === 'poll-wait') return 'awaiting-browser';
      return phase;
    // Settled phases are terminal until the caller starts a new attempt.
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return event === 'start' ? 'starting' : phase;
    default:
      return 'idle';
  }
}

export function isSettledProxyReloginPhase(phase) {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
}

/// Drives the three management calls. Deliberately owns no state and no
/// credential: the management key is read from disk per request and dropped
/// in the same `finally`, exactly like the usage-queue consumer. It has no
/// filesystem writer of any kind — see TRIPWIRE relogin-never-touches-auth-files.
export class ProxyReloginDriver {
  constructor({
    baseUrl = DEFAULT_CLIPROXY_BASE_URL,
    managementKeyPath = null,
    fetcher = globalThis.fetch,
    readFile = fs.promises.readFile,
    requestTimeoutMs = PROXY_RELOGIN_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.baseUrl = baseUrl;
    this.managementKeyPath = managementKeyPath;
    this.fetcher = fetcher;
    this.readFile = readFile;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async managementKeyPresent() {
    if (!this.managementKeyPath) return false;
    try {
      return String(await this.readFile(this.managementKeyPath, 'utf8')).trim() !== '';
    } catch {
      return false;
    }
  }

  /// One authenticated management request. Returns `{ ok, status, text }`;
  /// throws only when the request could not be made at all. Error bodies are
  /// cancelled unread — the same discipline as the queue consumer.
  async request(method, pathname, params) {
    const url = loopbackManagementUrl(this.baseUrl, pathname, params);
    let managementKey;
    try {
      if (!this.managementKeyPath) throw new ProxyReloginError('no-key');
      managementKey = String(await this.readFile(this.managementKeyPath, 'utf8')).trim();
      if (!managementKey) throw new ProxyReloginError('no-key');
    } catch (error) {
      throw error instanceof ProxyReloginError ? error : new ProxyReloginError('no-key');
    }
    let response;
    try {
      const timeout = Number(this.requestTimeoutMs);
      response = await this.fetcher(url, {
        method,
        headers: { Authorization: `Bearer ${managementKey}` },
        redirect: 'error',
        ...(Number.isFinite(timeout) && timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
      });
    } catch {
      throw new ProxyReloginError('unreachable');
    } finally {
      managementKey = null;
    }
    if (!response?.ok) {
      try { await response?.body?.cancel(); } catch { /* Never read an error body. */ }
      throw new ProxyReloginError('http', { status: Number.isInteger(response?.status) ? response.status : null });
    }
    return response.text();
  }

  /// Ask the proxy to begin its own OAuth for this provider. `is_webui=1` is
  /// load-bearing: it makes the proxy bind the provider's fixed callback port
  /// itself, which is what removes the terminal from the user's path.
  async start(provider) {
    const pathname = PROXY_RELOGIN_AUTH_URL_PATHS[provider];
    if (!pathname) throw new ProxyReloginError('unsupported-provider');
    const body = await this.request('GET', pathname, { is_webui: '1' });
    try {
      return assertProxyAuthUrlShape(body);
    } catch {
      throw new ProxyReloginError('malformed');
    }
  }

  async status(state) {
    if (!STATE_PATTERN.test(String(state ?? ''))) throw new ProxyReloginError('bad-state');
    const body = await this.request('GET', PROXY_RELOGIN_STATUS_PATH, { state });
    try {
      return assertProxyAuthStatusShape(body);
    } catch {
      throw new ProxyReloginError('malformed');
    }
  }

  async cancel(state) {
    if (!STATE_PATTERN.test(String(state ?? ''))) throw new ProxyReloginError('bad-state');
    await this.request('DELETE', PROXY_RELOGIN_SESSION_PATH, { state });
    return true;
  }

  async authFiles() {
    const body = await this.request('GET', PROXY_AUTH_FILES_PATH);
    try {
      return assertProxyAuthFilesShape(body);
    } catch {
      throw new ProxyReloginError('malformed');
    }
  }
}

/// Transport-layer failures, carrying a reason CODE only. The reason text the
/// user reads is produced by `proxyReloginFailureText` so every failure state
/// is one tested sentence rather than a leaked internal message.
export class ProxyReloginError extends Error {
  constructor(reason, { status = null } = {}) {
    super(`proxy relogin ${reason}`);
    this.name = 'ProxyReloginError';
    this.reason = reason;
    this.status = status;
  }
}

/// Honest failure copy: what went wrong, and what to try. One sentence each.
export function proxyReloginFailureText(reason, { status = null } = {}) {
  switch (reason) {
    case 'no-key':
      return 'CLIProxyAPI’s management key could not be read, so ModelDeck could not ask it to start a sign-in.';
    case 'unreachable':
      return 'CLIProxyAPI did not answer. Make sure the proxy is running, then try again.';
    case 'http':
      if (status === 401 || status === 403) {
        return 'CLIProxyAPI rejected ModelDeck’s management key. Check the key in ~/.config/cliproxyapi, then try again.';
      }
      if (status === 404) {
        return 'This CLIProxyAPI has remote management turned off, so it cannot run a sign-in for ModelDeck.';
      }
      return `CLIProxyAPI refused the sign-in request${status ? ` (HTTP ${status})` : ''}. Try again, or check the proxy’s log.`;
    case 'malformed':
      return 'CLIProxyAPI answered in a shape ModelDeck does not recognize. The proxy may be a different version than this build expects.';
    case 'unsupported-provider':
      return 'In-app proxy sign-in is available for Claude and Codex accounts only.';
    case 'bad-state':
      return 'The sign-in ModelDeck was tracking is no longer identifiable. Start the sign-in again.';
    case 'expired':
      return 'The sign-in was not finished in time. Start it again when you are ready to complete it in the browser.';
    case 'no-session':
      return 'There is no sign-in in progress for this account.';
    default:
      return 'The sign-in could not be completed. Try again.';
  }
}
