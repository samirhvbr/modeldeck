# 0031 — Anthropic-model use is ask-first; recorded authorization satisfies the ask

- Date: 2026-08-15
- Links: #376 (grilling close-record), shared conduct rule 13, team-workflow.md pointer (2da1f01)

Putting work on an Anthropic model — product callers, dev/test runs, agent spawns;
quota or API-billed alike — needs Tim's OK. A *recorded* standing authorization
(docs/lane-routing-policy.md, a Tim ruling on an issue or decision record) IS that OK
until revoked; the model Tim picks at session launch covers the session and everything
inheriting it, and only upgrades beyond it ask. Dev/mechanical work defaults to the
cheapest capable non-Anthropic model. Unrecorded surface = novel = ask, then record.
Enforcement is instruction-only. Normative text lives in ~/.claude-shared/agent-conduct.md
rule 13 (all profiles, mirrored to ~/.codex/AGENTS.md); this record is the repo-side
anchor so the question is never re-negotiated here again.
