# Team workflow — repo bindings (partial)

<!-- Partial binding of the team-workflow pack (timharris707/skills): only the
     adversarial-review skill is bound so far, at Tim's direction (2026-08-07).
     A full pack setup interview has not run. Refresh via the pack's setup
     skill. Precedence rule promoted to its own section below. -->

_Pack version at binding: team-workflow v1.4.0 · Bound: 2026-08-07 · Last confirmed: 2026-08-08 (audit dispositions, skills#153)_

## The decider

- **Decider**: Tim Harris

## Precedence & exemptions

How the pack composes with this repo's resident rule systems. Resident rules
win unless an exemption below says otherwise.

- **ModelDeck's own machinery remains authoritative** for everything outside
  the bound adversarial-review skill: `docs/lane-routing-policy.md`, the
  hand-written lane briefs, and `docs/HANDOFF.md` outrank pack defaults
  wherever they speak (Tim, 2026-08-07; promoted from this doc's header at
  the 2026-08-08 audit).
- **Profile-scoped plugin availability**: the team-workflow pack is installed
  only via the `lend-management` Claude profile on Tim's machine — a session
  under any other profile gets no pack skills and no warning; this doc is the
  cross-profile record.

## Orchestration (pointers — ModelDeck's own machinery is authoritative)

- **Runner inventory & policy**: `docs/lane-routing-policy.md` — the routing
  rule (backend → codex CLI, frontend/UI/judgment → Claude/Fable lane), the
  reasoning-effort table (Tim, 2026-08-07), and the review-machinery tier
  table (Tim, 2026-08-08), including the no-silent-fallback and
  no-runner-inheritance rules.
- **Launcher**: `scripts/lane-codex.sh` (mandatory codex wrapper; a
  PreToolUse hook denies bare `codex exec`). Watch with
  `scripts/lane-watch.mjs`.
- **Announce model/effort**: on — `.claude/lane-logs/manifest.jsonl` is the
  authority on what a lane ACTUALLY ran (model + effort, launch/exit
  records, issue stamping); read actuals from it rather than trusting any
  doc. This recorded-actuals discipline is how the repo satisfies the pack's
  v1.4.0 announce rule.
- **Merge flow**: orchestrator-only merges after independent verification and
  CodeRabbit triage, per the orchestrate fork
  (`.claude/skills/orchestrate/SKILL.md`) and the routing policy's launch
  discipline.

## Adversarial review (team-workflow `adversarial-review` skill)

- **Defect-class file**: [docs/agents/defect-classes.md](defect-classes.md) —
  seeded empty; grows only via live reproduction, proposed in the fixing PR.
  The hand-written per-review attack briefs (`.claude/lane-briefs/`) remain the
  instrument for high-stakes release stacks; this skill is the everyday floor.
- **Layers**: floor + orchestrator close-out (this repo runs orchestrated lanes).
- **Mandatory lenses**: **security** on anything touching credentials, Keychain,
  auth/renewal, or spawned-session env (the #199/#224 auth-override gate class);
  **UI/accessibility** on deck-row presentation (explicit accessibility labels
  suppressing child elements has bitten in #65, #113, #272); **compatibility**
  on daemon↔UI protocol or persisted-state changes.
- **Live-probe policy**: probes may drive local daemon/tests; **never** run
  `claude -p` or anything that spends provider quota, never touch the live
  Keychain or a running session, placeholder identities only (standing rule
  from this repo's review briefs).
- **Substantiality rules**: changes touching auth, renewal, routing, or the
  shell-env writer are always substantial.

## Accepted drift (written by setup's audit mode)

<!-- Drift findings the decider accepted as this repo's recorded choice instead of updating
     the binding. The next audit reads this list and does not re-flag an entry here. -->

- 2026-08-08 · pack v1.4.0 — the four v1.4.0 skills (codebase-review,
  domain-memory, diagnose, implement) carry no binding sections — accepted:
  deliberately unbound while the binding stays partial; decider to confirm at
  next setup re-run.
- 2026-08-08 · pack v1.4.0 — `.claude/handoff.md` is committed, inverting the
  pack's untracked-by-design handoff contract — accepted: tracked on purpose
  in this repo; no future session should gitignore or untrack it.
