# 0030 — Release DMG builds never run from a mktemp path

- Date: 2026-07-23
- Links: v0.3.4, PR #155

Release builds must run from a worktree under /private/..., never a mktemp
/var/folders path: macOS symlinks /var to /private/var, which silently breaks the
daemon-manifest writer's is-main-module check, and release-dmg.sh then dies later with
a confusing error. This bit a real release once (a process fact-record, accepted into
the store 2026-08-14).
