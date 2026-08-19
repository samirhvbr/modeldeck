# 0034 — Agent-state reads come from proxy/corpus data only, never live harness state

- Date: 2026-08-17
- Links: control-plane grilling close record, blume-sidecar-teardown §11 Q8, .claude/handoff-archive-2026-08-17-m1-provisioning.md

Any ModelDeck feature that reports on **live** agent or harness activity (fleet
pulse, the diagnostician's activity views, any watcher) reads only (a) proxy-side
data the daemon already owns and (b) the ingested session corpus — never live
harness state DBs or files under an active writer. Config artifacts at rest
(CLAUDE.md, skills, settings files — the deterministic linter's approved input
per ruling 9A of the same grilling) are not agent state and are outside this
rule. Evidence: 2026-08-17 M1 session, where
aggressive codex state-DB reads contended with the daemon's own reads and froze
the deck for 15 minutes. Corollary ruled in the same grilling: no
transcript-string status inference (Blume's "esc to interrupt"-style heuristics)
— agent liveness claims come from measured request-path signals or aren't made.

_Scope clarified same day (2026-08-17, review catch): the original wording listed
"linter" among the restricted readers, which would have banned the approved
config linter's own inputs. Transcription fix only; the ruling is unchanged._
