# 0035 — Grok/xAI becomes the third provider: corpus-first, after Receipts v1

- Date: 2026-08-17
- Links: control-plane grilling close record (addendum), docs/research/grok-xai-feasibility-2026-08-17.md, 0033

Tim ruled to add Grok/xAI as ModelDeck's third supported provider after the
feasibility spike cleared all three grades on evidence: the grok CLI's billing
endpoint returns ground-truth `credit_usage_percent` with a weekly/monthly window
(fits 0019); the local session store writes per-turn token splits richer than
either existing provider (incl. reasoning tokens and a direct cost field); and the
pinned CLIProxyAPI v7.2.130 already ships full xAI support including multi-account
load balancing — no fork, nothing to upstream. Sequencing: corpus-grade ingest
first (data already on disk, zero setup), then the quota probe, then wire/pool —
all starting **after Receipts v1 ships**; the v1 scope ruling (Claude+Codex, 0033)
stands. Grok-side caveats recorded in the evidence doc: widen the provider enum,
route per-model rather than wholesale base-URL override, read-only ingest (the
grok CLI uploads traces to xAI's bucket — our local-only posture is a selling
point, not a compromise).
