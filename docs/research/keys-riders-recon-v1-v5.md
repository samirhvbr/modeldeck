# Keys-with-riders recon — V1–V5 findings (issue #518)

_Claude recon lane, 2026-08-18. Answers the five verification items defined in
[docs/keys-with-riders-design.md](../keys-with-riders-design.md) §4, under
decision 0036 and the lane safety contract: every proxy probe ran against an
isolated spawned instance of the pinned binary on port 18421 (live ports
8317/3867 never touched), the upstream was a local mock on 127.0.0.1:18422 so
**zero provider calls** were made, placeholder identities/keys throughout, and
V5 ran on scratch keychains that were deleted afterwards._

**Probe fixture (reproducible).** Pinned binary
`dist/cliproxyapi/cliproxyapi` (v7.2.130, commit `f43aad76`, verified by
`npm run test:cliproxyapi-pin`'s pin file); pinned source checked out at
exactly that commit for the source citations below (file:line refs are into
the upstream repo at `f43aad7637ad813745bf7d341acb5663617570c5`). Every probe
below uses these variables; only `$SCRATCH_PW` is operator-chosen (any value —
it protects a throwaway keychain holding placeholder strings):

```sh
ROOT=/tmp/md518-recon                # probe workspace, removed at the end
PROXY=http://127.0.0.1:18421         # isolated spawned instance (never 8317/3867)
MGMT='Authorization: Bearer md518-recon-management-placeholder'
CLIENT_KEY=md518-recon-client-key-A-placeholder
BIN="$PWD/dist/cliproxyapi/cliproxyapi"   # run from the repo root
SCRATCH_PW=md518-recon-pass          # scratch-keychain password (placeholder)
mkdir -p "$ROOT/auths"
# both probe ports must be free BEFORE spawning (the suite's own rule):
for p in 18421 18422; do nc -z 127.0.0.1 $p && echo "$p BUSY - abort"; done
# observed: no output (both free)
```

Isolated config at `$ROOT/config.yaml` (the same shape as
`isolatedCLIProxyConfig` in `scripts/cliproxyapi-compat.mjs`, minus
`api-keys`, plus a mock upstream):

```yaml
host: "127.0.0.1"
port: 18421
remote-management:
  allow-remote: false
  secret-key: "md518-recon-management-placeholder"
  disable-control-panel: true
  disable-auto-update-panel: true
auth-dir: "/tmp/md518-recon/auths"          # empty dir
debug: false
logging-to-file: false
usage-statistics-enabled: true
plugins:
  enabled: false
claude-api-key:
  - api-key: "md518-recon-upstream-placeholder"
    base-url: "http://127.0.0.1:18422"       # local mock, NOT a provider
```

The mock upstream is a ~30-line node HTTP server at `$ROOT/mock-upstream.mjs`:
it listens on 127.0.0.1:18422 and answers every request with a minimal
Anthropic-shaped `messages` body (`usage: {input_tokens: 11, output_tokens:
7}`) and placeholder rider headers — `request-id:
req_recon518_placeholder_id`, `anthropic-ratelimit-unified-status: allowed`,
`anthropic-ratelimit-unified-reset: 1787430000`,
`anthropic-ratelimit-unified-fallback-percentage: 12.5`, `x-recon-marker:
md518`. Startup, readiness, and spawn:

```sh
node "$ROOT/mock-upstream.mjs" &            # logs "mock upstream listening"
"$BIN" -config "$ROOT/config.yaml" -local-model &   # compat suite's flag:
                                # embedded model catalog, no remote fetch
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "$PROXY/"
# observed: 200   (proxy ready)
```

Queue reads used the suite's discipline: `GET
/v0/management/usage-queue?count=1` with `-H "$MGMT"`, one record per pop,
isolated instance only. Zero-provider-call property is structural, not just
asserted: the only upstream credential in the config is the placeholder
`claude-api-key` entry whose `base-url` is the loopback mock, so the proxy has
no route to a provider host. Cleanup after the probes: kill both background
processes and `rm -rf "$ROOT"`.

**Startup side-finding (affects §2.6):** on first boot the proxy **rewrote
`config.yaml` in place**, replacing the plaintext `remote-management.secret-key`
with a bcrypt hash (`$2a$10$...`) and normalizing the document. This is direct,
observed proof that the proxy is a concurrent config writer even with no
management-API traffic — §2.6's TOCTOU guard and per-retry re-baseline are not
theoretical. Any byte-compare baseline taken before the proxy's first boot (or
before it hashes a newly-seeded plaintext secret) will mismatch through no
foreign action.

---

## V1 — what the usage record's `api_key` field carries

**Answer: the raw client key, verbatim.** Not masked, not hashed. The
hash-on-parse design (§2.2) works as designed; no mapping-key change needed.

Evidence (source): the access provider returns the exact matched candidate
value as the principal (`internal/access/config_access/provider.go:96`
`Principal: candidate.value`); the auth middleware stores it
(`internal/api/server_middleware.go:169` `c.Set("userApiKey",
result.Principal)`); the usage reporter reads it back
(`internal/runtime/executor/helps/usage_helpers.go:395` and `:62`) into
`Record.APIKey`, and the queue plugin serializes it unmodified as `api_key`
(`internal/redisqueue/plugin.go:117`, struct tag
`APIKey string \`json:"api_key"\``).

Evidence (probe), run in phase B (the `api-keys` list live):

```sh
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "$PROXY/v1/messages" \
  -H "x-api-key: $CLIENT_KEY" -H 'content-type: application/json' \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":16,"messages":[{"role":"user","content":"recon2"}]}'
# observed: 200
curl -s --max-time 10 "$PROXY/v0/management/usage-queue?count=1" -H "$MGMT" \
  | python3 -m json.tool
# observed (record excerpt; full record also carries tokens/latency/
# response_headers - the V4(a) capture below is from this same pop shape):
#   "api_key": "md518-recon-client-key-A-placeholder",
#   "auth_type": "apikey",
#   "endpoint": "POST /v1/messages",
#   "request_id": "a2aa1621"
```

A keyless request (accept-all phase) produced `"api_key": ""` — empty string,
not absent. The mapping must therefore never contain the hash of the empty
string (trivially true for 32-random-byte keys, but worth a named test).

**Flag — `source` can carry upstream credential material.** The same record's
`source` field carried the raw upstream `claude-api-key` value
(`md518-recon-upstream-placeholder`). Pinned source:
`resolveUsageSource` (`usage_helpers.go:408-445`) returns account email for
OAuth auths but falls through to `auth.Attributes["api_key"]` — the raw
upstream API key — for key-based upstream credentials. ModelDeck's ingest
allowlist **stores `source`** (`src/usage-ingest.mjs` `source:
requiredText(...)`), so against a coexist proxy configured with
`claude-api-key`/`codex-api-key` entries, raw provider API keys can reach
SQLite today via `source`. ModelDeck-managed proxies use OAuth auth files
(source = email), so the managed path is unaffected, but the discard-hardening
claim "no key material reaches SQLite" does not hold for key-configured
coexist proxies. Recorded as an acceptance criterion (with a regression-test
requirement) on build item 2, issue #519 (e.g. hash-or-drop `source` when
`auth_type == "apikey"`).

## V2 — empty/absent `api-keys` behavior (GATE for #521)

**Answer: empty or absent `api-keys` = accept-all (no authentication).
Writing the first entry flips the proxy to enforce-list, and — because the
config hot-reloads (V3) — the flip is live within ~2 seconds of the file
write, with no restart step in between. Every client not sending a listed key
401s from that moment.**

Evidence (source): with zero keys the provider is unregistered
(`internal/access/config_access/provider.go:19-23`); with zero providers the
manager returns nil/nil (`sdk/access/manager.go` `Authenticate`: `if
len(providers) == 0 { return nil, nil }`); the middleware comment states it
outright (`internal/api/server_middleware.go:148-150`): *"When no providers
are available, it allows all requests (legacy behaviour)."* Reload re-runs
registration (`internal/access/reconcile.go:88`).

Evidence (probe):

```sh
# phase A - config has NO api-keys
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "$PROXY/v1/models"
# observed: 200   (keyless, full model list body)
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "$PROXY/v1/messages" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":16,"messages":[{"role":"user","content":"recon"}]}'
# observed: 200   (keyless, body proxied from the mock: "recon-ok")

# phase B - append an api-keys block, atomic rename, NO restart.
# Write the CURRENT document plus the two api-keys lines to config.next.yaml
# (preserving the bcrypt-hashed secret-key line the proxy wrote at first
# boot - see the startup side-finding), then publish and wait out the
# watcher debounce:
#   api-keys:
#     - "md518-recon-client-key-A-placeholder"
mv "$ROOT/config.next.yaml" "$ROOT/config.yaml"; sleep 2
curl -s -i --max-time 5 "$PROXY/v1/models" | tail -1
# observed: {"error":"Missing API key"}          (HTTP 401)
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "$PROXY/v1/models" \
  -H 'x-api-key: md518-recon-wrong-key'
# observed: 401
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "$PROXY/v1/models" \
  -H "x-api-key: $CLIENT_KEY"
# observed: 200
```

**Gate verdict for the consented config write path (#521): CONDITIONAL
BUILD.** The design's blocker-2 risk is confirmed and is *sharper* than
written: there is no "until the proxy restarts" grace window — the first
`api-keys` write is immediately enforcing. §2.6's enforcement-flip gate
bullet must be treated as binding: the write path may not ship without
pre-flight evidence that all currently-observed clients carry a listed key
(or the legacy shared value appended per §2.5), and the consent screen must
describe the write as taking effect immediately, not "on restart".

## V3 — is `config.yaml` hot-reloaded?

**Answer: yes.** The watcher registers the config file itself, not just the
auth dir (`internal/watcher/events.go:30` `w.watcher.Add(w.configPath)`),
with a 150 ms debounce and a SHA-256 content-hash short-circuit
(`internal/watcher/config_reload.go:51-87`), and survives atomic
replace-by-rename (`replaceCheckDelay` in `internal/watcher/watcher.go:83-90`
exists precisely for rename-settling). Probe: both phase-B enablement and the
phase-C removal were performed by writing a temp file and `mv`-ing it over
`config.yaml` — ModelDeck's own publish pattern — and both were live within
~2 s with the proxy never restarted. Removal probe:

```sh
# phase C - the same document WITHOUT the api-keys block, atomic rename
mv "$ROOT/config.next.yaml" "$ROOT/config.yaml"; sleep 2
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "$PROXY/v1/models"
# observed: 200   (keyless: accept-all again)
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "$PROXY/v1/models" \
  -H "x-api-key: $CLIENT_KEY"
# observed: 200   (accept-all admits any header, not key retention)
```

**Design amendments this decides:** (a) §2.6 activation choreography
simplifies to "takes effect automatically" — no restart consent, no "pending
your restart" state for either managed or coexist proxies (D3's
no-automatic-restart posture stands but is moot for this feature; nothing
needs a restart). (b) §2.6's removal bullet ("the proxy keeps honoring
removed keys until its config is actually reloaded... pending restart") is
**contradicted**: removal is also live in seconds, and removing the *last*
entry silently returns the proxy to accept-all — the removal UX should state
that consequence instead of a pending-restart state. (c) The V2 flip above
inherits this immediacy.

## V4 — rate-limit header handling

### V4(a) — what the pinned proxy captures (isolated instance)

**Answer: the full upstream response header map, unfiltered, as
`response_headers`** — an object of Go-canonicalized header names to string
arrays, `omitempty` when no headers were captured. Source: executors call
`RecordAPIResponseMetadata` → `logging.SetResponseHeaders(ctx, headers)` with
the complete upstream header set (`internal/runtime/executor/helps/logging_helpers.go:191`);
the reporter snapshots it verbatim (`usage_helpers.go:261`); the queue plugin
serializes it (`plugin.go`, field `ResponseHeaders` with JSON tag
`response_headers,omitempty`). `cloneHTTPHeader` copies without
filtering (`internal/logging/requestmeta.go`). Probe capture (mock headers
pass through exactly, names canonicalized):

```json
"response_headers": {
  "Anthropic-Ratelimit-Unified-Fallback-Percentage": ["12.5"],
  "Anthropic-Ratelimit-Unified-Reset": ["1787430000"],
  "Anthropic-Ratelimit-Unified-Status": ["allowed"],
  "Content-Type": ["application/json"],
  "Request-Id": ["req_recon518_placeholder_id"],
  "X-Recon-Marker": ["md518"], "...": ["connection/date/keep-alive elided"]
}
```

Parser consequences for build item 2: values are **arrays** (take first,
reject multi-value to NULL or take index 0 — pick and test one); lookup must
be case-insensitive as designed (§2.3) — canonicalization makes exact-case
matching *appear* to work, which is exactly how a silent-NULL bug would ship;
the record's top-level `request_id` is the **proxy's internal id** (also in
`X-Cpa-Trace-Id`), *not* the provider request id — rider 1 must read
`response_headers["Request-Id"]`, never the record's `request_id` field.

### V4(b) — exact provider header names (source audit + docs ONLY; no live calls)

The pinned proxy names no provider rate-limit headers itself (grep over the
pinned source: no `anthropic-ratelimit` / `x-codex-*-used-percent` constants;
it forwards headers blind, which V4(a) proves suffices). Names come from
provider documentation and provider client source:

**Anthropic — documented API family**
([platform.claude.com/docs/en/api/rate-limits](https://platform.claude.com/docs/en/api/rate-limits),
fetched 2026-08-18): `retry-after` (seconds);
`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`
(integers; `-reset` in RFC 3339); `anthropic-priority-{input,output}-tokens-*`
(Priority Tier); `anthropic-workspace-id`. Fast mode adds `anthropic-fast-*`.

**Anthropic — unified family (subscription/OAuth traffic, the family §2.4
names).** **Community-observed evidence, not official documentation** — the
official Anthropic rate-limits page does not document the unified family at
all; the names below are observed from Claude Code traffic, primary citation
[anthropics/claude-code#12829](https://github.com/anthropics/claude-code/issues/12829)
which lists the full observed set: `anthropic-ratelimit-unified-status`,
`anthropic-ratelimit-unified-reset` (Unix epoch seconds),
`anthropic-ratelimit-unified-5h-{status,reset,utilization}`,
`anthropic-ratelimit-unified-7d-{status,reset,utilization}`,
`anthropic-ratelimit-unified-representative-claim`,
`anthropic-ratelimit-unified-fallback-percentage`,
`anthropic-ratelimit-unified-overage-disabled-reason`. Observed status values
include `allowed`, `allowed_warning`, `rejected` (design §2.4's enum);
`utilization` is fractional (e.g. `0.737`), `fallback-percentage` is percent —
the two scales differ, so `limit_used_percent`'s [0,100] rejection must pick
its source header deliberately. **Caveat recorded:** undocumented headers can
drift without notice; the parsers' absent/renamed→NULL posture (§4 V4) is the
correct defense and was a design assumption this recon confirms is necessary.

**Codex (ChatGPT backend)** — authoritative client parser
[`openai/codex` `codex-rs/codex-api/src/rate_limits.rs` @ `4a3e829c`](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/codex-rs/codex-api/src/rate_limits.rs)
(audited 2026-08-18; `main` resolved to
`4a3e829c56415f8c1e69b18fbe74f4d81eaa926a` at audit time and the file at that
SHA was verified byte-identical to the audited content; located via GitHub
code search `repo:openai/codex x-codex-primary-used-percent`): family prefix
`x-<limit_id>` (default `x-codex`, additional metered limit ids possible,
e.g. `x-codex-other-*`): `x-codex-primary-used-percent`,
`x-codex-primary-window-minutes`, `x-codex-primary-reset-at`,
`x-codex-secondary-used-percent`, `x-codex-secondary-window-minutes`,
`x-codex-secondary-reset-at`, `x-codex-limit-name`,
`x-codex-credits-{has-credits,unlimited,balance}`,
`x-codex-rate-limit-reached-type`, `x-codex-promo-message`. `reset-at` is
epoch seconds. **The `[0,100]` range for `used-percent` is an assumption,
not a proven bound**: the client parser accepts any finite `f64` and no
authoritative range source exists — which independently justifies §2.4's
reject-to-NULL (never clamp) posture for out-of-range values. Same drift
caveat: these are unversioned backend headers; NULL-on-absent is the
contract. Per the safety contract, **no live provider call was made** to
observe any of these names.

## V5 — Keychain ACL interop (scratch keychain only)

**Answer: the landmine is real and the design's recommended default is
confirmed. Items created via the stdin-fed `security` CLI are read back by
`/usr/bin/security` prompt-free; an item created via in-process `SecItemAdd`
triggered a SecurityAgent GUI password dialog on the CLI read — which in a
headless child is a hang (our probe: killed by SIGALRM at exactly the 15 s
timeout), i.e. exactly the #277 failure the helper exists to avoid. The
create path for build item 3 must be the stdin-fed CLI (`/usr/bin/security
-i` with `add-generic-password ... -T /usr/bin/security`), not SecItemAdd,
unless SecItemAdd is paired with explicit ACL/partition-list work that is
itself proven prompt-free.**

Method and evidence (all on scratch keychains, placeholder secrets, both
deleted afterwards — `security delete-keychain` confirmed, zero keychain
files remaining under the probe dir):

```sh
KC="$ROOT/md518-recon-scratch2.keychain-db"     # $ROOT and $SCRATCH_PW from
security create-keychain -p "$SCRATCH_PW" "$KC" # the fixture section
security unlock-keychain -p "$SCRATCH_PW" "$KC" # in-terminal, never via GUI
security set-keychain-settings "$KC"            # no auto-lock

# create path A: stdin-fed CLI, reader trusted at creation
printf 'add-generic-password -s md518-svc-cli2 -a "" -w md518-placeholder-value-cli2 -T /usr/bin/security %s\n' "$KC" \
  | /usr/bin/security -i
/usr/bin/security find-generic-password -s md518-svc-cli2 -w "$KC"
# observed: md518-placeholder-value-cli2   (printed immediately, no prompt;
#   also held without -T: the CLI creator is implicitly trusted on its items)

# create path B: SecItemAdd (compiled Swift: SecKeychainOpen("$KC") +
# kSecUseKeychain, service md518-svc-secitemadd, placeholder value)
# observed: "SecItemAdd status: 0" (item created), then:
/usr/bin/perl -e 'alarm 15; exec "/usr/bin/security", "find-generic-password", "-s", "md518-svc-secitemadd", "-w", $ENV{KC}'
# observed: SecurityAgent password dialog fired; the read produced no output
#   and died on SIGALRM at exactly 15 s (shell exit code 142). NOT retried.

security delete-keychain "$KC"   # observed: removed; zero *.keychain-db left
```

**Probe-design incident, recorded:** the path-B read attempts raised two GUI
keychain dialogs on the operator's screen (denied by Tim). A recon probe must
never require the human at the screen; the corrected method above
(in-terminal unlock, `-T` at creation, no retry of a prompting read) is the
one future suites must use. The dialogs are themselves the V5 data point: the
prompt names the *item* ACL, so this is creator-ACL behavior, not a locked
keychain.

**Caveat (review nit 9, recorded as required):** scratch-keychain ACL
behavior may differ from the login keychain (partition-list handling on the
login keychain is stricter for signed-app creators). This result is necessary
evidence, not sufficient; build item 3's named test must re-prove
prompt-freeness for the shipping create path, still on a scratch keychain,
and the first real-install activation should treat a prompting read as an
honest failure state.

---

## Summary of design contradictions / amendments found

1. **§2.6 removal choreography contradicted (V3):** removal hot-reloads —
   there is no "pending restart" state in either direction; and removing the
   last `api-keys` entry silently reopens the proxy to accept-all.
2. **V2 flip is immediate (V2×V3):** enforcement begins ~2 s after the file
   write; the consent screen's "pending restart" framing and any assumption
   of a restart-shaped grace window are wrong. #521 is gated on pre-flight
   client-coverage evidence (conditional build).
3. **`source` leaks upstream key material for key-configured coexist proxies
   (V1 side-finding):** ModelDeck's ingest stores `source`, and the pinned
   proxy puts the raw upstream `*-api-key` credential there for api-key
   auths. Recorded as an acceptance criterion on #519 (hash-or-drop `source`
   when `auth_type == "apikey"`, with a regression test).
4. **The proxy rewrites config.yaml at first boot** (bcrypt-hashes a
   plaintext management secret): §2.6's byte-compare baselines must be taken
   from a config the proxy has already settled, or the first consented write
   will detect a "foreign" change that is the proxy's own.
5. **Rider parsing details (V4a):** header values arrive as arrays; the
   record's `request_id` is the proxy's, not the provider's — rider 1 reads
   `response_headers["Request-Id"]`; unified `utilization` (fraction) vs
   `fallback-percentage` (percent) use different scales.

## Safety-contract confirmation

Spawned isolated instance on 127.0.0.1:18421 (port verified free first);
upstream was a local mock on 127.0.0.1:18422; live ports 8317/3867 never
contacted; zero provider requests and zero quota spend (V4(b) via docs +
provider client source only); queue reads count=1 against the isolated
instance only; placeholder identities/keys/secrets throughout; V5 on scratch
keychains `md518-recon-scratch{,2}.keychain-db`, both deleted; the live login
Keychain and existing ModelDeck/cli-proxy-api items untouched.
