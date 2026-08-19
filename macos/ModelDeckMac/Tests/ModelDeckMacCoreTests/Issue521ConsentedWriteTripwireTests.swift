import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #521 — the tripwires for the consented config write path. Each one
// guards a condition of the recorded V2 gate (issue #521's gate comment,
// evidence in docs/research/keys-riders-recon-v1-v5.md) or a never-compromise
// rule, and each names itself in its failure message so a future failure says
// which rule broke rather than which assertion did.
//
// TRIPWIRE coverage-gate-blocks-first-append   — gate condition (a)
// TRIPWIRE consent-copy-states-immediacy       — gate condition (b)
// TRIPWIRE removal-copy-discloses-accept-all   — gate condition (c)
// TRIPWIRE consented-write-guard-destinations  — never-compromise #3/#4, D2
//
// No test here touches a live proxy, port, config, or Keychain item.

private let placeholderKey = "md521-tripwire-placeholder-key"

private func sha(_ value: String) -> String { ClientKeyGenerator.sha256Hex(value) }

// MARK: - Gate condition (a): pre-flight client coverage

@Suite("TRIPWIRE coverage-gate-blocks-first-append")
struct Issue521CoverageGateTripwireTests {
    private func evidence(
        clients: [ObservedProxyClient], complete: Bool = true, at moment: TimeInterval = 0
    ) -> ClientCoverageEvidence {
        ClientCoverageEvidence(
            observedAt: Date(timeIntervalSince1970: 1_700_000_000 - moment),
            windowDescription: "the last 24 hours of proxy requests",
            clients: clients,
            isComplete: complete
        )
    }

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    @Test("the FIRST entry is blocked without evidence — the flip is live in ~2 seconds")
    func blocksWithoutEvidence() {
        let verdict = decideClientCoverage(
            evidence: nil, isFirstEntry: true,
            appendedKeyHashes: [sha(placeholderKey)],
            legacyValueWillBeAppended: false, now: now
        )
        guard case .blocked(let reason, _) = verdict else {
            Issue.record("""
                TRIPWIRE coverage-gate-blocks-first-append: the first api-keys entry was \
                allowed with NO client-coverage evidence. Recon V2 proved an empty list \
                means accept-all and the first entry flips the proxy to enforce-list \
                within ~2 seconds — every client not carrying a listed key 401s from \
                that moment, including live sessions whose environment was read once at \
                shell start.
                """)
            return
        }
        #expect(reason == ConsentedConfigWriteCopy.coverageMissingReason)
    }

    @Test("incomplete or stale evidence cannot prove coverage")
    func blocksIncompleteAndStaleEvidence() {
        let incomplete = decideClientCoverage(
            evidence: evidence(clients: [], complete: false), isFirstEntry: true,
            appendedKeyHashes: [], legacyValueWillBeAppended: false, now: now
        )
        #expect(!incomplete.isCovered, "TRIPWIRE coverage-gate-blocks-first-append: an incomplete observation proved nothing")

        let stale = decideClientCoverage(
            evidence: evidence(clients: [], at: 4000), isFirstEntry: true,
            appendedKeyHashes: [], legacyValueWillBeAppended: false, now: now
        )
        #expect(!stale.isCovered, "TRIPWIRE coverage-gate-blocks-first-append: stale evidence was accepted")
    }

    @Test("a client sending NO key blocks the write and is named")
    func blocksKeylessClient() {
        let verdict = decideClientCoverage(
            evidence: evidence(clients: [
                .init(name: "codex (no key)", coverage: .none),
                .init(name: "claude work", coverage: .provisionedKey(sha256: sha(placeholderKey))),
            ]),
            isFirstEntry: true,
            appendedKeyHashes: [sha(placeholderKey)],
            legacyValueWillBeAppended: false, now: now
        )
        guard case .blocked(_, let uncovered) = verdict else {
            Issue.record("TRIPWIRE coverage-gate-blocks-first-append: a keyless client would have been 401'd silently")
            return
        }
        #expect(uncovered == ["codex (no key)"])
    }

    @Test("a legacy-key client is covered ONLY when the legacy value is appended too")
    func legacyClientNeedsTheLegacyAppend() {
        let clients = [ObservedProxyClient(name: "an already-running shell", coverage: .legacySharedKey)]
        #expect(!decideClientCoverage(
            evidence: evidence(clients: clients), isFirstEntry: true,
            appendedKeyHashes: [], legacyValueWillBeAppended: false, now: now
        ).isCovered)
        #expect(decideClientCoverage(
            evidence: evidence(clients: clients), isFirstEntry: true,
            appendedKeyHashes: [], legacyValueWillBeAppended: true, now: now
        ).isCovered)
    }

    @Test("a key that is not in the list about to be written does not count as coverage")
    func blocksUnlistedKey() {
        let verdict = decideClientCoverage(
            evidence: evidence(clients: [.init(name: "some client", coverage: .provisionedKey(sha256: sha("other")))]),
            isFirstEntry: true,
            appendedKeyHashes: [sha(placeholderKey)],
            legacyValueWillBeAppended: false, now: now
        )
        #expect(!verdict.isCovered)
    }

    @Test("once the list is non-empty the gate stands down — the proxy already enforces")
    func standsDownAfterTheFlip() {
        let verdict = decideClientCoverage(
            evidence: nil, isFirstEntry: false,
            appendedKeyHashes: [], legacyValueWillBeAppended: false, now: now
        )
        #expect(verdict.isCovered)
    }

    @Test("the MODEL refuses the first append when the gate blocked it — not just the button")
    @MainActor
    func modelRefusesBlockedFirstAppend() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("modeldeck-521-gate-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("config.yaml")
        let original = "host: \"127.0.0.1\"\nport: 8317\n"
        try original.write(to: target, atomically: true, encoding: .utf8)

        let backups = ConfigBackupStore(
            paths: ModelDeckStatePaths(stateDirectory: root.appendingPathComponent("state", isDirectory: true))
        )
        let model = ConsentedConfigWriteModel(dependencies: .init(
            writer: ConsentedConfigWriter(backups: backups),
            backups: backups,
            coverage: NoEvidence(),
            records: NoRecord(),
            hash: sha
        ))
        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: placeholderKey)]
        ))
        guard case .consent(_, let canConfirm) = model.phase else {
            Issue.record("expected the consent prompt with the block explained, got \(model.phase)")
            return
        }
        #expect(!canConfirm)

        // A view that ignores `canConfirm` must still not be able to write.
        await model.confirm(settle: 0, sleep: { _ in })
        guard case .record(let record) = model.phase, case .refused = record.outcome else {
            Issue.record("""
                TRIPWIRE coverage-gate-blocks-first-append: confirming a BLOCKED first \
                append wrote anyway. The gate must live in the model, not in a disabled \
                button.
                """)
            return
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == original)
    }
}

private struct NoEvidence: ClientCoverageObserving {
    func observeClientCoverage() async -> ClientCoverageEvidence? { nil }
}

private final class NoRecord: ConfigKeyProvisioningRecordStoring, @unchecked Sendable {
    var record: ConfigKeyProvisioningRecord?
}

// MARK: - Gate conditions (b) and (c): what the consent copy must say

@Suite("TRIPWIRE consent-copy-states-immediacy")
struct Issue521ConsentCopyTripwireTests {
    @Test("no consent string promises a restart — recon V3 proved the config hot-reloads")
    func neverSaysRestart() {
        for line in ConsentedConfigWriteCopy.immediacyGovernedStrings where line.lowercased().contains("restart") {
            Issue.record("""
                TRIPWIRE consent-copy-states-immediacy: a consent string mentions a \
                restart — "\(line)". Recon V3 proved config.yaml hot-reloads (150 ms \
                debounce, survives atomic rename), so enforcement begins ~2 seconds \
                after the write with no restart step. Copy that implies a later event \
                tells the user their sessions are safe when they are already 401ing.
                """)
        }
    }

    @Test("the immediacy is stated in words, not implied")
    func statesImmediacy() {
        let effect = ConsentedConfigWriteCopy.immediacyEffect.lowercased()
        #expect(effect.contains("immediately"))
        #expect(effect.contains("two seconds"))
        #expect(ConsentedConfigWriteCopy.enforcementFlipEffect.contains("401"))
    }

    @Test("the append consent names BOTH operations: the api-keys entries and the 0600 tighten")
    func namesBothOperations() {
        let prompt = consentedConfigAppendPrompt(
            targetPath: "/tmp/md521/config.yaml",
            entryCount: 2,
            appendsLegacyValue: false,
            currentMode: 0o644,
            backupDirectoryPath: "/tmp/md521-state/proxy-config-backups",
            coverage: .covered(clientCount: 1),
            isFirstEntry: true
        )
        #expect(prompt.operations.contains { $0.contains("api-keys") && $0.contains("/tmp/md521/config.yaml") })
        #expect(prompt.operations.contains { $0.contains("chmod 600") && $0.contains("644") })
        #expect(prompt.effects.contains(ConsentedConfigWriteCopy.immediacyEffect))
        #expect(prompt.effects.contains(ConsentedConfigWriteCopy.enforcementFlipEffect))
        #expect(prompt.backupLine.contains("/tmp/md521-state/proxy-config-backups"))
        #expect(!prompt.undoLine.isEmpty)
        #expect(!prompt.declineConsequence.isEmpty)
    }

    @Test("TRIPWIRE removal-copy-discloses-accept-all: removing the last entry says the proxy reopens")
    func removalDisclosesAcceptAll() {
        let prompt = consentedConfigRemovalPrompt(
            targetPath: "/tmp/md521/config.yaml",
            entryCount: 1,
            wouldEmptyList: true,
            backupDirectoryPath: "/tmp/md521-state/proxy-config-backups"
        )
        guard prompt.effects.contains(ConsentedConfigWriteCopy.lastEntryRemovalDisclosure) else {
            Issue.record("""
                TRIPWIRE removal-copy-discloses-accept-all: removing the LAST api-keys \
                entry returns the proxy to answering every local request without a key, \
                immediately and with no other warning. The removal consent must say so.
                """)
            return
        }
        let disclosure = ConsentedConfigWriteCopy.lastEntryRemovalDisclosure.lowercased()
        #expect(disclosure.contains("without a key"))
        #expect(disclosure.contains("unauthenticated"))
        #expect(disclosure.contains("immediately"))
        // A removal that leaves entries behind must NOT carry the disclosure —
        // an always-on warning is a warning nobody reads.
        let partial = consentedConfigRemovalPrompt(
            targetPath: "/tmp/md521/config.yaml", entryCount: 1, wouldEmptyList: false,
            backupDirectoryPath: "/tmp/md521-state/proxy-config-backups"
        )
        #expect(!partial.effects.contains(ConsentedConfigWriteCopy.lastEntryRemovalDisclosure))
    }

    /// Should-fix 4. Copy shown before consent describes what ModelDeck is
    /// ABOUT to ask for; the moment it describes a completed write, the user is
    /// told a change landed that they have not agreed to and cannot yet undo.
    @Test("no pre-consent string claims a write already happened")
    func preConsentCopyClaimsNoWrite() {
        let forbidden = ["written", "wrote", "re-reads", "re-read the file", "saved a copy"]
        for line in ConsentedConfigWriteCopy.preConsentStrings {
            for phrase in forbidden where line.lowercased().contains(phrase) {
                Issue.record("""
                    TRIPWIRE consent-copy-states-immediacy: the pre-consent string \
                    "\(line)" claims a write ("\(phrase)"). Before consent nothing has \
                    been written and nothing has been agreed to; progress copy at that \
                    point may only describe looking, never changing.
                    """)
            }
        }
        #expect(!ConsentedConfigWriteCopy.preConsentStrings.contains(ConsentedConfigWriteCopy.takingEffectNowLine))
    }

    /// Should-fix 5. A gate that stood down ran no check, and copy claiming it
    /// found nothing is a fabricated result the user would act on.
    @Test("the stood-down verdict has its own copy and never reports a check that did not run")
    func standDownCopyIsDistinct() {
        let verdict = decideClientCoverage(
            evidence: nil, isFirstEntry: false, appendedKeyHashes: [],
            legacyValueWillBeAppended: false, now: Date()
        )
        #expect(verdict == .stoodDown)
        #expect(verdict.isCovered, "an already-enforcing list must not block maintenance appends")
        let stoodDown = ConsentedConfigWriteCopy.coverageStoodDownLine
        #expect(stoodDown != ConsentedConfigWriteCopy.coverageCoveredLine(clientCount: 0))
        for phrase in ["saw no clients", "checked every client"] where stoodDown.contains(phrase) {
            Issue.record("""
                TRIPWIRE consent-copy-states-immediacy: the stand-down line reports a \
                coverage check ("\(phrase)") that never ran.
                """)
        }
    }

    @Test("no copy in this feature carries key material or a fabricated key")
    func copyCarriesNoKeys() {
        let snippet = ConsentedConfigWriteCopy.manualSnippet(targetPath: "/tmp/md521/config.yaml")
        #expect(snippet.contains("<paste the key ModelDeck shows you>"))
        #expect(snippet.contains("chmod 600"))
    }
}

// MARK: - The write guard

@Suite("TRIPWIRE consented-write-guard-destinations")
struct Issue521WriteGuardTripwireTests {
    private let target = URL(fileURLWithPath: "/tmp/md521-guard/config.yaml")

    @Test("the derived target and its staging temp are the ONLY admitted destinations")
    func admitsOnlyTargetAndTemp() throws {
        try ConsentedConfigWriteGuard.requireConsentedConfigWrite(target, target: target)
        try ConsentedConfigWriteGuard.requireConsentedConfigWrite(
            URL(fileURLWithPath: "/tmp/md521-guard/\(ConsentedConfigWriteGuard.temporaryPrefix)AB12CD"),
            target: target
        )
        for forbidden in [
            "/tmp/md521-guard/other.yaml",
            "/tmp/md521-guard/subdir/config.yaml",
            "/tmp/elsewhere/config.yaml",
            "/tmp/md521-guard/.mgmt-key",
        ] {
            #expect(throws: ManagedProxyWriteGuard.Violation.unmanagedPathWrite(forbidden)) {
                try ConsentedConfigWriteGuard.requireConsentedConfigWrite(
                    URL(fileURLWithPath: forbidden), target: target
                )
            }
        }
    }

    @Test("an auth-dir destination raises the NAMED auth violation, declared or conventional")
    func refusesAuthDirectory() {
        let conventional = URL(fileURLWithPath: "/tmp/md521-guard/auth/claude.json")
        #expect(throws: ManagedProxyWriteGuard.Violation.authFileWrite(conventional.path)) {
            try ConsentedConfigWriteGuard.requireConsentedConfigWrite(conventional, target: target)
        }
        let declared = URL(fileURLWithPath: "/var/cpa-auths/claude.json")
        #expect(throws: ManagedProxyWriteGuard.Violation.authFileWrite(declared.path)) {
            try ConsentedConfigWriteGuard.requireConsentedConfigWrite(
                declared, target: target, declaredAuthDirectory: "/var/cpa-auths"
            )
        }
    }

    @Test("backups live in ModelDeck's own state directory and never in a proxy directory (D2)")
    func backupsStayOutOfTheProxyDirectory() {
        let state = URL(fileURLWithPath: "/tmp/md521-state")
        let proxyDirectory = target.deletingLastPathComponent()
        #expect(throws: Never.self) {
            try ConsentedConfigWriteGuard.requireBackupDestination(
                state.appendingPathComponent("proxy-config-backups/config-x.yaml.bak"),
                stateDirectory: state, forbiddenDirectories: [proxyDirectory]
            )
        }
        for forbidden in [
            proxyDirectory.appendingPathComponent("config.yaml.bak"),
            URL(fileURLWithPath: "/tmp/somewhere-else/config.yaml.bak"),
        ] {
            #expect(throws: ConsentedConfigWriteError.self, "TRIPWIRE consented-write-guard-destinations: a secret-bearing backup escaped ModelDeck's state directory") {
                try ConsentedConfigWriteGuard.requireBackupDestination(
                    forbidden, stateDirectory: state, forbiddenDirectories: [proxyDirectory]
                )
            }
        }
    }

    @Test("the consented writer still calls its guard before publishing")
    func writerCallsTheGuard() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Sources/ModelDeckMacCore/ConsentedConfigWriteLive.swift"),
            encoding: .utf8
        )
        guard let guardIndex = source.range(of: "ConsentedConfigWriteGuard.requireConsentedConfigWrite")?.lowerBound,
              let publishIndex = source.range(of: "OwnerOnlyPublisher.publish(\n            bytes, at: target")?.lowerBound
        else {
            Issue.record("TRIPWIRE consented-write-guard-destinations: the writer no longer publishes through the guard")
            return
        }
        #expect(guardIndex < publishIndex, "the guard must run BEFORE the publish, not after")
        // The backup store's guard call is likewise not optional.
        #expect(source.contains("ConsentedConfigWriteGuard.requireBackupDestination"))
    }

    @Test("the empty-string hash can never match a config entry (recon V1: keyless requests carry \"\")")
    func emptyValueNeverMatches() throws {
        let document = try ConfigAPIKeysDocument.parse("api-keys:\n  - \"\"\n  - \"\(placeholderKey)\"\n")
        let record = ConfigKeyProvisioningRecord(
            targetPath: "/tmp/x.yaml", writtenAt: Date(),
            entries: [.init(profileID: "a", profileLabel: "Work", keySha256: ClientKeyGenerator.sha256OfEmptyString)]
        )
        #expect(throws: ConsentedConfigWriteError.self) {
            _ = try document.removing(record: record, hash: sha)
        }
    }
}
