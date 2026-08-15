# 0020 — Renewal candidacy keyed solely on the remembered refresh error

- Date: 2026-08-12
- Links: #264

Whether an account is a renewal candidate stays keyed only on its remembered refresh
error (signinReason "expired"), never on incoming statusline data — a fresh statusline
capture changes only how the account is presented. Clearing the error the moment an
account looks healthy would stop auto-renew exactly when Tim wants it still running in
the background.
