# 0010 — Adoption respects the user's setup: identify by executable, tolerate user ops jobs

- Date: 2026-08-14
- Links: #422, #401

The supervising process is identified by the actual executable being run, never by
name-matching "cliproxyapi" — the field machine ran an unrelated rebalance cron whose
label also contained the string, and name-matching would have stopped the wrong job.
User-run jobs around the proxy, notably the rebalance cron editing routing weights, are
deliberately left alone at 1.0: management doesn't need to own every job that touches
the proxy's config to do its job.
