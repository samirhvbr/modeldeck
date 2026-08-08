import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #330 replaces By remaining's union with two independently enabled
// criteria. These fixtures use placeholder identities only.

private let issue330Now = Date(timeIntervalSince1970: 1_800_000_000)

private func issue330ISO(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: issue330Now.addingTimeInterval(offset))
}

private func issue330Account(_ id: String) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: "claude",
        label: "Account \(id)",
        identity: "\(id)@example.com",
        enabled: true,
        isDefault: false
    )
}

private func issue330Snapshot(
    _ accountID: String,
    remaining: Double,
    resetsIn: TimeInterval
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountID,
        scope: "weekly",
        remainingPercent: remaining,
        resetsAt: issue330ISO(resetsIn),
        stale: false
    )
}

private func issue330TruthTableState() -> DeckState {
    DeckState(
        accounts: [
            issue330Account("both-pass"),
            issue330Account("threshold-pass"),
            issue330Account("renewal-pass"),
            issue330Account("neither-pass"),
        ],
        usage: [
            issue330Snapshot("both-pass", remaining: 25, resetsIn: 6 * 3_600),
            issue330Snapshot("threshold-pass", remaining: 25, resetsIn: 2 * 86_400),
            issue330Snapshot("renewal-pass", remaining: 4, resetsIn: 6 * 3_600),
            issue330Snapshot("neither-pass", remaining: 4, resetsIn: 2 * 86_400),
        ]
    )
}

/// A direct row fixture permits the two unknowns to vary independently. A
/// percentless spend headline is still the displayed binding window, giving
/// the renewal criterion a real reset while the displayed percentage is nil.
private func issue330Row(
    _ id: String,
    remaining: Double?,
    resetsIn: TimeInterval?
) -> DeckAccountRow {
    let percentIsUnknown = remaining == nil
    let reset = resetsIn.map { issue330Now.addingTimeInterval($0) }
    let window = DeckWindow(
        scope: percentIsUnknown ? "spend" : "weekly",
        title: percentIsUnknown ? "Extra usage" : "Weekly",
        remainingPercent: remaining,
        resetsAt: reset,
        resetText: reset == nil ? "" : "Reset",
        severity: UsageSeverity.severity(remainingPercent: remaining, thresholds: .default),
        stale: false,
        spendText: percentIsUnknown ? "$0.00 of $100.00" : nil
    )
    return DeckAccountRow(
        account: issue330Account(id),
        provider: .claude,
        windows: [window],
        isActive: false
    )
}

@Suite("Issue #330 independent By remaining criteria")
@MainActor
struct Issue330IndependentCriteriaTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "issue330-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func enablementAndPassFailTruthTableUsesStrictAND() {
        let rows = DeckBuilder.rows(state: issue330TruthTableState(), now: issue330Now)
        let configurations: [(
            thresholdEnabled: Bool,
            renewalEnabled: Bool,
            visibleIDs: Set<String>
        )] = [
            (false, false, ["both-pass", "threshold-pass", "renewal-pass", "neither-pass"]),
            (true, false, ["both-pass", "threshold-pass"]),
            (false, true, ["both-pass", "renewal-pass"]),
            (true, true, ["both-pass"]),
        ]

        for configuration in configurations {
            let visible = Set(rows.filter {
                DeckPopoverModel.isVisibleByRemainingFilter(
                    $0,
                    threshold: .five,
                    thresholdEnabled: configuration.thresholdEnabled,
                    renewingSoonEnabled: configuration.renewalEnabled,
                    horizon: .oneDay,
                    now: issue330Now)
            }.map(\.id))
            #expect(visible == configuration.visibleIDs,
                    "threshold=\(configuration.thresholdEnabled), renewal=\(configuration.renewalEnabled)")
        }
    }

    @Test func unknownValuesExemptOnlyTheirOwnCriterion() {
        let unknownPercentFarReset = issue330Row(
            "unknown-percent-far", remaining: nil, resetsIn: 2 * 86_400)
        let lowUnknownReset = issue330Row(
            "low-unknown-reset", remaining: 4, resetsIn: nil)
        let unknownPercentNearReset = issue330Row(
            "unknown-percent-near", remaining: nil, resetsIn: 6 * 3_600)
        let highUnknownReset = issue330Row(
            "high-unknown-reset", remaining: 25, resetsIn: nil)
        let bothUnknown = issue330Row(
            "both-unknown", remaining: nil, resetsIn: nil)

        func isVisible(_ row: DeckAccountRow) -> Bool {
            DeckPopoverModel.isVisibleByRemainingFilter(
                row,
                threshold: .five,
                thresholdEnabled: true,
                renewingSoonEnabled: true,
                horizon: .oneDay,
                now: issue330Now)
        }

        #expect(!isVisible(unknownPercentFarReset),
                "unknown percentage is exempt, but the known far reset still fails")
        #expect(!isVisible(lowUnknownReset),
                "unknown reset is exempt, but the known-low percentage still fails")
        #expect(isVisible(unknownPercentNearReset))
        #expect(isVisible(highUnknownReset))
        #expect(isVisible(bothUnknown), "two unknowns create no invented failure")
        #expect(DeckPopoverModel.isVisibleByRemainingFilter(
            unknownPercentFarReset,
            threshold: .five,
            thresholdEnabled: true,
            renewingSoonEnabled: false,
            horizon: .oneDay,
            now: issue330Now
        ), "an unknown percentage is exempt when the threshold acts alone")
    }

    @Test func unanchoredPlaceholderRemainsRenewalUnknown() throws {
        let week = 7 * 86_400.0
        let state = DeckState(
            accounts: [issue330Account("fresh")],
            usage: [
                UsageSnapshot(
                    accountId: "fresh",
                    scope: "weekly",
                    remainingPercent: 100,
                    resetsAt: issue330ISO(week),
                    observedAt: issue330ISO(0),
                    detail: UsageSnapshotDetail(windowDurationMins: week / 60)
                ),
            ]
        )
        let fresh = try #require(DeckBuilder.rows(state: state, now: issue330Now).first)

        #expect(fresh.worstWindow?.anchor == .unanchored(windowDuration: week))
        #expect(fresh.displayedReset != nil, "the provider supplied a drifting placeholder")
        #expect(fresh.renewalCriterionReset == nil,
                "fresh-window copy is not an absolute reset the criterion may judge")
        #expect(DeckPopoverModel.isVisibleByRemainingFilter(
            fresh,
            threshold: .five,
            thresholdEnabled: false,
            renewingSoonEnabled: true,
            horizon: .oneDay,
            now: issue330Now
        ), "renewal-only mode exempts a genuinely unanchored reset")
    }

    @Test func anchoredExpiredResetVerdictIgnoresRollforwardMetadata() throws {
        let expiredReset = issue330Now.addingTimeInterval(-3_600)
        let state = DeckState(
            accounts: [
                issue330Account("without-observation"),
                issue330Account("with-observation"),
            ],
            usage: [
                UsageSnapshot(
                    accountId: "without-observation",
                    scope: "weekly",
                    remainingPercent: 4,
                    resetsAt: issue330ISO(-3_600)
                ),
                UsageSnapshot(
                    accountId: "with-observation",
                    scope: "weekly",
                    remainingPercent: 4,
                    resetsAt: issue330ISO(-3_600),
                    observedAt: issue330ISO(-7_200)
                ),
            ]
        )
        let rows = Dictionary(uniqueKeysWithValues: DeckBuilder.rows(
            state: state, now: issue330Now
        ).map { ($0.id, $0) })
        let withoutObservation = try #require(rows["without-observation"])
        let withObservation = try #require(rows["with-observation"])

        #expect(withoutObservation.worstWindow?.anchor == .anchored)
        #expect(withObservation.worstWindow?.anchor == .anchored)
        #expect(withoutObservation.worstWindow?.idleRollforward == nil)
        #expect(withObservation.worstWindow?.idleRollforward != nil,
                "the observation proves that the stored window rolled while idle")
        #expect(withoutObservation.renewalCriterionReset == expiredReset)
        #expect(withObservation.renewalCriterionReset == expiredReset,
                "presentation-only rollforward metadata cannot erase an anchored reset")

        func renewalOnlyVerdict(_ row: DeckAccountRow) -> Bool {
            DeckPopoverModel.isVisibleByRemainingFilter(
                row,
                threshold: .five,
                thresholdEnabled: false,
                renewingSoonEnabled: true,
                horizon: .oneDay,
                now: issue330Now)
        }

        let withoutMetadata = renewalOnlyVerdict(withoutObservation)
        let withMetadata = renewalOnlyVerdict(withObservation)
        #expect(withMetadata == withoutMetadata,
                "the same reset timestamp has the same verdict regardless of observedAt")
        #expect(!withoutMetadata)
        #expect(!withMetadata,
                "a real reset one hour ago fails the [now, now + horizon] lower bound")
    }

    @Test func oldDaemonCachedPlaceholderBiasesToVisibleUnknown() throws {
        let week = 7 * 86_400.0
        let state = DeckState(
            accounts: [issue330Account("cached-placeholder")],
            usage: [
                UsageSnapshot(
                    accountId: "cached-placeholder",
                    scope: "weekly",
                    remainingPercent: 100,
                    resetsAt: issue330ISO(week - 3_600),
                    observedAt: nil
                ),
            ]
        )
        let row = try #require(DeckBuilder.rows(state: state, now: issue330Now).first)

        #expect(row.worstWindow?.anchor == .unanchored(windowDuration: week),
                "without observedAt, an hour-old placeholder stays conservatively unknown")
        #expect(row.renewalCriterionReset == nil)
        #expect(DeckPopoverModel.isVisibleByRemainingFilter(
            row,
            threshold: .five,
            thresholdEnabled: false,
            renewingSoonEnabled: true,
            horizon: .sixDays,
            now: issue330Now
        ), "renewal-only mode must not hide an ambiguous cached placeholder")
    }

    @Test func bothCriteriaOffMakesTheEyeClickANoOpWithConfiguredCopy() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining
        model.hideRemainingThreshold = .twentyFive
        model.hideResetsHorizon = .sixDays
        model.hideRemainingThresholdEnabled = false
        model.hideRenewingSoonEnabled = false
        let state = issue330TruthTableState()

        #expect(model.eyeToggleChangesNothingVisible(state: state, now: issue330Now))
        model.toggleHideShowSystemFromEye(state: state, now: issue330Now)

        #expect(!model.hideShowEnabled, "a no-op callout never blocks the eye toggle")
        #expect(model.eyeCalloutText == "No filters are active.")
    }

    @Test func bothCriteriaOffStillRoutesManualHidesThroughTheEyePredicate() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining
        model.hideRemainingThresholdEnabled = false
        model.hideRenewingSoonEnabled = false
        model.setManualVisibility(.hidden, for: "both-pass")
        let state = issue330TruthTableState()

        #expect(!model.eyeToggleChangesNothingVisible(state: state, now: issue330Now),
                "the inactive automatic criteria do not erase a manual hide")
        #expect(!model.columns(for: state, now: issue330Now)
            .flatMap(\.rows).contains { $0.id == "both-pass" })
        model.toggleHideShowSystemFromEye(state: state, now: issue330Now)
        #expect(!model.hideShowEnabled)
        #expect(model.eyeCalloutText == nil,
                "restoring a manually hidden row is observable, so it is not a no-op")
        #expect(model.columns(for: state, now: issue330Now)
            .flatMap(\.rows).contains { $0.id == "both-pass" })
    }

    @Test func automaticStrictANDCanHideEverythingWithoutStrandingTheDeck() throws {
        let state = DeckState(
            accounts: [
                issue330Account("threshold-only"),
                issue330Account("renewal-only"),
            ],
            usage: [
                issue330Snapshot(
                    "threshold-only", remaining: 25, resetsIn: 2 * 86_400),
                issue330Snapshot(
                    "renewal-only", remaining: 4, resetsIn: 6 * 3_600),
            ]
        )
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byRemaining
        model.hideRemainingThreshold = .five
        model.hideRemainingThresholdEnabled = true
        model.hideRenewingSoonEnabled = true
        model.hideResetsHorizon = .oneDay

        let filtered = try #require(model.columns(
            for: state, now: issue330Now
        ).first { $0.provider == .claude })
        #expect(filtered.rows.isEmpty,
                "strict AND hides rows that pass only one of the two criteria")
        #expect(filtered.hiddenAccountCount == 2)
        #expect(filtered.accountCountText == "2 accounts")
        #expect(model.isHidingAnyRow(state: state, now: issue330Now),
                "the footer eye remains the visible escape hatch")
        #expect(!model.eyeToggleChangesNothingVisible(state: state, now: issue330Now))

        model.toggleHideShowSystemFromEye(state: state, now: issue330Now)
        let restored = try #require(model.columns(
            for: state, now: issue330Now
        ).first { $0.provider == .claude })
        #expect(!model.hideShowEnabled)
        #expect(model.eyeCalloutText == nil)
        #expect(Set(restored.rows.map(\.id)) == ["threshold-only", "renewal-only"])
        #expect(restored.hiddenAccountCount == 0)
    }

    @Test func calloutCopyMatchesEveryCriteriaConfiguration() {
        let state = DeckState(
            accounts: [issue330Account("passes")],
            usage: [issue330Snapshot("passes", remaining: 25, resetsIn: 6 * 3_600)]
        )
        let configurations: [(
            thresholdEnabled: Bool,
            renewalEnabled: Bool,
            copy: String
        )] = [
            (
                true,
                true,
                "No accounts are hidden by your 25% remaining and 6-day renewal filters."
            ),
            (true, false, "No accounts are hidden by your 25% remaining filter."),
            (false, true, "No accounts are hidden by your 6-day renewal filter."),
            (false, false, "No filters are active."),
        ]

        for configuration in configurations {
            let model = DeckPopoverModel(defaults: freshDefaults())
            model.hideMode = .byRemaining
            model.hideRemainingThreshold = .twentyFive
            model.hideResetsHorizon = .sixDays
            model.hideRemainingThresholdEnabled = configuration.thresholdEnabled
            model.hideRenewingSoonEnabled = configuration.renewalEnabled
            #expect(model.eyeToggleChangesNothingVisible(state: state, now: issue330Now))
            model.toggleHideShowSystemFromEye(state: state, now: issue330Now)
            #expect(model.eyeCalloutText == configuration.copy)
        }
    }

    @Test func captionMatchesEveryConfigurationWithLiveSelections() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideRemainingThreshold = .twentyFive
        model.hideResetsHorizon = .sixDays
        let configurations: [(
            thresholdEnabled: Bool,
            renewalEnabled: Bool,
            caption: String,
            missingDataCaption: String?
        )] = [
            (
                true,
                true,
                "Accounts with 25% or more remaining AND renewing within 6 days stay visible.",
                "Accounts with missing data stay visible."
            ),
            (
                true,
                false,
                "Accounts with 25% or more remaining stay visible. Everything else is hidden.",
                "Accounts with missing data stay visible."
            ),
            (
                false,
                true,
                "Accounts renewing within 6 days stay visible. Everything else is hidden.",
                "Accounts with missing data stay visible."
            ),
            (false, false, "No filters active — nothing is hidden.", nil),
        ]

        for configuration in configurations {
            model.hideRemainingThresholdEnabled = configuration.thresholdEnabled
            model.hideRenewingSoonEnabled = configuration.renewalEnabled
            #expect(model.byRemainingCaption == configuration.caption)
            #expect(model.byRemainingMissingDataCaption == configuration.missingDataCaption)
        }
    }

    @Test func renewalCriterionCaptionNamesKnownResetsExactly() {
        #expect(DeckPopoverModel.byRemainingRenewalCriterionCaption
            == "Hides accounts with a known reset outside the window.")
    }

    @Test func manualOverridesWinAcrossEveryCriteriaConfiguration() {
        let bothPass = issue330Row(
            "manual-both-pass", remaining: 25, resetsIn: 6 * 3_600)
        let neitherPass = issue330Row(
            "manual-neither-pass", remaining: 4, resetsIn: 2 * 86_400)

        for (thresholdEnabled, renewalEnabled) in [
            (false, false), (true, false), (false, true), (true, true),
        ] {
            let model = DeckPopoverModel(defaults: freshDefaults())
            model.hideMode = .byRemaining
            model.hideRemainingThresholdEnabled = thresholdEnabled
            model.hideRenewingSoonEnabled = renewalEnabled

            #expect(!model.isRowHidden(bothPass, now: issue330Now))
            model.setManualVisibility(.hidden, for: bothPass.id)
            #expect(model.isRowHidden(bothPass, now: issue330Now),
                    "manual Hide wins for threshold=\(thresholdEnabled), renewal=\(renewalEnabled)")

            let anyCriterionEnabled = thresholdEnabled || renewalEnabled
            #expect(model.isRowHidden(neitherPass, now: issue330Now) == anyCriterionEnabled)
            model.setManualVisibility(.shown, for: neitherPass.id)
            #expect(!model.isRowHidden(neitherPass, now: issue330Now),
                    "manual Show wins for threshold=\(thresholdEnabled), renewal=\(renewalEnabled)")
        }
    }

    @Test func zeroPointFourPointFourLiteralMigrationMatrixPassesEveryModeThrough() {
        #expect(DeckPopoverModel.hideShowEnabledDefaultsKey
            == "modeldeck.popover.hideShow.enabled")
        #expect(DeckPopoverModel.hideShowModeDefaultsKey
            == "modeldeck.popover.hideShow.mode")
        #expect(DeckPopoverModel.hideShowRemainingThresholdDefaultsKey
            == "modeldeck.popover.hideShow.remainingThreshold")
        #expect(DeckPopoverModel.hideShowRemainingThresholdEnabledDefaultsKey
            == "modeldeck.popover.hideShow.remainingThresholdEnabled")
        #expect(DeckPopoverModel.hideShowRenewingSoonEnabledDefaultsKey
            == "modeldeck.popover.hideShow.renewingSoonEnabled")
        #expect(DeckPopoverModel.hideShowResetsHorizonDefaultsKey
            == "modeldeck.popover.hideShow.resetsHorizon")
        #expect(DeckPopoverModel.hideShowManualHiddenDefaultsKey
            == "modeldeck.popover.hideShow.manualHidden")
        #expect(DeckPopoverModel.hideShowManualShownDefaultsKey
            == "modeldeck.popover.hideShow.manualShown")
        #expect(DeckPopoverModel.DeckHideMode.byAccount.rawValue == "by-account")
        #expect(DeckPopoverModel.DeckHideMode.byRemaining.rawValue == "by-resets")
        #expect(DeckPopoverModel.DeckHideMode.byZeroWeightings.rawValue
            == "by-zero-weightings")

        let modes: [(rawValue: String, expected: DeckPopoverModel.DeckHideMode)] = [
            ("by-account", .byAccount),
            ("by-resets", .byRemaining),
            ("by-zero-weightings", .byZeroWeightings),
        ]
        for mode in modes {
            for masterEnabled in [false, true] {
                for legacyRenewalEnabled in [false, true] {
                    let defaults = freshDefaults()
                    // These seven literal keys and serialized values are the
                    // 0.4.4 on-disk contract. Never seed this sentinel matrix
                    // through current constants or enum raw values.
                    defaults.set(
                        masterEnabled,
                        forKey: "modeldeck.popover.hideShow.enabled")
                    defaults.set(
                        mode.rawValue,
                        forKey: "modeldeck.popover.hideShow.mode")
                    defaults.set(
                        25,
                        forKey: "modeldeck.popover.hideShow.remainingThreshold")
                    defaults.set(
                        legacyRenewalEnabled,
                        forKey: "modeldeck.popover.hideShow.renewingSoonEnabled")
                    defaults.set(
                        "6d",
                        forKey: "modeldeck.popover.hideShow.resetsHorizon")
                    defaults.set(
                        ["manual-hidden"],
                        forKey: "modeldeck.popover.hideShow.manualHidden")
                    defaults.set(
                        ["manual-pinned"],
                        forKey: "modeldeck.popover.hideShow.manualShown")
                    #expect(defaults.object(
                        forKey: "modeldeck.popover.hideShow.remainingThresholdEnabled"
                    ) == nil)

                    let migrated = DeckPopoverModel(defaults: defaults)

                    #expect(migrated.hideShowEnabled == masterEnabled)
                    #expect(migrated.hideMode == mode.expected)
                    #expect(migrated.hideRemainingThreshold == .twentyFive)
                    #expect(migrated.hideRemainingThresholdEnabled)
                    #expect(migrated.hideRenewingSoonEnabled == legacyRenewalEnabled)
                    #expect(migrated.hideResetsHorizon == .sixDays)
                    #expect(migrated.manuallyHiddenAccountIDs == ["manual-hidden"])
                    #expect(migrated.manuallyShownAccountIDs == ["manual-pinned"])

                    #expect(defaults.bool(
                        forKey: "modeldeck.popover.hideShow.enabled") == masterEnabled)
                    #expect(defaults.string(
                        forKey: "modeldeck.popover.hideShow.mode") == mode.rawValue)
                    #expect(defaults.integer(
                        forKey: "modeldeck.popover.hideShow.remainingThreshold") == 25)
                    #expect(defaults.bool(
                        forKey: "modeldeck.popover.hideShow.renewingSoonEnabled")
                        == legacyRenewalEnabled)
                    #expect(defaults.string(
                        forKey: "modeldeck.popover.hideShow.resetsHorizon") == "6d")
                    #expect(defaults.stringArray(
                        forKey: "modeldeck.popover.hideShow.manualHidden")
                        == ["manual-hidden"])
                    #expect(defaults.stringArray(
                        forKey: "modeldeck.popover.hideShow.manualShown")
                        == ["manual-pinned"])

                    if mode.rawValue == "by-resets" {
                        #expect(defaults.object(
                            forKey: "modeldeck.popover.hideShow.remainingThresholdEnabled"
                        ) != nil)
                        #expect(defaults.bool(
                            forKey: "modeldeck.popover.hideShow.remainingThresholdEnabled"))
                    } else {
                        #expect(defaults.object(
                            forKey: "modeldeck.popover.hideShow.remainingThresholdEnabled"
                        ) == nil, "other 0.4.4 modes pass through without migration writes")
                    }

                    let relaunched = DeckPopoverModel(defaults: defaults)
                    #expect(relaunched.hideShowEnabled == masterEnabled)
                    #expect(relaunched.hideMode == mode.expected)
                    #expect(relaunched.hideRemainingThreshold == .twentyFive)
                    #expect(relaunched.hideRemainingThresholdEnabled)
                    #expect(relaunched.hideRenewingSoonEnabled == legacyRenewalEnabled)
                    #expect(relaunched.hideResetsHorizon == .sixDays)
                    #expect(relaunched.manuallyHiddenAccountIDs == ["manual-hidden"])
                    #expect(relaunched.manuallyShownAccountIDs == ["manual-pinned"])
                }
            }
        }
    }

    @Test func absentLegacyRenewalKeyKeepsItsShippedOnMeaning() {
        let legacyModeKey = "modeldeck.popover.hideShow.mode"
        let legacyThresholdKey = "modeldeck.popover.hideShow.remainingThreshold"
        let legacyRenewalKey = "modeldeck.popover.hideShow.renewingSoonEnabled"
        let legacyHorizonKey = "modeldeck.popover.hideShow.resetsHorizon"
        let defaults = freshDefaults()
        defaults.set("by-resets", forKey: legacyModeKey)
        defaults.set(25, forKey: legacyThresholdKey)
        defaults.set("6d", forKey: legacyHorizonKey)
        #expect(defaults.object(forKey: legacyRenewalKey) == nil)

        let migrated = DeckPopoverModel(defaults: defaults)

        #expect(migrated.hideRemainingThresholdEnabled)
        #expect(migrated.hideRenewingSoonEnabled,
                "0.4.4 represented the untouched default-ON sub-filter with an absent key")
        #expect(migrated.hideRemainingThreshold == .twentyFive)
        #expect(migrated.hideResetsHorizon == .sixDays)
        #expect(defaults.object(forKey: legacyRenewalKey) == nil,
                "migration preserves the shipped absent-key representation")
        #expect(DeckPopoverModel(defaults: defaults).hideRenewingSoonEnabled)
    }
}
