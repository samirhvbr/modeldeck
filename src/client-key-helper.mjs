// Issue #522 — per-profile client-key helper wiring (design §2.5, decision 0036).
//
// The `apiKeyHelper` string, the pinned shell env block and the launch preview
// all point at ONE Keychain item. Before #520 that item was the shared
// `cli-proxy-api-client`; per-profile provisioning gives each profile its own
// `cli-proxy-api-client.<slug>` item, where the slug is the account's stable
// machine id — never its free-text label.
//
// The slug is the only value this module ever interpolates into a shell
// command string, and `assertClientKeySlug` restricts it to `[a-z0-9-]`, so
// command injection through a profile name is structurally impossible
// (design §3.5). Account ids are `crypto.randomUUID()` values, which already
// satisfy that charset.

/// The pre-#522 shared item. Reserved EXCLUSIVELY for the legacy shared key:
/// `find-generic-password -s cli-proxy-api-client` without `-a` returns the
/// FIRST match, so per-profile items must never share this service name or a
/// stale shell could fetch another profile's key (security review of #506,
/// blocker 1). The dot-prefixed per-profile names cannot collide with it.
export const LEGACY_CLIENT_KEY_SERVICE = 'cli-proxy-api-client';
export const CLIENT_KEY_SERVICE_PREFIX = `${LEGACY_CLIENT_KEY_SERVICE}.`;

const CLIENT_KEY_SLUG_PATTERN = /^[a-z0-9-]+$/;
const CLIENT_KEY_SLUG_MAX_LENGTH = 128;

export function assertClientKeySlug(slug) {
  if (typeof slug !== 'string' || !slug || slug.length > CLIENT_KEY_SLUG_MAX_LENGTH
    || !CLIENT_KEY_SLUG_PATTERN.test(slug)) {
    throw new Error('client key profile slug must match [a-z0-9-] and be non-empty');
  }
  return slug;
}

export function clientKeyService(slug) {
  return `${CLIENT_KEY_SERVICE_PREFIX}${assertClientKeySlug(slug)}`;
}

/// Every service name that may reach a generated command string: the legacy
/// shared item, or one well-formed per-profile item. Anything else throws
/// rather than being quoted — the writers have no reason to emit a name
/// ModelDeck did not derive, and a throw is louder than an escape.
export function assertClientKeyService(service) {
  if (service === LEGACY_CLIENT_KEY_SERVICE) return service;
  if (typeof service === 'string' && service.startsWith(CLIENT_KEY_SERVICE_PREFIX)) {
    assertClientKeySlug(service.slice(CLIENT_KEY_SERVICE_PREFIX.length));
    return service;
  }
  throw new Error('client key Keychain service name is not a ModelDeck client-key service');
}

export function clientKeyHelperCommand(service) {
  return `security find-generic-password -s ${assertClientKeyService(service)} -w`;
}

/// The exact string every ModelDeck release before #522 wrote into
/// `settings.json`. It is a CONSTANT, not a pattern — see `classifyClaudeHelper`.
export const LEGACY_CLIENT_KEY_HELPER = clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE);

/// The Keychain service a profile's wiring must point at, from the recorded
/// helper state ModelDeck keeps for it. No record — an install that never
/// migrated, or a profile a user routed by hand — means the legacy shared
/// item, which is exactly the pre-#522 behaviour.
export function clientKeyServiceForRecord(record) {
  return record?.mode === 'per-profile' && typeof record.service === 'string'
    ? assertClientKeyService(record.service)
    : LEGACY_CLIENT_KEY_SERVICE;
}

/// The foreign-helper guard (design §2.5, security review should-fix 7 as
/// sharpened by CodeRabbit).
///
/// Recognition as "ours" is PROVEN OWNERSHIP, never pattern inference. A
/// helper is ours only when it is byte-identical to the string this profile's
/// own record says ModelDeck last wrote. A string that merely LOOKS generated
/// — right shape, even a real account's slug — has no ownership record behind
/// it and may be the user's own hand-authored wiring (including deliberate
/// cross-profile wiring), so it is refused, never overwritten or deleted.
///
/// The one accepted string with no per-profile record is the legacy shared
/// helper. That is not a pattern match either: it is equality against the
/// single fixed string every prior release wrote, which is why an install
/// that predates per-profile keys keeps working (design §2.5, D6).
///
/// Returns 'absent' | 'recorded' | 'legacy' | 'foreign'.
export function classifyClaudeHelper(helper, record) {
  if (typeof helper !== 'string' || !helper.trim()) return 'absent';
  const recorded = typeof record?.helper === 'string' && record.helper ? record.helper : null;
  if (recorded) return helper === recorded ? 'recorded' : 'foreign';
  return helper === LEGACY_CLIENT_KEY_HELPER ? 'legacy' : 'foreign';
}

export function claudeHelperIsOurs(helper, record) {
  const verdict = classifyClaudeHelper(helper, record);
  return verdict === 'recorded' || verdict === 'legacy';
}
