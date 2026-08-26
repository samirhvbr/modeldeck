# Issue #560 stage 2a: daemon Grok home discovery

## Delivered

`GET /api/grok/home-candidate` discovers the default Grok home (the parent of
the configured `GROK_SESSIONS_DIR`, normally `~/.grok`) or a `?path=...`
override. Existing paths are returned through `realpath`.

Response shape:

```json
{
  "path": "/canonical/grok/home",
  "exists": true,
  "isDirectory": true,
  "ownedByCurrentUser": true,
  "writableByOthers": false,
  "permissionsOk": true,
  "hasCredentials": true,
  "alreadyRegisteredAs": null,
  "lastSessionAt": "2026-08-23T19:20:21.000Z",
  "hint": null,
  "readFiles": [
    "/canonical/grok/home/auth.json",
    "/canonical/grok/home/sessions/*/*/updates.jsonl"
  ]
}
```

`alreadyRegisteredAs` is currently `"claude"`, `"codex"`, `"grok"`, or `null`.
`lastSessionAt` is the newest `updates.jsonl` mtime when it can be derived.
The metadata walk streams entries and returns `null` rather than guessing if
its 10,000-entry bound is reached. Discovery uses metadata only: it never opens
`auth.json` and performs no writes under the candidate.

## Files touched

- `src/adapters/grok.mjs`: shared directory inspection used by discovery and
  the existing registration assertion.
- `src/service.mjs`: canonical candidate inspection, shared foreign-provider
  guard, credential-presence metadata check, bounded last-session discovery,
  response assembly.
- `src/server.mjs`: GET route.
- `test/api.test.mjs`: fixture-only API coverage for ready, missing,
  other-writable, foreign-provider, override/realpath, configured-session
  symlink, scan bound, and zero-write/no-credential-open behavior.
- `FINISH-560a.md`: this handoff.

## Reused instead of added

- `POST /api/accounts` still validates Grok registration through
  `validatedGrokProfileRef`; it now consumes the same inspection and
  foreign-provider guard as discovery instead of carrying a second ruleset.
- `POST /api/refresh` already calls `refreshAll()`, whose existing
  `refreshGrok()` records the card's billing snapshot. No refresh endpoint,
  timer, or billing hook was added.
- The existing `GROK_SESSIONS_DIR` layout and `auth.json` presence-only posture
  remain the source of truth.

## Verification

- Endpoint seam: 9 passed, 0 failed.
- Existing Grok registration/security/refresh tests: 41 passed, 0 failed.
- `git diff --check`: passed.
- Isolated correctness, security, and spec review found two minor endpoint
  issues; both gained regression checks and were fixed. The incremental review
  found no remaining issue in this diff.
- Final `npm test`: 1,032 total; 1,002 passed; 28 failed; 2 skipped.
  - 21 failures are sandbox `listen EPERM` errors on `127.0.0.1` in existing
    socket-listening tests. The new endpoint test uses the in-process HTTP seam
    and passes here.
  - 7 failures are existing dashboard render timeouts. One was reproduced from
    an archive of committed `HEAD` with this diff absent, confirming it predates
    stage 2a.
  - The orchestrator should rerun `npm test` outside the sandbox as planned.

## Separate pre-existing security findings

The required security review confirmed two issues in committed code that this
endpoint did not introduce. They were left out of this scoped diff:

- The home-collision guard is one-way: Grok registration refuses an existing
  Codex/Claude home, but a Grok home registered first can later be registered
  as Codex through a caller-supplied in-tree path.
- The Grok billing probe validates `auth.json` and then opens it by path, leaving
  a parent-directory replacement race between the final metadata check and the
  read.

Both reproduced with temporary fixtures and should be dispositioned separately.
No live credentials, provider calls, or live paths were used.

## Fix round 1

1. `GET /api/grok/home-candidate` now applies the same mutation-token,
   session-cookie, and Origin check as mutation routes. The test `happy path
   uses the configured default and derives the last session time` proves an
   untokened request gets 403 and a tokened request gets 200.
2. `inspectGrokProfileRef` now turns non-`ENOENT` canonicalization and directory
   inspection errors into the normal unavailable response instead of an HTTP
   error. The test `a permission error during canonicalization uses the
   ordinary unavailable shape` injects `EACCES` and pins the full 200 response.
3. The canonical home guard now checks every other account, including Grok
   accounts. The test `a home registered to Grok is reported and refused for a
   second Grok account` pins `alreadyRegisteredAs: "grok"`, its hint, the 400
   from `POST /api/accounts`, and the unchanged account count.
4. The service's existing environment-fact options now pass an injected user
   ID into Grok directory inspection. The test `a home owned by another uid has
   a stable refusal shape` pins the complete endpoint response, including
   `ownedByCurrentUser: false` and the ownership hint.

Verification: the focused in-process API test passed 12 of 12 checks. The
required `npm test` run completed 1,035 tests: 1,006 passed, 28 failed, and 1
skipped. The 28 failures were exactly the known baseline: 21 sandbox
`listen EPERM` failures and 7 dashboard finding-row timeouts.
