# Version — samirhvbr fork of ModelDeck

**Current version:** `0.1.0`
**Upstream:** `1.1.9` — timharris707/modeldeck @ `cc537d4` (`main`, 1 commit past `v1.1.9`)

The **first semver in this file is ours**, and that is not cosmetic: the hooks,
`release.sh` and `fleet.sh` all read the first semver
([ADR-012][adr]). Pointing that at `1.1.9` would hand our tooling a number we do
not control, cannot bump, and that moves on somebody else's schedule — including
backwards, when an upstream reverts ([ADR-023][adr]).

**No package string.** `package.json` is `"private": true` and this fork
publishes to no registry, so no package manager needs a derived
`<upstream>+<prefix>.<ours>` identifier. If one is ever needed, it is derived
from the two lines above and it is never the first semver in this file.

**The upstream's own version fields are theirs and are not edited here** — the
`VERSION` file and the `version` field in `package.json` both still read
`1.1.9`. Editing them conflicts on every sync, which is the one thing the two
forks that versioned themselves before this rule got right from the start.

**A sync is a delivery.** Pulling from `upstream` changes what this fork is, so
it bumps the version above and its entry names the upstream point we moved to —
even when not a line of our own code changed.

What this fork keeps from the upstream, what it adds, and why each divergence is
deliberate: [`docs/repodocs.md`](docs/repodocs.md).

[adr]: https://github.com/samirhvbr/repodocs/blob/master/docs/decisions.md

---

## Changelog

The upstream's [`CHANGELOG.md`](CHANGELOG.md) was **retired at v0.3.17** and is a
frozen historical record; upstream release notes live on
[their GitHub Releases](https://github.com/timharris707/modeldeck/releases). Our
history is kept here instead of in a second changelog file, because two
changelogs drift and this one decides what a version means.

## 0.1.0 — 2026-09-08

Fork bootstrapped against the fleet documentation standard
([samirhvbr/repodocs](https://github.com/samirhvbr/repodocs) 1.13.0), at the
first version of our own — our history begins where our changes begin, not at
the upstream's number.

- `version.md`: our version, the upstream point this fork sits on, and our
  changelog in the one file that decides what a version means.
- `upstream` remote configured — the only mechanical record of provenance, and
  mandatory under ADR-023.
- `.claude/`: the permission posture the fork was born without. The deny-list
  beats the allow-list; nothing for the Node/Swift stack is granted.
- `.continue/`: the queue, git-tracked on purpose.
- `docs/repodocs.md`: which parts of the standard this fork adopted, which it
  deliberately did not, and what would have broken if it had.

Nothing the upstream owns was touched: `LICENSE.md` (PolyForm Noncommercial
1.0.0), `NOTICES`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `VERSION` and
`package.json` are all as they came.
