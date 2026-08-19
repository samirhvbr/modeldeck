import crypto from 'node:crypto';

export function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function findingId(pathologyKind, scopeKey) {
  return `finding-${hash(`${pathologyKind}\0${scopeKey}`).slice(0, 24)}`;
}

export function finiteTokens(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Diagnostic points include cache-write tokens in uncached tokens. */
export function diagnosticPointTotalInput(uncached, cached) {
  return finiteTokens(uncached) + finiteTokens(cached);
}

// Issue #524 (design §2.2) — per-profile attribution on receipts.
//
// `request_usage.profile_label` is captured at ingest by resolving the request's
// client key against the daemon's key→profile map, and is NULL whenever that
// resolution failed — an unknown key, or the legacy shared key every migrated
// shell keeps sending. That NULL is the honest answer and it is carried through
// to the receipt as one, never filled in from the transcript's profile slug:
// the slug says which profile's CLI wrote the log, the label says whose key
// paid for the request, and the whole point of the column is the case where
// those two disagree.
//
// Attribution is accumulated per session rather than per point on purpose:
// every detector's corpus fingerprint enumerates point fields explicitly, so a
// session-level counter cannot churn finding revisions.

/** A session with no key-level evidence yet. */
export function emptyAttribution() {
  return { keyed: 0, unresolved: 0, labels: [] };
}

/** Folds one wire-joined request's label into a session's running attribution. */
export function noteAttribution(attribution, profileLabel) {
  attribution.keyed += 1;
  const label = typeof profileLabel === 'string' && profileLabel !== '' ? profileLabel : null;
  if (label == null) {
    attribution.unresolved += 1;
    return attribution;
  }
  if (!attribution.labels.includes(label)) {
    attribution.labels.push(label);
    attribution.labels.sort();
  }
  return attribution;
}

/** Merges one session's attribution into another's (streams folded into a session). */
export function mergeAttribution(into, from) {
  const target = into || emptyAttribution();
  if (!from) return target;
  target.keyed += Number(from.keyed) || 0;
  target.unresolved += Number(from.unresolved) || 0;
  for (const label of Array.isArray(from.labels) ? from.labels : []) {
    if (typeof label === 'string' && label !== '' && !target.labels.includes(label)) {
      target.labels.push(label);
    }
  }
  target.labels.sort();
  return target;
}

/**
 * The evidence fields a receipt row carries about who spent it.
 *
 * Three outcomes, and the difference between the first two is the whole point:
 *  - `{}` — no request carried a resolvable key at all (a transcript-only
 *    session, or a provider with no wire join). The receipt says NOTHING about
 *    attribution rather than claiming it is unknown.
 *  - `{ profileLabel: null }` — requests DID carry keys and at least one did not
 *    resolve to a profile (or the session mixes profiles). Renders as the
 *    honest unattributed state.
 *  - `{ profileLabel: '<label>' }` — every keyed request resolved to one profile.
 */
export function attributionEvidence(session) {
  const attribution = session?.attribution;
  if (!attribution || !(Number(attribution.keyed) > 0)) return {};
  const labels = Array.isArray(attribution.labels) ? attribution.labels : [];
  if (Number(attribution.unresolved) > 0 || labels.length !== 1) return { profileLabel: null };
  return { profileLabel: labels[0] };
}
