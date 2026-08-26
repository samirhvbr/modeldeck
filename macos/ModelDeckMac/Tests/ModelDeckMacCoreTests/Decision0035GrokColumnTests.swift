import Foundation
import Testing
@testable import ModelDeckMacCore

// Decision 0035, stage two — the Grok deck column.
//
// Two properties are load-bearing and easy to regress silently:
//   1. the column is absent, not empty, for everyone without Grok accounts
//      (deck space is sacred — an empty third column would cost a third of
//      the popover's width for nothing);
//   2. every control in the column keeps its OWN accessibility label. This
//      repo has been bitten three times (#65, #113, #272) by a parent label
//      suppressing its children's elements, so the spoken strings are derived
//      in Core and pinned here.
//
// Placeholder identities only — never a real account (spec privacy rule).

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
}

private func account(
    _ id: String,
    provider: String,
    label: String,
    enabled: Bool = true
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: provider,
        label: label,
        identity: "\(id)@example.com",
        enabled: enabled
    )
}

private func snapshot(
    _ accountId: String,
    scope: String,
    remaining: Double,
    resetsIn: TimeInterval,
    // The health engine gates on data age, so its tests state an observation
    // time; the deck-rendering tests don't need one.
    observedAgo: TimeInterval? = nil
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: iso(resetsIn),
        observedAt: observedAgo.map { iso(-$0) },
        source: "grok-billing-api"
    )
}

/// A snapshot observed just now — fresh enough for the health engine's
/// staleness gate, so these tests exercise the period logic and nothing else.
private func freshSnapshot(
    _ accountId: String,
    scope: String,
    remaining: Double,
    resetsIn: TimeInterval
) -> UsageSnapshot {
    snapshot(accountId, scope: scope, remaining: remaining, resetsIn: resetsIn, observedAgo: 0)
}

/// Claude + Codex only — the shape of every deck before this change.
private func stateWithoutGrok() -> DeckState {
    DeckState(
        accounts: [
            account("c1", provider: "claude", label: "Studio"),
            account("x1", provider: "codex", label: "Studio"),
        ],
        usage: [
            snapshot("c1", scope: "week", remaining: 63, resetsIn: 2 * 86_400),
            snapshot("x1", scope: "week", remaining: 99, resetsIn: 6 * 86_400),
        ]
    )
}

private func stateWithGrok() -> DeckState {
    DeckState(
        accounts: [
            account("c1", provider: "claude", label: "Studio"),
            account("x1", provider: "codex", label: "Studio"),
            account("g1", provider: "grok", label: "Studio"),
            account("g2", provider: "grok", label: "Personal"),
        ],
        usage: [
            snapshot("c1", scope: "week", remaining: 63, resetsIn: 2 * 86_400),
            snapshot("x1", scope: "week", remaining: 99, resetsIn: 6 * 86_400),
            snapshot("g1", scope: "weekly", remaining: 41, resetsIn: 3 * 86_400),
            snapshot("g2", scope: "monthly", remaining: 77, resetsIn: 9 * 86_400),
        ]
    )
}

@Suite("Decision 0035 — Grok column")
struct Decision0035GrokColumnTests {
    // MARK: Column presence

    @Test func noGrokAccountsMeansNoGrokColumnAtAll() {
        let columns = DeckBuilder.columns(state: stateWithoutGrok(), sortOrder: .nextReset, now: now)
        #expect(columns.map(\.provider) == [.claude, .codex])
        #expect(!columns.contains { $0.provider == .grok })
    }

    @Test func grokAccountsAddAThirdColumnLast() {
        let columns = DeckBuilder.columns(state: stateWithGrok(), sortOrder: .nextReset, now: now)
        #expect(columns.map(\.provider) == [.claude, .codex, .grok])
        let grok = columns.last
        #expect(grok?.title == "Grok")
        #expect(grok?.rows.map(\.account.label) == ["Studio", "Personal"])
        #expect(grok?.subscriptionCountText == "2 subscriptions")
    }

    /// Claude and Codex keep their column even with nothing in it — the empty
    /// state is the add-account nudge. Grok has no add flow, so an empty Grok
    /// column would be a dead end AND a third of the deck's width.
    @Test func claudeAndCodexKeepEmptyColumnsButGrokDoesNot() {
        let columns = DeckBuilder.columns(state: DeckState(), sortOrder: .nextReset, now: now)
        #expect(columns.map(\.provider) == [.claude, .codex])
        #expect(columns.allSatisfy { $0.rows.isEmpty })
    }

    /// A disabled Grok account is not on the deck, so it cannot conjure a
    /// column either.
    @Test func disabledGrokAccountLeavesTheColumnAbsent() {
        let state = DeckState(
            accounts: [account("g1", provider: "grok", label: "Studio", enabled: false)],
            usage: [snapshot("g1", scope: "weekly", remaining: 41, resetsIn: 3 * 86_400)]
        )
        #expect(!DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
            .contains { $0.provider == .grok })
    }

    /// A Grok account with no usage row yet still gets a card (the daemon has
    /// simply not refreshed it) — never a broken or missing one.
    @Test func grokAccountWithNoUsageYetStillRenders() {
        let state = DeckState(
            accounts: [account("g1", provider: "grok", label: "Studio")],
            usage: []
        )
        let grok = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
            .first { $0.provider == .grok }
        #expect(grok?.rows.count == 1)
        #expect(grok?.rows.first?.windows.isEmpty == true)
    }

    // MARK: Deck width (#30 no-truncation, with a variable column count)

    /// The width #30 fixed for two columns was a constant. Once the column
    /// count became data, that constant would have squeezed three columns
    /// into the two-column width — breaking the very rule it encoded. The
    /// width is now derived, and these numbers are the contract: two columns
    /// reproduce #30's 640, three give the signed-off 0035 mockup's 940.
    @Test func deckWidthIsDerivedFromTheColumnCount() {
        #expect(DeckLayoutMetrics.columnLayoutWidth(columnCount: 2) == 640)
        #expect(DeckLayoutMetrics.columnLayoutWidth(columnCount: 3) == 940)
        #expect(DeckLayoutMetrics.singleColumnWidth == 420)
    }

    /// TRIPWIRE: a fourth provider must widen the deck, never re-squeeze it.
    /// Every column keeps the full per-column budget at every count.
    @Test func everyColumnKeepsItsFullWidthAtEveryCount() {
        for count in 1...6 {
            let width = DeckLayoutMetrics.columnLayoutWidth(columnCount: count)
            let perColumn = (width - DeckLayoutMetrics.columnChrome) / CGFloat(count)
            #expect(perColumn == DeckLayoutMetrics.columnWidth,
                    "\(count) columns must not shrink any card below the #30 budget")
        }
    }

    /// The deck the app actually renders for each state: adding Grok accounts
    /// takes the deck from two columns at 640 to three at 940.
    @Test func addingGrokWidensTheRenderedDeck() {
        let without = DeckBuilder.columns(state: stateWithoutGrok(), sortOrder: .nextReset, now: now)
        let with = DeckBuilder.columns(state: stateWithGrok(), sortOrder: .nextReset, now: now)
        #expect(DeckLayoutMetrics.deckWidth(layout: .twoColumn, columnCount: without.count) == 640)
        #expect(DeckLayoutMetrics.deckWidth(layout: .twoColumn, columnCount: with.count) == 940)
    }

    /// Single-column mode is one stacked list — the column count never
    /// touches its width, whatever providers exist.
    @Test func singleColumnWidthIgnoresTheColumnCount() {
        for count in 1...4 {
            #expect(DeckLayoutMetrics.deckWidth(layout: .singleColumn, columnCount: count) == 420)
        }
    }

    // MARK: Provider identity + ordering

    @Test func daemonProviderStringsMapToGrok() {
        #expect(DeckProvider.from("grok") == .grok)
        #expect(DeckProvider.from("xai") == .grok)
        #expect(DeckProvider.from("GROK") == .grok)
        #expect(DeckProvider.from("grok-4.6") == nil)
        #expect(DeckProvider.grok.displayName == "Grok")
    }

    /// Provider-sort grouping mirrors the column order left→right, with
    /// unknown providers still last.
    @Test func providerRankPutsGrokThirdAndUnknownLast() {
        #expect(DeckBuilder.providerRank(.claude) < DeckBuilder.providerRank(.codex))
        #expect(DeckBuilder.providerRank(.codex) < DeckBuilder.providerRank(.grok))
        #expect(DeckBuilder.providerRank(.grok) < DeckBuilder.providerRank(nil))
    }

    /// Issue #560 gave Grok its own add flow (connect an existing grok CLI
    /// home, read-only), so the picker offers it. Tim's ruling kept the deck
    /// itself unchanged: being addable must NOT earn Grok the empty
    /// add-account column Claude and Codex get.
    @Test func addAccountPickerOffersGrokWithoutGivingItAnEmptyColumn() {
        #expect(DeckProvider.addableCases == [.claude, .codex, .grok])
        let columns = DeckBuilder.columns(state: DeckState(), sortOrder: .nextReset, now: now)
        #expect(!columns.contains { $0.provider == .grok })
    }

    // MARK: Window copy

    @Test func grokWindowScopesReadInTheDecksVoice() {
        #expect(DeckBuilder.windowTitle(for: "weekly") == "Weekly · all models")
        #expect(DeckBuilder.windowTitle(for: "monthly") == "Monthly · all models")
        // The daemon's honest fallback when the provider states a percent but
        // not which period it belongs to.
        #expect(DeckBuilder.windowTitle(for: "usage period") == "Usage period")
    }

    /// All three are whole-pool windows, so they share the 5-hour-then-pool
    /// ordering rank rather than sinking below model-scoped rows.
    @Test func everyWholePoolWindowSharesOneRank() {
        #expect(DeckBuilder.windowRank(scope: "monthly") == DeckBuilder.windowRank(scope: "weekly"))
        #expect(DeckBuilder.windowRank(scope: "usage period") == DeckBuilder.windowRank(scope: "weekly"))
    }

    @Test func grokCardShowsPercentLeftAndReset() {
        let grok = DeckBuilder.columns(state: stateWithGrok(), sortOrder: .nextReset, now: now)
            .first { $0.provider == .grok }
        let studio = grok?.rows.first { $0.account.id == "g1" }
        let window = studio?.headlineWindow(isExpanded: false)
        #expect(window?.title == "Weekly · all models")
        #expect(window?.remainingText == "41% left")
        #expect(window?.resetText.hasPrefix("Resets") == true)
    }

    // MARK: Accessibility (#65 / #113 / #272 — labels must not eat children)

    /// The card's parent label suppresses its children's elements, so every
    /// fact the card SHOWS has to be spoken from this one derivation.
    @Test func grokCardSpeaksItsOwnLabel() {
        let grok = DeckBuilder.columns(state: stateWithGrok(), sortOrder: .nextReset, now: now)
            .first { $0.provider == .grok }
        let studio = grok?.rows.first { $0.account.id == "g1" }
        #expect(studio?.accessibilityLabel(showsIdentity: false) == "Studio")
        #expect(studio?.accessibilityLabel(showsIdentity: true) == "Studio, g1@example.com")
    }

    /// The column header's aggregate is a tappable control, so it carries its
    /// own label rather than inheriting the header's.
    @Test func grokColumnHeadlineSpeaksItsOwnLabel() throws {
        let grok = try #require(
            DeckBuilder.columns(state: stateWithGrok(), sortOrder: .nextReset, now: now)
                .first { $0.provider == .grok }
        )
        let display = try #require(DeckColumnUsageHeadline.display(for: grok, isStale: { _ in false }))
        let spoken = display.accessibilityLabel(.sum)
        #expect(!spoken.isEmpty)
        #expect(spoken != display.text(.sum), "the spoken form must be a sentence, not the bare number")
    }

    /// The provider mark is its own element with its own label; Grok ships no
    /// bundled artwork, and the fallback slot must still announce the provider.
    @Test func grokProviderMarkKeepsALabelWithoutArtwork() {
        #expect(ProviderIcons.image(for: .grok) == nil)
        // ProviderMarkView labels the slot with exactly this string.
        #expect(DeckProvider.grok.displayName == "Grok")
    }

    // MARK: Availability Health (CodeRabbit, PR #559)

    /// The health engine is a fixed 168-hour simulation, and `measuredPace`
    /// credits an account whose reset lies beyond one cycle with zero elapsed
    /// time. A monthly Grok window three weeks out therefore reads as "no
    /// pace, never resets" and yields a confidently wrong verdict. It is
    /// excluded until the simulation is period-aware.
    @Test func monthlyGrokAccountsAreExcludedFromAvailabilityHealth() {
        let state = DeckState(
            accounts: [account("g1", provider: "grok", label: "Monthly")],
            usage: [freshSnapshot("g1", scope: "monthly", remaining: 77, resetsIn: 21 * 86_400)]
        )
        let pool = AvailabilityHealthEngine.pool(for: .grok, state: state, now: now)
        #expect(pool.accounts.isEmpty, "a monthly window must never enter the 168-hour sim")
        #expect(pool.excluded == [AvailabilityExclusion(label: "Monthly", reason: "monthly window, not weekly")])
    }

    /// TRIPWIRE: the exclusion reason has to describe what is actually true.
    /// "no weekly usage data" is a lie for an account that has a perfectly
    /// good monthly window, and sends its owner hunting a refresh problem
    /// that does not exist.
    @Test func exclusionReasonNamesTheWindowItActuallyHas() {
        #expect(AvailabilityHealthEngine.missingDriverReason(in: []) == "no weekly usage data")
        #expect(AvailabilityHealthEngine.missingDriverReason(
            in: [snapshot("g1", scope: "monthly", remaining: 77, resetsIn: 21 * 86_400)]
        ) == "monthly window, not weekly")
        // The daemon's honest fallback when the period isn't stated.
        #expect(AvailabilityHealthEngine.missingDriverReason(
            in: [snapshot("g1", scope: "usage period", remaining: 50, resetsIn: 3 * 86_400)]
        ) == "window is not known to be weekly")
        // Spelling variants of the same window fold to the same reason.
        for scope in ["month", "30d", "Monthly"] {
            #expect(AvailabilityHealthEngine.missingDriverReason(
                in: [snapshot("g1", scope: scope, remaining: 77, resetsIn: 21 * 86_400)]
            ) == "monthly window, not weekly")
        }
    }

    /// The Grok header carries no health chip: the verdict needs a calibrated
    /// tier ladder (Grok has none) and a period the 168-hour sim can read.
    /// This is what the signed-off mockup shows, and the deck must match it.
    @Test func grokColumnCarriesNoHealthChip() {
        #expect(DeckProvider.grok.hasAvailabilityHealth == false)
        #expect(DeckProvider.claude.hasAvailabilityHealth)
        #expect(DeckProvider.codex.hasAvailabilityHealth)
    }

    /// Weekly-billed Grok accounts evaluate correctly, so the exclusion is
    /// scoped to the period — not to the provider.
    @Test func weeklyGrokAccountsStayInAvailabilityHealth() {
        let state = DeckState(
            accounts: [account("g1", provider: "grok", label: "Weekly")],
            usage: [freshSnapshot("g1", scope: "weekly", remaining: 41, resetsIn: 3 * 86_400)]
        )
        let pool = AvailabilityHealthEngine.pool(for: .grok, state: state, now: now)
        #expect(pool.accounts.map(\.label) == ["Weekly"])
        #expect(pool.excluded.isEmpty)
    }

    /// A monthly account beside a weekly one must not drag the pool: the
    /// weekly account still counts, and only the monthly one is named.
    @Test func aMonthlyAccountDoesNotDisturbItsWeeklyNeighbour() {
        let state = DeckState(
            accounts: [
                account("g1", provider: "grok", label: "Weekly"),
                account("g2", provider: "grok", label: "Monthly"),
            ],
            usage: [
                freshSnapshot("g1", scope: "weekly", remaining: 41, resetsIn: 3 * 86_400),
                freshSnapshot("g2", scope: "monthly", remaining: 77, resetsIn: 21 * 86_400),
            ]
        )
        let pool = AvailabilityHealthEngine.pool(for: .grok, state: state, now: now)
        #expect(pool.accounts.map(\.label) == ["Weekly"])
        #expect(pool.excluded.map(\.label) == ["Monthly"])
    }

    // MARK: Nothing invented for Grok

    /// No calibrated tier ladder exists for Grok plans yet, and the type's
    /// own "tier unknown" path is how that gets said out loud.
    @Test func grokTierWeightIsHonestlyUnknown() {
        let weight = AvailabilityHealthEngine.tierWeight(
            provider: .grok,
            account: account("g1", provider: "grok", label: "Studio")
        )
        #expect(weight.value == 1)
        #expect(weight.isKnown == false)
    }

    /// Nothing probes the grok CLI's version or auth yet, so the tools probe
    /// reports nothing rather than claiming "not installed".
    @Test func toolsProbeReportsNothingForGrok() {
        let response = ToolsProbeResponse(tools: .init(
            claude: ToolProbe(installed: true, authState: "ok"),
            codex: ToolProbe(installed: true, authState: "ok")
        ))
        #expect(response.probe(for: .grok) == nil)
        #expect(response.probe(for: .claude) != nil)
    }

    /// ModelDeck flips no active link for Grok, so there is nothing to warn
    /// about and no activation notice may appear.
    @Test func grokRaisesNoActivationNotice() {
        let state = stateWithGrok()
        #expect(state.activationState(for: .grok) == .unknown)
        #expect(!ActivationNotice.notices(for: state).contains { $0.provider == .grok })
    }
}
