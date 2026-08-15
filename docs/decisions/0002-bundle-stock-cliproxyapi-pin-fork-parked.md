# 0002 — Bundle stock CLIProxyAPI, pinned and managed; fork stays parked

- Date: 2026-08-11
- Links: #378

ModelDeck ships a pinned, stock (unforked) build of CLIProxyAPI managed by the daemon;
forking stays parked and reopens only if upstream won't merge needed reporting hooks.
This avoids fork-maintenance burden unless upstream collaboration genuinely fails.
