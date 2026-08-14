# Issue #404 research — public mirror: bundling an MIT Go binary in a PolyForm-NC repo

Autonomous research ticket (child of #378, cluster 8). Blocked by #399 (feeds
the reproducibility half — read together with
[`docs/research/issue-399-signing-notarization.md`](issue-399-signing-notarization.md)).
Facts only; decisions are flagged as open questions for the decider. Gates
#405 (1.0 criteria).

**Question:** how does bundling an MIT-licensed Go binary (pinned
CLIProxyAPI) appear in the public `timharris707/modeldeck` repo, which is
licensed PolyForm Noncommercial 1.0.0?

## 1. License-compat verdict: can a PolyForm-NC product ship MIT components?

**Verdict: yes — no clause conflict.** MIT and PolyForm-NC operate on
different axes and neither restricts the other:

- **MIT (CLIProxyAPI's own license, confirmed verbatim)**: fetched directly
  from `https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/LICENSE`.
  Full text:

  > MIT License
  >
  > Copyright (c) 2025-2005.9 Luis Pater
  > Copyright (c) 2025.9-present Router-For.ME
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to deal
  > in the Software without restriction, including without limitation the rights
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  > copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all
  > copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  > SOFTWARE.

  MIT's **only substantive obligation** is the notice clause: "The above
  copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software." It draws no distinction
  between source and binary/compiled distribution — "all copies or
  substantial portions" is form-agnostic, and the license imposes no
  restriction whatsoever on the license of a *larger work* the software is
  combined into, nor on whether that larger work is sold or is
  noncommercial-only. MIT is permissive and sublicense-compatible in this
  direction: a company can wrap MIT code in a proprietary, commercial, or
  (as here) noncommercial-only license for the surrounding product, as long
  as the MIT notice travels with the MIT-covered portion. (Cross-checked
  against community/legal-explainer consensus via web search — MIT's notice
  requirement is confirmed to apply to binary-only distributions too, with
  the accepted practice being to surface it in a NOTICES/LICENSE file,
  README, or in-app About/credits screen — no single canonical URL to cite
  for this consensus, but it is uncontested across every source checked.)

- **PolyForm Noncommercial 1.0.0 (ModelDeck's own license, this repo's
  `LICENSE.md:1-74`)**: the relevant clauses:
  - **"Copyright License"** (`LICENSE.md:9-11`): grants a copyright license
    "to do everything you might do with the software that would otherwise
    infringe the licensor's copyright in it for any permitted purpose,"
    conditioned on distributing only per "Distribution License" and
    "Changes and New Works License."
  - **"Distribution License"** (`LICENSE.md:13-15`): grants an *additional*
    license "to distribute copies of the software," including "the
    software with changes and new works."
  - **"Notices"** (`LICENSE.md:17-21`): "You must ensure that anyone who
    gets a copy of any part of the software from you also gets a copy of
    these terms or the URL for them above, as well as copies of any
    plain-text lines beginning with `Required Notice:` that the licensor
    provided with the software." This is PolyForm-NC's own attribution
    mechanism — an inbound-facing requirement (what recipients of
    ModelDeck must get), separate from and non-conflicting with the
    outbound MIT notice ModelDeck itself owes CLIProxyAPI.
  - **"No Other Rights"** (`LICENSE.md:47-49`): "These terms do not allow
    you to sublicense or transfer any of your licenses to anyone else, or
    prevent the licensor from granting licenses to anyone else. These terms
    do not imply any other licenses." This clause governs *ModelDeck's own
    copyright* in the parts of the software Tim/ModelDeck LLC owns — it has
    no bearing on a *third party's* separately-licensed MIT code embedded
    as an unmodified binary. PolyForm-NC is a license Tim, as licensor,
    applies to his own copyrighted work; it cannot and does not purport to
    relicense CLIProxyAPI's MIT copyright out from under its own authors
    (Luis Pater / Router-For.ME). The two licenses apply to two different
    copyright holders' two different works, bundled (not merged/derivative)
    in one distribution.
  - **Definitions** (`LICENSE.md:63-73`): "the **software** is the software
    the licensor makes available under these terms" — i.e. PolyForm-NC's
    scope is self-defined as what ModelDeck's licensor (Tim) is offering
    under it. It does not purport to be the license for every byte in the
    repository; a vendored MIT binary carries its own MIT terms
    concurrently, the same way this repo's `macos/.../Sparkle` vendor
    checkout carries Sparkle's own (MIT) `LICENSE` file alongside
    ModelDeck's PolyForm-NC `LICENSE.md` today — that dual-license
    coexistence is already the repo's existing, working precedent, not a
    novel arrangement #404 has to invent.

**No clause in either license conflicts.** MIT permits sublicensing under
any terms for the surrounding work, including a noncommercial-only one;
PolyForm-NC's "No Other Rights" and "Copyright License" clauses only
constrain what *ModelDeck's own* copyright license conveys and are silent
on (do not purport to reach) code Tim doesn't hold copyright in. The one
binding obligation created by bundling MIT code is MIT's own notice
requirement — a NOTICES-file/README/About-box attribution problem, not a
licensing-compatibility problem. (This is a straightforward reading of both
primary texts; not itself the kind of question that benefits from a
lawyer's sign-off, but flagged in Open Questions below in case Tim wants
one before 1.0 given the "gate-decision" label on this ticket and #405.)

## 2. Attribution placement — repo and app

### 2a. Real-world precedent: how comparable Mac apps do it

Three concrete examples found:

1. **Cyberduck** (macOS FTP/SFTP/cloud client) ships a root-level
   `Acknowledgments.rtf` compiling every bundled open-source component's
   license text into one file:
   https://github.com/iterate-ch/cyberduck/blob/master/Acknowledgments.rtf.
   This RTF is also what macOS's native About panel displays (see 2b).

2. **automazeio/vibeproxy** — the *same* upstream CLIProxyAPI fork this
   repo's own #399 research already treats as the closest real precedent
   for embedding this exact dependency. Checked directly: it has a root
   `LICENSE` (MIT, for vibeproxy's own code) and a README "Credits" section
   naming CLIProxyAPIPlus and linking to
   `router-for-me/CLIProxyAPIPlus`, plus "Special thanks to the
   CLIProxyAPIPlus project for providing the core functionality that makes
   VibeProxy possible" — but **no dedicated NOTICE/THIRD_PARTY_LICENSES
   file and no bundled copy of CLIProxyAPI's own MIT license text**
   alongside the embedded binary
   (`src/Sources/Resources/cli-proxy-api-plus`). This is a real example of
   under-compliance worth not copying: a README credits section alone
   likely satisfies moral/goodwill norms but is a weaker MIT-notice
   argument than reproducing the actual notice text, since MIT's clause
   asks for "this permission notice" (the specific text), not merely a
   thanks/link.

3. **LicensePlist** (`mono0926/LicensePlist`,
   https://github.com/mono0926/LicensePlist) — a widely-used Swift/SwiftPM
   tooling convention (not a single app, but the standard tool many Mac/iOS
   apps use): auto-generates a consolidated licenses list from
   `Package.resolved`, output either as a `Settings.bundle` plist tree or
   as a standalone HTML/Markdown/CSV acknowledgements file, one entry per
   dependency with its license type, copyright line, and full license text.
   Directly applicable to ModelDeck: `macos/ModelDeckMac` is already a
   SwiftPM project with a `Package.resolved` (Sparkle is already a
   dependency there), so this tool would pick up both Sparkle *and* could
   be pointed at a manually-added entry for the non-SwiftPM CLIProxyAPI
   binary.

### 2b. The native macOS mechanism: `Credits.rtf` / `NSAboutPanelOptionCredits`

AppKit's standard About panel
(`NSApplication.orderFrontStandardAboutPanel(options:)`) has a documented,
zero-extra-UI convention for exactly this: if the app bundle contains a
file named `Credits` with extension `.html`, `.rtf`, or `.rtfd` (checked in
that preference order), AppKit loads and displays it in the About panel's
scrollable credits area automatically, with no code required; the
`NSAboutPanelOptionCredits` key exists to override this programmatically
with an `NSAttributedString` instead. (Apple's own reference page for this
symbol, `https://developer.apple.com/documentation/appkit/nsapplication/aboutpaneloptionkey/credits`,
renders via JavaScript like the two Apple notarization pages #399 flagged
as unscrapable — this description is standard, long-documented AppKit
behavior, not verified as a verbatim quote from that page in this pass; a
human should open it directly if verbatim wording is needed for a spec.)
Cyberduck's `Acknowledgments.rtf` (2a.1) is a real, working instance of
this exact convention, not a hypothetical.

### 2c. Recommended placement for ModelDeck (repo + app)

Two things must both exist; neither substitutes for the other:

- **Repo**: a `THIRD_PARTY_NOTICES` (or `NOTICES`) file at the public
  mirror's root, containing the CLIProxyAPI MIT copyright/permission notice
  verbatim (§1 above) plus any other bundled third-party license text not
  already covered by existing precedent (Sparkle already ships its own
  `LICENSE` inside the vendored SwiftPM checkout — that stays as-is). This
  satisfies MIT's "included in all copies" for the source-adjacent
  distribution channel (the public mirror repo itself) the same way this
  repo already keeps Sparkle's `LICENSE` alongside its code.
- **App**: a `Credits.rtf` (or `.html`) dropped into the app bundle
  resources containing the same CLIProxyAPI notice (plus Sparkle's, plus
  any others), which AppKit's standard About panel will pick up with zero
  additional Swift code (§2b) — this satisfies MIT's "included in...
  substantial portions of the Software" for the *shipped binary*
  distribution channel (the DMG/notarized app), which is the one vibeproxy
  (2a.2) under-serves today.

Both are generation targets that can be produced from one source: the pin
manifest proposed in §3 below should carry the copyright/license text (or a
pointer to it) so the repo NOTICES file and the app's `Credits.rtf` can
both be generated/copied from the same record at build time, avoiding
drift between the two copies.

## 3. Build reproducibility recipe for `docs/RELEASE.md`

### 3a. What the public mirror currently does and doesn't carry

Read directly from `scripts/sync-mirror.sh:1-150` and `docs/RELEASE.md`
("Syncing the public mirror" section): the mirror is produced by
`git archive HEAD` of the *private* repo's committed tree, minus a fixed
strip list (`.claude/`, `docs/HANDOFF.md`,
`docs/ACCOUNT_ONBOARDING.md`, `docs/lane-routing-policy.md`,
`docs/incidents/`, `scripts/lane-codex.sh`, `scripts/lane-watch.mjs`,
`design/mac-app-roadmap.md`), scrubbed against a caller-supplied
regex-pattern file, and committed as a single flat squash under a neutral
author (`ModelDeck Mirror Sync <mirror-sync@example.invalid>`,
`sync-mirror.sh:130-136`) — consistent with the issue's framing of the
mirror as "fresh single-commit history" per push. **Today, nothing in this
strip list or in `docs/RELEASE.md`'s pipeline description mentions
CLIProxyAPI at all** — because the pinned-CLIProxyAPI bundling work is
still upstream of this ticket (gated by #399, which itself hasn't reached
an implementation decision — see its Open Questions). This is a forward
looking gap to fill, not a regression: no pin manifest, build script, or
checksum record exists yet for CLIProxyAPI anywhere in the tree (confirmed:
`grep -rn "manifest" scripts/build-daemon-binary.sh` and
`grep -rn manifest.json scripts/` turn up only the *daemon's own* Node SEA
manifest — see 3b — nothing CLIProxyAPI-shaped).

### 3b. Existing in-repo precedent to extend: the daemon's own pin/manifest pattern

ModelDeck already has a working "build reproducibility record" pattern for
its *other* embedded binary (the Node daemon), which the CLIProxyAPI
manifest should mirror rather than invent from scratch. Read directly from
`scripts/write-daemon-manifest.mjs:1-35`:

```js
export function daemonManifest({ binaryPath, nodeVersion, gitCommit }) {
  return {
    artifact: path.basename(binaryPath),
    nodeVersion,
    MDGitCommit: gitCommit || null,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'),
  };
}
```

This is written to `dist/daemon/manifest.json` by
`scripts/build-daemon-binary.sh` (`OUTPUT_MANIFEST` at line 14, invoked at
line 231) and then copied verbatim into the shipped app bundle at
`Contents/Resources/daemon/manifest.json` by `scripts/release-dmg.sh:375`
— i.e. the manifest travels *inside the shipped product*, not just in CI
logs. It records: the artifact name, the pinned upstream runtime version
(`nodeVersion`), the exact source commit it was built from
(`MDGitCommit`), and a sha256 of the produced binary. Nothing in it today
records upstream *license* text or a *source-tag/commit-of-origin* for a
third-party dependency, because the daemon is built entirely from this
repo's own `src/server.mjs` (per `issue-399-signing-notarization.md` §1) —
there is no "upstream pin" concept in that manifest because there's no
upstream for the daemon. CLIProxyAPI is different: it's an out-of-tree
third-party project being pinned to a specific upstream release/tag, so its
manifest needs one more field this precedent doesn't: which upstream
ref/tag/commit was pinned.

### 3c. Concrete recipe for `docs/RELEASE.md` to absorb

Given §399's still-open decision between (a) re-signing a downloaded pinned
CLIProxyAPI release binary and (b) building from the pinned Go source tag
in ModelDeck's own CI (see `issue-399-signing-notarization.md`, "Open
questions for the decider," first bullet), the reproducibility record
needs to work for *either* path, since it's a downstream concern from that
decision. Proposed, modeled directly on §3b's existing JSON-manifest
convention:

1. **Pin file** — a new `scripts/cliproxyapi-pin.json` (or similar) at the
   private repo root, hand-edited by whoever bumps the pin (mirrors how
   `VERSION` is the single hand-edited authority for ModelDeck's own
   version per `docs/RELEASE.md`'s existing "Output" section):
   ```json
   {
     "repo": "https://github.com/router-for-me/CLIProxyAPI",
     "ref": "v7.2.130",
     "commit": "<full 40-char upstream commit sha the tag points at>",
     "goVersion": "1.26.4",
     "license": "MIT",
     "copyrightNotice": "Copyright (c) 2025-2005.9 Luis Pater\nCopyright (c) 2025.9-present Router-For.ME"
   }
   ```
   This is the reproducibility anchor: anyone with this file and network
   access to the pinned commit can reproduce what ModelDeck bundled,
   independent of which build path (a) or (b) #399 settles on.

2. **Build/fetch script** — a new `scripts/build-cliproxyapi.sh`
   (mirroring `scripts/build-daemon-binary.sh`'s shape) that either
   `git clone`s and builds the pinned `commit` with the pinned `goVersion`
   (path b) or downloads and verifies the pinned release's darwin asset
   against upstream's own `checksums.txt` (path a — the sha256 verification
   step `issue-399-signing-notarization.md` §3 already flags as the
   integrity floor for that path). Either way it writes a manifest that
   extends §3b's shape with the upstream pin fields:
   ```json
   {
     "artifact": "cliproxyapi",
     "upstreamRepo": "https://github.com/router-for-me/CLIProxyAPI",
     "upstreamRef": "v7.2.130",
     "upstreamCommit": "<sha>",
     "buildMethod": "source|prebuilt",
     "goVersion": "1.26.4",
     "sha256": "<hash of the actual binary shipped>",
     "MDGitCommit": "<ModelDeck commit that built/fetched it>"
   }
   ```
   This should land at `dist/cliproxyapi/manifest.json` and, like the
   daemon's manifest today (`release-dmg.sh:375`), get copied into the
   shipped app bundle — so a end-user (or auditor) can inspect exactly
   what was bundled from inside the installed app, not just from CI logs.

3. **Reproducibility gate in `docs/RELEASE.md`** — a new numbered step
   alongside the existing "1. Requires `dist/daemon/modeldeckd`..." list in
   the "What the script does" section: `scripts/release-dmg.sh` should
   likewise require `dist/cliproxyapi/manifest.json` and fail closed if the
   pin file's `ref`/`commit` and the manifest's `upstreamRef`/
   `upstreamCommit` disagree — the same "guard rejects drift" posture
   `release-dmg.sh`'s existing repository guard already takes for the outer
   repo (`docs/RELEASE.md`, "The repository guard fetches origin, rejects
   tracked changes...").

4. **Public mirror strip-list is unaffected, on purpose.** The pin file
   (`scripts/cliproxyapi-pin.json`) and the build script
   (`scripts/build-cliproxyapi.sh`) should **not** be added to
   `sync-mirror.sh`'s strip list (`sync-mirror.sh:56-64`) — they contain no
   secrets (same "labels, not secrets" posture `docs/RELEASE.md`'s "One-time
   provisioning" section already takes for the signing-identity string and
   notary-profile name) and are exactly the artifact a public,
   PolyForm-NC-licensed mirror needs *present* for someone to independently
   reproduce the bundle, per the issue's own framing ("what the public repo
   must contain for someone to reproduce the shipped bundle"). Anyone
   cloning the public mirror should be able to run
   `scripts/build-cliproxyapi.sh` against the committed pin file and get a
   binary whose sha256 matches the manifest shipped inside the released
   app (`dist/cliproxyapi/manifest.json`, propagated into
   `Contents/Resources/`), without needing anything from the private repo.

5. **NOTICES/Credits.rtf generation, tying back to §2c.** A small step in
   the same build script (or a follow-on script) should read
   `copyrightNotice`/`license` out of the pin file and write/update both
   the repo-root `THIRD_PARTY_NOTICES` file and the app-bundle
   `Credits.rtf` from that single source, so the two copies (§2c) can't
   drift out of sync on a pin bump.

## Answers to the ticket's questions

1. **License-compat verdict, with citations.** Compatible — no clause
   conflict. MIT's only obligation (notice inclusion, form-agnostic,
   `router-for-me/CLIProxyAPI/main/LICENSE`) is satisfiable inside a
   PolyForm-NC product; PolyForm-NC's restrictive clauses
   (`LICENSE.md:9-15,47-49`) govern only ModelDeck's own copyright grant and
   don't purport to reach a bundled third party's separately-held
   copyright. See §1.
2. **Attribution placement (repo + app).** Repo: root-level
   `THIRD_PARTY_NOTICES` file (new), matching the existing pattern of
   Sparkle's already-vendored `LICENSE`. App: `Credits.rtf` in bundle
   resources, picked up automatically by AppKit's standard About panel with
   no code (`NSAboutPanelOptionCredits` convention; real example:
   Cyberduck's `Acknowledgments.rtf`). See §2.
3. **Reproducibility recipe for `docs/RELEASE.md`.** A hand-edited pin file
   (`scripts/cliproxyapi-pin.json`: upstream repo/ref/commit/Go
   version/license text), a new `scripts/build-cliproxyapi.sh` producing a
   manifest shaped like the daemon's existing
   `scripts/write-daemon-manifest.mjs` output plus upstream-pin fields, a
   `release-dmg.sh` guard requiring pin/manifest agreement, and explicitly
   keeping both new files *out* of `sync-mirror.sh`'s strip list so the
   public mirror is self-sufficient for reproduction. See §3.

## Open questions for the decider

- **Re-sign downloaded pinned binary vs. build from pinned Go source** —
  not re-litigated here; this is #399's own open question and the
  reproducibility recipe in §3 is written to work under either answer, but
  the *specific* build-script contents (§3c step 2) can't be finalized
  until #399 resolves it.
- **Formal legal sign-off on the license-compat verdict.** §1's reading is
  a straightforward textual analysis of both primary sources with no
  conflicting clause found, not a substitute for counsel if Tim wants one
  before 1.0 — flagged given this ticket's `gate-decision` label and that
  it gates #405 (1.0 criteria).
- **Exact NOTICES/Credits.rtf file name and format** — `THIRD_PARTY_NOTICES`
  vs. `NOTICE` vs. `ACKNOWLEDGEMENTS`, and RTF vs. HTML for the in-app
  credits, are naming/format choices with no functional difference found
  in research; §2c's recommendation is a default, not a requirement.
- **Whether to also adopt LicensePlist** (§2a.3) for the *SwiftPM* half of
  attribution (Sparkle and any future SwiftPM deps), separate from the
  hand-maintained CLIProxyAPI pin file — a tooling-choice decision, not
  required for #404's compatibility/placement/reproducibility questions to
  be answered.
