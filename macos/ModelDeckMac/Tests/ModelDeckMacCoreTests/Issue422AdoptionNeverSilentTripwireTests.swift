import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #422 — TRIPWIRE adoption-never-silent.
//
// The #401 field-trust rule: ModelDeck never changes a user's running setup
// without saying so. Adoption is the only path in the app that stops a
// process the user started, so the rule has to be structural, not a promise
// in a comment. Two halves, because either alone is escapable:
//
//   1. BEHAVIOURAL — drive EVERY adoption outcome (launchd job stopped, plain
//      process stopped, stop failed, port still occupied, supervision
//      unidentifiable) and assert each one ends on a visible record that
//      names what was stopped and by what command.
//   2. STATIC — assert `adopt()` has no exit that skips the record: every
//      `return` in its body is preceded by `finish(record:)`, and the body
//      sets no terminal phase of its own.
//
// Mutation-verified 2026-08-14: adding a silent early return to the refusal
// branch of `adopt()` (phase = .hidden; return) failed
// `everyAdoptionOutcomeIsRecorded` and `adoptHasNoSilentExit`; reverting
// restored green.

// MARK: - Behavioural half

/// Every adoption outcome the flow can reach, with the fake wiring that
/// produces it.
private struct AdoptionCase {
    let name: String
    let supervision: ExternalProxySupervision
    let stopSucceeds: Bool
    /// The verification probe's answer after the stop.
    let portStillAnswering: Bool
    /// What the record must name — the user's own job, in their words.
    let mustName: [String]
    let expectSuccess: Bool
}

private let adoptionCases: [AdoptionCase] = [
    AdoptionCase(
        name: "launchd job stopped",
        supervision: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"),
        stopSucceeds: true, portStillAnswering: false,
        mustName: ["com.example.cliproxyapi", "launchctl bootout"], expectSuccess: true
    ),
    AdoptionCase(
        name: "plain process stopped",
        supervision: .plainProcess(pid: 4242, command: "cliproxyapi -config c.yaml"),
        stopSucceeds: true, portStillAnswering: false,
        mustName: ["4242", "SIGTERM"], expectSuccess: true
    ),
    AdoptionCase(
        name: "stop command failed",
        supervision: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"),
        stopSucceeds: false, portStillAnswering: true,
        mustName: ["com.example.cliproxyapi", "launchctl bootout"], expectSuccess: false
    ),
    AdoptionCase(
        name: "stop reported success but the port is still occupied",
        supervision: .plainProcess(pid: 4242, command: "cliproxyapi"),
        stopSucceeds: true, portStillAnswering: true,
        mustName: ["4242", "SIGTERM"], expectSuccess: false
    ),
    AdoptionCase(
        name: "supervision could not be identified — nothing stopped",
        supervision: .unknown,
        stopSucceeds: false, portStillAnswering: true,
        mustName: ["nothing", "no command was run"], expectSuccess: false
    ),
]

@MainActor
@Suite("Issue #422 — TRIPWIRE adoption-never-silent")
struct Issue422AdoptionNeverSilentTripwireTests {

    @Test("every adoption outcome ends on a visible record naming what was stopped and how")
    func everyAdoptionOutcomeIsRecorded() async {
        for adoption in adoptionCases {
            let probe = ExternalProxyProbe(
                portAnswering: adoption.portStillAnswering, handshake: .confirmed
            )
            let model = makeOnboardingModel(
                detection: [probe],
                supervision: adoption.supervision,
                stopSucceeds: adoption.stopSucceeds
            )
            await model.adopt()

            guard case .record(let record) = model.phase else {
                Issue.record("""
                    TRIPWIRE adoption-never-silent: "\(adoption.name)" left the flow in \
                    \(model.phase) instead of a visible record. Adoption is the one path \
                    that stops a process the user started — it may never finish quietly.
                    """)
                continue
            }
            #expect(model.lastAdoptionRecord == record)
            #expect(!record.headline.isEmpty, "\(adoption.name): a record with no headline says nothing")
            #expect(!record.lines.isEmpty, "\(adoption.name): a record with no body says nothing")
            #expect(record.succeeded == adoption.expectSuccess, "\(adoption.name)")

            let visible = ([record.headline, record.stoppedWhat, record.stoppedHow] + record.lines)
                .joined(separator: "\n")
            for phrase in adoption.mustName {
                #expect(visible.contains(phrase), """
                    TRIPWIRE adoption-never-silent: "\(adoption.name)" produced a record that \
                    never mentions "\(phrase)". The record must name WHAT was stopped and HOW.
                    """)
            }
        }
    }

    @Test("a successful adoption says, in so many words, that ModelDeck now manages the proxy")
    func successAnnouncesTheTakeover() async {
        let model = makeOnboardingModel(
            // The verification probe after the stop: the port is free.
            detection: [.silent],
            supervision: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist")
        )
        await model.adopt()
        #expect(model.lastAdoptionRecord?.headline == "ModelDeck now manages your proxy")
    }

    // MARK: - Static half

    private static func onboardingSource() throws -> String {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // .../Tests/ModelDeckMacCoreTests
            .deletingLastPathComponent()   // .../Tests
            .deletingLastPathComponent()   // .../ModelDeckMac (package root)
            .appendingPathComponent("Sources/ModelDeckMacCore")
        return try String(contentsOf: sources.appendingPathComponent("ManagedProxyOnboarding.swift"),
                          encoding: .utf8)
    }

    /// The lines of `adopt()`'s body, comments dropped.
    private static func adoptBody(_ source: String) -> [String] {
        var body: [String] = []
        var inside = false
        var depth = 0
        for rawLine in source.components(separatedBy: "\n") {
            if !inside, rawLine.contains("public func adopt() async {") {
                inside = true
                depth = 1
                continue
            }
            guard inside else { continue }
            depth += rawLine.filter { $0 == "{" }.count
            depth -= rawLine.filter { $0 == "}" }.count
            if depth <= 0 { break }
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("//") || line.isEmpty { continue }
            body.append(line)
        }
        return body
    }

    @Test("adopt() has no exit that skips the record")
    func adoptHasNoSilentExit() throws {
        let body = Self.adoptBody(try Self.onboardingSource())
        #expect(!body.isEmpty, "adopt() could not be located — the tripwire must not silently pass")

        var recordedSinceLastReturn = false
        for line in body {
            if line.contains("finish(record:") { recordedSinceLastReturn = true }
            guard line == "return" || line.hasPrefix("return ") else { continue }
            #expect(recordedSinceLastReturn, """
                TRIPWIRE adoption-never-silent: adopt() returns without emitting an \
                AdoptionRecord first. Every adoption exit — success, failed stop, or \
                refusal — must call finish(record:) so the user sees what ModelDeck did.
                """)
            recordedSinceLastReturn = false
        }
        // The fall-through exit is a record too.
        #expect(body.last?.contains("finish(record:") == true, """
            TRIPWIRE adoption-never-silent: adopt() no longer ends on finish(record:).
            """)
    }

    @Test("adopt() sets no terminal phase of its own — only the record path may")
    func adoptSetsNoSilentPhase() throws {
        let body = Self.adoptBody(try Self.onboardingSource())
        for line in body where line.hasPrefix("phase = ") {
            #expect(line.contains(".working("), """
                TRIPWIRE adoption-never-silent: adopt() assigns `\(line)`. The only phase \
                adoption may set directly is the transient .working; every terminal state \
                goes through finish(record:).
                """)
        }
    }

    @Test("the stopper is reachable from exactly one place, behind the explicit action")
    func stoppingIsOnlyReachableFromAdopt() throws {
        let source = try Self.onboardingSource()
        let callSites = source.components(separatedBy: "stopExternalProxy(").count - 1
        // One protocol requirement, one call site in adopt(). Anything more
        // means some other path can stop a user's process.
        #expect(callSites == 2, """
            TRIPWIRE adoption-never-silent: stopExternalProxy appears \(callSites) times in \
            ManagedProxyOnboarding.swift. A user's process may only ever be stopped from \
            adopt(), which runs from an explicit button.
            """)
    }
}
