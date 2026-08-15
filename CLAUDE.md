# ModelDeck — repo agent context

## Never compromise

Properties no change may trade away without Tim's explicit sign-off:

1. **No provider-quota spend.** No test, probe, or review runs `claude -p` or
   anything else that spends provider quota; never touch the live Keychain or a
   running session; placeholder identities only.
2. **The usage-queue read is destructive** (count=1, always). Suites and tools
   talk only to their own spawned CLIProxyAPI instance; the live ports
   8317/3867 are banned (enforced at parse and config level in the compat
   suite — keep it that way).
3. **Auth is always substantial.** Changes touching auth, renewal, routing, or
   the shell-env writer always get the security lens and a full review — never
   a lightweight pass.
4. **Regression fixes ship with a tripwire.** A fix to a previously-reported
   bug isn't done until a check exists that would catch it coming back, named
   in the close-out.

## Team-workflow pack

- Repo bindings live in [docs/agents/team-workflow.md](docs/agents/team-workflow.md) —
  tracker, verify commands, decider, precedence. Read it before applying pack defaults.
- Before writing any PR description or comment on Tim's behalf, read the
  team-workflow pack's pr-writing reference (`orchestrate` skill,
  `references/pr-writing.md`). Applies to every session, not just orchestrated lanes.
