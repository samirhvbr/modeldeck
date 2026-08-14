# Issue #399 research — signing/notarization for a bundled CLIProxyAPI (Go) binary

Autonomous research ticket (child of #378, cluster 3). Facts only; decisions are
flagged as open questions for the decider. Feeds #403 (update cadence) and #404
(public mirror / reproducibility).

**Question:** what does it take to ship a pinned stock CLIProxyAPI (Go, MIT)
inside ModelDeck's signed, notarized, hardened-runtime app, keeping Gatekeeper,
hardened runtime, and Sparkle updates working?

## 1. This repo's existing precedent: the Node daemon binary

ModelDeck already ships one embedded executable inside `ModelDeck.app` — the
`modeldeckd` daemon, a Node.js [Single Executable Application
(SEA)](https://nodejs.org/api/single-executable-applications.html). Exact
current mechanics, read directly from the scripts:

- **Built from source, not a downloaded release binary.** `esbuild` bundles
  `src/server.mjs` into a CJS blob, which is injected into a copy of the
  *locally running* Node binary via `postject`
  (`scripts/build-daemon-binary.sh:196-220`). There is no "download upstream
  Node's release and re-sign it" step — Node itself is the base runtime (not
  the thing being shipped as a product); the actual project code
  (`src/server.mjs`) is what's compiled in, from the repo's own working tree,
  gated on a clean tracked tree unless `--allow-dirty` is passed
  (`scripts/build-daemon-binary.sh:48-61`).
- **Two-stage signing.** `build-daemon-binary.sh` strips Node's original
  signature (`codesign --remove-signature`) before SEA injection, then
  applies an **ad-hoc** signature (`--sign -`) with the daemon entitlements
  right after injection (`scripts/build-daemon-binary.sh:213-225`). The real
  Developer ID identity is applied later — `release-dmg.sh` re-signs the
  staged `modeldeckd` binary in place with
  `codesign --force --options runtime --timestamp --entitlements
  scripts/daemon-entitlements.plist --sign "$IDENTITY"`
  (`scripts/release-dmg.sh:494-497`), i.e. hardened runtime + secure
  timestamp + explicit entitlements, same identity as the outer app.
- **Entitlements are minimal and V8/JIT-specific**
  (`scripts/daemon-entitlements.plist:4-12`):
  `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory`. The plist's own
  comment states why: "V8 requires JIT under the hardened runtime. Signing it
  without these entitlements produces a binary that crashes at launch on
  notarized builds." These two are Node/V8-specific and would **not** apply
  to a Go binary (Go doesn't JIT).
- **No separate notarization step for the daemon binary.** It is never zipped
  and submitted to `notarytool` on its own. It is copied into
  `Contents/Resources/daemon/modeldeckd` before the *outer app* is assembled
  (`scripts/release-dmg.sh:371-372`), signed in place, and then the whole
  `ModelDeck.app` is zipped and submitted as one unit
  (`scripts/release-dmg.sh:520-544`: `ditto` → `notarytool submit --wait` →
  `stapler staple "$APP"`). The DMG itself is separately signed, notarized,
  and stapled as a second Apple round-trip
  (`scripts/release-dmg.sh:576-584`).
- **Every nested Mach-O gets signed individually, inside-out, before the
  outer signature.** Same pattern applied to Sparkle's `Autoupdate`,
  `Updater.app`, any XPC services, and the framework itself before the app
  binary and then the whole `.app` are signed
  (`scripts/release-dmg.sh:491-518`). The script's own comment states this is
  required because "notarization requires every nested Mach-O to carry
  [hardened runtime]" (`scripts/release-dmg.sh:498-502`).
- **Verification gates**: `codesign --verify --deep --strict` and `spctl -a
  -vv` on the app, `spctl -a -t open --context context:primary-signature -vv`
  on the DMG (`scripts/release-dmg.sh:588-590`).

**Takeaway for #399:** the in-repo precedent is "build from pinned/local
source, ad-hoc sign at build time, re-sign with the release identity +
hardened runtime + minimal entitlements at packaging time, notarize the whole
app bundle once." It is not an example of re-signing a third-party prebuilt
binary — no such path currently exists in this repo's pipeline.

## 2. automazeio/vibeproxy — the only real precedent for embedding CLIProxyAPI

Repo: https://github.com/automazeio/vibeproxy — Swift menu-bar app wrapping a
CLIProxyAPI fork (`router-for-me/CLIProxyAPIPlus`).

- **Does not build from source; downloads prebuilt upstream releases, and
  does not pin a version** — the opposite of what #399 asks about ("pinned").
  Two independent mechanisms both resolve to upstream's "latest" at run time:
  - `.github/workflows/update-cliproxyapi.yml` (scheduled every 12h): calls
    `https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest`,
    downloads the darwin-arm64 asset, opens an auto-bump PR.
    (https://raw.githubusercontent.com/automazeio/vibeproxy/main/.github/workflows/update-cliproxyapi.yml)
  - `.github/workflows/release.yml` ("Build and Sign macOS App" job):
    separately re-resolves latest via `gh release view --repo
    router-for-me/CLIProxyAPI --json tagName` at build time, downloads the
    arch-specific `.tar.gz`, and stages the extracted binary at
    `src/Sources/Resources/cli-proxy-api-plus`.
    (https://raw.githubusercontent.com/automazeio/vibeproxy/main/.github/workflows/release.yml)
  - The fetched binary is also committed into the repo at
    `src/Sources/Resources/cli-proxy-api-plus` (~58.5 MB blob):
    https://github.com/automazeio/vibeproxy/blob/main/src/Sources/Resources/cli-proxy-api-plus
- **Signing** (`create-app-bundle.sh`,
  https://github.com/automazeio/vibeproxy/blob/main/create-app-bundle.sh):
  the bundled Go binary is individually signed with `codesign --options
  runtime --timestamp --entitlements entitlements.plist`. Their
  `entitlements.plist` (fetched verbatim:
  https://raw.githubusercontent.com/automazeio/vibeproxy/main/entitlements.plist)
  grants **`com.apple.security.cs.allow-unsigned-executable-memory`** and
  **`com.apple.security.cs.disable-library-validation`** — this is the only
  concrete real-world evidence found of what entitlements a bundled Go
  binary needs under hardened runtime (no Apple doc names Go specifically;
  see §3). Sparkle's nested helpers get a separate
  `sparkle-entitlements.plist`. The whole app is then signed and verified
  with `codesign --verify --deep --strict --verbose=2`; falls back to ad-hoc
  signing for dev builds without a Developer ID cert.
- **Notarization**: zips the fully-signed `.app` (`ditto -c -k
  --sequesterRsrc --keepParent`), submits the whole bundle in one
  `notarytool submit --wait`, then `stapler staple` + `stapler validate` —
  same "sign every nested executable first, then notarize the whole outer
  bundle once" pattern as this repo's own pipeline (§1).

## 3. CLIProxyAPI upstream release artifacts

Repo: https://github.com/router-for-me/CLIProxyAPI (fork used by vibeproxy:
`router-for-me/CLIProxyAPIPlus`).

- **License confirmed MIT.** First line of
  https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/LICENSE
  reads "MIT License"; copyright held jointly by "Luis Pater" and
  "Router-For.ME".
- **Release assets are NOT Apple-signed.** Latest tag checked: v7.2.130 (12
  Aug 2026). 13 assets per release: darwin (`aarch64`, `amd64`), Linux
  (default + `_no-plugin` variants), FreeBSD, Windows, plus a
  `checksums.txt`. No `.sig`/`.asc` detached signatures, no signed checksum
  manifest, no mention of macOS codesigning or notarization anywhere in the
  release process. Integrity is sha256-only (git commits on the release are
  GPG-signed, which verifies *source*, not the compiled artifact).
  (https://github.com/router-for-me/CLIProxyAPI/releases)
- **No GoReleaser** — confirmed no `.goreleaser.yml` at repo root; releases
  come from a custom Actions workflow,
  `.github/workflows/release.yaml`
  (https://github.com/router-for-me/CLIProxyAPI/blob/main/.github/workflows/release.yaml).
- **Build determinism signals**: pinned Go version (`GO_VERSION: '1.26.4'`
  workflow env; `go.mod` also declares `go 1.26.0`, module
  `github.com/router-for-me/CLIProxyAPI/v7` —
  https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/go.mod).
  macOS binaries build natively on `macos-15-intel`/`macos-15` GitHub-hosted
  runners with `CGO_ENABLED=1` and `-ldflags="-s -w -X main.Version=...
  -X main.Commit=... -X main.BuildDate=..."` (stripped, version-stamped).
  `go.sum` is committed (module hash pinning), but no `vendor/` dir and no
  reproducible-build flag set was found. **Bit-for-bit reproducibility was
  not verified** — `CGO_ENABLED=1` native macOS builds are generally not
  bit-reproducible; this is a reasonable inference, not a tested or
  documented fact.

**Conclusion for #399 §1 (re-sign upstream binary vs. build from pinned
source):** re-signing upstream's prebuilt darwin binary is possible (nothing
in the release process prevents lifting the binary and re-signing it, exactly
as vibeproxy does) but starts from an artifact with **no Apple signature, no
detached signature, no reproducible-build guarantee** — only a sha256 in
`checksums.txt`. Building from the pinned source (Go 1.26.x per upstream's
own `go.mod`, MIT license permits this) gets ModelDeck the same trust level
this repo already has for the Node daemon (§1): full control of the build
environment, ability to audit `go.sum`, and no dependency on trusting a
third party's CI output before re-signing it. Trade-off is CI cost/complexity
(a Go toolchain + native macOS build step) vs. vibeproxy's simpler
"download + re-sign" path. This is a decision, not a fact — flagged in Open
Questions below.

## 4. Apple documentation — notarization of bundled/nested executables

Apple's own doc pages
(https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
and
https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
render via JavaScript and could not be scraped for verbatim text in this
pass — flagged as an open question below (a human should open these
directly to pull exact quotes for any spec/decision doc). What is
corroborated via Apple Developer Forums (Apple DTS staff posts) and observed
empirically in both this repo's own pipeline (§1) and vibeproxy's pipeline
(§2):

- **Every native executable bundled inside a Developer ID product must
  itself be signed** (with hardened runtime + secure timestamp) or
  notarization fails / Gatekeeper refuses to launch it. Apple DTS staff
  responses point to "Resolving common notarization issues" as the canonical
  reference for signing errors:
  https://developer.apple.com/forums/thread/770481,
  https://developer.apple.com/forums/thread/710228.
- **`com.apple.security.get-task-allow` must be absent** in release builds
  or notarization rejects the submission (Apple Developer Forums,
  code-signing topic:
  https://developer.apple.com/forums/topics/code-signing-topic/code-signing-topic-notarization).
- **The notary service issues one ticket per submission**, and that
  submission is the zipped/DMG/pkg bundle as a whole. Neither this repo's
  own `release-dmg.sh` nor vibeproxy's `release.yml` submit nested
  executables to `notarytool` individually — they sign each nested Mach-O
  first, then submit the *entire outer bundle* once. No Apple doc sentence
  stating "any change to any nested file invalidates the previous ticket"
  was independently retrieved verbatim in this pass; it is inferred from (a)
  both pipelines always re-signing and re-notarizing the whole bundle on
  every version bump, never notarizing just a swapped-out inner binary, and
  (b) the general mechanic that codesign hashes cover nested code, so
  changing any nested executable changes the outer signature.
- **No Apple-documented Go-specific hardened-runtime pitfall was found.**
  The JIT-related entitlements (`allow-jit`,
  `allow-unsigned-executable-memory` for V8/interpreted runtimes) used by
  this repo's own daemon (§1) are not applicable to Go's statically-compiled
  model. The concrete precedent for what a Go binary needs is vibeproxy's
  entitlements set (§2): `allow-unsigned-executable-memory` +
  `disable-library-validation`. Third-party (non-Apple) background on
  hardened-runtime entitlement mechanics: The Eclectic Light Company,
  "Notarization: the hardened runtime" —
  https://eclecticlight.co/2021/01/07/notarization-the-hardened-runtime/.
- **Sandbox entitlements not relevant here.** `com.apple.security.app-sandbox`
  and `com.apple.security.network.server` only matter for
  sandboxed/App-Store distribution. ModelDeck ships Developer ID
  (non-sandboxed) like vibeproxy, so a bundled Go loopback-listener helper
  does not need network-server sandbox entitlements — it needs the standard
  Developer ID signing (hardened runtime + timestamp) plus whatever
  hardened-runtime exception entitlements its Go runtime actually requires
  at launch (determined empirically by attempting a notarized launch and
  reading the crash/rejection reason, per this repo's own daemon precedent
  in §1 where the JIT entitlements were added specifically because the
  binary "crashes at launch on notarized builds" without them).

## Answers to the ticket's five questions

1. **Re-sign upstream binary vs. build from pinned source, with trade-offs.**
   Fact: neither this repo's own daemon (built from source, §1) nor
   vibeproxy (downloads + re-signs upstream's latest, §2) do a "build from a
   *pinned* release" of a third-party binary — vibeproxy always chases
   "latest." Upstream's release artifacts carry no Apple signature and no
   reproducibility guarantee beyond a sha256 (§3). This repo's own existing
   in-repo precedent is "build from source, don't trust a downloaded
   binary's signature." **Open question (decision, not fact):** whether
   ModelDeck re-signs a downloaded pinned CLIProxyAPI release binary
   (cheaper CI, matches vibeproxy's pattern, but trusts upstream's build
   environment and requires re-verifying the sha256 against
   `checksums.txt` on every pin bump) or builds from the pinned Go source
   tag in ModelDeck's own CI (matches this repo's existing daemon precedent
   and gives full build-environment control, at the cost of standing up a Go
   toolchain step in the release pipeline).

2. **Entitlements needed for a bundled Go loopback-listener helper.** No
   sandbox entitlements needed (Developer ID, non-sandboxed distribution).
   The one real-world precedent found (vibeproxy, §2) uses
   `com.apple.security.cs.allow-unsigned-executable-memory` and
   `com.apple.security.cs.disable-library-validation` in its
   `entitlements.plist` for its bundled Go binary. This repo's existing
   `scripts/daemon-entitlements.plist` entitlements
   (`allow-jit`, `allow-unsigned-executable-memory`) are V8/Node-specific and
   not a direct precedent for Go, though `allow-unsigned-executable-memory`
   does appear in both. **Open question:** the exact minimal entitlement set
   should be confirmed empirically by hardened-runtime-signing a real build
   of the pinned CLIProxyAPI binary and attempting a notarized launch, same
   as how this repo discovered its own JIT entitlement requirement (§1) —
   no Apple doc enumerates Go-specific requirements.

3. **Current-state notarization pitfalls for Go binaries, if any remain
   current.** No currently-documented Apple-specific Go pitfall was found in
   this pass. The generic Developer ID requirements apply (hardened runtime
   enabled, secure timestamp present, no `get-task-allow` entitlement in
   release builds — §4). vibeproxy's working pipeline (§2) is the strongest
   evidence that a bundled Go binary can be hardened-runtime-signed and
   notarized successfully with a small, specific entitlements file — it is
   a solved problem in practice for this exact upstream project.

4. **Does swapping the embedded binary force full app re-notarization (feeds
   #403)?** Yes, empirically, in both pipelines examined. Neither this
   repo's `release-dmg.sh` (§1) nor vibeproxy's `release.yml` (§2) notarizes
   a nested executable independently of the outer app — both re-sign every
   nested Mach-O and then re-submit the *entire* `.app` (and, in this repo's
   case, the DMG too) to `notarytool` on every build, with no partial/
   incremental notarization path used or referenced anywhere in either
   pipeline. No Apple doc sentence explicitly confirming "any nested change
   invalidates the ticket" was retrieved verbatim (see §4 caveat), but the
   absence of any incremental-notarization tooling or workflow step in
   either real pipeline is consistent with: swapping the embedded
   CLIProxyAPI binary (e.g. for a version bump) requires a full
   sign → notarize → staple cycle of the whole ModelDeck.app, same as any
   other release. This directly informs #403's update cadence: a CLIProxyAPI
   version bump is exactly as expensive, notarization-wise, as any other
   ModelDeck release — there is no cheaper "just swap the daemon" path
   available.

5. **How does vibeproxy do it, concretely?** See §2 in full: download
   upstream's latest darwin release tarball (not pinned, not built from
   source) → stage into `Contents/Resources/` → `codesign` the Go binary
   individually with hardened runtime + timestamp + a 2-entitlement plist
   (`allow-unsigned-executable-memory`, `disable-library-validation`) →
   sign the rest of the bundle inside-out → sign the outer `.app` → zip →
   `notarytool submit --wait` → `stapler staple` + `validate`. Structurally
   identical in shape to this repo's own daemon pipeline (§1); differs in
   that vibeproxy fetches upstream's binary rather than building it, and
   tracks "latest" rather than a pin.

## Open questions for the decider

- **Re-sign vs. rebuild from pinned source** (feeds #404 reproducibility
  gate too): re-signing a downloaded pinned release trades CI simplicity for
  trusting upstream's build environment and only a sha256 as integrity
  evidence; rebuilding from the pinned Go source tag matches this repo's own
  existing daemon precedent (§1) but requires a new Go build step in CI.
  Not resolved by this research — a decision for #399/#404's decider.
- **Exact minimal Go entitlements set**: vibeproxy's 2-entitlement plist
  (§2) is the only concrete precedent; this repo's own daemon entitlements
  (§1) are V8-specific and not directly transferable. Needs empirical
  verification against the actual pinned CLIProxyAPI binary before it ships
  (sign, notarize, launch, iterate on crash/rejection reasons — the same
  method this repo used to discover its own JIT entitlement need).
  Notarization/hardened-runtime pitfalls specific to Go were not found
  Apple-documented, but no Apple guidance exists for Go the way it exists
  for V8/JIT languages.
- **Apple doc verbatim text**: the two canonical Apple pages
  (`notarizing-macos-software-before-distribution`,
  `resolving-common-notarization-issues`) render via JavaScript and
  could not be scraped for exact quotes in this pass. Corroborated instead
  via Apple DTS staff forum posts and empirical pipeline behavior (§4). A
  human should open both pages directly if verbatim Apple wording is needed
  for a spec.
- **Build reproducibility of upstream CLIProxyAPI**: not verified bit-for-bit
  (native macOS build with `CGO_ENABLED=1`, no vendoring/reproducible-build
  flags found in their release workflow) — relevant to #404, not resolved
  here.
