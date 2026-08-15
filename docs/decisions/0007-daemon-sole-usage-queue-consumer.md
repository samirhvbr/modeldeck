# 0007 — Daemon is the usage queue's sole consumer, with loud double-consume detection

- Date: 2026-08-12
- Links: #400

The daemon is CLIProxyAPI's one and only usage-queue consumer (the queue drains
destructively on read; a second reader silently steals half the records), retiring the
old poller. Since the stock proxy can't structurally prevent a second consumer,
ModelDeck detects and loudly flags one instead — with a tripwire test that replays a
double-consume and asserts the warning fires.
