# 0014 — No OAuth token renewal for non-active profiles, ever

- Date: 2026-07-22
- Links: #117, #176, PR #116, PR #119

ModelDeck never renews or writes provider OAuth credentials, even to fix daily re-login
pain: it would violate the Consumer ToS, can trigger refresh-token-rotation theft
detection that kills every session in the account family, and Keychain ACLs block the
read anyway. The accepted alternative (#176, 0018) triggers the CLI's own legitimate
lazy renewal via a real cheap invocation.
