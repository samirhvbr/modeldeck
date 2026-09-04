# 0039 — Extra Claude homes are scanned read-only, attributed to a profile label

- Date: 2026-08-29
- Links: issue #605
- Status: ratified — Tim's ruling of 2026-08-29 (track `~/.claude-insight-agents`)

Transcript ingest historically enumerated exactly one root, the managed
`claude-profiles` directory, so a Claude home living elsewhere (the
insight-chat agent fleet under `~/.claude-insight-agents`) was invisible to
analytics. Its account also left the CLIProxyAPI pool on 2026-08-26, so the
quota curve had zero attribution from either corpus. Tim ruled he wants such
homes tracked.

The ruling, as shipped:

- The `extraClaudeScanRoots` setting lists additional Claude homes, each
  attributed to a profile label ({ path, profileSlug }). The label is free
  text — pointing it at a managed profile is the operator's contract, not
  daemon-enforced (profiles can be created after the setting). On Tim's
  machine `~/.claude-insight-agents` maps to `lend-management`.
- Extra roots are strictly read-only toward the scanned directory: ingest
  opens read streams only, never writes, never repins, never touches the
  home's Keychain (the insight-fleet hands-off standing rule). A tripwire
  test asserts the scanned tree is byte- and mtime-identical after ingest.
- The never-traverse-symlinks rule holds inside extra roots, and a root that
  is itself a symlink is skipped — `~/.claude` can never be wired in to
  duplicate rows. Roots overlapping the managed profiles directory are
  skipped for the same reason.
- No app UI: the list is edited via `PUT /api/settings`. Any future UI for
  it needs Tim's visual sign-off separately.
