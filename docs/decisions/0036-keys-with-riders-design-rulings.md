# 0036 — Keys-with-riders design rulings (D1–D6)

- Date: 2026-08-18
- Links: docs/keys-with-riders-design.md (the reviewed design, PR #506), issue #500, control-plane grilling close record ruling 5, 0032, 0034

Tim signed off the keys-with-riders design and ruled its six open decisions,
all per the design lane's recommendations (in-session, 2026-08-18):

- **D1** — the key→profile mapping is a daemon-owned SQLite table of SHA-256
  key hashes, updated transactionally with ingest; no credential-shaped value
  enters the database.
- **D2** — config backups live in ModelDeck's own state directory; the proxy-dir
  write guard stays at exactly two files.
- **D3** — proxy restarts are never automatic: user-triggered "restart now" for
  managed proxies, honest "pending your restart" for coexist (restarts kill
  live streams — same ground as the rebalancer rule).
- **D4** — receipts keep the profile label true at ingest (as-at history); a
  stable profile id is stored so a later bulk remap stays possible.
- **D5** — Claude-first; Codex parity is a follow-up marker gated on Codex
  traffic actually routing through the managed proxy.
- **D6** — the legacy shared Keychain item is left in place with removal
  offered, never auto-deleted; requests still using it attribute as honest
  NULL.

The sign-off also covers the two security-review-driven design changes:
per-profile Keychain service names (`cli-proxy-api-client.<slug>`; the bare
name stays exclusively legacy) and legacy-key admission during migration so
enabling enforcement never 401s a live session. Build items are filed off the
design's §5 with its verification gates (V1–V5) intact.
