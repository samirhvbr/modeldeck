# 0039 — The proxy and the CLIs upgrade as tested pairs, watched through a two-lens pin-watch

- Date: 2026-09-01
- Status: ratified — Tim approved all five measures in session
- Links: docs/live-proxy-ops.md, docs/RELEASE.md (upstream watch), scripts/version-skew-check.mjs

On 2026-09-01 two failures landed at once: Codex broke because the Homebrew
Codex CLI moved to 0.147.0 while the live CLIProxyAPI binary stood still, and
Fable 5.1 was unusable because the proxy stamps a Claude client fingerprint
older than Anthropic's minimum for new models. Root cause in both cases: we
tracked one version (the proxy's) through one lens (security), while health
actually depends on three versions agreeing — proxy, Codex CLI, and stamped
client identity.

Ruled, five parts:

1. CLI upgrades are held and applied as tested pairs with the proxy, never
   blind (`docs/live-proxy-ops.md`). A frontier-model launch is an expected
   skew event.
2. The pin-watch verdict answers security **and** compatibility
   (`docs/RELEASE.md`, upstream watch section).
3. A quota-free skew check (`npm run skew:check`) compares installed CLIs,
   the live binary, the bundled pin, and upstream releases against the
   recorded known-good pair in `scripts/version-pairs.json`.
4. Rollback is formal: the previous live binary is kept as
   `~/bin/cliproxyapi.bak-<version>` with a named swap-back procedure.
5. The proxy bypass (direct provider access per CLI) is documented as the
   outage escape hatch, not rediscovered under pressure.

A live per-provider canary was considered and rejected: it would spend
provider quota on every run, against the no-quota-spend rule. Automating a
direct-mode failover was rejected as more machinery than the failure rate
justifies; the documented manual bypass covers it.
