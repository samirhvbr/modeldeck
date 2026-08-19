# 0014 — No OAuth token renewal for non-active profiles, ever

- Date: 2026-07-22 · Consolidated 2026-08-17 (absorbed 0015, Tim's disposition)
- Links: #117, #176, PR #116, PR #119, #148, #114

ModelDeck never renews or writes provider OAuth credentials, even to fix daily re-login
pain: it would violate the Consumer ToS, can trigger refresh-token-rotation theft
detection that kills every session in the account family, and Keychain ACLs block the
read anyway. The accepted alternative (#176, 0018) triggers the CLI's own legitimate
lazy renewal via a real cheap invocation.

The setup-token workaround is also closed (formerly record 0015, spiked 2026-07-24,
#148): a user-minted claude setup-token as a longer-lived usage-probe credential was
tried and rejected — the provider API returns 403 on a deliberate user:profile scope
gap, not a bug to work around. Do not reopen without evidence the provider scope
changed; this no-renewal posture is the permanent answer.
