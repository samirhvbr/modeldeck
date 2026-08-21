# Adversarial review — defect classes

<!-- Seeded by the team-workflow pack's setup skill for the adversarial-review skill.
     Every finder loads this file. It records defect classes PROVEN IN THIS REPO —
     nothing imported, nothing hypothetical. -->

The admission and removal rules live in one place — the adversarial-review skill
(§ The defect-class checklist) — and are not restated here. This file is data only.

An empty list was the correct starting state; the list fills at the speed real
defects escape.

## Classes

<!-- One entry per class. Name the pattern, not the incident; note where it was
     proven (PR/issue) so the repro is one link away. Example shape:

### <Area the classes cluster in>
- **<The pattern, stated as the rule that prevents it.>** Proven: <PR/issue link>.
-->

<!-- Seeded 2026-08-20 from a mining pass over the last 50 merged PRs (#468–#558):
     every class below is backed by two or more CodeRabbit findings that were
     verified and fixed in this repo, links inline. Baseline at seeding:
     1.6 actionable findings and 2.2 review rounds per PR. This seeding is a
     one-time backfill (Tim-directed, PR #563); every future class follows the
     adversarial-review skill's same-PR admission rule. -->

### Tests

- **A test must be able to fail when the behavior it names regresses.** Assert the
  specific expected values and the specific transition, not a condition that is
  already true before the action, a superset, or a path the fixture never creates.
  Test inputs must survive upstream validation gates, or the test aborts before the
  behavior under test. Proven:
  [#468](https://github.com/timharris707/modeldeck-private/pull/468) (per-project
  allocation unasserted),
  [#473](https://github.com/timharris707/modeldeck-private/pull/473) /
  [#474](https://github.com/timharris707/modeldeck-private/pull/474) (wait target
  already rendered before the click),
  [#531](https://github.com/timharris707/modeldeck-private/pull/531) (assertion
  against a directory the fixture never creates — always passes),
  [#543](https://github.com/timharris707/modeldeck-private/pull/543) (one member of
  the status set uncovered),
  [#510](https://github.com/timharris707/modeldeck-private/pull/510) (stale-state
  transition never exercised),
  [#529](https://github.com/timharris707/modeldeck-private/pull/529) (test input
  rejected by an upstream gate before the checked branch).
- **Tests never read the real clock.** Freeze or inject time everywhere, including
  in the server the test drives; a real-clock path makes assertions pass vacuously
  on empty windows. Proven:
  [#492](https://github.com/timharris707/modeldeck-private/pull/492) (midnight edge),
  [#508](https://github.com/timharris707/modeldeck-private/pull/508) (endpoint used
  `Date.now()` while the fixture pinned a date 17 days earlier).

### Ingest & reconcile

- **A replay/reconcile path must remove and narrow, never only add.** Rebuilding
  derived state merges across *all* surviving sources (not a clone of the top-ranked
  one), removes rows derived from vanished records, and recomputes fields whose
  upsert is monotonic (`MIN`/`MAX`/flag-`MAX` folds silently keep values from records
  that no longer exist). Replacing an accumulated record or set instead of merging
  orphans state from earlier passes. Proven:
  [#551](https://github.com/timharris707/modeldeck-private/pull/551) (zero-byte
  removal scope, suppression set replaced, monotonic session bounds),
  [#558](https://github.com/timharris707/modeldeck-private/pull/558) (`cwd` taken
  from `ranked[0]` only),
  [#531](https://github.com/timharris707/modeldeck-private/pull/531) (provisioning
  record replaced, orphaning earlier appends).
- **A skip-unchanged predicate must compare every identity dimension.** Size+mtime
  misses a same-stat replacement (compare inode too); a checkpoint that ignores
  parser identity/version never reprocesses files after a parser change. Proven:
  [#477](https://github.com/timharris707/modeldeck-private/pull/477) (both),
  [#513](https://github.com/timharris707/modeldeck-private/pull/513) (parser-aware
  skip in both ingestion paths).
- **Ownership is a recorded fact, never inferred from a matchable value.** A value
  or syntax match cannot prove an entry is ours — a user can independently create
  the same value, and removal/overwrite then destroys their entry. Blank or
  duplicate labels must be refused, not skipped by a truthiness guard. Proven:
  [#506](https://github.com/timharris707/modeldeck-private/pull/506) (value-matched
  managed entries, syntax-matched helpers, label collisions),
  [#529](https://github.com/timharris707/modeldeck-private/pull/529) (blank labels
  bypassed the uniqueness gate).

### Concurrency & shutdown

- **State snapshotted before an `await` is stale at commit.** Re-read or re-base
  daemon-owned fields after the awaits, or serialize the writers; otherwise the
  interleaved write is erased. When one such site is found, sweep for siblings —
  the same shape recurs. Proven:
  [#532](https://github.com/timharris707/modeldeck-private/pull/532) (`saveAccount`,
  plus the sweep-found `verifyAccount` twin),
  [#553](https://github.com/timharris707/modeldeck-private/pull/553) (safety fence
  cleared while the guarded operation could still resume).
- **Teardown drains everything it started, and async entry points are
  single-flight.** Scheduled ticks are tracked and awaited at shutdown; the listener
  closes before service teardown so a late request cannot re-open resources;
  `@MainActor` reentrancy at each `await` means a repair/retry path needs an
  explicit in-progress guard. Proven:
  [#550](https://github.com/timharris707/modeldeck-private/pull/550) (untracked
  scheduled tick; teardown racing accepted requests),
  [#517](https://github.com/timharris707/modeldeck-private/pull/517) (duplicate
  stale-launch repairs from reentrant `retry()`).

### Input validation

- **Boundary inputs get an explicit decision: empty, blank, negative, and huge.**
  Range checks bound both sides (`Number.isSafeInteger && >= 1` admitted a value
  that poisoned a one-way ratchet); invalid input is refused or stored as `NULL`,
  never clamped into a valid-looking value; negative elapsed times (clock skew) and
  zero-byte documents are real states. Proven:
  [#529](https://github.com/timharris707/modeldeck-private/pull/529) (generation
  unbounded above),
  [#506](https://github.com/timharris707/modeldeck-private/pull/506) (out-of-range
  clamp), [#472](https://github.com/timharris707/modeldeck-private/pull/472)
  (negative heartbeat age),
  [#531](https://github.com/timharris707/modeldeck-private/pull/531) (empty config
  document failed round-trip verification).
- **Distinct entities must not fold under one shared key.** An identifier derived
  from a partial dimension (level, kind) makes unrelated instances replace or
  interleave with each other. Proven:
  [#472](https://github.com/timharris707/modeldeck-private/pull/472) (notification
  id from level alone — model-drop and usage banners collide),
  [#509](https://github.com/timharris707/modeldeck-private/pull/509) (NULL-agent
  sidechain rows folded into one stream).

### Prose & records

- **Copy, comments, and docs must match the code at this commit.** UI copy must not
  claim a write that has not happened; a consent summary names *every* change the
  operation makes; a comment contradicting the assertions under it is a defect; a
  handoff/doc claim made stale by this very PR gets updated in it. Proven:
  [#531](https://github.com/timharris707/modeldeck-private/pull/531) ("Written."
  shown before anything was written),
  [#506](https://github.com/timharris707/modeldeck-private/pull/506) (consent
  summary omitted the file-mode change),
  [#517](https://github.com/timharris707/modeldeck-private/pull/517) (comment vs
  assertions), [#493](https://github.com/timharris707/modeldeck-private/pull/493)
  (handoff claims made stale by the PR committing them).

### Performance

- **Serve-loop scans are bounded and near-linear.** No unbounded full-corpus reads
  and no per-item scans that multiply into `items × sessions × points` on the
  daemon's serve loop; cap rows, index lookups, binary-search points. Proven:
  [#509](https://github.com/timharris707/modeldeck-private/pull/509) (uncapped
  corpus read), [#512](https://github.com/timharris707/modeldeck-private/pull/512)
  (superlinear wire-failure attribution).
