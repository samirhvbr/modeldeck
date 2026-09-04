# 0040 — The pool sign-in runs the binary holding the proxy port; two review findings declined

- Date: 2026-09-03
- Links: issue #625, decision 0010, docs/live-proxy-ops.md
- Status: recorded by the implementing session; Tim may overrule

Settings' "Add to proxy pool…" spawns CLIProxyAPI's login helper. Under
coexist the daemon's static PATH could not see `~/bin`, and the helper ran
without `-config`. The fix resolves a bare binary name to the executable of
the same-user process listening on the proxy port (kernel program text via
lsof, per 0010's identify-by-executable rule), then PATH and the known install
dirs, and passes `-config <CLIPROXY_CONFIG_DIR>/config.yaml` on every spawn.
Issue #625 had suggested reading the launch agent's plist or the recorded
`liveProxy.binaryPath` instead; both are Tim-machine artefacts the shipped
daemon does not carry, and the port holder covers coexist and the managed
proxy with one rule.

Two adversarial-review findings were declined, with reasons:

1. **A symlinked or version-suffixed install (`cliproxyapi -> cliproxyapi-7.2.149`)
   fails the basename check and falls back to PATH.** lsof reports the resolved
   target, so a launch agent pointing at a symlink is not recognised as the
   port holder. Declined for now: the live-proxy ops doc installs by `cp`, the
   app's own detector applies the same basename rule
   (`isCLIProxyExecutable`), and loosening to a prefix match widens what the
   daemon will execute. Revisit if a real install uses a versioned filename.
2. **`~/bin` is not in the PATH fallback list, so a join attempted with the
   launch agent stopped still cannot find Tim's binary.** Declined: a join
   with the proxy down is an edge case, `~/bin` is not a conventional install
   dir the way `~/.local/bin` is, and Tim's existing `/opt/homebrew/bin`
   symlink covers it. Documented in docs/live-proxy-ops.md instead.

Also corrected on the record: the issue said the app dropped the ENOENT code
from the message. The shipped daemon already appended it; the code sat at the
end of an 85-character sentence in a two-line Settings row. The message now
leads with the code.
