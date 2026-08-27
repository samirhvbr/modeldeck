# 0037 — Adopt-retry path: first attempt's running-session warnings not recovered

- Date: 2026-08-26
- Links: PR #590 (review round 2, finding N5), issue #586

When a legacy-home adoption times out client-side and the retry succeeds via
the 409-already-managed path, the daemon warnings computed during the first
(completed) attempt are not re-delivered — the 409 refusal carries none.
Declined as a fix: recovering them would need a warnings-replay endpoint for
a narrow double-failure window, while the sheet's standing caption ("Quit any
running Claude Code sessions before continuing") and the normal-path warning
delivery (PR #590, review finding F9) already cover the exposure. Revisit
only if a field report shows session-storage loss traced to this window.
