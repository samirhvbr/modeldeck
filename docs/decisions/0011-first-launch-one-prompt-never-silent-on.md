# 0011 — First-launch flow: one prompt, two branches, never silent-on

- Date: 2026-08-14
- Links: #401, #422

First launch asks at most one onboarding question: the adoption offer if a proxy is
detected, else a fresh-install consent screen with "Enable" pre-selected (honoring the
tier-3 default, 0005). The choice is never silently defaulted on, is stored so later
launches never re-prompt, and stays revisitable in Settings.
