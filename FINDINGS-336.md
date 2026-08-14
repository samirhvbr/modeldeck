# Issue #336 findings — proxy request ID ↔ Claude transcript requestId

## VERDICT

**PARTIAL — the available historical sources produce a 0% exact join, but the
response-header mechanism itself is inconclusive because this corpus does not
establish same-request population overlap.**

Across 12,868 Claude-provider proxy records, neither proxy candidate produced a
single exact transcript match. This includes 12,786 records with the
`claude-cli` + `agent-sdk` user-agent signature and 12,818 successful Claude
records carrying an Anthropic-shaped response `Request-Id`. The historical
backfill therefore yields project/session attribution for **0 requests**.

Decision 8's source document records that all seven profiles began routing
through the proxy only on 2026-08-07 evening. The latest transcript `requestId`
in the scanned corpus is `2026-08-07T13:46:49.678Z` (06:46 PDT), before that
routing period. There is consequently no established request population that is
known to occur in both sources. The eight-hex top-level proxy `request_id` is
ruled out as the transcript key; the same-shaped response `Request-Id` remains
an unvalidated candidate rather than a disproved mechanism.

This lane was deliberately read-only and did not touch running sessions or make
provider requests. A conclusive yes/no test of the header candidate needs a
separately authorized controlled trace or naturally produced proxy/transcript
records after routing, with both sides known to represent the same request.

## Reproduce

Run from the worktree root:

```sh
node scripts/spike/336-requestid-join.mjs
```

The script uses only Node built-ins, reads the profile directories directly
(never `~/.claude`), redacts proxy sources to `account-1` through `account-7`,
and prints all summary tables to stdout. The pull archive is live, so the default
run freezes the analysis to proxy timestamps strictly before
`2026-08-10T00:00:00.000Z`, the last complete UTC day at investigation time.
Use `--all` only when a live, moving denominator is wanted.

## Method

1. Enumerate every `pull-*.json` archive file. Skip documents whose `usage`
   member is not an array, require a valid record timestamp, and select every
   row before the fixed cutoff. The Claude sample is a census of available
   Claude-provider rows in that window, not a random subsample.
2. Enumerate `projects/**/*.jsonl` below all seven direct ModelDeck profile
   directories without following symlinks. This includes both project-level
   transcripts and nested `subagents/*.jsonl` files.
3. Stream JSONL one line at a time. Index every non-empty top-level
   `requestId`, including the four IDs found only on non-assistant refusal
   records. Dedupe repeated lines by exact `requestId` while tracking transcript
   location and conflicts in profile, `sessionId`, `cwd`, `gitBranch`, and
   `message.model`.
4. Test the two proxy candidates independently:

   - top-level `request_id`;
   - case-insensitive `response_headers["Request-Id"]`, flattening either scalar
     or array header values and rejecting ambiguous multi-value headers.

5. Use exact, case-sensitive string equality. A proxy row is accepted only if
   its candidate set resolves to exactly one transcript ID. No timestamp/model
   fuzzy matching is counted as a match.
6. As falsification checks, also compare after lowercase/trim normalization and
   compare response `Request-Id` to transcript `message.id`. The script prints
   both results; every alternative intersection is also zero.

## Populations and data quality

The analysis window contains 29,261 proxy records total:

| Population | Records | Accounts | UTC days | Timestamp range |
| --- | ---: | ---: | ---: | --- |
| All proxy providers | 29,261 | — | 11 | 2026-07-30T23:56:10.562Z–2026-08-09T16:10:30.241Z |
| Claude provider sample | 12,868 | 7 | 11 | same archive window |
| Claude CLI + agent-SDK user agent | 12,786 | 7 | 11 | same archive window |
| Codex provider | 16,393 | — | 11 | same archive window |

The sample exceeds the required 1,000 Claude records, three accounts, and two
days. Account labels are deterministic pseudonyms; no source identities are
written here or emitted by the script.

| Account | Claude records | UTC days | CLI + agent-SDK records |
| --- | ---: | ---: | ---: |
| account-1 | 781 | 2 | 781 |
| account-2 | 3,896 | 10 | 3,867 |
| account-3 | 1,471 | 9 | 1,468 |
| account-4 | 1,557 | 7 | 1,552 |
| account-5 | 1,308 | 2 | 1,290 |
| account-6 | 2,329 | 9 | 2,318 |
| account-7 | 1,526 | 9 | 1,510 |

Source-quality observations:

- The proxy file inventory is live and continued growing during the spike. The
  committed denominators are stable because record timestamps are filtered by
  the fixed cutoff; the script labels and prints the current file inventory
  separately. Nine early files had a non-array `usage` member and zero included
  rows had invalid timestamps in the recorded run.
- All seven profile directories were enumerated; one contained no JSONL files
  during the investigation. Profile-specific retention horizons cannot be
  assigned to unmatched proxy rows without first having a shared key.
- The transcript scan found 78,549 unique `requestId` values after removing
  82,534 duplicate request-ID lines. Thirty-six malformed lines were skipped.
  Even if every malformed line contained a distinct relevant ID, it could not
  explain the 12,849-ID zero intersection.
- The global transcript request-ID horizon is
  `2026-06-12T05:08:32.420Z`–`2026-08-07T13:46:49.678Z`. The proxy population
  continues beyond that horizon. Timestamp-envelope overlap before the recorded
  routing change is not evidence that the sources contain the same requests.

## Exact ID match rates

| Scope | Records | Top-level `request_id` matches | Response `Request-Id` matches | Exact match rate |
| --- | ---: | ---: | ---: | ---: |
| All proxy providers (overall) | 29,261 | 0 | 0 | 0.000% |
| Claude provider sample | 12,868 | 0 | 0 | 0.000% |
| Claude CLI + agent-SDK user agent | 12,786 | 0 | 0 | 0.000% |
| Claude with response `Request-Id` | 12,849 | 0 | 0 | 0.000% |
| Successful Claude with response `Request-Id` | 12,818 | 0 | 0 | 0.000% |
| Codex provider | 16,393 | 0 | 0 | 0.000% |

The two proxy candidate fields are demonstrably different from each other:

| Candidate | Present rows | Shape | Distinct IDs | Duplicate groups / excess rows | Transcript matches |
| --- | ---: | --- | ---: | ---: | ---: |
| top-level `request_id` | 12,868 | 8 hexadecimal characters | 12,843 | 16 / 25 | 0 |
| response `Request-Id` | 12,849 | `req_…`, 28 characters | 12,849 | 0 / 0 | 0 |

On all 12,849 Claude rows carrying both fields, the two values differ. The
top-level ID groups apparent retry/failover attempts inside the proxy archive,
but its eight-hex shape is structurally incompatible with the `req_…`
transcript keys. The response header has the same surface format as transcript
IDs and is unique, yet its exact set intersection with all 78,549 transcript
IDs is empty. Lowercase/trim normalization and the alternate transcript
`message.id` probe also produce zero. Because no same-request overlap is known,
that empty response-header intersection is a historical coverage result, not
proof of a different ID namespace.

## Transcript deduplication and subagents

| Transcript request-ID class | Unique IDs | Proxy matches |
| --- | ---: | ---: |
| Top-level transcript only | 36,035 | 0 |
| Subagent transcript only | 42,514 | 0 |
| Present in both locations | 0 | 0 |
| **Total** | **78,549** | **0** |

Subagents were therefore not omitted: 42,514 subagent-only IDs (54.124% of the
index) were checked. No unmatched proxy row can be positively labeled a
subagent request from these IDs because there is no intersection at all. A
top-level-only parser would be seriously incomplete for a future overlapping
capture, but including subagents does not provide historical attribution here.

Repeated transcript lines are not an inflation source in the reported rates:
the index is one row per exact `requestId`. Only 25 transcript IDs have any
non-time metadata conflict; three have a profile/session/project-dimension
conflict. None is reached by the proxy join.

## Unmatched classes

The classes below are mutually exclusive and sum to all 29,261 proxy records,
because the exact match count is zero.

| Unmatched class | Count | Interpretation |
| --- | ---: | --- |
| Codex provider | 16,393 | No Claude transcript is expected. |
| Claude failed attempt, response `Request-Id` present | 31 | Upstream failed/retry attempts need not become transcript assistant records. |
| Claude failed attempt, response `Request-Id` absent | 19 | No transcript-compatible candidate was captured. |
| Claude successful other-client traffic (not `claude-cli`) | 32 | Direct/API client traffic has no expected Claude Code transcript. |
| Claude CLI before global transcript request-ID horizon | 0 | The proxy archive begins after the earliest transcript ID in the combined corpus. This is not a profile-specific retention count. |
| Claude CLI after indexed transcript horizon | 3,260 | Proxy traffic is newer than the latest indexed transcript request ID. |
| Claude CLI inside global transcript timestamp envelope, no exact ID match | 9,526 | The timestamps overlap globally, but the records predate established all-profile proxy routing; both top-level and subagent indexes were tested. |
| Conflicting candidate IDs / other provider | 0 | No candidate resolved to multiple transcripts; only Claude and Codex providers occur. |
| **Total** | **29,261** | |

Within the Claude sample, 74.029% (9,526/12,868) falls inside the combined
transcript timestamp envelope, while 25.334% (3,260/12,868) is after its latest
request ID. These are descriptive time classes only. They cannot measure
profile-specific retention or establish same-request overlap because account
sources cannot be mapped to transcript profiles without the missing join. Exact
historical attribution is unavailable from the two supplied sources; the cause
of the empty response-header intersection remains unresolved.

## Validated join recipe and consequence

For downstream ingestion, the safe recipe is still:

1. index all direct-profile transcript `requestId` values recursively, including
   subagents and non-assistant records, then dedupe by exact ID;
2. normalize response header names and scalar/array representation, but do not
   alter ID values;
3. probe top-level proxy `request_id` and response `Request-Id` separately;
4. accept only one exact transcript hit and reject conflicts;
5. preserve missing/unmatched rows with explicit reason codes.

That recipe is implemented, rerun, and denominator-reconciled, but **it finds
zero historical joins in this archive**. Issue #336 therefore cannot supply the
assumed exact per-request project/session bridge for the present backfill. The
response-header hypothesis remains open until an overlapping request is
captured on both sides. If it still fails on that controlled overlap, a future
design will need a shared ID captured at the same request hop or another
explicit attribution mechanism; timestamp/model heuristics would be
probabilistic and do not satisfy the exactness requirement.
