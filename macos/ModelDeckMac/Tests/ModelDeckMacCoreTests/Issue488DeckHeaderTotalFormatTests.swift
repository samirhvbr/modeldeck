import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #488 (Tim's field report, straight after 1.0.2): he expected the
// #482 sum ↔ share flip on the deck header too — "whatever we showed on the
// deck would automatically show up at the top". The format is now ONE
// per-provider preference (`poolTotalFormat`) that the deck header, the
// Settings picker, and the menu bar's right-click flip all read and write.
//
// Pinned claims: an explicit entry outranks the 1.0.2 pin suffix; with no
// entry, a same-provider suffix is honored (the migration read — nobody
// re-chooses); every flip surface writes the shared key AND keeps the pin
// suffix in agreement while the menu bar shows that pool's total (downgrade
// fidelity); the share header keeps the #458 honesty rules (counted
// denominator, partial-pool disclosure). Placeholder identities only; no
// daemon, no network, no clock.

private let anchor = Date(timeIntervalSince1970: 1_800_000_000)

private func window(_ remaining: Double?) -> DeckWindow {
    DeckWindow(
        scope: "5h",
        title: "5-hour",
        remainingPercent: remaining,
        resetsAt: anchor.addingTimeInterval(3_600),
        resetText: "resets in 1 hr",
        severity: .healthy,
        stale: false,
        spendText: nil
    )
}

private func row(_ id: String, _ remaining: Double?) -> DeckAccountRow {
    DeckAccountRow(
        account: DeckAccount(
            id: id, provider: "claude", label: "Profile \(id.uppercased())",
            identity: "\(id)@example.com", enabled: true, isDefault: false
        ),
        provider: .claude,
        windows: remaining == nil ? [] : [window(remaining)],
        isActive: false
    )
}

/// Tim's own seven-account example: 474% summed, 68% of the 700% capacity.
private func timsPool() -> DeckColumnUsageHeadline.Display {
    let remaining: [Double] = [38, 43, 62, 50, 86, 96, 99]
    let rows = remaining.enumerated().map { row("c\($0.offset)", $0.element) }
    return DeckColumnUsageHeadline.display(
        for: DeckColumn(provider: .claude, rows: rows)
    )!
}

@Suite("Shared pool-total format grammar (issue #488)")
struct PoolTotalFormatGrammarTests {
    @Test func entriesParsePerProviderAndJunkIsIgnored() {
        #expect(MenuBarPinResolver.poolFormat(for: .claude, in: "") == nil)
        #expect(MenuBarPinResolver.poolFormat(for: .claude, in: "claude:share") == .share)
        #expect(MenuBarPinResolver.poolFormat(for: .codex, in: "claude:share") == nil)
        #expect(MenuBarPinResolver.poolFormat(for: .codex, in: "claude:share,codex:sum") == .sum)
        // Unknown formats and junk entries read as unset, never a crash —
        // a newer build's value round-trips through this one unclobbered.
        #expect(MenuBarPinResolver.poolFormat(for: .claude, in: "claude:median") == nil)
        #expect(MenuBarPinResolver.poolFormat(for: .claude, in: "garbage,,claude:share") == .share)
    }

    @Test func updatingReplacesOneProviderAndKeepsTheOther() {
        let stored = MenuBarPinResolver.updatingPoolFormats("", provider: .claude, format: .share)
        #expect(stored == "claude:share")
        let both = MenuBarPinResolver.updatingPoolFormats(stored, provider: .codex, format: .share)
        #expect(both == "claude:share,codex:share")
        let flipped = MenuBarPinResolver.updatingPoolFormats(both, provider: .claude, format: .sum)
        #expect(flipped == "claude:sum,codex:share")
        #expect(MenuBarPinResolver.poolFormat(for: .claude, in: flipped) == .sum)
        #expect(MenuBarPinResolver.poolFormat(for: .codex, in: flipped) == .share)
    }

    @Test func resolutionPrefersTheSharedKeyOverThePinSuffix() {
        // Explicit entry wins — even an explicit sum over a share suffix.
        #expect(MenuBarPinResolver.resolvedTotalFormat(
            provider: .claude, poolFormats: "claude:sum", menuBarSetting: "total:claude|fmt:share"
        ) == .sum)
        #expect(MenuBarPinResolver.resolvedTotalFormat(
            provider: .claude, poolFormats: "claude:share", menuBarSetting: "total:claude"
        ) == .share)
    }

    @Test func aStoredOnePointTwoSuffixMigratesWithoutRechoosing() {
        // 1.0.2 stored the choice only as the pin's |fmt: suffix — with no
        // shared entry yet, a same-provider suffix is the format.
        #expect(MenuBarPinResolver.resolvedTotalFormat(
            provider: .claude, poolFormats: "", menuBarSetting: "total:claude|fmt:share"
        ) == .share)
        // Another provider's suffix says nothing about this pool.
        #expect(MenuBarPinResolver.resolvedTotalFormat(
            provider: .codex, poolFormats: "", menuBarSetting: "total:claude|fmt:share"
        ) == .sum)
        // No entry, no suffix, non-total pin, or nothing stored — sum.
        #expect(MenuBarPinResolver.resolvedTotalFormat(
            provider: .claude, poolFormats: "", menuBarSetting: "acct-1"
        ) == .sum)
        #expect(MenuBarPinResolver.resolvedTotalFormat(
            provider: .claude, poolFormats: "", menuBarSetting: nil
        ) == .sum)
    }
}

@Suite("Header display in both formats (issue #488)")
@MainActor
struct DeckHeaderFormatDisplayTests {
    @Test func timsHeaderRendersBothFormats() {
        let display = timsPool()
        #expect(display.text(.sum) == "474% left")
        #expect(display.text(.share) == "68% left")
        #expect(display.accessibilityLabel(.share)
            == "68 percent of capacity left across 7 subscriptions")
        // The share tooltip spells out the arithmetic so "68% left" can
        // never read as one subscription's number.
        #expect(display.tooltip(.share).contains("(474%)"))
        #expect(display.tooltip(.share).contains("(700%)"))
        #expect(display.tooltip(.sum) == display.tooltip)
    }

    @Test func partialPoolShareKeepsTheCoverageDisclosure() {
        let display = DeckColumnUsageHeadline.display(
            for: DeckColumn(provider: .claude, rows: [row("a", 50), row("b", nil)], hiddenAccountCount: 1)
        )!
        #expect(display.text(.share) == "50% left")
        #expect(display.tooltip(.share).contains("1 of this column's 3 subscriptions"))
        #expect(display.tooltip(.share).contains("1 with no current reading"))
        #expect(display.accessibilityLabel(.share)
            == "50 percent of capacity left across 1 of 3 subscriptions")
    }
}

@Suite("Shared format on the status model (issue #488)")
@MainActor
struct SharedFormatStatusModelTests {
    private var fixtureState: DeckState {
        DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true)],
            usage: [UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 80)]
        )
    }

    private func model() -> MenuBarStatusModel {
        let m = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        m.providerTotalsSource = { _ in [.claude: timsPool()] }
        return m
    }

    @Test func theSharedKeyDrivesTheIconOverThePinSuffix() {
        let m = model()
        m.pinnedAccountId = "total:claude"
        m.poolTotalFormat = "claude:share"
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .pinned(percentRemaining: 68))
        // An explicit sum outranks a leftover 1.0.2 share suffix.
        m.pinnedAccountId = "total:claude|fmt:share"
        m.poolTotalFormat = "claude:sum"
        #expect(m.iconState == .pinned(percentRemaining: 474))
        // And the source line agrees with the icon.
        #expect(m.menuBarNumberSourceLine?.text == "Menu bar 474% — Claude total · 7 subscriptions")
    }

    @Test func withNoSharedEntryTheSuffixStillWorks() {
        // The 1.0.2 read path is intact — a pre-migration document renders
        // exactly as it did.
        let m = model()
        m.pinnedAccountId = "total:claude|fmt:share"
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .pinned(percentRemaining: 68))
    }
}

@Suite("Every flip surface writes the shared setting (issue #488)")
@MainActor
struct SharedFormatWriteTests {
    private func loadedModel(_ document: DaemonSettings, then results: [StubSettingsSync.Result])
        async -> (SettingsSyncModel, StubSettingsSync) {
        let sync = StubSettingsSync(results: [.success(document)] + results)
        let model = SettingsSyncModel(sync: sync)
        await model.load()
        return (model, sync)
    }

    @Test func theFlipWritesTheSharedKeyAndTheMatchingPinSuffix() async {
        // Menu bar showing the Claude total: one patch carries the shared
        // key AND the rewritten pin, so a downgraded build reads the same
        // choice from the suffix.
        var document = DaemonSettings.defaults
        document.menuBarAccountId = "total:claude"
        let (model, sync) = await loadedModel(document, then: [.success(document)])

        await model.setPoolTotalFormat(provider: .claude, format: .share)

        #expect(sync.pushedPatches.count == 1)
        #expect(sync.pushedPatches.first?.poolTotalFormat == "claude:share")
        #expect(sync.pushedPatches.first?.menuBarAccountId == "total:claude|fmt:share")
    }

    @Test func aHeaderFlipLeavesAnUnrelatedMenuBarModeAlone() async {
        // Menu bar pinned to an account: the header's flip must not hijack
        // the menu bar display — only the shared key is written.
        var document = DaemonSettings.defaults
        document.menuBarAccountId = "acct-1"
        let (model, sync) = await loadedModel(document, then: [.success(document)])

        await model.setPoolTotalFormat(provider: .claude, format: .share)

        #expect(sync.pushedPatches.count == 1)
        #expect(sync.pushedPatches.first?.poolTotalFormat == "claude:share")
        #expect(sync.pushedPatches.first?.menuBarAccountId == nil)
    }

    @Test func aPreFourEightEightDaemonStillGetsThePinSuffixWrite() async {
        // Old-daemon tolerance: the daemon rejects the shared key, the
        // strip-and-retry keeps the pin write — the chosen format survives
        // through the 1.0.2 grammar both builds read as fallback.
        var document = DaemonSettings.defaults
        document.menuBarAccountId = "total:claude"
        let (model, sync) = await loadedModel(document, then: [
            .failure(DaemonClientError.daemonError(message: "unknown setting: poolTotalFormat", status: 400)),
            .success(document),
        ])

        await model.setPoolTotalFormat(provider: .claude, format: .share)

        #expect(model.lastError == nil)
        #expect(sync.pushedPatches.count == 2)
        #expect(sync.pushedPatches.last?.poolTotalFormat == nil)
        #expect(sync.pushedPatches.last?.menuBarAccountId == "total:claude|fmt:share")
    }

    @Test func theHeaderClickFlipsAgainstTheResolvedFormat() {
        // DeckPopoverModel: the header's click emits the OPPOSITE of what
        // the header currently renders — including when what it renders
        // came from a migrated 1.0.2 suffix.
        let deck = DeckPopoverModel(
            defaults: UserDefaults(suiteName: "issue488-\(UUID().uuidString)")!
        )
        var flips: [(DeckProvider, MenuBarPinResolver.TotalFormat)] = []
        deck.onSetPoolTotalFormat = { flips.append(($0, $1)) }

        #expect(deck.poolTotalFormat(for: .claude) == .sum)
        deck.flipPoolTotalFormat(for: .claude)
        deck.poolTotalFormatSetting = "claude:share"
        #expect(deck.poolTotalFormat(for: .claude) == .share)
        deck.flipPoolTotalFormat(for: .claude)
        deck.poolTotalFormatSetting = ""
        deck.menuBarPinnedSetting = "total:claude|fmt:share"
        #expect(deck.poolTotalFormat(for: .claude) == .share)
        deck.flipPoolTotalFormat(for: .claude)

        #expect(flips.map(\.1) == [.share, .sum, .sum])
        #expect(flips.map(\.0) == [.claude, .claude, .claude])
    }

    @Test func theContextMenuFlipRespectsTheSharedKey() throws {
        // With the shared key at share, the right-click offers Sum — even
        // though the pin string alone (bare sentinel) would say sum → the
        // #488 regression tripwire for surfaces disagreeing on the format.
        let items = MenuBarContextMenu.items(
            isCheckingForUpdates: false,
            menuBarSetting: "total:claude",
            poolTotalFormat: "claude:share"
        )
        let flip = try #require(items.first)
        #expect(flip.title == "Show Claude Total as Sum")
        #expect(flip.action == .setTotalFormat(provider: .claude, format: .sum))
    }
}

@Suite("Shared format storage compatibility (issue #488)")
struct SharedFormatStorageTests {
    @Test func aPreFourEightEightDocumentDecodesAsNothingChosen() throws {
        let decoded = try JSONDecoder().decode(
            DaemonSettings.self,
            from: Data(#"{"menuBarAccountId": "total:claude|fmt:share"}"#.utf8)
        )
        #expect(decoded.poolTotalFormat == "")
    }

    @Test func thePatchEncodesTheSharedKeyForThePut() throws {
        let data = try JSONEncoder().encode(
            DaemonSettingsPatch(poolTotalFormat: "claude:share")
        )
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains(#""poolTotalFormat":"claude:share""#))
    }
}
