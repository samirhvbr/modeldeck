import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #343: the usage-analytics dashboard entry point. Contract under
// test: 0.4.6 defaults on while a pre-#343 daemon still decodes false when
// the key is absent, the patch carries it without clobbering other
// keys, old daemons that reject the key get the strip-and-retry tolerance,
// and the menu-item strings/URL are the explicit Core contract the SwiftUI
// layer renders. Placeholder values only — never real account data.

@Suite("Usage analytics feature flag settings (issue #343)")
struct UsageAnalyticsSettingsTests {
    // TRIPWIRE (#388): the 0.4.6 client mirror must not drift back off.
    @Test func defaultsToOn() {
        #expect(DaemonSettings.defaults.usageAnalyticsEnabled == true)
    }

    @Test func absentKeyDecodesAsOff() throws {
        // A pre-#343 daemon's document has no usageAnalyticsEnabled key.
        let json = #"{"autoRefreshEnabled":true,"layout":"two-column"}"#
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(json.utf8))
        #expect(settings.usageAnalyticsEnabled == false)
    }

    @Test func presentKeyDecodes() throws {
        let json = #"{"usageAnalyticsEnabled":true}"#
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(json.utf8))
        #expect(settings.usageAnalyticsEnabled == true)
    }

    @Test func patchEncodesOnlyWhenSet() throws {
        let empty = DaemonSettingsPatch()
        #expect(empty.isEmpty)
        let emptyData = try JSONEncoder().encode(empty)
        #expect(!String(decoding: emptyData, as: UTF8.self).contains("usageAnalyticsEnabled"))

        let patch = DaemonSettingsPatch(usageAnalyticsEnabled: true)
        #expect(!patch.isEmpty)
        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(patch)
        ) as? [String: Any]
        #expect(object?.count == 1)
        #expect(object?["usageAnalyticsEnabled"] as? Bool == true)
    }

    @Test func mergingLaterPatchWins() {
        let off = DaemonSettingsPatch(usageAnalyticsEnabled: false)
        let on = DaemonSettingsPatch(usageAnalyticsEnabled: true)
        #expect(off.merging(on).usageAnalyticsEnabled == true)
        #expect(on.merging(DaemonSettingsPatch()).usageAnalyticsEnabled == true)
    }
}

@Suite("Usage analytics menu contract (issue #343)")
struct UsageAnalyticsMenuTests {
    @Test func dashboardURLRidesTheDaemonBase() throws {
        let base = try #require(URL(string: "http://127.0.0.1:3867"))
        #expect(UsageAnalytics.dashboardURL(base: base).absoluteString == "http://127.0.0.1:3867/dashboard")
    }

    @Test func menuItemNamesTheBrowserSideEffectForVoiceOver() {
        // Deck-row accessibility class of bugs (mandatory UI lens): the
        // VoiceOver label is an explicit contract, distinct from the title,
        // and names where the click lands (the web browser).
        #expect(UsageAnalytics.menuItemTitle == "Usage Analytics…")
        #expect(UsageAnalytics.menuItemAccessibilityLabel.localizedCaseInsensitiveContains("browser"))
        #expect(UsageAnalytics.menuItemAccessibilityLabel != UsageAnalytics.menuItemTitle)
    }

    @MainActor
    @Test func deckModelPublishesNoURLByDefault() {
        // nil = flag off = the gear menu renders no item at all.
        let suite = "issue343-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let model = DeckPopoverModel(defaults: defaults)
        #expect(model.usageAnalyticsDashboardURL == nil)
    }
}

@Suite("Usage analytics old-daemon tolerance (issue #343)")
@MainActor
struct UsageAnalyticsStripRetryTests {
    @Test func unknownKeyIsStrippedAndPatchRetried() async {
        // A pre-#343 daemon rejects the flag; the rest of the patch must
        // survive the retry (the #90/#123/#176/#238/#242 tolerance path).
        var merged = DaemonSettings.defaults
        merged.pauseWhileActive = true
        let sync = StubSettingsSync(results: [
            .failure(DaemonClientError.daemonError(
                message: "unknown setting: usageAnalyticsEnabled", status: 400
            )),
            .success(merged),
        ])
        let model = SettingsSyncModel(sync: sync)

        await model.update(DaemonSettingsPatch(
            pauseWhileActive: true, usageAnalyticsEnabled: true
        ))

        #expect(model.lastError == nil)
        #expect(sync.pushedPatches.count == 2)
        #expect(sync.pushedPatches.last?.usageAnalyticsEnabled == nil)
        #expect(sync.pushedPatches.last?.pauseWhileActive == true)
        #expect(model.settings.pauseWhileActive == true)
    }

    @Test func flagOnlyPatchAgainstOldDaemonIsASuccessfulNoOp() async {
        var oldDocument = DaemonSettings.defaults
        oldDocument.usageAnalyticsEnabled = false
        let sync = StubSettingsSync(results: [
            .success(oldDocument),
            .failure(DaemonClientError.daemonError(
                message: "unknown setting: usageAnalyticsEnabled", status: 400
            )),
        ])
        let model = SettingsSyncModel(sync: sync)
        await model.load()

        await model.setUsageAnalyticsEnabled(true)

        #expect(model.lastError == nil)
        #expect(sync.pushedPatches.count == 1)
        // The daemon-confirmed document still reads off, so the toggle
        // honestly snaps back rather than pretending the old daemon has a
        // dashboard to serve.
        #expect(model.settings.usageAnalyticsEnabled == false)
    }

    @Test func setterIsANoOpWhenUnchanged() async {
        let sync = StubSettingsSync(results: [])
        let model = SettingsSyncModel(sync: sync)
        await model.setUsageAnalyticsEnabled(true)
        #expect(sync.pushedPatches.isEmpty)
    }
}
