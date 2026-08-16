import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #445 — TRIPWIRE coexist-costs-no-deck-row.
//
// Tim's field ruling on the installed 1.0.0: the "External proxy detected —
// not managed by ModelDeck" state "shouldn't use a whole row", and "even an
// icon that would make that whole row visible wouldn't be okay". The defect
// this guards against is the row coming back — as a caption, a banner, or a
// glyph placed in the deck's vertical stack rather than in chrome that
// already renders.
//
// The other half of the ruling is that the state stays DISCOVERABLE (#401,
// never silent coexistence): the header glyph's tooltip carries the retired
// row's sentence, and Settings → General → Managed proxy keeps the full one.
// Both halves are asserted here, so neither can be satisfied by deleting the
// other.

@Suite("Issue #445 — external-proxy notice costs no deck row")
@MainActor
struct ProxyCoexistNoticeTests {
    // MARK: The decision (pure)

    @Test("a recorded coexist choice shows the header glyph, and it explains itself")
    func coexistShowsGlyphWithTheWholeStory() throws {
        let display = ProxyCoexistNotice.display(
            phase: .externalInstanceDetected,
            choice: .coexist,
            onboardingCardPresented: false
        )
        guard case .headerGlyph(let tooltip) = display else {
            Issue.record("coexist must stay visible somewhere: got \(display)")
            return
        }
        // The retired row's sentence survives verbatim inside the tooltip.
        #expect(tooltip.contains(ProxyCoexistNotice.headline))
        // Under a recorded coexist choice the hover says WHY managed-only
        // features are off — the #422 rule, never a bare "unavailable".
        #expect(tooltip.contains(ManagedProxyOnboardingCopy.coexistUnavailableReason))
        // And it names where the full story lives now.
        #expect(tooltip.contains(ProxyCoexistNotice.settingsPointer))
    }

    @Test("an unchosen external instance is the #400 refusal, in the same one glyph")
    func externalWithoutAChoiceUsesTheRefusalMessage() throws {
        let display = ProxyCoexistNotice.display(
            phase: .externalInstanceDetected,
            choice: nil,
            onboardingCardPresented: false
        )
        guard case .headerGlyph(let tooltip) = display else {
            Issue.record("the #400 refusal must not go silent: got \(display)")
            return
        }
        #expect(tooltip.contains(ManagedProxyModel.externalInstanceMessage))
    }

    @Test("the first-launch card owns the surface while it is up")
    func onboardingCardSuppressesTheGlyph() {
        #expect(
            ProxyCoexistNotice.display(
                phase: .externalInstanceDetected,
                choice: nil,
                onboardingCardPresented: true
            ) == .silent
        )
    }

    @Test("every other proxy phase is none of this notice's business")
    func otherPhasesAreSilent() {
        let others: [ManagedProxyModel.Phase] = [
            .idle, .unavailable, .starting, .running, .stopped,
            .restarting(attempt: 2), .failed("placeholder failure"),
        ]
        for phase in others {
            #expect(
                ProxyCoexistNotice.display(
                    phase: phase,
                    choice: .coexist,
                    onboardingCardPresented: false
                ) == .silent,
                "\(phase) must not be re-routed through the coexistence glyph"
            )
        }
    }

    // MARK: TRIPWIRE coexist-costs-no-deck-row

    @Test("TRIPWIRE coexist-costs-no-deck-row: no row, no banner, no row-making icon")
    func theDeckStackRendersNothingForThisState() throws {
        let source = try deckPopoverSource()

        // 1. The retired full-width caption is gone from the app layer. Its
        //    words live in the tooltip (ProxyCoexistNotice.headline) and in
        //    Settings — never again as a rendered line.
        #expect(
            !source.contains("Label(\"External proxy detected"),
            "TRIPWIRE coexist-costs-no-deck-row: the deck grew the caption back as a row"
        )

        // 2. The `.externalInstanceDetected` branch of the proxy banner
        //    renders NOTHING. Anything with a body here is a row.
        let banner = try #require(source.range(of: "case .externalInstanceDetected:"))
        let nextCase = try #require(source.range(of: "case .restarting(", range: banner.upperBound..<source.endIndex))
        let branch = source[banner.upperBound..<nextCase.lowerBound]
        #expect(
            branch.contains("EmptyView()"),
            "TRIPWIRE coexist-costs-no-deck-row: the external-instance branch must render EmptyView"
        )
        for rowMaker in ["Label(", "Text(", "HStack", "Image("] {
            #expect(
                !branch.contains(rowMaker),
                "TRIPWIRE coexist-costs-no-deck-row: '\(rowMaker)' in the external-instance branch is a deck row"
            )
        }

        // 3. The glyph is not in the deck's vertical stack — not even as an
        //    icon, which is the shape Tim ruled out by name. `body` runs from
        //    its declaration to the footer's Divider.
        let bodyStart = try #require(source.range(of: "var body: some View {"))
        let bodyEnd = try #require(source.range(of: "Divider()", range: bodyStart.upperBound..<source.endIndex))
        let stack = source[bodyStart.upperBound..<bodyEnd.lowerBound]
        #expect(
            !stack.contains("externalProxyGlyph"),
            "TRIPWIRE coexist-costs-no-deck-row: the glyph moved into the deck's row stack"
        )

        // 4. It lives in the header's existing control cluster instead —
        //    chrome that renders on every open, so it costs no row.
        // Ordered, not adjacent (the #395 precedent): the claim is that the
        // glyph is invoked inside the header's control row, between the
        // update badge and the sort/gear cluster.
        let anchors = ["private var header: some View {", "updateReadyBadge\n", "externalProxyGlyph", "weeklyFocusControl\n"]
        let positions = anchors.map { source.range(of: $0)?.lowerBound }
        #expect(positions.allSatisfy { $0 != nil })
        #expect(positions.compactMap { $0 } == positions.compactMap { $0 }.sorted())
    }

    // MARK: Still discoverable (#401 stands)

    @Test("Settings → General → Managed proxy keeps the full sentence")
    func settingsKeepsTheFullStory() {
        #expect(
            ManagedProxyOnboardingCopy.settingsSummary(for: .coexist)
                == ManagedProxyOnboardingCopy.coexistUnavailableReason
        )
        #expect(ManagedProxyOnboardingCopy.settingsSectionTitle == "Managed proxy")
        #expect(!ProxyCoexistNotice.glyphAccessibilityLabel.isEmpty)
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
