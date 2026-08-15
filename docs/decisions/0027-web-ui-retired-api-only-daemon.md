# 0027 — Web UI retired; daemon is API-only; the native app is the one UI

- Date: 2026-07-21
- Links: #9, PR #84

The browser-based public/ dashboard was removed; the daemon serves /api/* only and the
native menu-bar app is the supported UI, avoiding two UIs kept in sync. The 1.0 app
window re-hosts the rebuilt single-file dashboard inside the app (0004) — this record
is why no separate browser UI exists.
