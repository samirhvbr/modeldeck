# 0017 — Launched sessions pin their config dirs against mid-session profile flips

- Date: 2026-07-21
- Links: #66, #62

ModelDeck-launched sessions pin CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR
to the profile's real (non-symlink) path, because the CLI resolves its config location
once at startup without realpath() — flipping the shared ~/.claude symlink mid-session
silently splits transcripts across profiles, and a later resume can "succeed" showing
only half the history with no error. Externally launched sessions remain exposed and
need a separate guard.
