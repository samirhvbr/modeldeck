# 0012 — Proxy pin rides app releases; always built from pinned source, never re-signed

- Date: 2026-08-14
- Links: #403, #399

The bundled CLIProxyAPI pin updates only with app releases — swapping the embedded
binary forces full re-notarization anyway, so a separate cadence buys nothing — and is
always built from the pinned upstream source commit in ModelDeck's CI and signed with
ModelDeck's identity, never a re-signed upstream blob. It ships with no entitlements by
default; one is added only after a real hardened-runtime failure, with the reason
recorded beside the signing step. A security-only CVE path may bypass the release train
but still rides the pin-bump compatibility tripwire suite.
