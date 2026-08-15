# 0024 — Weight badge shows effective weight for the displayed view

- Date: 2026-08-06
- Links: #272, PR #274

The per-account weight badge shows the account's EFFECTIVE routing weight for the
currently displayed view (Fable vs Weekly), reading the daemon's excluded-models flag —
an account benched from Fable duty still carries weight for general-pace duty, so one
fixed raw number would mislead.
