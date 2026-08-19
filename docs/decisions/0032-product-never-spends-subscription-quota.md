# 0032 — The product never spends a user's subscription quota on itself

- Date: 2026-08-17
- Links: control-plane grilling close record, blume-sidecar-teardown §11 Q1, 0031

The shipped ModelDeck product never spends a user's subscription quota on its own
operation — analysis, audits, suggestions, anything. Permanent line, chosen over
Blume's model (their Improve pipeline burns the user's own Opus per conversation).
LLM-assisted features remain possible only on non-subscription engines (a local
model or a user-supplied metered API key), and each concrete such feature is
adjudicated by Tim when proposed and recorded then. Per 0031, this record is the
standing answer for product callers: on-quota is settled NO; off-quota is
per-feature ask. Receipts v1 and the whole chartered arc are zero-LLM by design,
so nothing currently planned invokes the off-quota path.
