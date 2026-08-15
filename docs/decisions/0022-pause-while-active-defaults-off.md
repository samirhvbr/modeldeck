# 0022 — Pause-refresh-while-active defaults off

- Date: 2026-07-29
- Links: #187

The "pause refresh while a session is active" setting defaults to OFF (was ON): the
moment a user burns usage fastest is exactly when they most want live numbers, so
pause-by-default hid the most important data at the most important time. Existing
installs that already saved a settings document keep their prior value.
