# Claude Code profile — ModelDeck (samirhvbr fork)

> **Status:** `ACTIVE`

`.claude/` in this repository follows the standard of the samirhvbr/Blue3 fleet:
a **model profile** plus a **permission posture**, both versioned.

Conduct rules for the agent are in [CLAUDE.md](../CLAUDE.md).

## Files

| File | Role |
|------|------|
| `settings.json` | The **active** profile, versioned. |
| `settings.local.json` | Machine-local override, **gitignored** — it may hold paths and tokens that belong to one machine. Never commit it. |

## The deny-list beats the allow-list — always

`Bash(git push:*)` is allowed, and `git push --force` / `-f` is still blocked.
That asymmetry is the point: pushing is routine, rewriting published history is
not, and no allow-list entry can re-open a denied one. The same holds for
`git reset --hard` and `git clean -fd`.

Secret reads are denied by path (`.env`, `*.pem`, `*.key`, `*.p8`, `*.p12`,
`*.pfx`). A guard added after the first secret lands is a guard added too late.

## Granting a new permission is the owner's act

The skeleton grants **reading, writing and git, and nothing else**. Nothing for
your stack is granted yet — no build, no test, no package manager, no database
client. That is deliberate.

When a permission needs to exist, it is **written into `settings.json` together
with its reason and how to revert it** — never applied silently, and never left
as a promise in prose.

That last clause is not style. In a sibling repository the agent guide claimed
`git pull` was "pre-authorised (allow)" while no such rule existed in any
settings file; the norm and the artefact disagreed for weeks. A norm that does
not match the artefact is a defect.

<!-- Record each grant here as you make it: what, when, why, how to revert. -->

| Granted | When | Why | Revert by |
|---|---|---|---|
| _(nothing yet)_ | | | |
