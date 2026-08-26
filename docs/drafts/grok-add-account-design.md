# Adding a Grok subscription — design note (issue #560)

Stage 1: design and mockup only. Nothing is implemented. Tim's sign-off on
`docs/mockups/grok-add-account.html` gates everything after this.

## Why Grok can't reuse the existing flow

The add-account sheet today does two things Grok has no counterpart for:

1. It asks the daemon to **create an isolated, owner-only profile folder** for
   the new subscription (`~/.claude-profiles/<name>`, `~/.codex-profiles/<name>`).
2. It then **hands off to the provider's own sign-in**, launching Terminal with
   the provider's login command and reading the identity back afterwards.

The grok CLI owns `~/.grok` and runs its own auth. ModelDeck creates nothing
there and drives no sign-in — decision 0035 fixed that posture as read-only, and
that posture is a selling point, not a gap to close. So the picker deliberately
omits Grok today (`DeckProvider.addableCases` in
`macos/ModelDeckMac/Sources/ModelDeckMacCore/DeckPopoverModel.swift`), and the
Grok deck column is reachable only by posting to the daemon's API by hand.

## The proposed flow

Two steps, in the same 420-point sheet, no new window.

**Step 1 — pick Grok, point at the folder, consent.** The provider menu gains a
third entry. Choosing Grok swaps the sentence under the fields and adds one
inline block showing the grok home ModelDeck found (`~/.grok` by default), when
it was last used, and a "Choose Another Folder…" link for anyone who keeps a
second grok home. The label, purpose and color fields are unchanged, so the card
that lands looks like every other card. A green dot means the daemon has already
checked the folder: it exists, the current user owns it, nobody else can write
to it, `auth.json` is present, and it isn't already registered as some other
subscription's home. Under it, one plain sentence — ModelDeck reads this folder,
never writes to it, never signs you in or out, never copies credentials — plus a
collapsed "What ModelDeck reads" list naming the two files.

**The refusals happen here, before the button works,** not as an error after: no
grok home found (with `grok` to run, copyable), the folder is writable by other
local users (with the exact `chmod g-w,o-w` to run), the folder is already a
Claude or Codex subscription's home (which would send an OpenAI token to xAI's
billing endpoint), or — added during the build, once the daemon started refusing
it — the folder is already connected as another Grok subscription, since two
would poll xAI for one pool and read as two independent subscriptions in the
deck.

**Step 2 — connected.** ModelDeck takes one billing reading and shows the card
that just landed: "59% left · Weekly · all models · Resets Sat 5:00 PM". There is
no sign-in step and no "Signed in as …" — ModelDeck never opens Grok's
credential, so it has no identity to display. The billing reading is the honest
equivalent, and because it is the same reading the deck card uses, a card that
could never fill in fails here rather than silently.

## What already exists vs what needs building

Already in the daemon, shipped by PR #559:

- `POST /api/accounts` accepts `provider: "grok"` with a `profileRef`
  (`Service.saveAccount` → `validatedGrokProfileRef`, `src/service.mjs`).
- Every check step 1 shows is already performed there: the path is resolved
  through `realpath` (so a symlink or `..` can't walk around it), the folder must
  exist, be a real directory, be owned by the current user, and not be
  group- or other-writable (`assertGrokHomeDirectory`, `src/adapters/grok.mjs`),
  and it must not already be another provider's registered home.
- The quota reading: `refreshGrok` → `fetchGrokUsage` runs an isolated child
  process against xAI's billing endpoint and records the same snapshot shape
  every other provider records. It rides the existing refresh pass — no new
  polling.
- Sign-in state for the card: presence of `<home>/auth.json`, never opened.
- Receipts ingest from `~/.grok/sessions/*/*/updates.jsonl`, read-only, already
  running.
- The deck column itself, including the initial-letter provider mark.

Needs building:

- **A read-only discovery endpoint** — something like
  `GET /api/grok/home-candidate?path=…` returning `{ path, exists, hasCredentials,
  permissionsOk, alreadyRegisteredAs, lastSessionAt, hint }`. The Mac app should
  not be the thing stat-ing provider folders and re-deriving permission rules the
  daemon already owns; one source of truth or the two will drift. This is the
  only genuinely new daemon surface, and it reads nothing but directory metadata.
- **Swift:** `addableCases` gains `.grok`; `AddAccountModel` gains a
  connect-existing path (two steps, no login command, no activation dance, no
  identity verify); `AddAccountSheet` swaps its step-1 body and its step-2 body
  when the provider is Grok.
- **Confirm-step reading:** step 2 needs one Grok refresh. Today only
  `POST /api/refresh` exists (whole pass). Either that is good enough or a
  per-account refresh is added; the difference is a few hundred milliseconds and
  no new risk either way.

## Read-only posture, stated plainly

- ModelDeck creates nothing inside `~/.grok` and writes nothing there. Ever.
- ModelDeck never runs a grok sign-in or sign-out.
- The credential file is handed to an isolated child process that asks xAI for a
  billing percentage. Its contents are never stored, never logged, never shown.
- Sign-in state on the card comes from whether `auth.json` exists, not from
  reading it.
- Removing a Grok subscription removes only ModelDeck's reference to the folder.
- Adding a Grok subscription spends no model quota: the billing endpoint is a
  metering read, not a model call (decision 0032 holds).

## OPEN QUESTIONS — Tim's calls, batched

1. **Empty-column nudge.** Claude and Codex show an empty column when they have
   no accounts, and that empty state is the add-account nudge. The Grok column
   ruling (PR #559 mockup) was: no accounts, no column, because there was no add
   flow. Once there is one, does Grok get the same empty column? *My
   recommendation: no — leave the deck exactly as it is today. Adding happens
   from the picker; a third of the deck width spent on a nudge for a provider
   most users don't have is a bad trade.*
2. **A second grok home.** The daemon accepts any folder, so "Choose Another
   Folder…" costs nothing to offer and lets someone with two grok homes add
   both. Offer it, or lock v1 to `~/.grok` only? *Recommendation: offer it as
   the secondary inline link shown, defaulting to the discovered `~/.grok`.*
3. **How much consent detail.** Is the one-line promise enough, or do you want
   the "What ModelDeck reads" file list expanded by default rather than
   collapsed? *Recommendation: collapsed. The promise is the message; the file
   list is for the person who wants to check it.*
4. **Verify at connect, or land and wait.** Step 2 takes a live billing reading
   before saying "connected". The alternative is to save immediately and let the
   next scheduled refresh fill the card. *Recommendation: verify at connect — a
   card that silently never fills is the worse failure, and it is one cheap
   metering call.*
5. **No grok home found.** Show the instruction with a copyable `grok` command
   (what the mockup does), or launch Terminal running `grok` the way the
   Claude/Codex flow launches a login? *Recommendation: instruct, don't launch.
   ModelDeck driving grok's auth is exactly the line 0035 drew.*
6. **Wording check.** "Connect" as the button and "Grok is connected" as the
   step-2 title, versus the existing flow's "Add"/"Signed in". Different word for
   a genuinely different action, or keep the vocabulary uniform?

### Riders parked in #560

- **Grok icon asset — recommend stay parked.** There is no installed Grok
  desktop app to take an `.icns` from (the #103 precedent), and the
  initial-letter mark already shipped and reads fine in the deck.
- **Tier ladder — recommend stay parked.** There is no calibrated data for Grok
  plans yet, so a health dot would be a guess, and a guessed dot is worse than no
  dot. `isKnown: false` stays honest until real plan data exists.
