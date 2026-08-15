# 0008 — Existing proxy: adopt with a visible handover, or honest coexistence

- Date: 2026-08-14
- Links: #401, #422

Detecting an existing proxy on :8317 yields a one-click adoption offer (no credential
migration needed per 0006); declining enters coexist mode where managed-only features
show as unavailable with a stated reason. A "Stop Managing" rollback keeps adoption
from being a one-way door, and every outcome is reported, never silent.
