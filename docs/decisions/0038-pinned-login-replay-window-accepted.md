# 0038 — Pinned login command: stale-copy replay window on 2.1.216-era CLIs accepted

- Date: 2026-08-29
- Links: issue #596 (public mirror #6), adversarial review of the #596 fix
- Status: ratified — Tim approved the merge path and this acceptance in
  session on 2026-08-29 (the #597-then-hardening decision)

The #596 fix pins the activation-flow login command with the profile env
pair. Within the app flow, activation flips `~/.claude` to the same profile
the env names, so the two cannot disagree. The accepted residual: a user who
copies the served command and replays it after a later account switch runs
env pinned to profile A against an active home of profile B. On affected
2.1.216-era builds (credential keyed to the resolved home, `.claude.json` to
the env) that splits identity into A and credential into B — and unlike the
pre-fix replay, the split lands inside managed profiles rather than the
default home.

Accepted rather than mitigated because: the population is affected-era or
version-undetectable CLIs only (current builds honor the env pair and stay
self-consistent); it requires the user to replay a stale command outside the
flow; and the verify identity-mismatch refusal remains the backstop before
anything is recorded. A cross-profile identity/credential agreement sweep
(the #65 blind-spot class) is the real mitigation and is out of this fix's
scope. Revisit if a field report shows a split-brain traced to a replayed
command.

The overclaim this record corrects: docs/CLAUDE_IDENTITY.md and the loginSpec
comment briefly said activation and the pin "cannot disagree" unqualified;
both now scope the claim to the in-flow case and cite this record.
