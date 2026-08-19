import React, { useState } from 'react';
import { formatClock, formatPercent, formatTokens, plural } from './format.js';

const PATHOLOGY_LABELS = {
  'cold-cache-churn': 'Cold-cache churn',
  'context-bloat': 'Context bloat',
};
const SESSION_RECEIPT_LIMIT = 20;

function pathologyLabel(kind) {
  if (PATHOLOGY_LABELS[kind]) return PATHOLOGY_LABELS[kind];
  const words = String(kind || 'Finding').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function providerLabel(provider) {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return String(provider || 'Unknown');
}

// Issue #524 (design §2.2) — who spent it, on the receipt.
//
// `profileLabel` is the ingest-time resolution of the request's client key to a
// ModelDeck profile. Three states, and the difference between the first two is
// the whole feature:
//   - the field is ABSENT: this receipt has no key-level evidence at all
//     (transcript-only session). It says nothing rather than inventing a doubt.
//   - the field is null: requests DID carry keys and at least one did not
//     resolve — the legacy shared key, an unknown key, or a session spanning
//     profiles. It renders as "Unattributed" and is never filled in from the
//     transcript's profile slug sitting right next to it.
//   - the field is a label: every keyed request resolved to that one profile.
export const UNATTRIBUTED_LABEL = 'Unattributed';
export const UNATTRIBUTED_EXPLANATION = 'Unattributed: these requests carried a key ModelDeck could not match to a profile, so no profile is named.';
export function attributionExplanation(label) {
  return `Spent by ${label}, matched from the client key on the request.`;
}

/** The chip's state, or null when the receipt carries no attribution evidence. */
export function attributionState(session) {
  if (!session || !Object.hasOwn(session, 'profileLabel')) return null;
  const label = session.profileLabel;
  if (typeof label !== 'string' || label === '') {
    return { attributed: false, text: UNATTRIBUTED_LABEL, explanation: UNATTRIBUTED_EXPLANATION };
  }
  return { attributed: true, text: label, explanation: attributionExplanation(label) };
}

function cadenceLabel(seconds) {
  const minutes = Number(seconds || 0) / 60;
  return (Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)) + ' min cadence';
}

export default function Findings({ findings = [], unavailable = false }) {
  const active = findings.filter((finding) => finding?.active !== false);
  const [expanded, setExpanded] = useState(null);
  const [showAll, setShowAll] = useState(null);
  if (unavailable) {
    return (
      <section className="card findings-card" aria-label="Burn receipts">
        <div className="card-head findings-head">
          <h2 className="card-title">Burn receipts</h2>
          <span className="card-note finding-error" role="status">Burn receipts unavailable</span>
        </div>
      </section>
    );
  }
  if (!active.length) return null;

  return (
    <section className="card findings-card" aria-label="Burn receipts">
      <div className="card-head findings-head">
        <h2 className="card-title">Burn receipts</h2>
        <span className="card-note">measured from ingested receipts</span>
      </div>
      <div className="findings-list">
        {active.map((finding) => {
          const evidence = finding.evidence || {};
          const sessions = Array.isArray(evidence.sessions)
            ? evidence.sessions.filter((session) => (
              session && typeof session === 'object' && !Array.isArray(session)
            ))
            : [];
          const count = Number(evidence.affectedSessions ?? sessions.length) || 0;
          const excess = Number(evidence.estimatedExcessUncachedTokens) || 0;
          const hasBurnedTokens = Object.hasOwn(evidence, 'tokensBurned');
          const burned = Number(evidence.tokensBurned) || 0;
          const contextBloat = finding.pathologyKind === 'context-bloat';
          const averageInput = Number(evidence.avgInputTokens) || 0;
          const inputTokens = Number(evidence.inputTokens) || 0;
          const providerWeekInput = Number(evidence.providerWeekInputTokens) || 0;
          const multiplier = evidence.longContextMultiplier;
          const open = expanded === finding.id;
          const allVisible = showAll === finding.id;
          const visibleSessions = allVisible ? sessions : sessions.slice(0, SESSION_RECEIPT_LIMIT);
          const hiddenSessions = sessions.length - visibleSessions.length;
          const receiptId = `finding-receipt-${finding.id}`;
          return (
            <div className="finding" key={finding.id}>
              <button
                type="button"
                className="finding-row"
                aria-expanded={open}
                aria-controls={open ? receiptId : undefined}
                onClick={() => {
                  setExpanded(open ? null : finding.id);
                  if (open) setShowAll(null);
                }}
              >
                <span className="finding-name">{pathologyLabel(finding.pathologyKind)}</span>
                <span className="finding-summary">
                  {plural(count, 'session')}
                  {hasBurnedTokens
                    ? ` · ${formatTokens(burned)} burned`
                    : contextBloat
                      ? ` · ${formatTokens(averageInput)} avg input · ${formatPercent(inputTokens, providerWeekInput)} of measured week`
                      : (excess > 0 ? ` · ${formatTokens(excess)} excess uncached` : '')}
                </span>
                <span className="finding-chevron" aria-hidden>{open ? '⌄' : '›'}</span>
              </button>
              {open ? (
                <div className="finding-receipt" id={receiptId}>
                  {evidence.fix ? <p className="finding-fix">{evidence.fix}</p> : null}
                  {contextBloat && evidence.basis ? <p>{evidence.basis}</p> : null}
                  {contextBloat && multiplier ? (
                    <p className="finding-multiplier">
                      {plural(multiplier.turnCount, 'turn')} above {formatTokens(multiplier.thresholdInputTokens)} input
                      {' · '}whole request billed at {multiplier.inputMultiplier}× input / {multiplier.outputMultiplier}× output
                    </p>
                  ) : null}
                  <div className="finding-sessions">
                    {visibleSessions.map((session, index) => {
                      const rateReceipt = Object.hasOwn(session, 'tokensBurned');
                      const attribution = attributionState(session);
                      return (
                        <div
                          className="finding-session"
                          key={`${session.provider}:${session.profileSlug}:${session.sessionId}:${session.agentId || ''}:${index}`}
                        >
                          <span
                            className="finding-session-name"
                            title={`${providerLabel(session.provider)} · ${session.profileSlug || 'unknown profile'} · ${session.sessionId || 'unknown session'}${session.agentId ? ` · agent ${session.agentId}` : ''}`}
                          >
                            <strong>{providerLabel(session.provider)}</strong>
                            {' · '}{session.profileSlug || 'unknown profile'}
                            {' · '}{session.sessionId || 'unknown session'}
                            {session.agentId ? ` · agent ${session.agentId}` : ''}
                          </span>
                          {attribution ? (
                            // The word carries the state, never the colour
                            // alone; the sr-only sentence is the whole
                            // explanation, because a title attribute never
                            // reaches VoiceOver.
                            <span
                              className={attribution.attributed
                                ? 'finding-attribution'
                                : 'finding-attribution unattributed'}
                              title={attribution.explanation}
                            >
                              {attribution.text}
                              <span className="sr-only">{' — ' + attribution.explanation}</span>
                            </span>
                          ) : null}
                          <span className="finding-session-evidence">
                            {rateReceipt ? (
                              <>
                                <time dateTime={session.firstAt}>{formatClock(session.firstAt)}</time>
                                {' – '}
                                <time dateTime={session.lastAt}>{formatClock(session.lastAt)}</time>
                                {' · '}{formatTokens(session.tokensBurned)} burned
                              </>
                            ) : contextBloat ? (
                              <>
                                {plural(session.turnCount, 'turn')}
                                {' · '}{formatTokens(session.avgInputTokens)} avg input
                                {' · '}{formatTokens(session.inputTokens)} input
                                {' · '}{formatPercent(session.inputTokens, providerWeekInput)} of measured week
                              </>
                            ) : (
                              <>
                                {cadenceLabel(session.medianCadenceSeconds)}
                                {' · '}{formatTokens(session.uncachedInputTokens)} uncached
                                {' · '}{formatTokens(session.cacheReadTokens)} cache reads
                                {' · '}{formatTokens(session.estimatedExcessUncachedTokens)} excess
                              </>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {hiddenSessions > 0 ? (
                      <button
                        type="button"
                        className="finding-show-more"
                        onClick={() => setShowAll(finding.id)}
                      >
                        Show {plural(hiddenSessions, 'more session')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
