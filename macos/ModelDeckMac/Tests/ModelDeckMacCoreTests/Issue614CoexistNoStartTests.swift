import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #614 — TRIPWIRE coexist-offers-no-start.
//
// Field incident, 2026-09-01: Tim's recorded first-launch answer is
// `coexist` (he runs his own CLIProxyAPI under a launch agent). At launch
// the app correctly stops managing, which leaves the lifecycle in
// `.stopped`, and the deck rendered that as "Proxy stopped · Start". One
// click during an outage launched the bundled (pinned, older) binary onto
// port 8317 ahead of his upgraded launch agent, which then failed to bind
// for two days. The bundled proxy must not be startable from the deck where
// the user has said they run their own, declined a managed one, or has not
// answered yet.

@Suite("Issue #614 — coexist offers no Start for the bundled proxy")
@MainActor
struct CoexistNoStartTests {
    @Test("the deck offers Start only where ModelDeck owns the proxy")
    func startIsOfferedOnlyUnderAnOwningChoice() {
        #expect(!managedProxyStartOffered(recordedChoice: .coexist))
        #expect(!managedProxyStartOffered(recordedChoice: .managedDeclined))
        #expect(!managedProxyStartOffered(recordedChoice: nil))
        #expect(managedProxyStartOffered(recordedChoice: .adopted))
        #expect(managedProxyStartOffered(recordedChoice: .managedEnabled))
    }

    @Test("the gate and the launch rule agree, so the deck can never start what launch refuses")
    func gateMatchesLaunchRule() {
        let choices: [ManagedProxyOnboardingChoice?] = [nil, .coexist, .managedDeclined, .adopted, .managedEnabled]
        for choice in choices {
            #expect(
                managedProxyStartOffered(recordedChoice: choice) == managedProxyMayRunAtLaunch(recordedChoice: choice),
                "\(String(describing: choice)) must be startable from the deck exactly when it may run at launch"
            )
        }
    }

    // MARK: TRIPWIRE coexist-offers-no-start

    @Test("TRIPWIRE coexist-offers-no-start: every deck call that can start the bundled proxy sits behind the gate")
    func everyStartCallInTheDeckIsGated() throws {
        let source = try deckPopoverSource()
        let gate = "if managedProxyStartOffered(recordedChoice: onboardingModel.choice) {"
        let lines = source.components(separatedBy: "\n")
        var calls = 0
        for (index, line) in lines.enumerated() where line.contains("proxyModel.startManaging()") || line.contains("proxyModel.retry()") {
            calls += 1
            // The gate must open within the few lines above the call, and no
            // brace may close it in between: an ungated call anywhere in the
            // file, not just after the two known case labels, fails here.
            let window = lines[max(0, index - 8)..<index]
            let opensGate = window.contains { $0.trimmingCharacters(in: .whitespaces) == gate }
            let closesBeforeCall = window.reversed().prefix { !$0.contains(gate) }.contains { $0.trimmingCharacters(in: .whitespaces) == "}" }
            #expect(
                opensGate && !closesBeforeCall,
                "TRIPWIRE coexist-offers-no-start: line \(index + 1) can start the bundled proxy without the recorded-choice gate"
            )
        }
        // Exactly the two rows (Start, Try Again). A third call site is a new
        // path that must be reviewed against #614 before it exists.
        #expect(calls == 2, "TRIPWIRE coexist-offers-no-start: expected 2 start/retry call sites in the deck, found \(calls)")
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
