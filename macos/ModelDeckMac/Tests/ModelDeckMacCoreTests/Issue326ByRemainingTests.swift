import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #326 replaces the middle "By resets" radio with "By remaining":
// the percentage rendered on the collapsed card passes an inclusive
// threshold, and the same binding window supplies the optional renewal
// criterion. Issue #330 makes those criteria independently enabled and a
// strict AND when both are on. All fixture identities are placeholders.

private let issue326Now = Date(timeIntervalSince1970: 1_800_000_000)

private func issue326ISO(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: issue326Now.addingTimeInterval(offset))
}

private func issue326Account(_ id: String, label: String) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: "claude",
        label: label,
        identity: "\(id)@example.com",
        enabled: true,
        isDefault: false
    )
}

private func issue326Snapshot(
    _ accountID: String,
    scope: String = "weekly",
    remaining: Double?,
    resetsIn: TimeInterval?
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountID,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsIn.map(issue326ISO),
        stale: false
    )
}

@Suite("Issue #326 By remaining")
@MainActor
struct Issue326ByRemainingTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "issue326-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func visibleIDs(
        from state: DeckState,
        using model: DeckPopoverModel
    ) -> Set<String> {
        Set(model.columns(for: state, now: issue326Now).flatMap(\.rows).map(\.id))
    }

    // MARK: Independent threshold and renewal criteria

    @Test func expiredResetFailsTheRenewingSoonLegAtEveryHorizon() throws {
        let state = DeckState(
            accounts: [issue326Account("expired", label: "Studio")],
            usage: [
                issue326Snapshot("expired", remaining: 2, resetsIn: -3_600),
            ]
        )
        let row = try #require(DeckBuilder.rows(state: state, now: issue326Now).first)

        for horizon in DeckPopoverModel.DeckResetsHorizon.allCases {
            #expect(!DeckPopoverModel.renewsWithinResetHorizon(
                row, horizon: horizon, now: issue326Now),
                "a reset one hour ago must fail the \(horizon.displayName) future window")
        }
    }

    @Test func renewalWindowIncludesNowAndItsUpperBoundaryOnly() throws {
        let twelveHours = 12 * 3_600.0
        let state = DeckState(
            accounts: [
                issue326Account("now", label: "Studio"),
                issue326Account("inside", label: "Client"),
                issue326Account("boundary", label: "Workshop"),
                issue326Account("outside", label: "Personal"),
            ],
            usage: [
                issue326Snapshot("now", remaining: 2, resetsIn: 0),
                issue326Snapshot("inside", remaining: 2, resetsIn: twelveHours - 1),
                issue326Snapshot("boundary", remaining: 2, resetsIn: twelveHours),
                issue326Snapshot("outside", remaining: 2, resetsIn: twelveHours + 1),
            ]
        )
        let rows = Dictionary(uniqueKeysWithValues: DeckBuilder.rows(
            state: state, now: issue326Now
        ).map { ($0.id, $0) })
        let resettingNow = try #require(rows["now"])
        let justInside = try #require(rows["inside"])
        let onBoundary = try #require(rows["boundary"])
        let justOutside = try #require(rows["outside"])

        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            resettingNow, horizon: .twelveHours, now: issue326Now),
            "reset == now counts because the row is resetting this instant")
        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            justInside, horizon: .twelveHours, now: issue326Now))
        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            onBoundary, horizon: .twelveHours, now: issue326Now),
            "the upper horizon boundary remains inclusive")
        #expect(!DeckPopoverModel.renewsWithinResetHorizon(
            justOutside, horizon: .twelveHours, now: issue326Now))
    }

    @Test func thresholdAndRenewingSoonAreIndependentAndStrictWhenCombined() {
        let state = DeckState(
            accounts: [
                issue326Account("threshold-only", label: "Studio"),
                issue326Account("renewing-only", label: "Client"),
                issue326Account("both", label: "Workshop"),
                issue326Account("neither", label: "Personal"),
            ],
            usage: [
                issue326Snapshot(
                    "threshold-only", remaining: 50, resetsIn: 3 * 86_400),
                issue326Snapshot(
                    "renewing-only", remaining: 2, resetsIn: 6 * 3_600),
                issue326Snapshot(
                    "both", remaining: 50, resetsIn: 6 * 3_600),
                issue326Snapshot(
                    "neither", remaining: 2, resetsIn: 3 * 86_400),
            ]
        )
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining

        #expect(model.hideRemainingThreshold == .five)
        #expect(model.hideRemainingThresholdEnabled)
        #expect(model.hideRenewingSoonEnabled)
        #expect(model.hideResetsHorizon == .oneDay)
        #expect(visibleIDs(from: state, using: model) == ["both"],
                "with both criteria enabled, every criterion must pass")

        model.hideRenewingSoonEnabled = false
        #expect(visibleIDs(from: state, using: model) == [
            "threshold-only", "both",
        ], "with renewal off, the percentage criterion acts alone")

        model.hideRemainingThresholdEnabled = false
        model.hideRenewingSoonEnabled = true
        #expect(visibleIDs(from: state, using: model) == [
            "renewing-only", "both",
        ], "with threshold off, the renewal criterion acts alone")
    }

    @Test func inclusiveBoundaryUsesTheRoundedPercentageTheCardDisplays() throws {
        let state = DeckState(
            accounts: [
                issue326Account("exact", label: "Studio"),
                issue326Account("rounds-to-five", label: "Client"),
                issue326Account("rounds-to-four", label: "Personal"),
            ],
            usage: [
                issue326Snapshot("exact", remaining: 5.0, resetsIn: 3 * 86_400),
                issue326Snapshot(
                    "rounds-to-five", remaining: 4.6, resetsIn: 3 * 86_400),
                issue326Snapshot(
                    "rounds-to-four", remaining: 4.4, resetsIn: 3 * 86_400),
            ]
        )
        let rows = DeckBuilder.rows(state: state, now: issue326Now)
        let exact = try #require(rows.first { $0.id == "exact" })
        let roundedUp = try #require(rows.first { $0.id == "rounds-to-five" })
        let roundedDown = try #require(rows.first { $0.id == "rounds-to-four" })
        #expect(exact.displayedRemainingPercent == 5)
        #expect(roundedUp.displayedRemainingPercent == 5,
                "raw 4.6 is rendered as 5%, so the filter must judge it as 5%")
        #expect(roundedDown.displayedRemainingPercent == 4)

        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining
        model.hideRenewingSoonEnabled = false
        #expect(visibleIDs(from: state, using: model) == ["exact", "rounds-to-five"],
                "the 5% boundary is inclusive and follows the displayed number")
    }

    @Test func sharedRoundingDerivationPinsThresholdEdges() {
        #expect(DeckWindow.roundedRemainingPercentagePoints(4.5) == 5)
        #expect(DeckWindow.roundedRemainingPercentagePoints(4.49) == 4)
        #expect(DeckWindow.roundedRemainingPercentagePoints(0.4) == 0)
    }

    @Test func rowEnteringVisibilitySeedsAnimationAtCommittedRoundedValue() throws {
        func row(remaining: Double) throws -> DeckAccountRow {
            let state = DeckState(
                accounts: [issue326Account("edge", label: "Studio")],
                usage: [
                    issue326Snapshot(
                        "edge", remaining: remaining, resetsIn: 3 * 86_400),
                ]
            )
            return try #require(DeckBuilder.rows(state: state, now: issue326Now).first)
        }

        let previous = try row(remaining: 4.49)
        let committed = try row(remaining: 4.5)
        #expect(!DeckPopoverModel.isVisibleByRemainingFilter(
            previous,
            threshold: .five,
            thresholdEnabled: true,
            renewingSoonEnabled: false,
            horizon: .oneDay,
            now: issue326Now))
        #expect(DeckPopoverModel.isVisibleByRemainingFilter(
            committed,
            threshold: .five,
            thresholdEnabled: true,
            renewingSoonEnabled: false,
            horizon: .oneDay,
            now: issue326Now))

        let tracker = DeckChangeTracker(defaults: freshDefaults())
        _ = tracker.capture(rows: [previous])
        let change = try #require(tracker.capture(rows: [committed])["edge"])
        #expect(change.headlineAnimationStartRemaining == change.currentRemaining)
        #expect(DeckWindow.roundedRemainingPercentagePoints(
            change.headlineAnimationStartRemaining
        ) == 5, "the first visible animation frame reads 5%, never the rejected 4%")
        let committedPoints = try #require(committed.displayedRemainingPercent)
        #expect(Double(DeckWindow.roundedRemainingPercentagePoints(
            change.headlineAnimationStartRemaining
        )) == committedPoints,
        "the animation seed and the visibility filter consume the same committed integer")
        let committedWindow = try #require(committed.worstWindow)
        let liveText = try #require(committedWindow.remainingText)
        #expect(change.headlineText(
            animationRemaining: change.headlineAnimationStartRemaining,
            displayedWindow: committedWindow,
            liveText: liveText
        ) == "5% left")
        #expect(change.headlineText(
            animationRemaining: change.previousRemaining,
            displayedWindow: committedWindow,
            liveText: liveText
        ) == "5% left", "even stale 4% state falls back to the committed 5% text")
    }

    @Test func sameRoundedAnimationEndpointsMayKeepThePreviousSeed() {
        let change = DeckUsageChange(
            scope: "weekly", previousRemaining: 4.41, currentRemaining: 4.49)
        #expect(change.headlineAnimationStartRemaining == change.previousRemaining)
        #expect(DeckWindow.roundedRemainingPercentagePoints(
            change.headlineAnimationStartRemaining
        ) == DeckWindow.roundedRemainingPercentagePoints(change.currentRemaining))
    }

    @Test func staleResetMakesTheEyeToggleObservableAgain() {
        func state(resetsIn: TimeInterval) -> DeckState {
            DeckState(
                accounts: [issue326Account("low", label: "Studio")],
                usage: [
                    issue326Snapshot("low", remaining: 2, resetsIn: resetsIn),
                ]
            )
        }

        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining
        model.hideRemainingThreshold = .five
        model.hideRemainingThresholdEnabled = false
        model.hideRenewingSoonEnabled = true
        model.hideResetsHorizon = .twelveHours

        #expect(model.eyeToggleChangesNothingVisible(
            state: state(resetsIn: 0), now: issue326Now),
            "with renewal acting alone, reset == now keeps the low row visible")
        #expect(!model.eyeToggleChangesNothingVisible(
            state: state(resetsIn: -3_600), now: issue326Now),
            "once that reset is stale, renewal fails and the eye visibly restores the row")
    }

    @Test func missingResetExemptsOnlyRenewalAndUnknownPercentExemptsThreshold() {
        let state = DeckState(
            accounts: [
                issue326Account("low-no-reset", label: "Studio"),
                issue326Account("unknown", label: "Client"),
            ],
            usage: [
                issue326Snapshot("low-no-reset", remaining: 2, resetsIn: nil),
                issue326Snapshot("unknown", remaining: nil, resetsIn: nil),
            ]
        )
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining

        #expect(visibleIDs(from: state, using: model) == ["unknown"],
                "the known-low row still fails threshold; fully unknown data never hides")

        model.hideRemainingThresholdEnabled = false
        #expect(visibleIDs(from: state, using: model) == ["low-no-reset", "unknown"],
                "an unknown reset exempts a row when renewal is the only active criterion")
    }

    @Test func filterUsesThePreferenceSelectedBindingWindow() throws {
        let state = DeckState(
            accounts: [issue326Account("binding", label: "Studio")],
            usage: [
                // Default lowest-remaining binding fails the 5% threshold.
                issue326Snapshot(
                    "binding", scope: "5h", remaining: 2, resetsIn: 3 * 86_400),
                // The model-window preference makes this the number the card
                // displays. A parallel account-wide minimum would still hide it.
                issue326Snapshot(
                    "binding", scope: "week:fable", remaining: 80,
                    resetsIn: 3 * 86_400),
            ]
        )
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining
        model.hideRenewingSoonEnabled = false
        #expect(visibleIDs(from: state, using: model).isEmpty)

        model.preferModelWindowHeadline = true
        let displayedRow = try #require(DeckBuilder.rows(
            state: state,
            now: issue326Now,
            preferModelWindowHeadline: true
        ).first)
        #expect(displayedRow.worstWindow?.scope == "week:fable")
        #expect(displayedRow.displayedRemainingPercent == 80)
        #expect(visibleIDs(from: state, using: model) == ["binding"],
                "visibility must follow the model-selected card binding")
    }

    // MARK: Settings options and persistence

    @Test func remainingThresholdOptionsLabelsDefaultAndPersistence() {
        #expect(DeckPopoverModel.DeckHideMode.allCases == [
            .byAccount, .byRemaining, .byZeroWeightings,
        ])
        #expect(DeckPopoverModel.DeckHideMode.allCases.map(\.displayName) == [
            "By subscription", "By remaining", "By zero weightings",
        ])
        #expect(DeckPopoverModel.DeckRemainingThreshold.allCases == [
            .one, .five, .ten, .twentyFive, .fifty,
        ])
        #expect(DeckPopoverModel.DeckRemainingThreshold.allCases.map(\.displayName) == [
            "1%", "5%", "10%", "25%", "50%",
        ])

        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        #expect(model.hideRemainingThreshold == .five)
        #expect(model.hideRemainingThresholdEnabled)
        model.hideRemainingThreshold = .twentyFive
        model.hideRemainingThresholdEnabled = false
        let relaunched = DeckPopoverModel(defaults: defaults)
        #expect(relaunched.hideRemainingThreshold == .twentyFive)
        #expect(!relaunched.hideRemainingThresholdEnabled)
    }

    @Test func renewingSoonDefaultsOptionsAndPersistence() {
        #expect(DeckPopoverModel.DeckResetsHorizon.allCases == [
            .twelveHours, .oneDay, .fortyEightHours, .threeDays,
            .fourDays, .fiveDays, .sixDays, .sevenDays,
        ])
        #expect(DeckPopoverModel.DeckResetsHorizon.allCases.map(\.displayName) == [
            "12 hours", "24 hours", "48 hours", "3 days",
            "4 days", "5 days", "6 days", "7 days (All)",
        ])

        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        #expect(model.hideRenewingSoonEnabled)
        #expect(model.hideResetsHorizon == .oneDay)
        model.hideRenewingSoonEnabled = false
        model.hideResetsHorizon = .sixDays
        let relaunched = DeckPopoverModel(defaults: defaults)
        #expect(!relaunched.hideRenewingSoonEnabled)
        #expect(relaunched.hideResetsHorizon == .sixDays)
    }

    // MARK: Shipped By-resets migration

    @Test func literalByResetsRawValueMigratesInPlaceWithoutStrandingState() {
        let defaults = freshDefaults()
        defaults.set("by-resets", forKey: "modeldeck.popover.hideShow.mode")
        defaults.set("4d", forKey: "modeldeck.popover.hideShow.resetsHorizon")
        defaults.set(["manual-hidden"], forKey: "modeldeck.popover.hideShow.manualHidden")
        defaults.set(["manual-pinned"], forKey: "modeldeck.popover.hideShow.manualShown")

        let migrated = DeckPopoverModel(defaults: defaults)
        #expect(DeckPopoverModel.DeckHideMode.byRemaining.rawValue == "by-resets",
                "the shipped raw value remains decodable instead of falling back")
        #expect(migrated.hideMode == .byRemaining)
        #expect(migrated.hideRemainingThreshold == .five)
        #expect(migrated.hideRemainingThresholdEnabled,
                "0.4.4's structural threshold migrates explicitly enabled")
        #expect(migrated.hideRenewingSoonEnabled)
        #expect(migrated.hideResetsHorizon == .fourDays)
        #expect(migrated.manuallyHiddenAccountIDs == ["manual-hidden"])
        #expect(migrated.manuallyShownAccountIDs == ["manual-pinned"])

        let state = DeckState(
            accounts: [
                issue326Account("manual-hidden", label: "Studio"),
                issue326Account("manual-pinned", label: "Client"),
                issue326Account("automatic-high", label: "Workshop"),
                issue326Account("automatic-hidden", label: "Personal"),
            ],
            usage: [
                issue326Snapshot(
                    "manual-hidden", remaining: 80, resetsIn: 6 * 86_400),
                issue326Snapshot(
                    "manual-pinned", remaining: 2, resetsIn: 6 * 86_400),
                issue326Snapshot(
                    "automatic-high", remaining: 80, resetsIn: 6 * 86_400),
                issue326Snapshot(
                    "automatic-hidden", remaining: 2, resetsIn: 6 * 86_400),
            ]
        )
        #expect(visibleIDs(from: state, using: migrated) == ["manual-pinned"],
                "strict AND hides the far-renewing high row while manual overrides still win")
    }

    // MARK: Verbatim, selection-live Settings caption

    @Test func settingsCaptionIsVerbatimAndTracksBothLiveSelections() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(model.byRemainingCaption
            == "Subscriptions with 5% or more remaining AND renewing within 24 hours stay visible.")

        model.hideRemainingThreshold = .twentyFive
        model.hideResetsHorizon = .sixDays
        #expect(model.byRemainingCaption
            == "Subscriptions with 25% or more remaining AND renewing within 6 days stay visible.")

        model.hideRenewingSoonEnabled = false
        #expect(model.byRemainingCaption
            == "Subscriptions with 25% or more remaining stay visible. Everything else is hidden.")
    }
}
