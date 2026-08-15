# 0003 — Swift is the shell; Node stays the data plane

- Date: 2026-08-12
- Links: #397, #402

For 1.0, Swift owns the window, onboarding, and proxy lifecycle; the existing Node data
plane (ingest, SQLite, analytics, dashboard) ships as-is as the built daemon binary.
Porting it would rewrite 657 already-tested Node tests for zero user-visible gain and
would dominate the 1.0 build cost.
