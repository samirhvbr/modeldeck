# Control-plane grilling — close record

_2026-08-17 (PDT) · Decider: Tim Harris · Grilling run per the team-workflow pack.
Three rounds, frontier emptied, shared understanding explicitly confirmed by the
decider. Every recommendation was **accepted as offered; none overridden.**_

**Evidence base:** [docs/research/quota-control-plane-verification.md](research/quota-control-plane-verification.md)
(capability audit + cited pain research, load-bearing citations spot-checked) ·
[docs/research/blume-sidecar-teardown.md](research/blume-sidecar-teardown.md) ·
two-seat external advisory round (grok-4.6, gpt-5.6-sol; artifacts at
`~/.advisory-board/runs/modeldeck-blume-strategy-2026-08-17/`).

## Settled decisions

1. **Quota line** — the shipped product never spends a user's subscription quota
   on its own operation; permanent. LLM analysis only ever on non-subscription
   engines (local model / user-supplied metered key), each future feature
   adjudicated when concrete and recorded then. V1 is zero-LLM. → standing record
   **[0032](decisions/0032-product-never-spends-subscription-quota.md)**.
2. **Identity** — receipts-first: "Your subscriptions, with receipts."
   Measurement/diagnosis/protection language; pool features framed as resilience;
   nothing marketed as limit-evasion; "control plane" vocabulary is earned
   post-#470, not claimed now.
3. **Audience** — single-account users first. The diagnostician leads; corpus
   grade (proxy-less; verified for BOTH providers) is the on-ramp; routing one's
   own account through the bundled proxy is the wire-grade upgrade; pool features
   are operator depth.
4. **1.0 boundary** — the closed full-app map stays closed; this entire arc is
   post-1.0. Derived (unasked because entailed by 2+3): **Receipts v1** =
   burn-pathology diagnostician + context-cost surfacing + exhaustion forecast +
   reset calendar, as the arc's first slice.
5. **Keys change** — approved **with riders**: per-profile client API keys
   (stock `api-keys` list, no fork) with key→profile resolved at ingest and only
   a profile **label** stored (the discard-hardening stands); retain the response
   `Request-Id` (one column; reopens the FINDINGS-336 transcript-join candidate);
   retain **parsed** provider rate-limit headers. Auth-adjacent: security lens +
   full review mandatory (never-compromise #3). Known blockers are ours: the
   shared Keychain helper (`service.mjs:144`) and the never-modify-existing-config
   rule (`ManagedProxyLive.swift`) need a consented write path for adopted installs.
6. **Retention** — `request_usage` bounded at ~13 months (~400 days) with a
   prune regression test; today's unbounded growth was an accident, now a policy.
7. **Provider scope** — Claude + Codex both in Receipts v1 (corpus grade
   verified for both: Claude transcripts and `codex_turns` per-turn token splits).
8. **Quarantine actuator** — parked behind #470's own adjudication. This arc
   ships detection + notification only; decision 0006's
   daemon-never-writes-auth-files tripwire stands untouched until #470 works the
   relaxation properly.
9. **Blume three (from the teardown's §11)** —
   (A) config audit → build as the **deterministic multi-profile linter**,
   sequenced after Receipts v1 inside this arc;
   (B) correction mining → **dead** (three independent kill votes); the
   deterministic failure-count promotion ("denied 14× this week — add a hook?")
   survives as a later candidate;
   (C) agent monitor → **proxy-native fleet pulse** only, operator tier, later in
   arc; no transcript-string status inference, ever.
10. **Teardown leftovers closed** — window model stays closed (no pinnable
    floating panel); no harness-breadth chase (no cursor/gemini/opencode parser
    estate; provider expansion is a separate facts-first question); and the
    standing doctrine → **[0034](decisions/0034-agent-state-reads-proxy-corpus-only.md)**:
    agent-state reads come from proxy/corpus data only, never live harness state
    DBs (the 2026-08-17 M1 15-minute deck freeze, made law).
11. **Grok/xAI third provider** — feasibility spike commissioned (three
    unknowns: xAI subscription-usage API; whether grok's session store carries
    per-turn tokens; upstream CLIProxyAPI xAI support/appetite). Ruling returns
    to the decider with facts; **not** in Receipts v1.

The arc frame (2, 3, 4, 7 + sequencing) is recorded as
**[0033](decisions/0033-receipts-arc-charter.md)**.

## Named follow-ups, with owners

- **Grok/xAI feasibility spike** — commissioned this session → `research`-skill
  lane (launched at close).
- **Stock CLIProxyAPI `plugins:` capability + upstream reporting-hooks appetite**
  — named, **not yet commissioned**; gates reserves and any hard burn-guard
  (decision 0002 names upstream-refusal as the fork-reopen trigger) → `research`.
- **#470 charter** (rebalancer into daemon; quarantine/canary as product face;
  0006 tripwire relaxation) → its own `decision-map` session when taken up.
- **Receipts v1 breakdown into tracker items** → `to-tickets`, at the decider's
  word; this session filed nothing by design.

## Process notes

- The consolidation-pass offer was **dispositioned by Tim later the same evening**:
  0015 folded into 0014 (the one true redundancy), size bound raised 30 → 40 in
  the binding. Store at 34 active records incl. 0035.
- Artifacts committed via PR #493 (this branch).

## Addendum — 2026-08-17, same evening

The commissioned Grok spike returned **all three grades clear** (usage-percent
endpoint exists; per-turn token splits richer than Claude/Codex in the session
store; xAI support already present in the pinned CLIProxyAPI, multi-account
included). Tim ruled: **add Grok/xAI as the third provider, corpus-first,
sequenced after Receipts v1** — v1 scope stays Claude+Codex. Record:
[0035](decisions/0035-grok-xai-third-provider.md); evidence:
[docs/research/grok-xai-feasibility-2026-08-17.md](research/grok-xai-feasibility-2026-08-17.md).
