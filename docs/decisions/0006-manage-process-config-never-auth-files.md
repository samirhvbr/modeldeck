# 0006 — ModelDeck manages the proxy's process and config, never its auth files

- Date: 2026-08-12
- Links: #398, #401

Under management, ModelDeck owns starting/stopping CLIProxyAPI and its config, but
CLIProxyAPI remains the only writer of its auth files at ~/.config/cliproxyapi;
re-login drives the proxy's own sign-in flow. This preserves the "never stores
credentials" contract and makes existing installs adoptable with no credential
migration. Enforced by the managed-proxy-never-writes-auth tripwire.
