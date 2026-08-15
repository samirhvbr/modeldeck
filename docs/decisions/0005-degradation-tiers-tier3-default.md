# 0005 — Degradation tiers preserved; bundled proxy defaults to tier 3

- Date: 2026-08-11
- Links: #378

Analytics keeps three degradation tiers — local-log only (1), window/quota via managed
OAuth (2), measured truth with pool attribution (3) — with out-of-the-box installs
defaulting to tiers 1–2 and a bundled managed proxy defaulting to tier 3. The app is
useful with zero setup, and the full install naturally lands on the highest-fidelity
mode.
