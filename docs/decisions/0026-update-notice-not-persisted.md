# 0026 — Update notice deliberately not persisted across launches

- Date: 2026-08-06
- Links: #269, PR #271

The dismissible "new version available" notice resets every launch on purpose: a
remembered dismissal would also suppress the NEXT update's notice, since the same
dismissed flag would still apply.
