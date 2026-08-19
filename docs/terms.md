# Domain glossary

_Seeded 2026-08-17 at the control-plane grilling close (first record); maintained
per the domain-memory binding in docs/agents/team-workflow.md._

- **receipts** — ModelDeck's product identity (0033): measured evidence of
  subscription burn — what was spent, on what, and (at wire grade) by which
  account — as opposed to estimates, coaching, or provider dashboards.
  Attribution depth follows the grade: corpus-grade receipts are per-turn from
  the harness's own records; per-account, per-request truth is wire grade.
- **corpus grade** — insight computed from the ingested session corpus
  (Claude transcripts, codex rollouts) with no proxy in the path; the zero-setup
  on-ramp tier. Both providers carry per-turn token splits. Limits: no
  per-account wire truth, and workload attribution stays modeled until the
  per-profile keys change lands.
- **wire grade** — insight measured at the request path by the bundled proxy
  (`request_usage`); requires routing through it; the upgrade tier.
- **pool depth** — features that only exist with multiple accounts behind the
  proxy (routing, rebalancing, right-sizing, quarantine); the operator tier.
- **burn pathology** — a deterministic, receipt-detectable pattern of avoidable
  quota burn with a one-line fix: cold-cache churn, context bloat, retry storms,
  swarm bursts, the >272K long-context multiplier.
- **diagnostician** — the Receipts v1 surface that names a user's burn
  pathologies from their own data and states the fix; takes no side between
  "you changed" and "the provider changed" — it shows receipts.
