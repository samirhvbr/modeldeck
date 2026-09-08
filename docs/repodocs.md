# repodocs — the standard this fork follows, and where it deliberately stops

> **Status:** `ACTIVE` · What this repository adopted from the fleet standard,
> what it did not, and why each divergence is deliberate rather than an
> oversight.

This repository is a **fork of [timharris707/modeldeck](https://github.com/timharris707/modeldeck)
that we own**. Both halves of that sentence carry weight: we own the remote and
we push to it, and the code, the license and the release history are the
upstream's. The rule for exactly this case is
[ADR-023][adr] in
[samirhvbr/repodocs](https://github.com/samirhvbr/repodocs) — *a fork we own has
a version of its own, and records the upstream point it sits on.*

**repodocs is a source of consultation, not a dependency.** It is never a
submodule, never vendored. Nothing here installs it and nothing here breaks when
it moves.

## Why this file exists at all

An undocumented divergence reads as a mistake to the next person and gets
"fixed" back. This fork diverges from the skeleton in six places on purpose, and
in a fork the cost of a wrong "fix" is not untidiness — it is a merge conflict on
**every** sync with the upstream, forever.

## 1. What was adopted

| What | Why it was safe |
|---|---|
| [`../version.md`](../version.md) | The fork had **no version of its own at all**. Added at `0.1.0` — our history begins where our changes begin, not at the upstream's `1.1.9` (ADR-023 §1) |
| `upstream` remote | Mandatory under ADR-023 §7. The only mechanical record of provenance |
| [`../.claude/`](../.claude/) | The repository was born without a permission posture. Purely additive — the upstream tracks no `settings.json` |
| [`../.continue/`](../.continue/) | The queue. Purely additive |
| `docs/repodocs.md` (this file) | The record of the divergences below |

## 2. What was NOT adopted, and what would have broken

**Merge rule, non-negotiable: never overwrite a file the repository already had
because the skeleton has one with the same name.**

| Skeleton file | What is here instead | What adopting it would have cost |
|---|---|---|
| `LICENSE` (MIT, `Copyright (c) 2026 Samir Hanna Verza`) | **`LICENSE.md` — PolyForm Noncommercial 1.0.0**, the upstream's | **Relicensing somebody else's copyrighted work.** Not a style question and not ours to do. The conformance check `diff LICENSE repodocs/LICENSE` will never pass here, and must not |
| `NOTICE` | `NOTICES` — the upstream's real third-party attributions | Destroying attribution that the PolyForm license's *Notices* section requires be carried forward |
| `version.md` as the only version | `VERSION` and `package.json` still read `1.1.9` | Those are the **upstream's own version fields**. Editing them conflicts on every sync — the one thing both self-versioning forks in the fleet got right from the start (ADR-023 §3) |
| `CHANGELOG.md`, each `##` a commit subject | The upstream's `CHANGELOG.md`, **retired at v0.3.17** and frozen; our changelog lives inside `version.md` | Writing our entries into their frozen historical record. A changelog inside `version.md` is the sanctioned case — [runbook §8][runbook] says nothing is written and no second file is created |
| `CLAUDE.md` + `AGENTS.md` twins, with the three echo blocks | The upstream's `CLAUDE.md`, untouched | It is **their** agent context — it speaks of *"Tim's explicit sign-off"* and binds to `docs/agents/team-workflow.md`. Stamping echo blocks into it conflicts on every sync |
| `tools/git-hooks/` + `core.hooksPath` | Not installed | The upstream's subjects are `Sync: release X.Y.Z`. `commit-msg` would **refuse every commit this fork is about to receive** ([runbook §8][runbook]) |
| `.github/workflows/release.yml` + `tools/release.sh` | Not installed | It publishes. Cutting GitHub Releases on a fork of somebody else's project, against a version namespace that is theirs |
| `README.md` | The upstream's | It describes the product accurately. A second README answering the same question is the failure mode; the fix is not a third |

## 3. How this fork graduates

Nothing above is permanent. `fleet.sh` classifies a repository as
upstream-shaped by reading whether **the last five commit subjects are ours**.
Once they are, this fork stops being skipped and receives the hooks and the echo
blocks like any other repository — automatically.

**The heuristic is the adoption test, and there is no list to maintain.** Until
then `fleet.sh check` still reads this repository, in its `FORKS WE OWN`
section, where it verifies exactly four things:

- `version.md` exists
- its first semver is **ours**, not an upstream number in a local-version string
- it says which upstream point the fork sits on
- an `upstream` remote is configured

All four hold as of `0.1.0`.

The two items that would still not follow after graduation are `LICENSE.md` and
`NOTICES` — those are permanent, for the reason in §2.

## 4. Contributing back to the upstream

**None of this governs what we write into `timharris707/modeldeck`.** A pull
request or an issue there follows **their** language and **their** commit shape,
not ours ([ADR-019][adr] and
[conventions.md §8](https://github.com/samirhvbr/repodocs/blob/master/docs/conventions.md#8-language)).
Our `X.Y.Z - description` subject reads as noise in a repository that has no
`version.md` of ours, and there is no version there for us to bump.

Check before writing: a written instruction first, then the last ~20 merged pull
requests, then the issues, then the commit log. When it cannot be determined,
English (US).

## 5. Where each question is answered

| Question | Where |
|---|---|
| What is the documentation norm? | [repodocs `docs/conventions.md`](https://github.com/samirhvbr/repodocs/blob/master/docs/conventions.md) — the single source; never copied here |
| How does a fork version itself? | [repodocs `docs/versioning.md`](https://github.com/samirhvbr/repodocs/blob/master/docs/versioning.md#a-fork-we-own-versions-itself) and [ADR-023][adr] |
| What version is this, and of what upstream point? | [`../version.md`](../version.md) |
| What is still open here? | [`../.continue/README.md`](../.continue/README.md) — the queue, read first |
| What does the product do? | The upstream's [`../README.md`](../README.md) |

[adr]: https://github.com/samirhvbr/repodocs/blob/master/docs/decisions.md
[runbook]: https://github.com/samirhvbr/repodocs/blob/master/docs/runbook.md
