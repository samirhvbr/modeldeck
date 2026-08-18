import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #482 (Tim's request): the menu bar can show a provider POOL's total
// % left — the #458 column headline — as the raw sum ("474%") or as a share
// of the counted pool's capacity ("68%": 474 of 700), flippable from
// Settings and the icon's right-click menu.
//
// Pinned claims: the sentinel grammar keeps every downgrade contract the
// #229/#235 sentinels established; the share form's denominator is the
// COUNTED accounts (a partial pool never fabricates capacity); no card gets
// the checkmark in total mode; quiet mode gates on the share percent in
// both formats; and display-only discipline holds — notifications keep
// watching every account. Placeholder identities only; no daemon, no
// network, no clock.

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

/// The #458 headline for a seven-account pool summing to 474 — Tim's own
/// example (474% of 700% capacity = 68%).
private func timsPool() -> DeckColumnUsageHeadline.Display {
    let remaining: [Double] = [38, 43, 62, 50, 86, 96, 99]
    let rows = remaining.enumerated().map { row("c\($0.offset)", $0.element) }
    return DeckColumnUsageHeadline.display(
        for: DeckColumn(provider: .claude, rows: rows)
    )!
}

@Suite("Total sentinel grammar (issue #482)")
struct MenuBarTotalSentinelTests {
    @Test func totalSentinelsAreRecognizedPerProvider() {
        #expect(MenuBarPinResolver.totalSentinel(for: .claude) == "total:claude")
        #expect(MenuBarPinResolver.totalProvider("total:claude") == .claude)
        #expect(MenuBarPinResolver.totalProvider("total:codex") == .codex)
        #expect(MenuBarPinResolver.isTotal("total:claude"))
        #expect(!MenuBarPinResolver.isTotal(""))
        #expect(!MenuBarPinResolver.isTotal("acct-1"))
        #expect(!MenuBarPinResolver.isTotal("health:claude"))
        // An unknown future provider is NOT total mode — it takes the
        // unresolvable-pin fallback like any unknown sentinel.
        #expect(MenuBarPinResolver.totalProvider("total:gemini") == nil)
        #expect(!MenuBarPinResolver.isTotal("total:gemini"))
    }

    @Test func formatSuffixRoundTripsAndDefaultsToSum() {
        let share = MenuBarPinResolver.totalValue(provider: .claude, format: .share)
        #expect(share == "total:claude|fmt:share")
        #expect(MenuBarPinResolver.totalFormat(share) == .share)
        #expect(MenuBarPinResolver.totalProvider(share) == .claude)
        // Sum is the no-suffix default — byte-identical to the bare
        // sentinel, the #292 no-suffix-for-default discipline.
        #expect(MenuBarPinResolver.totalValue(provider: .codex, format: .sum) == "total:codex")
        #expect(MenuBarPinResolver.totalFormat("total:codex") == .sum)
        // An unrecognized future format degrades to sum, not a dead mode.
        #expect(MenuBarPinResolver.totalFormat("total:claude|fmt:median") == .sum)
        // pinBase strips the format suffix like the #292 window suffix.
        #expect(MenuBarPinResolver.pinBase(share) == "total:claude")
    }

    @Test func totalNeverResolvesToAnAccount() {
        let state = DeckState(
            accounts: [DeckAccount(id: "total:claude", provider: "claude", label: "Oddly Named")],
            usage: []
        )
        // The prefix guard covers even a colliding literal id, and unknown
        // future providers ("total:gemini") equally never resolve.
        #expect(MenuBarPinResolver.resolve("total:claude", in: state) == nil)
        #expect(MenuBarPinResolver.resolve("total:claude|fmt:share", in: state) == nil)
        #expect(MenuBarPinResolver.resolve("total:gemini", in: state) == nil)
    }

    @Test func totalModeMeansNoCardGetsTheCheckmark() {
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: [UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 9)]
        )
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "total:claude|fmt:share",
            state: state,
            worstRemaining: WorstRemaining(percent: 9, accountId: "c1", scope: "week")
        )
        #expect(source == nil)
    }
}

@Suite("Share-of-capacity arithmetic (issue #482)")
@MainActor
struct MenuBarTotalShareTests {
    @Test func timsExampleSumsTo474AndSharesTo68() {
        let display = timsPool()
        #expect(display.points == 474)
        #expect(display.countedAccounts == 7)
        // 474 / 700 capacity — Tim's own arithmetic.
        #expect(display.sharePercent == 68)
    }

    @Test func shareRoundsToTheNearestWholePercent() {
        let display = DeckColumnUsageHeadline.display(
            for: DeckColumn(provider: .claude, rows: [row("a", 100), row("b", 0), row("c", 0)])
        )!
        // 100 of 300 capacity = 33.3 -> 33.
        #expect(display.sharePercent == 33)
    }

    @Test func shareDenominatorIsTheCountedAccountsOnly() {
        // One account has no current reading: it is out of the sum AND out
        // of the capacity — a partial pool never fabricates capacity.
        let display = DeckColumnUsageHeadline.display(
            for: DeckColumn(provider: .claude, rows: [row("a", 50), row("b", nil)])
        )!
        #expect(display.points == 50)
        #expect(display.countedAccounts == 1)
        #expect(display.sharePercent == 50)
        #expect(!display.isComplete)
    }
}

@Suite("Total modes on the status model (issue #482)")
@MainActor
struct MenuBarTotalStatusModelTests {
    private var fixtureState: DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
                DeckAccount(id: "c2", provider: "claude", label: "Client"),
            ],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 80),
                UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 4),
            ]
        )
    }

    private func model(totals: DeckColumnUsageHeadline.Display?) -> MenuBarStatusModel {
        let m = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        if let totals {
            m.providerTotalsSource = { _ in [.claude: totals] }
        }
        return m
    }

    @Test func sumFormatShowsThePoolTotalNeutrally() {
        let m = model(totals: timsPool())
        m.pinnedAccountId = "total:claude"
        m.apply(deckState: fixtureState)
        // Neutral pinned rendering — 474 even though c2 sits at a
        // would-be-critical 4%: a pool total is not a severity signal.
        #expect(m.iconState == .pinned(percentRemaining: 474))
        #expect(m.iconState.percentLabel == "474%")
        // Display-only: the global worst still feeds notifications.
        #expect(m.worstRemaining == WorstRemaining(percent: 4, accountId: "c2", scope: "week"))
        #expect(m.menuBarSourceAccountId == nil)
        #expect(m.menuBarPercentSource == nil)
    }

    @Test func shareFormatShowsTheCapacityShare() {
        let m = model(totals: timsPool())
        m.pinnedAccountId = "total:claude|fmt:share"
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .pinned(percentRemaining: 68))
    }

    @Test func noCountableDataShowsThePlainGlyph() {
        // Provider absent from the totals (nothing countable) and source
        // entirely unwired both render the bare glyph — a number is never
        // fabricated.
        let unwired = model(totals: nil)
        unwired.pinnedAccountId = "total:claude"
        unwired.apply(deckState: fixtureState)
        #expect(unwired.iconState == .plain)

        let m = model(totals: timsPool())
        m.pinnedAccountId = "total:codex"
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .plain)
    }

    @Test func quietModeGatesOnTheSharePercentInBothFormats() {
        // Pool share 68%: a 50% threshold hides both formats — the sum
        // format must not compare 474 against a 1–99 gate.
        let m = model(totals: timsPool())
        m.pinnedAccountId = "total:claude"
        m.showWhen = MenuBarShowWhen.belowPercent(50).stored
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .plain)
        // Raising the gate above the share shows the selected format again.
        m.showWhen = MenuBarShowWhen.belowPercent(70).stored
        #expect(m.iconState == .pinned(percentRemaining: 474))
        m.pinnedAccountId = "total:claude|fmt:share"
        #expect(m.iconState == .pinned(percentRemaining: 68))
    }

    @Test func sourceLineNamesThePoolAndCoverage() throws {
        let m = model(totals: timsPool())
        m.pinnedAccountId = "total:claude"
        m.apply(deckState: fixtureState)
        let line = try #require(m.menuBarNumberSourceLine)
        #expect(line.text == "Menu bar 474% — Claude total · 7 subscriptions")
        m.pinnedAccountId = "total:claude|fmt:share"
        let share = try #require(m.menuBarNumberSourceLine)
        #expect(share.text == "Menu bar 68% — Claude total · 7 subscriptions")
        #expect(share.tooltip.contains("Share of capacity"))
    }

    @Test func partialPoolSourceLineStatesTheDenominator() {
        let partial = DeckColumnUsageHeadline.display(
            for: DeckColumn(provider: .claude, rows: [row("a", 50), row("b", nil)], hiddenAccountCount: 1)
        )!
        let line = MenuBarSourceResolver.totalNumberSourceLine(
            provider: .claude, display: partial, format: .sum
        )
        #expect(line.text == "Menu bar 50% — Claude total · 1 of 3 subscriptions")
    }

    @Test func totalRendersAPercentCompositeNotTheBareGlyph() {
        let m = model(totals: timsPool())
        m.pinnedAccountId = "total:claude"
        m.apply(deckState: fixtureState)
        let image = MenuBarIconRenderer.labelImage(for: m.iconState)
        #expect(image !== MenuBarIconRenderer.deckGlyph)
    }
}

@Suite("Context-menu flip (issue #482)")
struct MenuBarTotalContextMenuTests {
    @Test func totalModeLeadsWithTheFlipItem() throws {
        let items = MenuBarContextMenu.items(
            isCheckingForUpdates: false, menuBarSetting: "total:claude"
        )
        let flip = try #require(items.first)
        #expect(flip.title == "Show Claude Total as Share of Capacity")
        #expect(flip.action == .setMenuBarSetting("total:claude|fmt:share"))
        // Flipping back writes the bare sum sentinel.
        let back = MenuBarContextMenu.items(
            isCheckingForUpdates: false, menuBarSetting: "total:claude|fmt:share"
        )
        #expect(back.first?.title == "Show Claude Total as Sum")
        #expect(back.first?.action == .setMenuBarSetting("total:claude"))
    }

    @Test func nonTotalModesKeepTheFixedMenu() {
        for setting in [nil, "", "none", "health:claude", "acct-1|win:model"] as [String?] {
            let items = MenuBarContextMenu.items(
                isCheckingForUpdates: false, menuBarSetting: setting
            )
            #expect(items.map(\.action) == [.about, .checkForAppUpdates, .quit])
        }
    }
}

@Suite("Total sentinel storage compatibility (issue #482)")
struct MenuBarTotalStorageTests {
    @Test func settingsDocumentRoundTripsTheTotalValue() throws {
        let decoded = try JSONDecoder().decode(
            DaemonSettings.self,
            from: Data(#"{"menuBarAccountId": "total:claude|fmt:share"}"#.utf8)
        )
        #expect(decoded.menuBarAccountId == "total:claude|fmt:share")
    }

    @Test func patchEncodesTheTotalValueForThePut() throws {
        let data = try JSONEncoder().encode(
            DaemonSettingsPatch(
                menuBarAccountId: MenuBarPinResolver.totalValue(provider: .codex, format: .share)
            )
        )
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains(#""menuBarAccountId":"total:codex|fmt:share""#))
    }

    @Test func downgradeReadsTotalAsAnUnresolvablePin() {
        // A pre-#482 build has no total handling: the value reads as a pin
        // that doesn't resolve and the #123 fallback shows lowest-across —
        // degraded but never a crash (the #229/#235 downgrade contract).
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: [UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 9)]
        )
        #expect(MenuBarPinResolver.resolve("total:claude|fmt:share", in: state) == nil)
        let legacyFallback = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "acct-gone",
            state: state,
            worstRemaining: WorstRemaining(percent: 9, accountId: "c1", scope: "week")
        )
        #expect(legacyFallback == "c1")
    }
}
