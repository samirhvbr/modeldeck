# Blume Sidecar — competitive teardown and build-input findings

_Researched 2026-08-17 · Static teardown of the shipped macOS app, v1.0.66 · No live
run: the app was never executed, nothing was installed, no credential surface was
touched. Facts below come from reading the shipped bundle. Decisions are flagged as
open questions for the decider._

**Why this exists:** Tim found blume.codes via a paid X ad, recognized it as adjacent
to ModelDeck, and wants three of its capabilities built into ModelDeck. This document
is the input to that design work (grilling / decision map), not a plan.

---

## 0. TL;DR

Blume Sidecar is a **direct partial competitor** to ModelDeck built by a tiny,
six-week-old Norwegian company. It overlaps ModelDeck on provider usage tracking and
beats it on harness breadth; it does **not** do multi-account/pool management, which
remains ModelDeck's moat. Its genuine differentiation is an **"Improve" pipeline**
that mines your agent transcripts and audits your `CLAUDE.md`/`AGENTS.md`/skills/hooks
against a versioned catalog of context-engineering checks, then proposes apply-able
diffs.

The single most important thing this teardown produced is not the competitive read —
it is that **they shipped their own architecture specs and readable source inside the
app bundle.** We have their design documents. Three of them, covering exactly the
three features Tim wants.

**The one hard collision to resolve before building anything:** Blume's Improve
pipeline works by spending the user's own provider quota (`claude --print --model
opus` on your transcripts). ModelDeck's never-compromise rule #1 forbids exactly
that. That conflict is a decision for Tim, and it gates the whole feature set.

---

## 1. Provenance — what was examined and how to reproduce

| Item | Value |
| --- | --- |
| Version | 1.0.66, channel `stable`, `sourceSha` `005145f6f9a957a2a657188969f6138f82a6672d` |
| Download | `https://updates.blume-page.com/desktop/stable/download` (302 → the DMG) |
| DMG sha256 | `1b58e46924510f41b77f604a59987461401e0a6d5d417c8ae66a9f1b98fc4313` |
| Signature | `Developer ID Application: Blume AS (5YWNUNABHW)`, notarized, `spctl` accepted |
| Bundle id | `page.blume.sidecar` · min macOS 12.0 |
| Internal repo | `git+https://github.com/blumepage/sidecar-prototype.git` (private) |

Artifacts live at `~/blume-teardown/` (outside the repo — 176 MB DMG + 389 MB
extracted tree; do not commit). If deleted, recreate with:

```bash
curl -s https://updates.blume-page.com/desktop/stable/download-info
```

then download the DMG from the `url` field, `hdiutil attach -nobrowse -readonly`, copy
`Blume.app`, and `npx @electron/asar extract Blume.app/Contents/Resources/app.asar out`.
Before extracting, verify you have the SAME artifact this doc describes: sha256 must
match the table above and the bundle version must be 1.0.66 — the stable channel is
mutable, and a newer build is a different artifact whose findings may differ.

**Why the teardown was this productive:** it is an Electron app, and the `app.asar`
was shipped **unminified with internal design documents included** —
`plans/CONTEXT_ENGINEERING_AUDIT_V1.md`, `plans/SIGNAL_BASED_SUGGESTIONS_V1.md`, and
`plans/AGENT_RENDER.md`. These are as-built specs with decisions, deviations,
promotion thresholds, prompt contracts, and a v2 backlog. Copies are in
`~/blume-teardown/asar-out/plans/`.

_(Worth noting for our own release hygiene: the ModelDeck mirror-strip discipline in
`scripts/sync-mirror.sh` exists to prevent precisely this class of leak. Blume has no
such discipline.)_

---

## 2. Who they are

- **Legal:** Terms name *Blume Corporation*, Delaware (`2810 N Church St STE 89245,
  Wilmington, DE` — a registered-agent mail drop, not an office). The code signature
  says **Blume AS** — the Norwegian corporate form. Norwegian company, US holding
  wrapper.
- **People:** Only one name appears anywhere — **Olav Ljosland**, author of their blog
  posts, LinkedIn headline "making the world blume", previously co-founder of
  Modulize (Norwegian construction-tech). Other posts are bylined "Blume Team". Their
  LLM gateway hostname is `…agentic-cms-olav.workers.dev`, which is a personal
  Cloudflare account name — consistent with a solo or near-solo build.
- **Size / age:** Earliest blog post 2026-07-03 (six weeks old). No funding
  announcements, no team page, no Crunchbase entry. Version 1.0.66 in ~6 weeks implies
  rapid continuous release.
- **Money:** Free today. Terms: *"The Service is currently provided free of charge; we
  may introduce paid features in the future on notice."* They are running **paid X
  ads** for a free product — land-grab phase, monetization deferred.
- **Reach:** `better-auth` accounts, referral service (`referrals.blume-page.com`),
  feedback service, and a **remote control plane** (`agents.blume-codes.com`) that
  serves prompt/agent versions to installed clients. They can change analysis behavior
  server-side without shipping an update.

---

## 3. How it is built

Electron + React (react-router, Radix, Tailwind, lucide), `better-sqlite3` for local
storage, `electron-updater`, Sentry + PostHog + OpenTelemetry logs.

Architecturally the interesting parts:

- **Ports-and-adapters with two hosts.** All product logic lives in shared packages
  (`@blume/app-core`, `@blume/setup-model`, `@blume/storage-port`, …) behind a
  `SidecarHost` interface. There are **two implementations: Electron and a "Web
  Lab"** — a browser runtime that runs the same shared UI and core against adapters,
  used for testing. Their specs repeatedly say *"do not report parity until both
  surfaces agree."* This is a strong pattern and a direct analog of ModelDeck's
  Swift-shell / Node-data-plane split (#397).
- **Work runs in Electron `utilityProcess` workers**, never on main: a setup-scan
  worker, a conversation-refresh worker, an improve-agent worker, an analytics rollup
  worker. Their architecture test (`pnpm test:architecture`) enforces worker placement
  and "no shell logic" on main.
- **A native Rust sidecar binary** (`resources/harness-parser/harness-parser`, Mach-O
  arm64, ~1 MB) does all transcript parsing. Invoked as a CLI with
  `--harness --version --input`.
- **Local SQLite** with a migration ledger (they are at migration 27+). Tables include
  `conversations`, `events`, `conversation_transcript_{events,tool_calls,todos,todo_lists,user_turns}`,
  `projects`, `setup_artifacts`, `setup_versions`, `usage_snapshots`,
  `app_usage_intervals`, and the whole `improve_*` family (`improve_signals`,
  `improve_signal_clusters`, `improve_signal_cluster_members`, `improve_suggestions`,
  `improve_runs`, `improve_project_audits`, `improve_suggestion_feedback_events`).

**Window model — directly relevant to Tim's "full app, not a menu-bar item":**
Blume is a **real dock app** (no `LSUIElement` in Info.plist), not a menu-bar agent.
It has three window modes tracked in telemetry — `pinned_compact`, `pinned_expanded`,
`regular_expanded` — plus `setVisibleOnAllWorkspaces`, panel/floating behavior, and
vibrancy. So the product is a narrow always-on-top companion strip that can expand
into a full window and follows you across Spaces. That is a third option ModelDeck's
closed #402 decision did not consider: not menu-bar, not conventional window, but a
**pinnable floating panel**.

---

## 4. Feature 1 — live agent monitoring (`plans/AGENT_RENDER.md`)

**What it does:** shows every coding agent across every harness in two sections,
RUNNING and WAITING, with per-agent task-list progress, nested sub-agents, and
elapsed timers.

**How it actually works — the valuable part.** The Rust `harness-parser` reads
harness state straight off disk. Paths it knows:

```
~/.claude/projects/**/*.jsonl   ~/.claude/todos/   ~/.claude/tasks/   ~/.claude/statsig/
~/.codex/sessions/              ~/.cursor/projects/**/*.jsonl
~/.pi/agent/sessions/           ~/.omp/agent/sessions/
~/.local/share/opencode/{storage,sessions}/        ~/.gemini/
plus skills/, rules/, mcp config, metadata.json, terminal.log, screens/*.txt
```

Note the harness breadth: **claude, codex, cursor, opencode, gemini, pi, omp** —
against ModelDeck's claude + codex.

**Status inference is heuristic, and they wrote the heuristics down.** Statuses are
`running | needs-approval | finished | cancelled | failed | unknown`, derived from
signals including:

- `assistant-tool-use` → actively working; `assistant-final` → finished
- terminal evidence: the literal string `esc to interrupt` → active work
- `Claude is waiting for an AskUserQuestion response` → needs-approval
- `Claude background sub-agent is still running`
- approval phrasing: `do you want`, `approve`, `permission`, `allow command`
- explicit fallbacks labelled `no strong lifecycle signal`, `tool error evidence`

**Sub-agent detection:** `isSidechain`, `Task` tool_use blocks, `agentName`,
`cursor-subagent`, and strings like `Async agent launched successfully` /
`working in the background`.

**Version tolerance — the best idea in the parser.** It carries known harness
versions (e.g. Claude Code `2.1.170`, `2.1.173`, `2.1.217`) and resolves an incoming
transcript to a parser via a documented ladder:
`exact → patch_compatible → minor_compatible → family_fallback`, recording which
resolution was used and emitting structured `errors` / `provenance` per parse. That
is how you survive harnesses changing their on-disk format underneath you — a problem
ModelDeck already has with its own log ingest.

**Their UI spec is unusually complete** and includes reducer invariants they say to
write tests for: single-current-task (auto-demote the previous current — they call out
Cursor emitting two in-progress tasks during transitions), progress derived and never
stored, `firstMessage` written once, sub-agents never in `rootIds`, a waiting parent
keeps running sub-agents, failed agents render in WAITING with no separate section,
and resume-from-waiting must not duplicate the agent. If ModelDeck builds this, that
spec is worth reading in full before designing state.

---

## 5. Feature 2 — provider usage tracking (the overlap with ModelDeck)

Mechanically similar to what ModelDeck already does, single-identity:

- **Claude:** reads the OAuth token via `/usr/bin/security find-generic-password -s
  "Claude Code-credentials" -w`, falling back to `~/.claude/.credentials.json`; caches
  it in Electron `safeStorage`. Calls **`https://api.anthropic.com/api/oauth/usage`**
  directly from the client. Refresh URL `https://platform.claude.com/v1/oauth/token`.
- **Codex:** reads *and atomically writes* `~/.codex/auth.json` (it refreshes the
  token and writes it back); parses OpenAI claims from the JWT.
- **Cursor:** a user-pasted session cookie against `cursor.com/api/usage`,
  `/api/usage-summary`, `/api/auth/me`.

**A genuinely clever trick worth stealing.** Rather than refreshing Claude's OAuth
token itself, it makes the *real CLI* do it: it prepares a scratch directory
(`~/Library/Application Support/Blume/ClaudeProbe`) seeded with
`.claude/settings.local.json` = `{"disableDeepLinkRegistration":"disable"}`, then runs

```
/bin/zsh -lc 'printf "/status\n/exit\n" | /usr/bin/script -q /dev/null "$BLUME_CLAUDE_BIN"'
```

driving Claude Code through a pseudo-tty so Claude refreshes its own credential. It
locates the binary by asking the user's login shell (`command -v claude`), with
`BLUME_CLAUDE_BIN` / `CLAUDE_BIN` / `~/.n/bin` / `~/.local/bin` fallbacks. This is a
refresh strategy that never handles the refresh token — relevant to ModelDeck's
`#484`/renewal work, though note ModelDeck's constraint set is different because it
manages *many* pinned profiles.

**Critical competitive gap:** everything above is **single-identity per provider** —
one Keychain item, one `auth.json`, one cookie. There is no profile, account-pool,
or `CLAUDE_CONFIG_DIR` concept anywhere in the bundle. **Blume cannot do what
ModelDeck does.** Multi-account management, pool routing, rebalancing, and per-slot
Keychain landing remain uncontested.

---

## 6. Feature 3 — setup/config centralization

A scanner inventories every agent-config artifact across harnesses into
`setup_artifacts` + `setup_versions` (content, hash, delta history), at two scopes:
**global** (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, global skills) and
**project** (repo `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.cursor/rules/*.mdc`,
`.claude/skills/`, `.claude/settings.json`, `.codex/config.toml`, `.cursorrules`, …).

Two design decisions worth borrowing:

- **Content-hash triggering.** Everything downstream keys off a `setup_state_hash`
  over sorted `(scope, path, contentHash)` tuples, so re-scans are idempotent and work
  only happens when content actually changed. Their as-built notes record a real bug
  here worth avoiding: producers hashed *unfiltered* artifact sets while consumers
  hashed *filtered* ones, so the hashes never compared equal and "setup-changed" fired
  on **every** tick — fixed by unifying all producers through one hash function, with
  parity regression tests.
- **Global-as-project-overlay.** A user-global file participates in each project's
  hash and finding identity, so changing `~/.claude/CLAUDE.md` re-qualifies every
  affected project independently, and the planner is warned about cross-project blast
  radius and biased toward project-local fixes.

MCP inventory is deliberately **metadata-only** for privacy (no tool descriptions
parsed) — which they note blocks a check they wanted to write.

---

## 7. Feature 4 — the Improve pipeline (their real differentiation)

Two sources feed one pipeline.

### 7.1 Conversation-derived signals (`SIGNAL_BASED_SUGGESTIONS_V1.md`)

Stages, each persisted as an `improve_runs` row and streamed to the UI as progress:

```
queued → building-packet → extracting → retrieving → clustering → promoting → planning → done
```

1. **building-packet** — build a synthetic-filtered conversation packet plus capped
   read-only setup context; compute a `transcript_hash`; **dedupe**: skip if a
   completed run exists for `conversation_id + transcript_hash`.
2. **extracting** — LLM call #1 pulls *signals* (friction observed in **user turns** —
   corrections, re-explanations). Weak one-offs are stored too, not discarded.
3. **retrieving** — purely local candidate-cluster retrieval (≤25): exact key, shared
   command/path/code tokens, shared setup refs, lexical overlap, with project/scope/
   harness as boosts.
4. **clustering** — LLM call #2 assigns each signal to a cluster once; records
   duplicate-cluster candidates.
5. **promoting** — threshold evaluation. **A single conversation cannot promote** in
   normal operation (dev flag only) — the product philosophy is *"pain over best
   practice"*: it must recur before it becomes a suggestion.
6. **planning** — LLM call #3 per newly-promoted cluster authors the actual
   operations + patch previews + base hashes. Caps are **logged, never silent**.

**Apply is all-or-nothing with a base-hash check:** if the target file changed since
the suggestion was planned, it returns `needs_review` and **does not overwrite**.
Undo is supported. Their regression suite covers exactly this plus untrusted-JSON
extraction from harness output.

### 7.2 The context-engineering audit (`CONTEXT_ENGINEERING_AUDIT_V1.md`)

The strongest single idea in the product. A per-project agentic task audits your setup
files against a **declarative, versioned check registry**. Each check is a typed
object: `id`, `goal`, `lookFor`, `evidenceRequired`, `suggestedFix`, `signalKind`,
`defaultSeverity`, `harnessApplicability`, `sourceRefs`, `failExample`, `passExample`,
`notThis`. Rules: ids never reused, both examples mandatory, catalog render is
snapshot-tested so prompt drift shows up in review, and editing the catalog forces a
version bump + new agent version.

V1 catalog (10 checks): `ce-over-constraint`, `ce-redundant-repetition`,
`ce-progressive-disclosure`, `ce-derivable-content`, `ce-contradiction`,
`ce-skill-quality`, `ce-obsolete-practices`, `ce-missing-essentials`,
`ce-cursor-rule-scoping`, `ce-shared-rules-portability`.

V2 added 8 more, several of which are sharp: `ce-dead-setup-content` (guidance in
stripped HTML comments, broken `@imports`, plain `.md` in `.cursor/rules` which Cursor
ignores, codex chains past the 32 KiB `project_doc_max_bytes`, zero-byte AGENTS.md),
`ce-skill-invocation-safety` (deploy/publish skills lacking
`disable-model-invocation: true`; `allowed-tools` granting more than the body uses),
`ce-skill-listing-budget` (Claude ~1,536 chars/skill entry; codex ~8k total),
`ce-unenforced-invariants` (must-never rules with no hook/deny backing them),
`ce-skill-scope`, `ce-rules-file-parity`, `ce-plugin-adoption`, `ce-undiscoverable-docs`.

Every check cites dated sources — Anthropic's context-engineering and "Steering Claude
Code" posts, Claude/Codex/Cursor docs, Martin Fowler's site (Böckeler's harness-
engineering pieces), every.to, eugeneyan, latent.space — with a rule that **no check
may rest on a single vendor's blog post unless scoped to that vendor's harness**.

**Anti-nag machinery** (they name best-practice spam as the core product risk):
severity + corroboration promotion gates (high promotes alone; medium needs recurrence
or a corroborating conversation signal; low needs conversation-derived corroboration
reaching ≥0.5 of a normal threshold), a **1-active audit suggestion cap** inside a
3-suggestion budget, audit suggestions ranked *below* conversation-pain ones,
per-`(checkId, artifact)` suppression until the content hash changes (permanent if
applied), and *"declining a check is a successful outcome"* written into the prompt
contract. Findings require quoted evidence, and factual claims must be tool-verified
against the repo (the lockfile decides pnpm vs npm) before being recorded.

### 7.3 The planner rubric — the context-cost ladder

Worth reproducing nearly verbatim, because it is the reasoning ModelDeck would need
its own version of. Always-on context is *"paid on every turn of every session
forever. Most learnings do not deserve that."* Cheapest first:

1. **Hook** — zero model context. Deterministic automation on an event. Use when the
   guidance is mechanically enforceable.
2. **Doc / reference** — ~zero until opened. Facts the agent looks up, not procedures
   it performs.
3. **Skill** — name + description always on, body loads on trigger (progressive
   disclosure). Multi-step, situational procedures.
4. **Rule / memory** — always on, every turn. The most expensive. Reserve for short,
   universal invariants.

Default bias is **down** the ladder; prefer `update` over `create`; remove stale or
conflicting guidance; keep rule edits tiny. Mapping by signal kind: `permission` →
hook, `workflow` → skill, `domain` → doc, `command` → hook or a short AGENTS.md line,
`preference` → skill if situational, rule only if universal and short.

This guidance is injected **only** into the planning prompt and is explicitly never
installed into any analyzed project — authoring-time guidance for the generator, not a
runtime rule.

### 7.4 Where the analysis actually runs — and the cost model

Two providers, `processingProvider`:

- **`local-plans` (the default).** Spawns the user's own CLI:
  `claude --print --output-format text --model opus`, or
  `codex exec --color never --skip-git-repo-check --ignore-user-config --ignore-rules
  -m gpt-5-codex -`. Prompt via temp file to stdin, strict-JSON parsing tolerant of
  ```json fences, SIGTERM→SIGKILL timeout, and **the environment is scrubbed** of
  `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*COOKIE*`, and AWS creds before
  spawn. **This spends the user's own subscription quota, on Opus, per run.**
- **`cloud`.** A Blume-hosted Cloudflare Worker LLM gateway
  (`blume-llm-release-1-0-66-…workers.dev`), authorized by a short-lived per-install
  access token keyed to the release. Gated behind a **versioned consent**
  (`CLOUD_PROCESSING_CONSENT_VERSION`, `hasCurrentCloudProcessingConsent`) — re-consent
  is required when the version bumps. Not the default.

---

## 8. Privacy and security posture — what it touches

Stated fairly, because it matters both for evaluating them and for what we would
inherit if we copied the design:

**Reads:** the login Keychain (`Claude Code-credentials`), `~/.claude/.credentials.json`,
`~/.codex/auth.json` (also **writes** it), a Cursor session cookie, every harness
transcript on disk, and every agent-config file.

**Sends off-device:** provider usage calls go **directly to the provider**, not to
Blume — the OAuth token is never sent to Blume's servers. Telemetry (PostHog EU,
Sentry, OTLP) carries content-free aggregates by design: their spec commits to
per-`check_id` counts of found/promoted/suggested/applied/dismissed, where check ids
are product-defined constants, plus window-mode timing intervals. Setup file content
and transcript excerpts stay in local SQLite. The exception is the opt-in cloud
processing provider, which by definition sends analysis context to their gateway.

**Assessment:** not malware; the design is more privacy-conscious than most. But it
is unavoidably a broad-permission app — it reads your credentials store and every
transcript, executes your shell and your agent CLIs, and a **remote control plane can
change the prompts and agent versions it runs without an app update**. On Tim's
laptop specifically it would crawl ten accounts' profiles and poke a live Keychain
and running `claude` processes, which is why the live run was declined in favor of
this teardown. If a live run is ever wanted, it needs a **separate macOS user
account** (the login Keychain is per-user; a throwaway `$HOME` is not sufficient).

---

## 9. Competitive read

| Dimension | Blume | ModelDeck |
| --- | --- | --- |
| Multi-account / pool routing | **None** — single identity per provider | Core capability, uncontested |
| Harness breadth | 7 (claude, codex, cursor, opencode, gemini, pi, omp) | 2 (claude, codex) |
| Usage tracking | Yes, same provider endpoints | Yes, plus pool totals and attribution |
| Live agent monitoring | Yes, cross-harness, sub-agents, task lists | No |
| Config inventory + audit | Yes — their differentiation | No |
| Measured-truth capture (proxy in path) | No | Yes (tier 3) |
| Platform | macOS + Windows + Linux | macOS only (ruled at #405) |
| Maturity | 6 weeks, solo-ish, free, unmonetized | Older, narrower, 1.0-bound |

They are ahead on harness breadth and on the improve/audit layer; ModelDeck is ahead
on everything that requires managing more than one identity, and on measured truth.

---

## 10. What this suggests ModelDeck could build

Tim named three. Restating them with what the teardown adds, and what each collides
with. **These are inputs to a grilling, not recommendations to build as-is.**

### Idea A — Config/context audit ("your setup is wasting context / contradicts itself")
The highest-value and most differentiated. ModelDeck already inventories and manages
agent config across *many* accounts, which makes the multi-profile version of this
audit something Blume structurally cannot do (e.g. "these 7 Claude profiles have
drifted from each other", "this global rule contradicts that project's"). Their check
registry shape, severity/corroboration gates, and anti-nag budget are directly
adaptable.

### Idea B — Repeated-correction mining → skill/rule promotion
Depends on transcript analysis, which is where the quota collision lives (§11 Q1).
The context-cost ladder is the reusable IP-adjacent reasoning here. Note their key
restraint: recurrence across conversations is *required* before anything is proposed.

### Idea C — Live agent monitor in the app window
The most demo-able and least differentiated. `AGENT_RENDER.md` is effectively a free
spec, and the versioned-parser resolution ladder is the part worth copying. Biggest
risk is scope: this is a new real-time subsystem, and ModelDeck already has an
evidenced hazard here — per the 2026-08-17 M1 session, aggressive reads of codex state
DBs **contended with the daemon's own reads and froze the deck for 15 minutes**. A
transcript/state watcher must be designed against that.

---

## 11. Open questions for the decider

These are the questions a grilling or decision map should work. Ordered most-gating
first.

1. **Quota collision (gates everything).** Never-compromise #1 says no ModelDeck code
   spends provider quota. Blume's entire Improve pipeline is built on spending it —
   Opus calls per conversation, per run. Options that need adjudicating: (a) carve out
   an explicit, user-consented exception for user-initiated analysis; (b) route
   analysis to a cheap non-Anthropic model per conduct rule 13's dev/mechanical
   default; (c) ModelDeck-hosted inference (new cost centre + privacy surface we have
   never had); (d) deterministic, non-LLM checks only. Note (d) covers a real fraction
   of Blume's catalog — `ce-dead-setup-content`, `ce-skill-listing-budget`,
   `ce-skill-invocation-safety`, `ce-cursor-rule-scoping` are largely mechanical.
2. **Does any of this belong before 1.0?** The full-app decision map is **closed** and
   #405 defines the 1.0 label; this is new scope with no ticket. Post-1.0 by default
   unless Tim rules otherwise.
3. **Multi-profile semantics.** If the audit runs across N pinned profiles, what is
   the unit of a finding — per profile, per project, per account-pool? This is the
   differentiating design question and has no analog in Blume to copy.
4. **Mutation surface.** Applying suggestions means ModelDeck **writes to the user's
   `CLAUDE.md`/skills/hooks** — a class of action it has never taken. Base-hash +
   `needs_review` + undo is Blume's answer. Never-compromise #4 means any such feature
   ships with a tripwire. Does Tim want ModelDeck writing these files at all, or only
   proposing diffs the user applies elsewhere?
5. **Swift shell vs Node data plane.** #397 ruled Swift is the shell, Node is the data
   plane. A transcript parser, a check engine, and an agent monitor each have to land
   on one side. Blume's answer (native parser binary + JS core + shared UI) is one
   model; ModelDeck's split is already decided and should constrain this.
6. **Window model.** Blume's pinnable floating panel is a third option beyond
   #402's menu-bar-plus-window decision. Is that worth reopening, or is it settled?
7. **Harness breadth.** Blume covers 7 harnesses. Does ModelDeck's audit stay
   claude+codex, or is cursor coverage a wedge?
8. **Where does agent monitoring get its data** without repeating the M1 state-DB
   contention incident?

---

## 12. Reusable specifics (the shopping list)

Concrete things worth lifting, independent of which features get built:

- The **context-cost ladder** (§7.3) as the rubric for any guidance ModelDeck ever
  proposes.
- **Versioned parser resolution** — `exact → patch_compatible → minor_compatible →
  family_fallback`, with the resolution recorded per parse.
- **Content-hash triggering** plus their unify-all-hash-producers bug and its parity
  regression test.
- **Base-hash apply** with `needs_review` on drift, all-or-nothing, plus undo.
- **Anti-nag budget**: severity + corroboration promotion, N-active caps, suppression
  until content changes, "declining is success" in the prompt contract.
- **Declarative check registry** with mandatory fail/pass examples, `notThis`
  precision guards, snapshot-tested prompt rendering, and ids that are never reused.
- **Caps are logged, never silent** — matches ModelDeck's existing honesty discipline.
- **Env scrubbing before any spawn** (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
  `*COOKIE*`, AWS).
- Their **status-inference heuristics** for agent liveness (§4), which are otherwise
  expensive to rediscover.

## 13. Source map

| Finding | Where |
| --- | --- |
| Agent UI + reducer invariants | `~/blume-teardown/asar-out/plans/AGENT_RENDER.md` |
| Improve pipeline, apply safety, harness adapters | `plans/SIGNAL_BASED_SUGGESTIONS_V1.md` |
| Audit catalog, promotion, privacy boundary | `plans/CONTEXT_ENGINEERING_AUDIT_V1.md` |
| Keychain read, CLI-driven refresh, usage endpoints | `out/main/index.js` ~6168–6390 |
| LLM gateway + cloud consent | `out/main/index.js` ~8660–8700, ~10590 |
| Context-cost ladder text | `out/main/chunks/improveStageAgentPorts-*.js` |
| Harness paths + status heuristics | `strings resources/harness-parser/harness-parser` |
| Schema | `grep -rhoE 'CREATE TABLE[^(]*' out/main` |
