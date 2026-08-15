# 0021 — Spend scope excluded from the headline, kept as a tertiary row

- Date: 2026-07-19
- Links: #28

The spend (dollar-budget) scope is excluded from "worst remaining" headlines,
sort-by-Lowest, and menu-bar severity — for subscription users spend is the least
important signal, and an empty spend value was dominating the headline in red while
real windows were healthy. Spend is still shown as a muted, last-position,
non-severity row whenever it has meaningful data; it disappears only when meaningless
(no reset data and zero/unknown usage), per Tim's 2026-07-19 call on #28.
