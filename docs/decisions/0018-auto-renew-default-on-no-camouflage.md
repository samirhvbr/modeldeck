# 0018 — Scheduled auto-renew ships on by default; no traffic camouflage

- Date: 2026-07-31
- Links: #176

Guarded auto-renewal of expired-idle accounts ships on by default so the deck shows
real usage without manual re-login — but any traffic disguising or randomization as
camouflage was explicitly rejected. Only the CLI's own lazy-renewal mechanism (a real,
cheap, legitimate invocation) is used, disclosed plainly.
