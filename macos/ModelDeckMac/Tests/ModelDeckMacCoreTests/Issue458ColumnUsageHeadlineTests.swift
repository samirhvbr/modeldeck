import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #458 — the provider column header's aggregate "% left".
//
// Two claims are pinned here. First the arithmetic: the headline is exactly
// the sum of the integers the member rows render, so anyone can verify it by
// adding up the column. Second, and the one Tim's spec makes a hard line: a
// PARTIAL sum is never presented as a complete one — every account left out
// (hidden, stale, or without a current reading) shrinks the stated
// denominator and says so in the tooltip, and a column with nothing
// countable shows no headline at all rather than a comforting number.
//
// Placeholder identities only; no daemon, no network, no clock.

private let anchor = Date(timeIntervalSince1970: 1_800_000_000)

private func account(_ id: String, label: String) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: "claude",
        label: label,
        identity: "\(id)@example.com",
        enabled: true,
        isDefault: false
    )
}

private func window(
    _ remaining: Double?,
    scope: String = "5h",
    stale: Bool = false,
    spendText: String? = nil
) -> DeckWindow {
    DeckWindow(
        scope: scope,
        title: "5-hour",
        remainingPercent: remaining,
        resetsAt: anchor.addingTimeInterval(3_600),
        resetText: "resets in 1 hr",
        severity: .healthy,
        stale: stale,
        spendText: spendText
    )
}

private func row(_ id: String, _ remaining: Double?, stale: Bool = false, spendText: String? = nil) -> DeckAccountRow {
    DeckAccountRow(
        account: account(id, label: "Profile \(id.uppercased())"),
        provider: .claude,
        windows: remaining == nil && spendText == nil ? [] : [window(remaining, stale: stale, spendText: spendText)],
        isActive: false
    )
}

private func column(_ rows: [DeckAccountRow], hidden: Int = 0) -> DeckColumn {
    DeckColumn(provider: .claude, rows: rows, hiddenAccountCount: hidden)
}

@Suite("Issue #458 — column header aggregate usage")
@MainActor
struct Issue458ColumnUsageHeadlineTests {
    // MARK: The sum

    @Test("the headline is the sum of the members' displayed % left")
    func sumsTheColumn() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 100), row("b", 141), row("c", 100)])
        ))
        #expect(display.text == "341% left")
        #expect(display.points == 341)
        #expect(display.isComplete)
        #expect(display.countedAccounts == 3)
        #expect(display.totalAccounts == 3)
        // A complete sum must not hedge — no shrunken denominator, no
        // "the real total is at least this".
        #expect(!display.tooltip.contains("of this column's"))
        #expect(!display.tooltip.contains("real total is at least this"))
        #expect(display.accessibilityLabel == "341 percent left across 3 subscriptions")
    }

    @Test("the sum adds the integers the rows actually render, not the raw values")
    func sumsWhatIsOnScreen() throws {
        // 4.6 and 10.4 render as "5% left" and "10% left"; a headline of 15
        // is the only one a person can verify by reading the column.
        let rows = [row("a", 4.6), row("b", 10.4)]
        #expect(rows[0].displayedRemainingPercent == 5)
        #expect(rows[1].displayedRemainingPercent == 10)
        let display = try #require(DeckColumnUsageHeadline.display(for: column(rows)))
        #expect(display.text == "15% left")
    }

    @Test("a member at zero is known data and counts")
    func zeroCounts() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 0), row("b", 40)])
        ))
        #expect(display.text == "40% left")
        #expect(display.isComplete)
        #expect(display.countedAccounts == 2)
    }

    @Test("a fully exhausted column still states its honest zero")
    func allZeroStillRenders() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 0), row("b", 0)])
        ))
        #expect(display.text == "0% left")
        #expect(display.isComplete)
    }

    @Test("a single-account column speaks in the singular")
    func singularPhrasing() throws {
        let display = try #require(DeckColumnUsageHeadline.display(for: column([row("a", 72)])))
        #expect(display.text == "72% left")
        #expect(display.tooltip.contains("1 subscription"))
        #expect(!display.tooltip.contains("1 subscriptions"))
        #expect(display.accessibilityLabel == "72 percent left across 1 subscription")
    }

    // MARK: Nothing to say

    @Test("an empty column has no headline")
    func emptyColumnIsSilent() {
        #expect(DeckColumnUsageHeadline.display(for: column([])) == nil)
    }

    @Test("an all-hidden column has no headline — the sum would cover nobody")
    func allHiddenIsSilent() {
        #expect(DeckColumnUsageHeadline.display(for: column([], hidden: 4)) == nil)
    }

    @Test("a column where nothing is known shows no number rather than a fabricated one")
    func allUnknownIsSilent() {
        #expect(DeckColumnUsageHeadline.display(
            for: column([row("a", nil), row("b", nil)])
        ) == nil)
        // Same when every member is stale: the seam, not the data, is what
        // disqualifies them.
        #expect(DeckColumnUsageHeadline.display(
            for: column([row("a", 50), row("b", 50)]),
            isStale: { _ in true }
        ) == nil)
    }

    // MARK: Never a partial sum presented as complete

    @Test("a member with no current reading is omitted and the denominator shrinks")
    func unknownMemberShrinksTheDenominator() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 100), row("b", nil), row("c", 60)])
        ))
        #expect(display.text == "160% left")
        #expect(!display.isComplete)
        #expect(display.countedAccounts == 2)
        #expect(display.totalAccounts == 3)
        #expect(display.tooltip.contains("2 of this column's 3 subscriptions"))
        #expect(display.tooltip.contains("1 with no current reading"))
        // The direction of the error is stated, not just its existence —
        // and as a LOWER BOUND: an omitted subscription may itself be at 0%
        // left, so "higher" would overclaim.
        #expect(display.tooltip.contains("real total is at least this"))
        #expect(display.accessibilityLabel == "160 percent left across 2 of 3 subscriptions")
    }

    @Test("a spend-headlined card carries no % left, so it cannot join the sum")
    func spendHeadlinedMemberIsUnknown() throws {
        let spend = row("b", nil, spendText: "$245.63 of $500.00")
        #expect(spend.displayedRemainingPercent == nil, "precondition: the card renders dollars, not a %")
        let display = try #require(DeckColumnUsageHeadline.display(for: column([row("a", 80), spend])))
        #expect(display.text == "80% left")
        #expect(!display.isComplete)
        #expect(display.tooltip.contains("1 with no current reading"))
    }

    @Test("a stale member is omitted — the headline claims present-tense runway")
    func staleMemberIsOmitted() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 90), row("b", 30), row("c", 45)]),
            isStale: { $0.id == "b" }
        ))
        #expect(display.text == "135% left")
        #expect(!display.isComplete)
        #expect(display.countedAccounts == 2)
        #expect(display.tooltip.contains("1 with data too old to count"))
        #expect(display.tooltip.contains("real total is at least this"))
    }

    @Test("the daemon's own stale flag disqualifies a member too")
    func daemonStaleFlagIsHonored() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 90), row("b", 30, stale: true)])
        ))
        #expect(display.text == "90% left")
        #expect(!display.isComplete)
        #expect(display.tooltip.contains("1 with data too old to count"))
    }

    @Test("hidden accounts are disclosed — the count beside it still states the whole roster")
    func hiddenAccountsShrinkTheDenominator() throws {
        let col = column([row("a", 100), row("b", 100)], hidden: 3)
        // Precondition: the neighbouring string keeps counting all five.
        #expect(col.subscriptionCountText == "5 subscriptions")
        let display = try #require(DeckColumnUsageHeadline.display(for: col))
        #expect(display.text == "200% left")
        #expect(!display.isComplete)
        #expect(display.totalAccounts == 5)
        #expect(display.tooltip.contains("2 of this column's 5 subscriptions"))
        #expect(display.tooltip.contains("3 hidden"))
    }

    @Test("every exclusion reason is named when they mix")
    func mixedExclusionsAreAllNamed() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 100), row("b", nil), row("c", 50, stale: true)], hidden: 1),
            isStale: { _ in false }
        ))
        #expect(display.text == "100% left")
        #expect(display.tooltip.contains("1 hidden"))
        #expect(display.tooltip.contains("1 with data too old to count"))
        #expect(display.tooltip.contains("1 with no current reading"))
    }

    @Test("mixed plan tiers are summed unweighted, and the tooltip admits it")
    func mixedTiersAreNotWeighted() throws {
        let display = try #require(DeckColumnUsageHeadline.display(
            for: column([row("a", 100), row("b", 100)])
        ))
        #expect(display.points == 200, "v1 sums percentages; cross-tier token weighting is out of scope")
        #expect(display.tooltip.contains("Plan tiers aren't weighted"))
    }

    // MARK: Placement — the header line, not a new row

    @Test("the header renders '7 subscriptions · 341% left' in its existing line")
    func theHeaderCarriesItOnTheRight() throws {
        let source = try deckPopoverSource()
        let viewStart = try #require(source.range(of: "struct DeckColumnView: View {"))
        let viewEnd = try #require(source.range(of: "// MARK: - Type scale", range: viewStart.upperBound..<source.endIndex))
        let view = String(source[viewStart.upperBound..<viewEnd.lowerBound])

        // The header line the column already rendered, start to finish.
        let headerStart = try #require(view.range(of: "HStack(spacing: 7) {"))
        let headerEnd = try #require(view.range(of: ".padding(.bottom, 2)", range: headerStart.upperBound..<view.endIndex))
        let header = String(view[headerStart.upperBound..<headerEnd.lowerBound])

        // Tim's amendment: count first, separator bubble, aggregate LAST so
        // it lands on the trailing edge in line with the rows' "% left".
        let ordered = ["Spacer()", "column.subscriptionCountText", "Text(\" · \")", "usage.text"]
        let positions = ordered.map { header.range(of: $0)?.lowerBound }
        #expect(positions.allSatisfy { $0 != nil }, "header must read: spacer, count, separator, aggregate")
        #expect(positions.compactMap { $0 } == positions.compactMap { $0 }.sorted())

        // Styled as the rows' "% left" (DeckType.value), with the row's own
        // name-·-tier separator treatment (DeckType.tier).
        #expect(header.contains("DeckType.value"))
        #expect(header.contains("DeckType.tier"))

        // No new row and no new surface: the aggregate is computed once and
        // used only inside the header line.
        #expect(
            view.components(separatedBy: "columnUsageHeadline").count - 1 == 2,
            "the headline should be one computed property used at exactly one site"
        )
        let afterHeader = view[headerEnd.upperBound..<view.endIndex]
        #expect(
            !afterHeader.contains("columnUsageHeadline") && !afterHeader.contains("usage.text"),
            "issue #458 exists to COMPRESS information — the aggregate may never grow its own row"
        )
    }

    private func deckPopoverSource() throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
    }
}
