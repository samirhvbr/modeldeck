# 0009 — Proxy detection is one named, non-destructive endpoint check

- Date: 2026-08-14
- Links: #422, #400

Detection uses exactly GET /healthz then one authenticated GET /v0/management/config —
never an endpoint scan, and never the usage-queue endpoint, because reading that queue
consumes it (0007). One known side-effect-free handshake avoids both false positives
and accidental data loss.
