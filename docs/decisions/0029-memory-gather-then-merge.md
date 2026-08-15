# 0029 — Cross-profile memory: gather-then-merge, agent-driven, keep-both on collision

- Date: 2026-08-01
- Links: #204

Enabling shared memory gathers every profile's memory into one location (never picks
one profile's as "the" answer), backs up originals, and keeps collisions as both; the
merge into a coherent master is an explicit agent-driven pass that flags uncertain
merges rather than guessing. Gather-then-merge preserves everyone's history where
pick-one would silently discard it.
