# Grilling record — usage analytics reporting — 2026-08-09

Decider: Tim Harris. Session: usage-analytics research + grilling (orchestrator session,
2026-08-09). Confirmed by Tim in-session. This record is the plan source for any
spec/tickets filed later; no build work is authorized by this document itself.

## Problem and scope

Tim burns through Claude subscription windows faster than he can explain — seven Claude
Max accounts "barely keeping head above water" while three Codex accounts never exhaust.
Wanted: clean, trustworthy, multi-dimensional usage reporting (account, project, task,
model, reasoning effort, skill) he can explore from any direction. **Scope of this
grilling: the reporting/monitoring layer only.** Usage-management actions (what to change
about workflows/policies) are phase 2, a separate effort after the reporting exists.

Inspiration/contrast: Theo's T3 Code usage page (built on ccusage) — good transcript-
parsing plumbing, but no per-account, per-project, per-task, per-effort, or per-skill
dimensions. Research (3-lane sweep this session) found no tool on the market covers those
dimensions; Claude Code's OTEL telemetry natively emits skill.name/effort/agent
attribution that no tool consumes; ModelDeck is uniquely positioned because only it knows
which account ran which session.

## Settled decisions (13)

1. **Scope** — reporting only; management is phase 2. *(Framing: Tim's; agreed.)*
2. **Primary lens: quota-first** — every view denominated in % of each account's real
   windows (5-hour / weekly / model-weekly). Provider utilization numbers are ground
   truth; token counts and counterfactual API-rate dollars are secondary detail.
   *(Recommended; accepted.)*
3. **Warehouse home: ModelDeck daemon** — new table family in the daemon's SQLite (or a
   sibling DB it owns); ingesters run under the daemon. *(Recommended; accepted.)*
4. **Usage queue: daemon takes over** as the sole CLIProxyAPI usage-queue consumer
   (queue drains on read — exactly one consumer). Scrubs secrets on ingest; retires
   poll-usage.sh and its launchd agent in the same change. *(Recommended; accepted.)*
5. **OTEL: on, all seven profiles, immediately** — exporters pointed at a local-only
   collector owned by the warehouse; nothing leaves the machine. Fills the Claude-side
   effort gap (transcripts record no effort) and gives exact per-skill/per-subagent
   attribution going forward. *(Recommended; accepted.)*
6. **Surface: local web dashboard** served by the daemon (interactive filters and
   drill-downs); Mac app links to it; native SwiftUI view possibly later.
   *(Recommended; accepted.)*
7. **Machines: this Mac only for v1**; schema carries a machine column from day one so
   the Mac Mini can merge later. *(Recommended; accepted.)*
8. **Task attribution: derivable-now** — session × project (cwd/gitBranch) × session
   title × lane-manifest issue, plus the requestId↔transcript join (proxy `request_id` ↔
   JSONL `requestId` — exactness to be verified in build). Explicit launch-time task
   stamping is v2, driven by where ambiguity actually hurts. *(Recommended; accepted.)*
9. **Backfill: everything available** — full Claude transcript corpus (2.4 GB, to
   mid-June), Codex rollouts + archived sessions (~10 GB), scrubbed proxy archive
   (2026-07-30 →), and the ~99k usage_snapshots rows. *(Recommended; accepted.)*
10. **V1 views: five** — (a) account headroom (window history per account, provider
    numbers), (b) project burn, (c) model × effort, (d) session/task explorer (session
    leaderboard with subagent tree, skills, context-size trend, lane issue),
    (e) burn timeline — calendar bar chart with hour/day granularity toggle plus an
    hour-of-day histogram, filterable by account/provider/model.
    *(Views a–c recommended and accepted; d and e added/promoted into v1 by Tim —
    recommendation to defer them overridden.)*
11. **Runway: retrospective only in v1** — forecasting ("window exhausts in ~N hours")
    is v2; the deck's Availability Health keeps owning "can I start now".
    *(Recommended; accepted.)*
12. **Ship track: feature-flagged on the normal release train** — PRs, CodeRabbit,
    versioned releases; dashboard behind a default-off setting until Tim declares it
    user-ready. *(Recommended; accepted.)*
13. **Estimates policy: show both, label estimates** — provider percentages always
    displayed as truth; attributed window-burn per project/session computed from a
    fitted token-weighting model, visibly marked as estimate with fit quality shown.
    Raw source files are kept after ingest (warehouse is a rebuildable derived copy).
    *(Both recommended; accepted.)*

## Facts established during the session (inputs, not decisions)

- CLIProxyAPI poller archive (since 2026-07-30) records per-request account email,
  model, reasoning effort (both providers), full token splits, latency, and Anthropic's
  own rate-limit headers. It cannot see project/task. Archive was scrubbed of plaintext
  inbound API keys this session (29,495 records; verified clean).
- Claude transcripts carry project/session/request attribution, cache TTL splits,
  subagent rollups, and Skill tool-use markers — but no effort and no thinking-token
  split. Parser traps: dedup by requestId (~2× inflation), subagent double-count,
  ~/.claude and ~/.codex are symlinks into profile homes.
- Codex rollouts carry per-turn model + effort + reasoning tokens + cwd/git; only the
  insight Codex account has local data.
- Transcript auto-cleanup was active in all profiles (~7 weeks of history surviving);
  `cleanupPeriodDays: 3650` was set in all seven profiles this session (Tim-approved).
- Burn diagnosis (11 days of proxy data): 4.25B tokens, 95.8% cache reads; workhorse
  models average ~155–162K input/request; 61% of output+reasoning at effort high+;
  >99.5% of traffic agent-driven; failure waste ≈ 0; cache hit rates already 94–97%.
- Archive-based Claude quota inference contradicted Tim's lived experience and was
  traced to an undercount: all seven Claude profiles only routed through the proxy from
  2026-08-07 evening. Hence decision 2's ground-truth rule.

## Named for later (owned elsewhere)

- Phase 2 (usage management): context-size discipline, Codex effort-tier policy review,
  burst concurrency — after reporting exists.
- V2 candidates: runway forecasts, explicit task stamping, Mac Mini ingestion, client
  split, wasted-session detection, per-machine views.
- Build sequencing, spec, and tickets: to be ordered separately by Tim (to-tickets /
  lane briefs); first build step should verify the requestId↔transcript join.

## Approved slice list (to-tickets sign-off, 2026-08-09)

Tim approved filing these 13 tracer-bullet slices verbatim (blockers in parentheses):
1. Join spike: proxy request_id ↔ transcript requestId (—)
2. Warehouse schema + proxy-archive backfill + summary endpoint (—)
3. Daemon becomes usage-queue consumer; retire poller (2)
4. Window-history endpoint over usage_snapshots (—)
5. Claude transcript backfill ingester, 7 profiles (1, 2)
6. Codex rollout ingester, sessions + archived (2)
7. Local OTEL collector + profile exporter rollout (2)
8. Dashboard shell + account headroom view, feature-flagged (4)
9. Burn timeline view (2, 8)
10. Model × effort view (2, 8)
11. Project burn view (5, 8, 13)
12. Session/task explorer (5, 6, 8)
13. Window-burn estimate model, labeled estimates (2, 4, 5)
