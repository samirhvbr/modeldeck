# Team workflow — repo bindings

<!-- Seeded by the team-workflow pack's setup skill. This doc is the single place the
     pack's skills read repo-specific facts from; keep it current via a setup re-run
     (idempotent refresh), not hand-drift. Full binding as of 2026-08-14 — the partial
     (adversarial-review-only) binding of 2026-08-07 was upgraded at Tim's direction
     in the setup re-run interview. -->

_Pack version: team-workflow v1.5.2 · First bound: 2026-08-07 (partial) · Full binding + last confirmed: 2026-08-14 (setup re-run interview, Tim)_

## Tracker binding

- **Tracker**: GitHub Issues on `timharris707/modeldeck-private`
- **Claim recipe**: the pack's tracker-discipline recipes as written, `--repo timharris707/modeldeck-private` on every command
- **Frontier query**: `gh issue list --repo timharris707/modeldeck-private --label 1.0-build --state open`
- **Blocking**: native dependency edges (as wired on the nine-slice 1.0 board, #378) — the repo does not use a `blocked` label
- **Label vocabulary**: mapped onto the repo's own labels, nothing created (Tim, 2026-08-14): `1.0-build` is the frontier/ready label for the current milestone; `gate-decision` and `bug` map directly; the pack's state labels (`needs-triage`, `ready-for-agent`, `ready-for-human`, `blocked`) and `slice`/`process` are deliberately not created — the lane-routing machinery and dependency edges carry that state instead
- **Implicit-repo check**: match — `gh repo view` resolves to `timharris707/modeldeck-private` in this clone (checked 2026-08-14). Note the public mirror `timharris707/modeldeck` (releases) is a different repo; never run tracker recipes against it.

## Verify commands

Confirmed by Tim, 2026-08-14. "Verified" in this repo means:

```bash
npm test                              # node --test suite (repo root)
npm run test:cliproxyapi-pin          # pin-compat suite + live-evidence verify
swift test                            # run from macos/ModelDeckMac
npm run release:check                 # release stacks only
```

## The decider

- **Decider**: Tim Harris (confirmed 2026-08-14)

Every pack skill says "the decider"; this line is where the role resolves. Sessions brief decisions with recommendations and evidence; the decider answers them on the record.

## Docs home

- **Binding doc home**: `docs/agents/team-workflow.md` (this file; confirmed 2026-08-14)
- **Decision maps**: `docs/<scope>-decision-map.md` (e.g. `docs/full-app-1.0-decision-map.md`)
- **Research findings**: `docs/research/`
- **Domain/context docs agents should load**: `docs/lane-routing-policy.md` (orchestration), `.claude/handoff.md` (session state — tracked in this repo by design, see Accepted drift)
- **Anthropic-model use is ask-first** per shared conduct rule 13 (`~/.claude-shared/agent-conduct.md`, Tim-confirmed 2026-08-15, modeldeck#376): recorded standing authorizations satisfy the ask — in this repo that is `docs/lane-routing-policy.md` and Tim rulings recorded on issues/decision records; anything not recorded asks first, and dev/mechanical work defaults to the cheapest capable non-Anthropic model

## Precedence & exemptions

How the pack composes with this repo's resident rule systems. Resident rules
win unless an exemption below says otherwise.

- **ModelDeck's own orchestration machinery remains authoritative**:
  `docs/lane-routing-policy.md`, the orchestrate fork
  (`.claude/skills/orchestrate/SKILL.md`), the hand-written lane briefs, and
  `docs/HANDOFF.md` outrank pack defaults wherever they speak (Tim,
  2026-08-07; scope reconfirmed at the 2026-08-14 full binding — the full
  binding adds pack skills where the resident machinery is silent, it does
  not displace it).
- **Prototype test-exemption**: code on `prototype/<name>` branches is exempt
  from test-first / coverage rules — prototype branches are throwaway by
  contract and never merge; the exemption ends the moment the winner's real
  implementation starts.
- **Plugin availability**: the pack is enabled via the repo-tracked
  `.claude/settings.json` (`enabledPlugins`), so every profile on this
  machine gets it in this repo. (Supersedes the 2026-08-07 note that the
  pack was reachable only via the `lend-management` profile — stale as of
  the settings commit that moved `enabledPlugins` into the repo.)

## Templates

- Issue/work-item spec: adopted — the repo's own `.github/ISSUE_TEMPLATE/` plus the house issue-as-spec style used on the 1.0 board; pack `issue-slice-spec` seeding declined (Tim, 2026-08-14)
- Lane brief: adopted — hand-written briefs in `.claude/lane-briefs/` per the lane-routing policy

## Handoff

- **Handoff location**: `.claude/handoff.md` — **tracked on purpose** (accepted drift, 2026-08-08; stands)
- **Ignore entry**: declined — inverted by design, never gitignore or untrack the handoff
- **Session-start auto-load hook**: already satisfied outside repo settings — handoff auto-load fires at session start via profile-level wiring (verified live 2026-08-14); no repo-settings hook seeded

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

## Codebase review (team-workflow `codebase-review` skill)

Bound 2026-08-14 (full-binding re-run).

- **Report destination**: one tracker issue created per run on `timharris707/modeldeck-private`, closed at disposition
- **Lane-count threshold (N)**: 10 merged lanes since the last review (≈ once per wave-cycle at current cadence)
- **Rejection memory**: the domain-memory home below — rejections land as decision records in `docs/decisions/`, one store, never two. No prior rejection-memory path existed; nothing to migrate.
- **Executor mechanics**: launched as a read-only lane via the repo's lane machinery per `docs/lane-routing-policy.md`

## Domain memory (team-workflow `domain-memory` skill)

Bound 2026-08-14 (full-binding re-run).

- **Memory home**: `docs/decisions/` + `docs/terms.md` (created on first record — nothing pre-seeded)
- **Size bound**: 30 records — past it, sessions offer a consolidation pass, dispositioned by the decider, never run unprompted
- **Backfill**: requested on 2026-08-14 (Tim, setup re-run) — the one-time lane drafting decision records from closed PRs/issues/handoffs for card-by-card disposition; not yet run

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
  announce rule.
- **Merge flow**: orchestrator-only merges after independent verification and
  CodeRabbit triage, per the orchestrate fork
  (`.claude/skills/orchestrate/SKILL.md`) and the routing policy's launch
  discipline.

## Glossary & non-negotiables (dispositions)

- **Never-compromise list**: accepted, all four harvested items (Tim, 2026-08-14) — written into the repo `CLAUDE.md` (no quota spend · destructive usage-queue read · auth always substantial · regression tripwire).
- **Domain glossary**: declined for now (Tim, 2026-08-14) — revisit at next setup re-run; when taken up it routes through the domain-memory terms file, with a pointer (not a second glossary) in `CLAUDE.md`.
- **Session-scope conduct pointer**: accepted (Tim, 2026-08-14) — written into the repo `CLAUDE.md` (read the pack's pr-writing reference before writing any PR description or comment).

## Accepted drift (written by setup's audit mode)

<!-- Drift findings the decider accepted as this repo's recorded choice instead of updating
     the binding. The next audit reads this list and does not re-flag an entry here. -->

- 2026-08-08 · pack v1.4.0 — the four v1.4.0 skills (codebase-review,
  domain-memory, diagnose, implement) carry no binding sections — **resolved
  2026-08-14**: full binding confirmed at the setup re-run; sections above.
- 2026-08-08 · pack v1.4.0 — `.claude/handoff.md` is committed, inverting the
  pack's untracked-by-design handoff contract — accepted: tracked on purpose
  in this repo; no future session should gitignore or untrack it.
