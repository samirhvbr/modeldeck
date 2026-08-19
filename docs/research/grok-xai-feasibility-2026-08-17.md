# Grok/xAI as ModelDeck's third provider — feasibility spike

_2026-08-17 · Commissioned by Tim at the control-plane grilling close; run as a
read-only research lane. No prompts sent to any CLI; `~/.grok/auth.json` never
opened; `session_search.sqlite` inspected as a /tmp copy per decision 0034.
Primary sources: the local grok CLI 1.0.4 install (`~/.grok/` docs + binary
strings), the public CLI repo `xai-org/grok-build`, and `router-for-me/CLIProxyAPI`
at ModelDeck's pinned commit. Ruling on this evidence: decision 0035 (add,
corpus-first, after Receipts v1)._

## Unknown 1 — subscription usage/limits API (quota grade): YES, an endpoint exists

- **The CLI has a `/usage` (alias `/cost`) command** ("View credit usage or manage
  billing" — `~/.grok/docs/user-guide/04-slash-commands.md:408`). Behind it, the
  TUI calls ACP extension `x.ai/billing`, whose handler does
  **`GET {cli_chat_proxy_base}/billing?format=credits`** — default base
  `https://cli-chat-proxy.grok.com/v1` — with `Authorization: Bearer <session
  token>`, `X-XAI-Token-Auth`, and `x-userid` headers, "which forwards to the
  backend `GetGrokCreditsConfig`". Verified in public source:
  [`crates/codegen/xai-grok-shell/src/extensions/billing.rs`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs)
  (also present verbatim in the local binary's strings).
- **Response fields** (from that source file): `credit_usage_percent` (0–100),
  `current_period` {type: `USAGE_PERIOD_TYPE_WEEKLY`|monthly, start/end RFC 3339},
  `on_demand_cap`/`on_demand_used`, `prepaid_balance`, `is_unified_billing_user`,
  `subscription_tier` (e.g. "SuperGrok Heavy"), per-period `history`. A direct
  analog of Anthropic's `oauth/usage` percent-plus-window — fits decision 0019's
  ground-truth-percent rule. Binary strings confirm limit semantics: 402/403 →
  "You hit your free usage limit" / "You hit your weekly limit"; tiers free /
  X Basic / SuperGrok / Plus / Heavy.
- **Auth mechanism** (docs only — `~/.grok/docs/user-guide/02-authentication.md`):
  default OAuth2 browser login at `auth.x.ai`/`accounts.x.ai`, tokens in
  `~/.grok/auth.json` (0600) with silent refresh and hot reload; device-code flow,
  enterprise OIDC (PKCE), external-auth-provider hook, `XAI_API_KEY` fallback.
- Context: xAI's **API-key** side has no programmatic usage endpoint (console UI
  only) per [docs.x.ai/developers/rate-limits](https://docs.x.ai/developers/rate-limits);
  the **subscription** side is a shared weekly pool (Warp's docs confirm
  third-party tools draw from the same pool). `/billing?format=credits` is how the
  CLI itself reads that pool.

## Unknown 2 — local session store per-turn tokens (corpus grade): YES, richer than Claude/Codex

- **Per-turn usage is persisted.** Each session dir
  `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl` carries a
  `turn_completed` update with a full usage object. Real sample (modeldeck cwd):
  `{"inputTokens":141321,"outputTokens":7651,"totalTokens":148972,
  "cachedReadTokens":95744,"cacheCreationTokens":0,"reasoningTokens":4490,
  "modelCalls":3,"apiDurationMs":129500,"costUsdTicks":364384400,
  "modelUsage":{"grok-4.6-build":{…}},"numTurns":3}` — input/output/cache split,
  reasoning tokens, per-model breakdown, and a **direct cost field**, none of
  which Claude transcripts carry.
- Supporting store facts: `signals.json` holds session-level counters incl.
  `contextTokensUsed`/`contextWindowTokens`; `summary.json` holds
  model/timestamps; `chat_history.jsonl` and `prompt_history.jsonl` carry no
  usage keys; **`session_search.sqlite` is an FTS5 title/content index only — no
  token columns**; `~/.grok/logs/` is `unified.jsonl` + MCP stderr logs. Layout
  documented in `~/.grok/docs/user-guide/17-sessions.md`; persistence code public
  in `xai-org/grok-build` (`x.ai/session/usage` projects the in-memory
  UsageLedger; the on-disk per-turn record is the ACP update stream).
- **Privacy flag for ingest design:** `signals.json` shows a `gcsQueue*` upload
  pipeline — this CLI uploads session traces to an xAI bucket (the July incident
  that forced the open-sourcing). Corpus ingest must be read-only, and this
  strengthens the receipts pitch: ModelDeck's posture is local-only.

## Unknown 3 — CLIProxyAPI support (wire grade): YES, already in ModelDeck's pin

- **The pinned v7.2.130 tree (`f43aad7…`, per `scripts/cliproxyapi-pin.json`)
  already ships full xAI support**: `internal/auth/xai/`,
  `internal/cmd/xai_login.go`, `internal/client/grokbuild/`, and a complete
  `internal/runtime/executor/xai_executor*.go` family including
  `xai_executor_tokens.go` (usage/token accounting) and a websockets executor.
  Verified by listing the git tree at that exact commit.
- HEAD README lists xAI as a first-class provider ("Grok Build support via OAuth
  login", "Grok Build multi-account load balancing"); login is
  `./cli-proxy-api --xai-login`, provider id `xai`
  ([help.router-for.me/configuration/provider/xai](https://help.router-for.me/configuration/provider/xai)).
  History: upstream issues [#2150](https://github.com/router-for-me/CLIProxyAPI/issues/2150)
  and [#3408](https://github.com/router-for-me/CLIProxyAPI/issues/3408), both
  closed; active xai work continues (v7.2.131 Grok Imagine; open PR "embed
  Grok 4.6 catalog entry").
- **Decision 0002 is moot here**: nothing needs upstreaming, so no fork question.
  (`xai-org/grok-build` itself accepts no external contributions.)
- Caveats for the build ticket: (a) ModelDeck's `request_usage` parser enumerates
  `provider (claude|codex)` — widening is ModelDeck-side work; (b) route the grok
  CLI per-model, not via a wholesale `GROK_CLI_CHAT_PROXY_BASE_URL` override — the
  wholesale override would also move the `/billing` fetch onto CLIProxyAPI, which
  doesn't implement that path, degrading the CLI's own usage display; (c) small
  catalog-lag risk (grok-4.6 entry landing at upstream HEAD; pin is 7.2.130).

## Verdict per tier (terms per docs/terms.md)

| Tier | Verdict |
|---|---|
| **Corpus grade** | **Possible today, zero-setup.** Per-turn splits in `updates.jsonl` exceed both existing providers (adds reasoning tokens + costUsdTicks). |
| **Quota grade** | **Possible.** `GET {base}/billing?format=credits` returns ground-truth `credit_usage_percent` + weekly/monthly period + tier. |
| **Wire grade / pool depth** | **Possible with the current pin.** xAI OAuth accounts + multi-account load balancing already in v7.2.130; remaining work is ModelDeck-side (provider enum, routing config, compat-suite coverage against a spawned proxy instance). |

## Recommendation (accepted as decision 0035)

**Add** — all three grades clear, and uniquely, no upstream dependency blocks any
of them. Ordering matches the on-ramp model: corpus first (free, data already on
disk), quota probe second, wire/pool last — starting after Receipts v1 ships.
**Cheapest first step:** extend the session-corpus ingester to parse
`turn_completed.usage` from `~/.grok/sessions/*/*/updates.jsonl` (schema
cross-checkable against `xai-org/grok-build` source). Zero quota spend, zero
proxy changes, no new credentials touched — and it produces the first Grok
receipts from Tim's own data.
