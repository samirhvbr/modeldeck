# 0016 — Per-profile identity via securestorage scoping; ModelDeck never touches tokens

- Date: 2026-07-20
- Links: #62

Per-profile Claude identity comes from scoping Keychain lookup with
CLAUDE_SECURESTORAGE_CONFIG_DIR plus a one-time manual /login per profile, so the CLI
itself writes each account's OAuth — ModelDeck never reads, writes, or copies a token.
Chosen so the design degrades honestly (an identity-mismatch state) rather than
silently lying if the undocumented behavior changes upstream.
