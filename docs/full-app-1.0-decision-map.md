# Full-app 1.0 — decision map

_Parent ticket: [Full package: bundle managed CLIProxyAPI + dashboard app window (post-0.4.6 decision map) (#378)](https://github.com/timharris707/modeldeck-private/issues/378) · Charted 2026-08-12 · Decider: Tim Harris · Weight: deep (child gate-decision tickets, most-gating-first)_

## Destination

"Decided" for this scope means the Release 1.0 milestone is speccable as
ordinary build tickets: ModelDeck ships as a full-fledged app — a pinned,
managed CLIProxyAPI bundled per the #378 charter (decision 1), the analytics
dashboard in a real SwiftUI app window (decision 2), and whatever "full Swift
buildout" is decided to mean — with the credential-surface, packaging,
migration, update, and public-mirror questions each carrying a recorded
decision, and an adjudicated definition of what earns the 1.0 label. Timing
per charter decision 3: everything here is post-0.4.6; nothing gates or grows
the current dashboard train. Build routing is settled (Tim, 2026-08-12, on
#378): codex gpt-5.6-sol at `max` for most of the build, Opus 5 at `max` for
UI components.

## Already decided (the #378 charter, Tim 2026-08-11 — not relitigated here)

1. Bundle STOCK CLIProxyAPI, pinned, managed by the daemon (fork stays PARKED).
2. Menu bar stays the glanceable deck; dashboard gets a SwiftUI window hosting
   the single-file dashboard build in a WKWebView. Not a dock-app rethink.
3. Post-0.4.6 timing.
4. Degradation tiers preserved: tier 1 local-log analytics (zero deps), tier 2
   window/quota (managed OAuth), tier 3 measured truth + pool attribution
   (proxy in path). Out of the box = tiers 1–2; bundled proxy = tier 3 default.

## Clusters

### 1. ✅ "Full Swift buildout" scope — what moves into Swift, what stays Node
**Ticket:** [#397](https://github.com/timharris707/modeldeck-private/issues/397) · **DECIDED (Tim, 2026-08-12): Option A — Swift is the shell** (window, onboarding, proxy lifecycle); the Node data plane stays, as a recorded decision. Full record on the ticket.

### 2. ✅ Credential surface — who owns the proxy's auth files under management
**Ticket:** [#398](https://github.com/timharris707/modeldeck-private/issues/398) · **DECIDED (Tim, 2026-08-12): ModelDeck manages config + process, never auth files**; state stays at `~/.config/cliproxyapi`; #396 re-login = daemon drives the proxy's own interactive flow. Full record on the ticket.

### 3. ✅ Signing/notarization — a Go binary inside the notarized Mac app
**Ticket:** [#399](https://github.com/timharris707/modeldeck-private/issues/399) · **RESEARCH DELIVERED**: [findings](research/issue-399-signing-notarization.md) — upstream binaries unsigned; embedded-binary swap forces full re-notarization (feeds #403); re-sign-vs-build-from-source is an open decision folded into the #403 grilling.

### 4. ✅ Usage-queue single-consumer invariant as an in-app design constraint
**Ticket:** [#400](https://github.com/timharris707/modeldeck-private/issues/400) · **DECIDED (Tim, 2026-08-12): sole consumer by construction + loud dashboard detection of a second consumer** (structural prevention impossible with stock proxy — on the record). Full record on the ticket.

### 5. ✅ Migration — existing external CLIProxyAPI instances (:8317)
**Ticket:** [#401](https://github.com/timharris707/modeldeck-private/issues/401) · **DECIDED (Tim, 2026-08-14): ADOPT with a visible handover** — detect :8317, offer one-click adoption (same config dir, #398 makes it credential-migration-free); decline = coexist-as-client with managed features honestly unavailable; user ops tolerated; "stop managing" rollback. Full record on the ticket.

### 6. ✅ App window — WKWebView specifics
**Ticket:** [#402](https://github.com/timharris707/modeldeck-private/issues/402) · **DECIDED (Tim, 2026-08-14): all four sub-recommendations** — loopback WKWebView (ATS scoped to 127.0.0.1), route-object deep links (one nav system), one window with honest daemon-down state + route restore, daemon token embedded (security lens mandatory at build review). No prototype graduated. Full record on the ticket.

### 7. ✅ Update cadence — pinned-version policy and upgrade path
**Ticket:** [#403](https://github.com/timharris707/modeldeck-private/issues/403) · **DECIDED (Tim, 2026-08-14): pin rides app releases** (re-notarization economics); build from pinned source, never re-sign upstream blobs; entitlements start at none; compatibility tripwire (incl. live-endpoint capture) at every pin bump; CVE-only expedite path; upstream watch is a RELEASE.md step, not in-app. #399's open decisions closed here. Full record on the ticket.

### 8. ✅ Public mirror — bundling in the PolyForm-NC public repo
**Ticket:** [#404](https://github.com/timharris707/modeldeck-private/issues/404) · **RESEARCH DELIVERED**: [findings](research/issue-404-public-mirror.md) — MIT + PolyForm-NC compatible (clause-cited); attribution = repo NOTICES + app Credits.rtf; reproducibility recipe for RELEASE.md; residual decisions ride #403/#405.

### 9. ✅ Release 1.0 criteria — what earns the label
**Ticket:** [#405](https://github.com/timharris707/modeldeck-private/issues/405) · **DECIDED (Tim, 2026-08-14) — MAP CLOSED.** 1.0 = bundled managed proxy + app window + Swift-shell scope + adoption flow, **plus #395/#396 promoted to 1.0-mandatory** (a managed proxy that silently 401s is worse than an unmanaged one). Quality bar = the 0.4.6 protocol (field re-click gate, mutation-verified tripwires, live-endpoint capture for management APIs). Mirror per #404 recipe; version → 1.0.0. Non-goals on the record: Windows/Linux OUT, iOS (#18) OUT, fork stays PARKED. Full record on the ticket.

## Not yet specified (in-scope fog, not yet ticket-shaped)

- ~~Onboarding flow for the bundled proxy~~ — RULED (Tim, 2026-08-14, post-map
  addendum): ONE first-launch surface, two branches — existing :8317 detected →
  the #401 adoption offer; fresh install → a single consent screen with Enable
  pre-selected (honoring tier-3-default), decline lands tiers 1–2 with the
  upgrade visible in settings. Never silent-on (the #401 field-trust rule).
  Rides build slice D.
- Whether the interim ops jobs (rebalance cron, launchd ingest) fold into the
  managed daemon at 1.0 — sharpens once #397 (buildout scope) and #400 (queue
  consumer) land. (#388 already retires the interim ingest job at 0.4.6.)
- ~~Windows/Linux story, if any~~ — RULED OUT at #405 (2026-08-14): not a 1.0 goal.

## Out of scope (ruled past the destination, with rulings)

- **Forking CLIProxyAPI** — PARKED by charter decision 1; trigger unchanged
  (only if reporting hooks upstream won't merge). Reopening is a new
  adjudication.
- **Full dock-app rethink** — ruled out by charter decision 2 (menu bar +
  window, not a rethink).
- **0.4.6 scope growth** — charter decision 3; the dashboard train ships as
  chartered, gated on Tim's field re-click, regardless of this map.

## Verdicts (written back as tickets close)

- 2026-08-12 · #397 — Option A, Swift is the shell; Node data plane stays (recorded decision).
- 2026-08-12 · #398 — ModelDeck manages config + process, never auth files; state stays at `~/.config/cliproxyapi`.
- 2026-08-12 · #400 — sole consumer by construction + loud detection; structural prevention impossible with stock proxy.
- 2026-08-12 · #399 — research delivered ([findings](research/issue-399-signing-notarization.md)); open decisions folded into #403.
- 2026-08-12 · #404 — research delivered ([findings](research/issue-404-public-mirror.md)); license-compat confirmed; residual decisions ride #403/#405.
- 2026-08-14 · #401 — ADOPT with visible handover; decline = honest coexist; user ops tolerated; "stop managing" rollback.
- 2026-08-14 · #402 — loopback WKWebView (scoped ATS), route-object deep links, one window + route restore, daemon token in-window (security lens at build review). No prototype graduated.
- 2026-08-14 · #403 — pin rides app releases; build-from-source, no re-signing; entitlements-from-none; pin-bump compat tripwire with live-endpoint capture; CVE-only expedite; upstream watch in RELEASE.md. Closes #399's open decisions.
- 2026-08-14 · #405 — 1.0 label defined; #395/#396 promoted to 1.0-mandatory; quality bar = 0.4.6 protocol; mirror per #404; 0.4.x → 1.0.0; Windows/Linux + iOS OUT. **Map closed — gate released: cut the 1.0 build tickets.**
- 2026-08-14 · onboarding consent (post-map addendum, ruled during to-tickets) — one first-launch surface, two branches: adoption offer (#401) when :8317 answers; fresh-install consent screen with Enable pre-selected (tier-3 default), decline = tiers 1–2. Never silent-on. Rides build slice D.
