# Managed proxy: first launch, adoption, coexistence, rollback

Issue #422 (1.0 build D), implementing the #401 verdict and the onboarding
addendum in `docs/full-app-1.0-decision-map.md` (Verdicts, 2026-08-14).

Two rules outrank everything below: **never silent coexistence** and **never
silent replacement**. ModelDeck does not start a proxy the user never agreed
to, and it does not stop one without saying which job it stopped and how.

## First launch asks once

At launch — after slice C (#421) has evaluated the port — ModelDeck asks at
most one question, and only if no answer is recorded yet:

| What's on `:8317` | Surface |
| --- | --- |
| Something answers | **Adoption offer** — "ModelDeck can manage your proxy" |
| Nothing answers | **Consent screen** — "Enable measured usage truth?", Enable pre-selected |

Dev builds with no bundled proxy binary ask nothing at all.

The answer is stored in `UserDefaults`
(`managedProxyOnboardingChoice`). Later launches never re-prompt; the choice is
revisitable in **Settings → General → Managed proxy**.

Until a choice that wants management is recorded, the launch sequence holds
slice C's lifecycle stopped (`managedProxyMayRunAtLaunch`). A user who declines
stays declined across relaunches.

## Detection is ONE named check

1. `GET http://127.0.0.1:8317/healthz` — is the port occupied at all.
2. If it is: **one** authenticated `GET /v0/management/config`, using the
   existing key at `~/.config/cliproxyapi/.mgmt-key`
   (`src/paths.mjs` `CLIPROXY_MANAGEMENT_KEY_PATH`).

That endpoint is the project's already-named handshake
(`scripts/build-cliproxyapi.sh`, `test/cliproxyapi-pin-compat.test.mjs`) and is
non-destructive. `/v0/management/usage-queue` is never used for identification:
its read **consumes** the queue (#400).

ModelDeck never walks a list of management endpoints looking for one that
answers, and it never stores, logs, or displays the key — it is read inside the
call and dropped.

If the handshake doesn't confirm, the offer still appears, but the copy says
plainly that ModelDeck could not confirm what is on the port.

## Adoption stops your proxy visibly

Adopting is one click, and it reports what it did — every time, including when
it fails.

ModelDeck first discovers **how** your proxy is supervised, identifying it by
**executable**, never by name:

1. the serving process — the `ps` row whose executable is named `cliproxyapi`;
2. the LaunchAgent in `~/Library/LaunchAgents` that runs *that exact
   executable* (ModelDeck's own agents are excluded).

Name matching would be wrong on a real install. The field machine for this
slice runs both `com.cliproxyapi.server` and `com.cliproxyapi.rebalance-weights`
— the latter a python job whose label *and* arguments contain "cliproxyapi".
Matching on the word would have stopped the rebalance cron and left the server
running.

Then it stops exactly that:

| Supervision | What adoption runs |
| --- | --- |
| LaunchAgent | `launchctl bootout gui/<uid>/<label>` |
| Plain process | one `SIGTERM` to the pid (never `SIGKILL` — ModelDeck did not spawn it) |
| Neither | **nothing**: adoption refuses and says so |

After the stop, the port is re-probed. A stop that "succeeded" while something
still answers is reported as a failure and ModelDeck starts **no** proxy of its
own — two proxies would each drain half the usage queue (#400).

Adoption needs no credential migration by construction (#398): the managed
instance runs against the same `~/.config/cliproxyapi`, with the same config
and the same sign-ins. Nothing is copied or moved.

## Coexistence is a stated choice

Declining adoption records **coexist**: ModelDeck keeps reading from the proxy
you run, exactly as before, and says why the managed-only features are off —
starting, restarting after a crash, and version pinning stay off while you
manage it yourself.

That reason lives in **Settings → General → Managed proxy**, in full. On the
deck it is a single quiet glyph in the header's control row, whose tooltip
carries the same sentence — never a row of its own. Tim's ruling (#445,
2026-08-15) amends the surface, not the principle: coexistence is still never
silent, it just does not tax the deck. `ProxyCoexistNotice` owns that decision
and TRIPWIRE `coexist-costs-no-deck-row` holds it.

## User-run ops are tolerated (#401a)

Under adoption, ModelDeck manages the proxy's **process and config file** and
nothing else. Jobs you run around it — notably the **rebalance cron**, which
edits routing weights in the proxy's auth files that the proxy itself re-reads
— keep working and are deliberately left alone at 1.0. Management does not own
them, does not disable them, and does not need to.

Auth files stay CLIProxyAPI's alone: ModelDeck never writes them (#398,
enforced by the `managed-proxy-never-writes-auth` tripwire from slice C).

## Rollback: Stop Managing

**Settings → General → Managed proxy → Stop Managing** (confirmed) stops
ModelDeck's proxy and prints the concrete commands your own setup needs:

- adopted a LaunchAgent →
  `launchctl bootstrap gui/<uid> <plist>` then
  `launchctl kickstart -k gui/<uid>/<label>`
- adopted a plain process → the command line that was running
- nothing was ever adopted → it says there is nothing to restore

The steps are selectable and copyable. Your configuration and sign-ins never
moved, so nothing else is needed.

## Tripwires

- `adoption-never-silent` (`Issue422AdoptionNeverSilentTripwireTests`) —
  behavioural: every adoption outcome ends on a visible record naming what was
  stopped and how; static: `adopt()` has no exit that skips the record, sets no
  terminal phase of its own, and the stopper is reachable from that one place.
  Mutation-verified 2026-08-14.
- `managed-proxy-never-writes-auth` (slice C) still binds this flow: adoption
  writes nothing.
