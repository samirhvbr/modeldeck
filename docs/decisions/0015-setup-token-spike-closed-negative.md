# 0015 — setup-token longevity spike closed negative

- Date: 2026-07-24
- Links: #148, #117, #114

Using a user-minted claude setup-token as a longer-lived usage-probe credential was
tried and rejected: the provider API returns 403 on a deliberate user:profile scope
gap, not a bug to work around. Do not reopen without evidence the provider scope
changed; the no-renewal posture (0014) stands as the permanent answer.
