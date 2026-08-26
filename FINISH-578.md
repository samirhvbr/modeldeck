# Issue #578 finish report

## Outcome

The multi-profile configuration linter v1 is implemented and left uncommitted. `modeldeck lint` runs the same pure MD-L01 through MD-L15 engine used by the daemon. It supports a human table and `--json`, returns a nonzero status only when an error finding exists, and gives every finding a stable SHA-256 fingerprint.

The daemon keeps the latest report in memory, serves it from `GET /api/config-lint`, runs on demand through the mutation-guarded `POST /api/config-lint/run`, runs once at startup, and schedules the next run 24 hours after completion. No UI or notifications were added.

The reviewed spec now lives at `docs/config-linter.md`. The draft status line is gone, the old draft path is absent, and the recorded-rulings section cites issue #578 and Tim's 2026-08-25 decisions.

## Files touched

- `bin/modeldeck.mjs`: adds `modeldeck lint`, `--json`, read-only store opening, table output, and the error-only exit rule.
- `docs/config-linter.md`: promoted reviewed spec with the recorded rulings.
- `src/config-linter.mjs`: pure registry, predicates, findings, uncertainty handling, fingerprints, and table rendering.
- `src/config-linter-snapshot.mjs`: read-only collection of the closed input set, containment checks, race checks, launchd classification, proxy metadata, stored daemon facts, PATH enumeration, and runtime override checks.
- `src/adapters/codex.mjs`: extracts only the approved `tokens.account_id` slice through the shared offset parser.
- `src/db.mjs`: adds sanitized daemon facts and a read-only SQLite/WAL image loader that creates no database sidecars or shared-memory reader marks.
- `src/paths.mjs`: adds the configurable `.zshenv` path.
- `src/server.mjs`: adds the findings and run endpoints plus daemon lifecycle wiring.
- `src/service.mjs`: adds startup, on-demand, and daily runs; stores the latest report; persists already-computed CLI version and Claude reset facts; and exposes allowlisted proxy metadata through the existing reader.
- `src/shared-scope.mjs`: shares the offset-based JSON object inspector and enforces JSON whitespace and syntax without decoding unapproved values.
- `test/config-linter-engine.test.mjs`: registry, fire, no-fire, could-not-evaluate, version, shape, and fingerprint tests.
- `test/config-linter-snapshot.test.mjs`: collector, containment, race, redaction, no-write, failure, PATH, launchd, proxy, and runtime override tests.
- `test/config-linter-cli.test.mjs`: MD-L04 tracer, formats, exit status, stored facts, read-only WAL, no-write, and failure output tests.
- `test/config-linter-daemon.test.mjs`: latest report, failure containment, startup/daily scheduling, stored facts, and endpoint guard tests.
- `test/fixtures/config-linter/`: clean, firing, and unavailable snapshots plus a file estate containing placeholder identities only.
- `test/codex-duplicate-token.test.mjs`: adds malformed trailing-whitespace coverage to the identifier reader.
- `test/proxy-weights.test.mjs`: proves whitespace-only credential strings do not establish membership.

## Rule status

Every rule has a stable ID, predicate, incident source, verified CLI versions, suggested fix, and severity.

| Rule | Status | Result |
| --- | --- | --- |
| MD-L01 | Shipped, error | Reports `apiKeyHelper` in a managed Claude profile. |
| MD-L02 | Shipped, error | Reports managed-profile API key or auth token overrides by property presence only. |
| MD-L03 | Shipped, warn | Compares the sanitized base URL origin with the expected proxy and checks the proxy roster. Userinfo, path, and query values never enter findings. |
| MD-L04 | Shipped, error | Reports missing, non-symlink, dangling, or outside-root Claude and Codex activation links when managed accounts exist. This is the end-to-end tracer through engine and CLI. |
| MD-L05 | Shipped, error | Requires the real generated Claude shell source, matching config and secure-storage pins, and a pin matching the active profile. |
| MD-L06 | Shipped, warn | Requires the complete generated Codex pinning block when two or more valid Codex homes exist, including unregistered homes found under the managed root. |
| MD-L07 | Shipped, error | Reports duplicate Codex account identifiers and stored Claude weekly-reset fingerprints. Cold daemon and one-shot CLI runs consume persisted facts. |
| MD-L08 | Shipped, warn | Checks both profile roots and every registered or discovered profile home for owner-only directory state and current-user ownership. |
| MD-L09 | Shipped, error | Reports malformed, non-object, or non-regular `.claude.json`; transient reads become could-not-evaluate. |
| MD-L10 | Shipped, warn | Checks shared-memory links and shared-scope manifest and backup-marker consistency without following manifest paths outside `backups/`. |
| MD-L11 | Demoted and shipped, info | PATH candidates are enumerated, sorted, realpath-deduplicated, and stable across reruns without spawning `claude`. Only the daemon-selected executable has stored version evidence. Multiple reachable executables with incomplete version evidence therefore produce a could-not-evaluate info finding. The stable two-run test passed and recorded zero process spawns. |
| MD-L12 | Shipped, error | Reports the ModelDeck launchd job when it is spawn-failed with exit 78 or the recorded launch-constraint marker. Missing verdicts become could-not-evaluate. |
| MD-L13 | Shipped, warn | Reports every positive-weight proxy auth file that no registered account claims, including incomplete credential files; unreadable peers remain visible and an empty readable directory is a clean no-fire. |
| MD-L14 | Shipped, warn | Checks management-key presence for a managed proxy and checks metadata permissions without reading its contents. |
| MD-L15 | Shipped, warn | Reports active daemon path overrides that split the database, Claude profiles, Codex profiles, Claude shell file, proxy auth directory, or proxy management-key path across installs. |

The clean fixture produces no findings. The firing fixture produces at least one decided finding at the registered severity for every rule. The unavailable fixture produces a could-not-evaluate finding for every rule, never an error.

## Verification

Focused linter run after the final parser fix:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Engine | 10 | 0 |
| Snapshot collector | 29 | 0 |
| CLI | 13 | 0 |
| Daemon | 6 | 0 |
| Total | 58 | 0 |

Related checks:

- Proxy weights: 12 passed, 0 failed.
- Codex duplicate identity: 7 passed, 0 failed.
- CLIProxyAPI compatibility: 5 passed, 0 failed, 1 expected skip because the live binary is not built in this worktree.
- Shared scope: 29 passed; its one endpoint test hit the known sandbox `listen EPERM` on `127.0.0.1`.
- `git diff --check`: clean.
- Fixture identity scan: no real user path, common real email domain, or token pattern found.
- The full collector and full CLI no-write tests compare root and descendant directory mtimes, file mtimes, modes, symlink targets, and file content before and after. Both passed with zero changes.

Historical in-sandbox `npm test` result from the initial implementation:

- 1,080 tests total.
- 1,057 passed.
- 21 failed.
- 2 skipped.
- All 21 failures are the known sandbox `listen EPERM` refusal on `127.0.0.1` in localhost API tests.
- Zero non-EPERM failures.
- The two skips are the existing missing esbuild development dependency and the unbuilt live CLIProxyAPI binary.

The later verified outside-sandbox result was 1,087 tests total; 1,086 passed; 0 failed; 1 skipped.

## Safety evidence

- Linter runs do not call filesystem mutation methods, Keychain tools, provider APIs, provider CLIs, or network clients.
- The collector opens managed and proxy files read-only. Canonical-root and inode checks stop profile swaps, and `O_NOFOLLOW` file handles stop proxy auth symlink swaps.
- The one-shot CLI opens the database through an in-memory image. WAL magic, page sizes, salts, header checksum, frame checksums, and commit sizes are validated before committed frames are applied. A bad WAL becomes 15 could-not-evaluate findings and creates no sidecars.
- URL evidence keeps only `URL.origin`. It drops credentials, paths, and query data.
- Unreadable, malformed, transient, and version-unknown inputs remain visible as could-not-evaluate findings. They do not crash, silently disappear, or become error findings.
- The collector reuses `readCodexAccountId`, the daemon's proxy metadata reader, and the offset parser in `src/shared-scope.mjs`. It does not call the mutation-oriented shared-scope document method because that path can schedule reconciliation and silently omits invalid profiles. The linter-specific metadata guard keeps those invalid profiles reportable while sharing the established JSON boundary.

## Review and regression checks

Three independent finders and a separate skeptic reviewed the change. Confirmed issues were fixed and kept as regression tests. They covered URL redaction, profile and proxy symlink escapes, directory and file swaps, WAL bounds and checksums, persisted version and duplicate facts, cold-daemon duplicate state, exact shell blocks, unregistered Codex homes, incomplete positive-weight proxy files, empty proxy directories, transient I/O, strict JSON syntax, PATH failures, shared-manifest traversal, all MD-L15 path pairs, safe launchctl selection, and compatibility with services that do not inject a proxy file opener. The skeptic reran the seven latest reproductions against the final code and found no remaining confirmed defect in that set.

One additional audit defect was found after that checkpoint. The named cause was: trailing-content checks used JavaScript `.trim()`, which accepts whitespace characters that JSON rejects, so malformed documents could be treated as valid. Four red tests reproduced it across `.claude.json`, Claude settings, Codex identity, and proxy auth metadata. A shared strict JSON-whitespace boundary fixed all four, and the kept tests now pass.

## Limits and deliberate unknowns

The literal requirement that no secret byte ever enter memory could not be met while reusing the established full-buffer offset parser. Each secret-bearing JSON file is first read into a source buffer. The parser then validates structure and decodes only approved slices, and secret values never enter returned objects, findings, logs, or stored facts. Removing the source-buffer exposure requires a streaming byte parser for all affected JSON readers, which is a larger replacement of the established shared-scope discipline and was not added in this lane.

The app-owned managed proxy has explicit launch state: it is managed by the app, not launchd. An unmanaged external proxy remains `unknown` because the repository records no safe LaunchAgent label for it. Matching an arbitrary job by executable name could inspect the wrong process, so the collector does not guess.

No UI, notification, auto-fix, provider call, provider CLI spawn, Keychain read, or live-session inspection was added.

## Fix round 1

1. The launchd collector now accepts `launchctlPath` or `readLaunchd`, defaults the executable to `/bin/launchctl`, and the CLI passes `MODELDECK_LAUNCHCTL_PATH`. All collector tests use the canned reader, all CLI tests use the fixture executable, and the seam test rejects `/bin/launchctl`. Pinning tests: `launchd inspection honors the injected executable and never touches live launchctl in tests` and `CLI launchctl override reaches the collector without touching the live daemon`.
2. Full healthy and incident-shaped `launchctl print` dumps now cover job-level state, exit 78, the LWCR marker, and later nested `state = active` lines through classification and MD-L12 evaluation. Pinning tests: `incident-shaped full launchctl dump reaches MD-L12 despite later nested active states` and `healthy full launchctl dump remains an MD-L12 no-fire`.
3. Shared-scope `manifest.json` now uses the no-follow regular-file reader and the shared byte-offset JSON inspector, decoding only `mergedProfiles` and `memoryEnabled`; parse failures cannot echo source bytes into MD-L10 evidence. Pinning test: `malformed shared-scope manifest evidence never includes source bytes`.
4. Shell inspection now reads `.zshenv` and `claude-env.sh` through `O_NOFOLLOW` regular-file handles. Symlinks become could-not-evaluate evidence with a regular-file reason, and their targets are not read. Pinning test: `shell inspection refuses symlinked zshenv and Claude env files without reading their targets`.
5. MD-L03 now treats a missing or invalid expected proxy origin as could-not-evaluate with an explicit reason before comparing origins or consulting the proxy roster. Pinning test: `MD-L03 refuses to guess when the expected proxy origin is missing or invalid`.
6. MD-L05 now skips known activation-link defects already reported by MD-L04, records that policy in rule provenance, and leaves one error row for that root cause. Pinning test: `a missing Claude activation link produces MD-L04 without a duplicate MD-L05 row`.
7. The unused `configLintDaemonFactsAvailable` option was removed from both test fixtures. The stored-facts path remains covered without the flag by `cold daemon lint uses stored duplicate fingerprints before any refresh`.
8. No rate cap was implemented. The accepted residual is recorded in `docs/config-linter.md`: `POST /api/config-lint/run` relies only on the mutation gate and in-flight coalescing. This documentation-only item has no code test by instruction.

Historical in-sandbox root `npm test` result for this round: 1,087 tests total; 1,065 passed; 21 failed with the known sandbox `listen EPERM` refusal on `127.0.0.1`; 1 skipped; 0 non-EPERM failures.

Verified final outside-sandbox result: 1,087 tests total; 1,086 passed; 0 failed; 1 skipped.

## Fix round 2

1. CLI and daemon lint now use one shared service-to-snapshot options mapper, including the configured launchctl executable. Pinning tests: `CLI launchctl override reaches the collector without touching the live daemon` and `daemon config lint passes its launchctl override through the shared snapshot options`.
2. MD-L15 builds proxy comparisons only when the proxy config directory exists and skips unset proxy values, so unrelated data-directory splits remain reportable. Pinning test: `runtime override lint reports a data-dir split when proxy paths are unset`.
3. The package and lockfile now require Node `>=24.16.0`, the first release with the read-only SQLite `deserialize` path this CLI uses. Pinning test: `CLI read-only store declares the Node 24.16 deserialize floor`.
4. The complete CLI no-write check now asserts the nonzero exit and the expected two MD-L04 report scopes before comparing the estate. Pinning test: `a complete CLI lint makes zero content or mtime changes in its fixture estate`.
5. The grounding paragraph no longer starts a line with an issue-number heading token, clearing markdownlint MD018. Documentation-only finding; no code test was requested.
6. Earlier sandbox `npm test` numbers are explicitly historical, and the verified final outside-sandbox result is recorded as 1,087 total, 1,086 passed, 0 failed, and 1 skipped. Documentation-only finding; no code test was requested.

Required in-sandbox root `npm test` result for this round: 1,090 tests total; 1,068 passed; 21 failed with the known sandbox `listen EPERM` refusal on `127.0.0.1`; 1 skipped; 0 non-EPERM failures.
