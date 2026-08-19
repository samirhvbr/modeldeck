# Quota control plane — capability verification & pain-point findings

> **Dispositioned 2026-08-17:** every §6 question was ruled at the control-plane
> grilling — see [docs/control-plane-grilling-2026-08-17.md](../control-plane-grilling-2026-08-17.md)
> and decisions 0032–0034. This doc remains the evidence base.

_2026-08-17/18 · Inputs to the control-plane design grilling. Two verification lanes
(a read-only repo capability audit; a cited web pain-point sweep) plus a two-seat
external advisory round (grok-4.6, gpt-5.6-sol — artifacts at
`~/.advisory-board/runs/modeldeck-blume-strategy-2026-08-17/`). Nothing here is a
decision; §6 lists what the grilling must rule on. Load-bearing repo citations were
spot-checked verbatim by the orchestrating session._

## 0. TL;DR

The strategy direction that came out of the Blume teardown and the advisory board —
**ModelDeck as the quota control plane** — survives verification with three
corrections:

1. **Today ModelDeck is a measurement plane, not a control plane.** Nothing in the
   system can write routing weights (tripwire-forbidden, decision 0006; external
   cron; folding in is post-1.0 #470) and nothing can stand in a request's path
   (daemon is out-of-band by design, decision 0027). "Control" claims are staged,
   not immediate.
2. **The measurement base is exceptional and under-used.** Per-request three-way
   input split + output/reasoning tokens, model, serving account, latency, TTFT,
   status — pulled every 5 minutes, never pruned. Context-size-per-request (the
   Codex-1M story) is measurable today.
3. **The loudest durable user pain is not "limits too low" — it is "I can't see,
   predict, or attribute my burn, so every limit feels like theft."** That maps
   1:1 onto what the measurement base can honestly answer.

The single highest-leverage change found: **per-profile client API keys** (stock
config accepts a list; our parser currently discards the `api_key` field the proxy
emits). No fork. It converts attribution from modeled to measured and keeps
identity on the safe side of the M1 state-DB-contention line.

## 1. Capability ground truth (repo audit, spot-checked)

### See / store today
- `request_usage` (SQLite, owner-only, **no retention pruning**): `request_id`,
  `observed_at`, `account_id`/`source_raw`, `provider` (claude|codex), `model`,
  `alias`, `reasoning_effort`, `endpoint`, `user_agent_class`, `failed`,
  `status_code`, `latency_ms`, `ttft_ms`, `input_uncached`, `input_cache_read`,
  `input_cache_write`, `output_total`, `output_reasoning`, `total`, `machine`
  ([db.mjs:675-701](../../src/db.mjs)).
- Queue: `GET /v0/management/usage-queue?count=500`, destructive, every 5 min,
  daemon sole consumer (decision 0007; [usage-queue-consumer.mjs:4-45](../../src/usage-queue-consumer.mjs)).
- Quota %: measured per provider (Claude OAuth probe; Codex app-server rate-limit
  buckets). `usage_snapshots` retained 90 days.
- Context signal ships today over the session corpus: `avgInputTokens` +
  `contextTrend` ([db.mjs:2379-2381, 2563-2572](../../src/db.mjs)). Field evidence:
  workhorse models ~155–162K input/request, 95.8% cache reads
  (usage-analytics grilling 2026-08-09).
- Blackout detection: 3-failure streak per account
  ([service.mjs:4473-4498](../../src/service.mjs)); remedy today is a notification
  string, not an action.

### Deliberately discarded by our parser (policy, reversible — not a proxy limit)
`api_key`, `access_token_sha256`, `response_headers` (incl. Anthropic rate-limit
headers and the `req_…` Request-Id), raw UA/IP, failure bodies
([usage-ingest.mjs:63-66](../../src/usage-ingest.mjs)).

### Cannot see today
Which profile/session/project/agent sent a request (all profiles share one client
key — `CLIPROXY_API_KEY_HELPER`, [service.mjs:144](../../src/service.mjs); the
request_id↔transcript join returned 0% in FINDINGS-336). The configured context
window (we see tokens carried, not the dial). Prompt/response content (by design).

### Act today
Claude profile→proxy routing on/off; pool join (login spawn); credential repair via
management API; Claude auto-renew (default on); proxy process lifecycle (managed
mode); macOS notifications (capacity threshold, blackout, model downgrade).
**Not act:** weight writes (tripwire, decision 0006; external cron; #470 post-1.0);
any in-path admission (throttle/reject/queue/redirect); Codex routing (explicitly
unmanaged today); Codex renewal.

### The stock-pin constraint (decision 0002 — confirmed stock, unforked)
Config-reachable without fork: `api-keys` (list — the attribution lever),
`usage-statistics-enabled`, remote-management flags, per-credential `weight` +
`excluded-models` (readable; writing is the cron's), management API endpoints.
**Unknowns flagged for research:** the stock `plugins:` system (we ship it
disabled; capabilities undocumented in-repo — the cheapest possible route to
in-path features if capable); `usage-statistics-enabled` upstream default on a
fresh managed install; auth-dir hot-reload is documented in our docs but untested
by any suite. 0002's own text names the fork trigger: "only if upstream won't
merge needed reporting hooks" — an upstream-PR path exists.

### Codex asymmetry (all in Codex's disfavor)
Proxy rows exist (16,393 in the field archive) but never resolve to an account row
([db.mjs:1444](../../src/db.mjs)); routing is user-owned config we neither write
nor verify; no fitted burn model; no OTEL; no auto-renew; auth-file health often
UNKNOWN (id_token metadata absent).

### Feasibility verdicts (audit, verbatim classes)
| Feature | Verdict |
| --- | --- |
| Burn forecasting ("pool dry ~HH:MM") | **buildable-with-existing-data** (was the 2026-08-09 grilling's deferred-v2 intent; now placed in Receipts v1 by decision 0033) |
| Pool right-sizing (30-day keep/drop/add) | **buildable-with-existing-data** (unpruned `request_usage` + 90d snapshots + readable weights) |
| Context-cost attribution — per-project, apportioned | **buildable-with-existing-data** (must carry estimate label, decision 0019) |
| Context-cost attribution — per-profile, measured | **needs-new-capture-but-no-fork** (per-profile api-keys + stop discarding `api_key`; our blockers: shared Keychain helper, never-modify-existing-config rule) |
| Dying-account quarantine (act half) + canary restore | **needs-#470 + tripwire relaxation** (detection ships today) |
| Runaway-burn guard (hard stop) / capacity reserves | **needs-fork-or-plugin-or-fronting-layer** (no admission control exists) |

## 2. Pain-point evidence (web sweep, cited)

Method caveats: X and Reddit not directly fetchable; X quotes are search-snippet
verbatim, Reddit via press/GitHub quoting. Full report in the session transcript;
key evidence below.

### The Codex 1M flip — verified, with precision corrections
- Aug 16–17 2026: OpenAI's Codex lead (@thsottiaux) enabled 1M context for
  ChatGPT-plan accounts (`model_context_window = 1000000`), with the advisory "there
  is a reason the current context length is the default, we have tuned it to
  ~perfection" ([x.com/thsottiaux/status/2089143488696705077](https://x.com/thsottiaux/status/2089143488696705077);
  merged same-day: openai/codex PR "Raise the GPT-5.6 maximum context window",
  cap 872K input).
- **Correction to our framing:** the pre-flip subscription default was **272K**
  (372K was the launch cap, cut 2026-07-13 because it "caused more subscription
  usage to be charged than intended" — openai/codex#34619). Requests above 272K
  input bill at **2× input / 1.5× output for the whole request**
  (openai/codex#32486). So 1M isn't just more tokens — it's a multiplier trap.
- Burn mechanism, user-stated day one: "With 1M it never has to [trim], so it keeps
  everything and resends all of it every turn… burn a full plan in about a day on
  loops" ([@ziwenxu_](https://x.com/ziwenxu_/status/2089159923175203209)).
- The change appeared in no changelog as of the sweep — the exact "announced only
  via X" pattern users already filed against (openai/codex#34619).

### Recurring complaint themes (12-month sweep, ranked by loudness × constancy)
1. **No visibility into what consumed quota** — constant, deepest. "'75% of ?' is
   useless"; "I wasted hours investigating whether my own tooling was causing
   excess usage" (claude-code#28848). Both vendors shipped real metering bugs users
   couldn't self-diagnose (Codex Nov-2025 cache bug #6172; Claude Mar-2026 cache
   inflation, #59946 double-count, #51291 429s consuming quota "with nothing
   running").
2. **Limits hit mid-work / top model burns the week in days** — constant.
   "Cutting off usage mid work-week is like losing your top developer"
   (claude-code#9424); "maxed out every Monday, resets Saturday… out of 30 days I
   get to use Claude 12" (Register 2026-03-31).
3. **Silent limit/context changes** — loudest wave-driver. TechCrunch 2025-07-17
   headline; "silently tightened… just opaque percentages" (claude-code#54714);
   the Jan-2026 "~60% cut" token-level log analysis that made press; Codex's July
   context cut release-noted as "corrected their context windows". Users can't
   tell cut vs. bug vs. promo-expiry apart — that inability IS the complaint.
4. **Surprise burn from agents/MCP/config overhead** — constant among heavy users.
   MCP tools eating 49.3% of a window before work starts (claude-code#13717);
   "97 agents, 2M tokens burned in 34 seconds," diagnosable only by grepping local
   JSONL (claude-code#64328); setup re-transmitted every turn (#46526).
5. **Multi-account juggling** — common enough to sustain an ecosystem: ≥5 OSS
   switchers/balancers (claude-swap, clauth, claude-balancer, ccflare, Hydra) and
   an official feature request (claude-code#34341, "automatic rate-limit
   failover"). ToS line per community analysis: multiple accounts tolerated;
   "limit evasion" and token extraction are ban grounds.
6. **Reset confusion** — constant background. Drifting reset dates
   (openai/codex#38900); "Resets Mon 12am… It's Tuesday" (HN).
7. **429s killing long agent runs** — occasional, severe. 2-hour runs dying at
   80-90% on one 429 (claude-agent-sdk-python#812); "dashboard says 100% left,
   backend says limit hit" (openai/codex#38354, claude-code#22876).

### First-party field evidence: the cache-cadence save (Tim, 2026-08-17)
Founder-reported, order-of-magnitude: in orchestration mode, check-ins every ~5
minutes let Anthropic's prompt cache (5-minute TTL) expire between calls — every
turn re-billed its context as uncached input. Dropping the cadence to ~4 minutes
kept sessions cached and cut token burn by roughly 30–60×. Two implications:
(1) this exact signature — `input_cache_read` collapsing while `input_uncached`
balloons at a regular cadence — is visible in the three-way split we already
store per request; (2) it is the positive-control twin of the Mar-2026 cache-bug
wave (theme 1): the same receipts distinguish "your cadence killed the cache"
from "their cache broke." Half the mystery burn is self-inflicted and currently
invisible to the user; nobody today shows them which half.

### Coping landscape / adjacent products
ccusage (~18K stars) prices estimates from local JSONL but knows nothing of real
quotas; Claumon forecasts limit-hits (demand proof for forecasting); Extraheadroom
charges $4–40/mo for a compression proxy ("Same AI plan. Twice the code");
claude-code-limiter meters a shared subscription across a team (agency demand
signal); API resellers content-market on these exact complaints. blume.codes
markets "track your plan limits and token burn before you hit a wall" — still no
multi-account story.

## 3. Claims-to-capability matrix

Stamps: **TODAY** (data exists; feature is presentation/assembly) ·
**AFTER-KEYS** (needs per-profile api-keys capture, no fork) ·
**POST-#470** (needs daemon weight-write authority + tripwire relaxation) ·
**RESEARCH** (plugin/upstream/fronting question) · **CAN'T** (don't claim).

| # | Claim (the honest sentence) | Pain | Stamp |
| --- | --- | --- | --- |
| 1 | "See exactly what ate your quota — every request, every token, every account." | Theme 1 (loudest) | **TODAY** (per-account, per-request); per-workload **AFTER-KEYS**; per-project today is labeled apportionment |
| 2 | "Independent receipts when the meter is wrong — theirs or yours." (metering-bug defense; "you changed vs. they changed" baselines) | Themes 1, 3 | **TODAY** (unpruned history + 90d snapshots). Cannot restore removed capacity — never imply it |
| 3 | "Know when the wall arrives before it hits — per account and for the pool." (exhaustion forecast) | Theme 2 | **TODAY** (build the deferred v2; data + rate machinery exist) |
| 4 | "The 1M trap, priced: what your context size actually costs you per turn." | 1M flip, theme 4 | **TODAY** (context consumed per request; correlate with measured quota drain). We infer the dial from the distribution — never claim to read the setting |
| 5 | "Catch runaway burn in minutes, with the culprit named." | Theme 4 | Alert **TODAY** (5-min queue cadence bounds honesty: "minutes," never "instantly"); culprit-naming **AFTER-KEYS**; auto-quarantine of the bleeding account **POST-#470**; hard-stopping the session **CAN'T** (no admission path; harness-side or RESEARCH) |
| 6 | "A pool that protects itself: failing accounts benched before your agents feel them." | Themes 5, 7 | Detection **TODAY**; automated bench + canary restore **POST-#470**; positioning must be *resilience/visibility*, never limit-evasion (ToS line) |
| 7 | "Reserve headroom for you — background fleets can't starve your live session." | Theme 2 | **RESEARCH** (admission control: stock plugin system unknown / upstream hooks per 0002 / fronting layer). Do not market until the mechanism exists |
| 8 | "Your resets, decoded — one calendar across every account and provider." | Theme 6 | **TODAY** (presentation over existing resetsAt data) |
| 9 | "Right-size your stack: keep, drop, or add a subscription — from 30 days of your own traffic." | Themes 2, 5 | **TODAY** (mind the Codex `source_raw` asymmetry) |
| 10 | "Find out when it's *you* — burn pathologies diagnosed from receipts, each with a one-line fix." (cold-cache churn, context bloat, retry storms, swarm bursts, the >272K multiplier) | Themes 1, 4 + cache-cadence evidence | **TODAY** at proxy grade (the 3-way input split is the diagnostic instrument) AND at corpus grade for both providers — Claude transcripts carry usage splits, and `codex_turns` stores per-turn `input_tokens`/`cached_input_tokens`/`cache_write_input_tokens`/output/TTFT ([db.mjs:760-777](../../src/db.mjs), verified 2026-08-18) |

Composite positioning that survives every stamp: **"Your subscriptions, with
receipts."** Blume coaches from vibes; harness vendors show their own meter;
ModelDeck is the only party that measured every request across the whole pool.

## 3b. The audience pivot (Tim, 2026-08-17)

Most Claude/Codex subscribers run **one** account per provider; the deck today is
built for the many-account power user. If the product nails burn
visibility/diagnosis, the addressable audience widens by orders of magnitude —
"struggling with subscription burn" describes essentially every serious
Claude Code or Codex user, one account or ten.

Architectural consequence the audit exposes: **receipts come from the proxy
(tier 3)**. A single-account user gets them only by routing their one account
through the bundled local proxy — which is exactly what ccflare/Extraheadroom
users already do voluntarily, carries none of the pooling ToS shadow, and the
degradation-tier decision (0005) already frames graceful tiering. A proxy-less
corpus grade exists for BOTH providers: Claude transcripts carry per-turn usage
splits (`avgInputTokens`/`contextTrend` ship today), and Codex rollouts land in
`codex_turns` with full token splits incl. cache columns ([db.mjs:760-777](../../src/db.mjs),
verified 2026-08-18 — corrects the audit's UNVERIFIED flag). Working shape: **the diagnostician meets you at your
tier** — corpus-grade insight with zero setup, wire-grade receipts when the
proxy is on, pool features when there's a pool. The persona/tier ruling is now a
lead grilling question (§6 Q1b).

## 4. What this does to the advisory-board bets

- Codex-seat's **Quota Guard** → survives as *forecast + alert + attribute*
  (attribute after keys); the "one-click pause/reweight" half rides #470.
- Grok-seat's **dying-slot quarantine** → detect-now / act-post-#470.
- **Forecasting + right-sizing + receipts** were upgraded by verification — the
  cheapest honest wins, all zero-quota, no-fork, and aimed at the loudest pains.
- **Reserves** (the best new idea) moved furthest out — mechanism unknown.
- All three takes' zero-LLM consensus holds: nothing above spends a token of
  anyone's quota.

## 5. Sequencing that falls out (input to grilling, not a plan)

1. **Receipts v1** — per-request/account explorer + context-cost surfacing +
   reset calendar + forecast ("dry at ~HH:MM"). All TODAY-stamped. The Codex-1M
   week is the ready-made launch case study.
2. **Keys** — per-profile client API keys + retain `api_key` (+ decide on
   Request-Id and rate-limit headers while in there). Unlocks workload
   attribution and measured per-profile setup cost.
3. **Right-sizing report** (30-day), riding the same data.
4. **#470 lane** — rebalancer into the daemon behind the recorded gates; then
   quarantine/canary as its first product surface.
5. **Research spike** — stock plugin system capabilities + upstream hook appetite
   (0002's named reopen trigger) → decides reserves/hard-guard feasibility.

## 6. Open questions for the grilling (the frontier)

1. **Positioning ruling:** "quota control plane / receipts" as the product
   identity — and the ToS-adjacent line: resilience/visibility framing vs.
   anything readable as limit-evasion marketing.
   **1b. Persona/tier ruling:** is the headline audience the single-account
   burn-sufferer (diagnostician-first, proxy as upgrade) or the multi-account
   operator (control-plane-first)? Does Receipts v1 ship corpus-grade
   (proxy-less) for Claude, or proxy-first for everyone?
2. **The keys change:** approve per-profile api-keys + retaining `api_key`?
   (Touches the shared Keychain helper and the never-modify-existing-config rule —
   auth-adjacent, so security lens + full review per never-compromise #3.)
   Sub-question: also retain response `Request-Id` and rate-limit headers?
3. **Retention policy for `request_usage`:** unbounded growth is currently an
   accident; receipts want history; pick a bound (and a tripwire).
4. **#470 scope:** does quarantine/canary become #470's product face, and what
   relaxes decision 0006's tripwire (daemon-writes-weights) safely?
5. **Codex parity:** how far to lift the asymmetry (account resolution, managed
   routing, renewal) — and in what order relative to Receipts v1?
6. **The LLM door:** board voted 2–1 deterministic-forever; orchestrator
   recommended hard-line-with-non-subscription-engines-later. Rule it.
7. **Blume's three (from the teardown grilling queue):** deterministic
   multi-profile audit = yes-shaped per all three takes; correction mining = dead
   (three kill votes) unless Tim overrules; monitor = collapses into proxy-native
   fleet pulse. Confirm dispositions.
8. Pre/post-1.0 boundary for all of the above (teardown §11 Q2 stands).
