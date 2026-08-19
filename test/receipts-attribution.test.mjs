// Issue #524 — per-profile attribution on burn receipts (design §5 item 7).
//
// The named tripwires here exist because the failure they guard against is
// silent and plausible-looking: a receipt that says "claude-work" because the
// transcript sat in that profile's directory, while the request was actually
// paid for by a key ModelDeck could not resolve. Attribution that guesses is
// worse than no attribution, so the unresolved state has to survive every hop
// from the column to the pixel.
//
// Safety: in-memory stores and canned findings only. No daemon, no proxy, no
// live port, no Keychain, no provider call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import { bootPage, waitFor } from '../dashboard/test-support/index.mjs';
import {
  attributionEvidence,
  emptyAttribution,
  mergeAttribution,
  noteAttribution,
  readDiagnosticCorpus,
} from '../src/diagnostician.mjs';
import { RETRY_STORM, retryStormDetector } from '../src/rate-pathologies.mjs';

const DETECTED_AT = '2026-08-17T23:00:00.000Z';

function receiptFinding(sessions) {
  return {
    id: 'finding-attribution-placeholder',
    scopeKey: 'attribution-placeholder',
    corpusFingerprint: 'attribution-corpus-placeholder',
    evidence: {
      affectedSessions: sessions.length,
      tokensBurned: 30_000,
      fix: 'wait for the rate-limit window instead of retrying immediately',
      sessions: sessions.map((session, index) => ({
        provider: 'claude',
        profileSlug: 'claude-profile-placeholder',
        sessionId: `attribution-session-placeholder-${index}`,
        requestCount: 3,
        firstAt: '2026-08-17T20:05:02.000Z',
        lastAt: '2026-08-17T20:05:06.000Z',
        medianCadenceSeconds: 2,
        tokensBurned: 30_000,
        uncachedInputTokens: 3_000,
        cacheReadTokens: 27_000,
        signalGrade: 'wire',
        rateLimitFailures: 3,
        ...session,
      })),
    },
  };
}

async function openReceipt(t, store, port) {
  const app = createApp({
    store,
    service: { projectsRoot: '/workspace/placeholder' },
    host: '127.0.0.1',
    port,
    mutationToken: 'attribution-dashboard-token-placeholder',
  });
  const dom = bootPage(DASHBOARD_APP_HTML, app, { host: `127.0.0.1:${port}` });
  t.after(() => dom.window.close());
  const page = dom.window.document;
  await waitFor(() => page.querySelector('.finding-row'), 'the finding row to render', { timeoutMs: 1_500 });
  page.querySelector('.finding-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => page.querySelector('.finding-receipt'), 'the receipt to open');
  return page;
}

/**
 * TRIPWIRE #524 unresolved-attribution-is-never-guessed.
 *
 * If this test is relaxed, a receipt can name a profile that did not pay for
 * the request — the exact mis-attribution design §3.6 forbids, and the reason
 * the ingest column is nullable in the first place.
 */
test('TRIPWIRE: an unresolved profile label stays unresolved, and absence is not doubt', () => {
  assert.deepEqual(
    attributionEvidence({ attribution: { keyed: 0, unresolved: 0, labels: [] } }),
    {},
    'a session with no keyed request says nothing about attribution',
  );
  assert.deepEqual(attributionEvidence({}), {}, 'a session with no attribution evidence says nothing');
  assert.deepEqual(
    attributionEvidence({ attribution: { keyed: 3, unresolved: 0, labels: ['placeholder-work'] } }),
    { profileLabel: 'placeholder-work' },
  );
  assert.deepEqual(
    attributionEvidence({ attribution: { keyed: 3, unresolved: 1, labels: ['placeholder-work'] } }),
    { profileLabel: null },
    'one unresolved request is enough to refuse to name the profile',
  );
  assert.deepEqual(
    attributionEvidence({ attribution: { keyed: 2, unresolved: 0, labels: ['placeholder-a', 'placeholder-b'] } }),
    { profileLabel: null },
    'a session spanning two profiles names neither',
  );

  // A NULL, an empty string, and a non-string all mean the same thing: the key
  // did not resolve.
  for (const value of [null, undefined, '', 7, {}]) {
    assert.deepEqual(
      attributionEvidence({ attribution: noteAttribution(emptyAttribution(), value) }),
      { profileLabel: null },
      `${JSON.stringify(value) ?? 'undefined'} is not a profile label`,
    );
  }

  const merged = mergeAttribution(
    noteAttribution(emptyAttribution(), 'placeholder-work'),
    noteAttribution(emptyAttribution(), null),
  );
  assert.deepEqual(attributionEvidence({ attribution: merged }), { profileLabel: null },
    'folding an agent stream in cannot launder its unresolved requests');
});

test('a wire-failure receipt carries the ingested label, and NULL when the key did not resolve', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const baselineAt = Date.parse('2026-08-17T20:00:00.000Z');
  const sessionId = 'attribution-corpus-session-placeholder';
  store.ingestTranscriptBatch({
    sessions: [{
      sessionId,
      profileSlug: 'claude-profile-placeholder',
      machine: 'machine-placeholder',
      cwd: '/workspace/placeholder',
      firstAt: new Date(baselineAt).toISOString(),
      lastAt: new Date(baselineAt + 300_000).toISOString(),
    }],
    requests: Array.from({ length: 8 }, (_unused, index) => {
      const at = new Date(baselineAt + index * 60_000).toISOString();
      return {
        dedupeKey: `${sessionId}:${index}`,
        requestId: null,
        sessionId,
        profileSlug: 'claude-profile-placeholder',
        messageId: `message-placeholder-${index}`,
        recordUuid: null,
        model: 'claude-placeholder',
        effort: null,
        observedAt: at,
        inputTokens: 1_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 9_000,
        outputTokens: 2_000,
        cacheCreationEphemeral5mInputTokens: 0,
        cacheCreationEphemeral1hInputTokens: 0,
        isSidechain: false,
        agentId: null,
      };
    }),
  });
  const wireFailure = (index, seconds, profileLabel) => ({
    requestId: `attribution-wire-placeholder-${index}`,
    machine: 'machine-placeholder',
    observedAt: new Date(baselineAt + 300_000 + seconds * 1_000).toISOString(),
    source: 'identity-placeholder@example.invalid',
    provider: 'claude',
    model: 'claude-placeholder',
    alias: null,
    reasoningEffort: null,
    endpoint: '/v1/messages',
    userAgentClass: 'claude-code',
    profileLabel,
    failed: true,
    statusCode: 429,
    latencyMs: 10,
    ttftMs: null,
    inputUncached: 1_000,
    inputCacheRead: 9_000,
    inputCacheWrite: 0,
    outputTotal: 0,
    outputReasoning: 0,
    total: 10_000,
  });

  store.ingestRequestUsage([
    wireFailure(0, 2, 'placeholder-work'),
    wireFailure(1, 4, 'placeholder-work'),
    wireFailure(2, 6, 'placeholder-work'),
  ]);
  let corpus = await readDiagnosticCorpus(store, { logger() {} });
  let [finding] = retryStormDetector.detect(corpus);
  assert.equal(finding.evidence.sessions[0].profileLabel, 'placeholder-work',
    'the label written at ingest reaches the receipt');

  // One more failure from a key that resolved to nothing — the legacy shared
  // key every migrated shell keeps sending (design §2.5) — and the session can
  // no longer name one profile.
  store.ingestRequestUsage([wireFailure(3, 8, null)]);
  corpus = await readDiagnosticCorpus(store, { logger() {} });
  [finding] = retryStormDetector.detect(corpus);
  assert.equal(finding.evidence.sessions[0].profileLabel, null);
  assert.notEqual(finding.evidence.sessions[0].profileSlug, null,
    'the transcript slug is still there — and is still not used as the label');
});

/**
 * TRIPWIRE #524 unattributed-receipt-states-itself.
 *
 * The unattributed state must be readable, not inferable from a missing chip,
 * and its explanation must reach a screen reader — a `title` attribute alone
 * never does (the rule PR #433 set for this codebase).
 */
test('TRIPWIRE: the receipt renders attribution honestly, and says so out loud', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.syncFindings(RETRY_STORM, [receiptFinding([
    { profileLabel: 'placeholder-work' },
    { profileLabel: null },
    {},
  ])], { detectedAt: DETECTED_AT });
  const page = await openReceipt(t, store, 43571);

  const rows = [...page.querySelectorAll('.finding-session')];
  assert.equal(rows.length, 3);

  const attributed = rows[0].querySelector('.finding-attribution');
  assert.ok(attributed, 'a resolved receipt names its profile');
  assert.match(attributed.textContent, /placeholder-work/);
  assert.ok(!attributed.classList.contains('unattributed'));
  assert.match(
    attributed.querySelector('.sr-only').textContent,
    /matched from the client key on the request/,
    'the explanation is spoken, not only hovered',
  );

  const unattributed = rows[1].querySelector('.finding-attribution');
  assert.ok(unattributed, 'an unresolved receipt states the fact in place');
  assert.ok(unattributed.classList.contains('unattributed'));
  assert.match(unattributed.textContent, /Unattributed/,
    'the word carries the state — never the colour alone');
  assert.match(
    unattributed.querySelector('.sr-only').textContent,
    /could not match to a profile, so no profile is named/,
  );
  assert.doesNotMatch(unattributed.textContent, /claude-profile-placeholder/,
    'the transcript profile slug is never borrowed to fill the gap');

  assert.equal(rows[2].querySelector('.finding-attribution'), null,
    'a receipt with no key-level evidence claims nothing either way');

  // The attribution chip is evidence, not a control: it must not be focusable
  // and must not be the only way to read anything.
  assert.equal(page.querySelectorAll('.finding-attribution button').length, 0);
  assert.equal(page.querySelectorAll('.finding-attribution [tabindex]').length, 0);
});
