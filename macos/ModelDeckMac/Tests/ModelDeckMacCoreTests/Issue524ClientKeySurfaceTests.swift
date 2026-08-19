import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #524 — the deck/settings surface for per-profile attribution and the
// consented-write states.
//
// Safety contract: every test here is pure. Nothing spawns a proxy, touches
// ports 8317/3867, reads the Keychain, opens a real config, or prompts.

@Suite("Issue #524 — the consent phases reach a surface")
struct Issue524ConsentSurfaceTests {
    private func prompt(canConfirm: Bool) -> ConsentedConfigConsentPrompt {
        consentedConfigAppendPrompt(
            targetPath: "/tmp/placeholder/config.yaml",
            entryCount: 2,
            appendsLegacyValue: true,
            currentMode: 0o644,
            backupDirectoryPath: "/tmp/placeholder/backups",
            coverage: canConfirm ? .covered(clientCount: 3) : .blocked(
                reason: ConsentedConfigWriteCopy.coverageMissingReason, uncovered: []
            ),
            isFirstEntry: true
        )
    }

    @Test("a hidden phase costs no row")
    func hiddenIsSilent() {
        #expect(ClientKeyConsentSurface.display(phase: .hidden) == .silent)
    }

    @Test("the two progress states stay distinguishable, and neither claims a write happened")
    func progressStatesAreThemselves() throws {
        let preparing = try #require(
            ClientKeyConsentSurface.display(phase: .working(ConsentedConfigWriteCopy.preparingLine)).section
        )
        #expect(preparing.headline == ConsentedConfigWriteCopy.preparingLine)
        #expect(preparing.isBusy)
        #expect(preparing.controls.isEmpty)

        let applying = try #require(
            ClientKeyConsentSurface.display(phase: .working(ConsentedConfigWriteCopy.applyingLine)).section
        )
        #expect(applying.headline != preparing.headline)
    }

    @Test("the consent prompt puts every disclosure on the surface, including what declining costs")
    func consentShowsEveryDisclosure() throws {
        let prompt = prompt(canConfirm: true)
        let section = try #require(ClientKeyConsentSurface.display(
            phase: .consent(prompt, canConfirm: true)
        ).section)

        #expect(section.headline == prompt.title)
        for line in prompt.operations + prompt.effects {
            #expect(section.evidenceLines.contains(line))
        }
        for line in [prompt.coverageLine, prompt.backupLine, prompt.undoLine] {
            #expect(section.evidenceLines.contains(line))
        }
        // The cost of saying no is READ, not hovered.
        #expect(section.evidenceLines.contains(prompt.declineConsequence))
        // The immediacy disclosure in particular: recon V3's whole point.
        #expect(section.evidenceLines.contains(ConsentedConfigWriteCopy.immediacyEffect))
        #expect(section.evidenceLines.contains(ConsentedConfigWriteCopy.enforcementFlipEffect))
    }

    @Test("a blocked coverage gate disables confirm and says why, in place")
    func blockedCoverageExplainsItself() throws {
        let prompt = prompt(canConfirm: false)
        let section = try #require(ClientKeyConsentSurface.display(
            phase: .consent(prompt, canConfirm: false)
        ).section)
        let confirm = try #require(section.controls.first { $0.action == .confirm })

        #expect(!confirm.isEnabled)
        #expect(confirm.unavailableExplanation == prompt.coverageLine)
        #expect(confirm.accessibilityHint == prompt.coverageLine)
        #expect(confirm.accessibilityLabel.contains("unavailable"))
        // Disabled, never hidden: #521's model documents that the prompt stays
        // up so the user reads who would break.
        #expect(section.controls.contains { $0.action == .decline && $0.isEnabled })
    }

    @Test("a record shows its lines, and offers backup deletion only when the model does")
    func recordRendersItsOwnAccount() throws {
        let refused = try #require(ClientKeyConsentSurface.display(phase: .record(
            ConsentedConfigRecord(
                outcome: .refused(reason: ConsentedConfigWriteCopy.targetUnknownReason),
                headline: ConsentedConfigWriteCopy.refusedHeadline,
                lines: [ConsentedConfigWriteCopy.targetUnknownReason]
            )
        )).section)
        #expect(refused.headline == ConsentedConfigWriteCopy.refusedHeadline)
        #expect(refused.evidenceLines == [ConsentedConfigWriteCopy.targetUnknownReason])
        #expect(refused.controls.isEmpty, "nothing to press on a refusal")

        let removed = try #require(ClientKeyConsentSurface.display(phase: .record(
            ConsentedConfigRecord(
                outcome: .written,
                headline: ConsentedConfigWriteCopy.removalSucceededHeadline,
                lines: [ConsentedConfigWriteCopy.liveLine, ConsentedConfigWriteCopy.backupDeletionOffer],
                backupPath: "/tmp/placeholder/backups/config.yaml.placeholder",
                activation: .live,
                offersBackupDeletion: true
            )
        )).section)
        let delete = try #require(removed.controls.first { $0.action == .deleteBackups })
        #expect(delete.isEnabled)
        #expect(delete.accessibilityHint == ConsentedConfigWriteCopy.backupDeletionOffer)
    }

    @Test("a superseded write is not reported as one ModelDeck is still confirming")
    func supersededPicksTheHonestLine() throws {
        let reason = "the file changed after the write"
        let section = try #require(ClientKeyConsentSurface.display(phase: .record(
            ConsentedConfigRecord(
                outcome: .written,
                headline: ConsentedConfigWriteCopy.appendSucceededHeadline,
                lines: [
                    ConsentedConfigWriteCopy.nothingElseChangesEffect,
                    ConsentedConfigWriteCopy.takingEffectNowLine,
                ],
                activation: .superseded(reason: reason)
            )
        )).section)
        #expect(!section.evidenceLines.contains(ConsentedConfigWriteCopy.takingEffectNowLine))
        #expect(section.evidenceLines.contains(ConsentedConfigWriteCopy.supersededLine(reason)))
    }
}

@Suite("Issue #524 — the attribution state is honest about what it knows")
struct Issue524AttributionSurfaceTests {
    private func wiring(
        mode: String = ClientKeyHelperWiring.perProfileMode,
        stage: String? = "complete",
        settingsWired: Bool = true,
        shellEnvWired: Bool? = true,
        legacyAdmitted: Bool = false,
        complete: Bool = true
    ) -> ClientKeyHelperWiring {
        ClientKeyHelperWiring(
            accountId: "placeholder-a",
            mode: mode,
            service: "cli-proxy-api-client.placeholder-a",
            stage: stage,
            settingsWired: settingsWired,
            shellEnvWired: shellEnvWired,
            legacySharedKeyStillAdmitted: legacyAdmitted,
            complete: complete
        )
    }

    @Test("a daemon that has not answered is not reported as 'off'")
    func unknownIsSilent() {
        #expect(ClientKeyAttributionSurface.display(wiring: nil) == .silent)
    }

    @Test("a legacy install is told plainly that receipts cannot name a profile")
    func legacyStatesTheLimit() throws {
        let section = try #require(ClientKeyAttributionSurface.display(
            wiring: wiring(mode: ClientKeyHelperWiring.legacyMode, stage: nil, settingsWired: false, shellEnvWired: nil, complete: false)
        ).section)
        #expect(section.headline == ClientKeySurfaceCopy.attributionOffHeadline)
        #expect(section.evidenceLines == [ClientKeySurfaceCopy.attributionOffLine])
        #expect(section.controls.isEmpty, "nothing here can turn it on, so nothing here pretends to")
    }

    @Test("a fully wired profile says so, and admits what the shared key still costs")
    func wiredStatesTheResidualGap() throws {
        let plain = try #require(ClientKeyAttributionSurface.display(wiring: wiring()).section)
        #expect(plain.headline == ClientKeySurfaceCopy.attributionOnHeadline)
        #expect(plain.evidenceLines.count == 1)

        let coexisting = try #require(ClientKeyAttributionSurface.display(
            wiring: wiring(legacyAdmitted: true)
        ).section)
        #expect(coexisting.evidenceLines.contains(ClientKeySurfaceCopy.legacyStillAdmittedLine))
        #expect(ClientKeySurfaceCopy.legacyStillAdmittedLine.contains("unattributed"))
    }
}

/// TRIPWIRE #524 model-copy-reaches-the-surface (never-compromise #4).
///
/// #521 pinned its sentences in Core so the immediacy and enforcement-flip
/// disclosures could not drift, and #522 pinned the partial-migration sentence
/// so a half-done migration could not read as finished. A view that re-words
/// any of them routes around both tripwires while looking like ordinary UI
/// work. This asserts the surface QUOTES those types rather than restating
/// them: every rendered sentence must be a string one of the merged models
/// produced, or one of this surface's own pinned constants.
@Suite("TRIPWIRE #524 model-copy-reaches-the-surface")
struct Issue524CopyProvenanceTripwireTests {
    /// Every sentence the merged models own, plus the ones #524 adds.
    private static func admittedStrings(
        prompts: [ConsentedConfigConsentPrompt],
        wirings: [ClientKeyHelperWiring],
        records: [ConsentedConfigRecord]
    ) -> Set<String> {
        var admitted = Set<String>()
        for prompt in prompts {
            admitted.formUnion(prompt.operations)
            admitted.formUnion(prompt.effects)
            admitted.formUnion([
                prompt.title, prompt.backupLine, prompt.undoLine, prompt.coverageLine,
                prompt.declineConsequence, prompt.confirmButtonTitle, prompt.declineButtonTitle,
            ])
        }
        for wiring in wirings {
            if let partial = wiring.partialStateDescription { admitted.insert(partial) }
            admitted.insert(ClientKeySurfaceCopy.attributionOnLine(service: wiring.service))
        }
        for record in records {
            admitted.insert(record.headline)
            admitted.formUnion(record.lines)
            if case .superseded(let reason) = record.activation {
                admitted.insert(ConsentedConfigWriteCopy.supersededLine(reason))
            }
        }
        admitted.formUnion([
            ConsentedConfigWriteCopy.preparingLine,
            ConsentedConfigWriteCopy.applyingLine,
            ClientKeySurfaceCopy.deleteBackupsButtonTitle,
            ClientKeySurfaceCopy.attributionOnHeadline,
            ClientKeySurfaceCopy.attributionUnfinishedHeadline,
            ClientKeySurfaceCopy.attributionOffHeadline,
            ClientKeySurfaceCopy.attributionOffLine,
            ClientKeySurfaceCopy.legacyStillAdmittedLine,
        ])
        return admitted
    }

    @Test("no sentence on this surface is invented by it")
    func everyStringIsQuoted() {
        let prompts = [
            consentedConfigAppendPrompt(
                targetPath: "/tmp/placeholder/config.yaml", entryCount: 1, appendsLegacyValue: false,
                currentMode: 0o600, backupDirectoryPath: "/tmp/placeholder/backups",
                coverage: .covered(clientCount: 0), isFirstEntry: true
            ),
            consentedConfigAppendPrompt(
                targetPath: "/tmp/placeholder/config.yaml", entryCount: 2, appendsLegacyValue: true,
                currentMode: 0o644, backupDirectoryPath: "/tmp/placeholder/backups",
                coverage: .blocked(reason: ConsentedConfigWriteCopy.coverageStaleReason, uncovered: []),
                isFirstEntry: true
            ),
            consentedConfigRemovalPrompt(
                targetPath: "/tmp/placeholder/config.yaml", entryCount: 1, wouldEmptyList: true,
                backupDirectoryPath: "/tmp/placeholder/backups"
            ),
        ]
        let wirings = [
            ClientKeyHelperWiring(
                accountId: "placeholder-a", mode: ClientKeyHelperWiring.perProfileMode,
                service: "cli-proxy-api-client.placeholder-a", stage: "settings",
                settingsWired: true, shellEnvWired: false, legacySharedKeyStillAdmitted: true
            ),
            ClientKeyHelperWiring(
                accountId: "placeholder-b", mode: ClientKeyHelperWiring.perProfileMode,
                service: "cli-proxy-api-client.placeholder-b", stage: "complete",
                settingsWired: true, shellEnvWired: true, legacySharedKeyStillAdmitted: true,
                complete: true
            ),
            ClientKeyHelperWiring(
                accountId: "placeholder-c", mode: ClientKeyHelperWiring.legacyMode,
                service: KeychainClientKeyStore.legacySharedService
            ),
        ]
        let records = [
            ConsentedConfigRecord(
                outcome: .refused(reason: ConsentedConfigWriteCopy.targetNoConfigFlagReason),
                headline: ConsentedConfigWriteCopy.refusedHeadline,
                lines: [ConsentedConfigWriteCopy.targetNoConfigFlagReason]
            ),
            ConsentedConfigRecord(
                outcome: .written,
                headline: ConsentedConfigWriteCopy.appendSucceededHeadline,
                lines: [ConsentedConfigWriteCopy.nothingElseChangesEffect,
                        ConsentedConfigWriteCopy.takingEffectNowLine],
                activation: .superseded(reason: "the file changed after the write")
            ),
            ConsentedConfigRecord(
                outcome: .written,
                headline: ConsentedConfigWriteCopy.removalSucceededHeadline,
                lines: [ConsentedConfigWriteCopy.liveLine,
                        ConsentedConfigWriteCopy.backupDeletionOffer],
                activation: .live,
                offersBackupDeletion: true
            ),
        ]
        let admitted = Self.admittedStrings(prompts: prompts, wirings: wirings, records: records)

        var displays: [ClientKeySurfaceDisplay] = [
            .silent,
            ClientKeyConsentSurface.display(phase: .working(ConsentedConfigWriteCopy.preparingLine)),
            ClientKeyConsentSurface.display(phase: .working(ConsentedConfigWriteCopy.applyingLine)),
        ]
        for prompt in prompts {
            displays.append(ClientKeyConsentSurface.display(phase: .consent(prompt, canConfirm: true)))
            displays.append(ClientKeyConsentSurface.display(phase: .consent(prompt, canConfirm: false)))
        }
        for record in records {
            displays.append(ClientKeyConsentSurface.display(phase: .record(record)))
        }
        for wiring in wirings {
            displays.append(ClientKeyAttributionSurface.display(wiring: wiring))
        }

        for display in displays {
            guard let section = display.section else { continue }
            for line in [section.headline] + section.evidenceLines {
                if !admitted.contains(line) {
                    Issue.record("""
                    TRIPWIRE #524 model-copy-reaches-the-surface: the deck surface rendered a \
                    sentence no merged model produced:

                    \(line)

                    #521 and #522 pin their user-facing strings in Core so the immediacy, \
                    enforcement-flip, and partial-migration disclosures cannot drift. Quote them, \
                    or add the new sentence to ClientKeySurfaceCopy where it can be pinned too — \
                    never re-word one here.
                    """)
                }
            }
            for control in section.controls {
                if !admitted.contains(control.title) {
                    Issue.record("TRIPWIRE #524: control title '\(control.title)' is not pinned copy")
                }
            }
        }
    }

    @Test("the partial-migration sentence reaches the user whole, never summarized")
    func partialMigrationIsQuotedWhole() throws {
        let partial = ClientKeyHelperWiring(
            accountId: "placeholder-a", mode: ClientKeyHelperWiring.perProfileMode,
            service: "cli-proxy-api-client.placeholder-a", stage: "settings",
            settingsWired: true, shellEnvWired: false
        )
        let sentence = try #require(partial.partialStateDescription)
        let section = try #require(ClientKeyAttributionSurface.display(wiring: partial).section)
        #expect(section.evidenceLines == [sentence])
        #expect(section.headline == ClientKeySurfaceCopy.attributionUnfinishedHeadline)
        // A half-migrated profile must never read as attributing correctly.
        #expect(section.headline != ClientKeySurfaceCopy.attributionOnHeadline)
        #expect(section.controls.isEmpty, "this surface owns no migration to re-run")
    }
}

/// TRIPWIRE #524 no-dead-controls-and-labels-present (never-compromise #4,
/// PR #435 rule).
///
/// Two accessibility invariants the deck-row presentation class (#65/#113/#272)
/// makes non-negotiable, asserted over every state this surface can produce:
/// a control is either actionable or explains its unavailability IN PLACE, and
/// every control carries a spoken label. Relaxing this lets a mute, disabled
/// button ship — the failure PR #435 was filed for.
@Suite("TRIPWIRE #524 no-dead-controls-and-labels-present")
struct Issue524ControlInvariantTripwireTests {
    private static func allSections() -> [ClientKeySurfaceSection] {
        var phases: [ConsentedConfigWriteModel.Phase] = [
            .hidden,
            .working(ConsentedConfigWriteCopy.preparingLine),
            .working(ConsentedConfigWriteCopy.applyingLine),
        ]
        for coverage: ClientCoverageVerdict in [
            .covered(clientCount: 0), .covered(clientCount: 4), .stoodDown,
            .blocked(reason: ConsentedConfigWriteCopy.coverageMissingReason, uncovered: ["placeholder-client"]),
        ] {
            for isFirstEntry in [true, false] {
                let prompt = consentedConfigAppendPrompt(
                    targetPath: "/tmp/placeholder/config.yaml", entryCount: 1,
                    appendsLegacyValue: true, currentMode: 0o644,
                    backupDirectoryPath: "/tmp/placeholder/backups",
                    coverage: coverage, isFirstEntry: isFirstEntry
                )
                phases.append(.consent(prompt, canConfirm: coverage.isCovered))
            }
        }
        phases.append(.consent(
            consentedConfigRemovalPrompt(
                targetPath: "/tmp/placeholder/config.yaml", entryCount: 2,
                wouldEmptyList: true, backupDirectoryPath: "/tmp/placeholder/backups"
            ),
            canConfirm: true
        ))
        for offersDeletion in [true, false] {
            phases.append(.record(ConsentedConfigRecord(
                outcome: .written,
                headline: ConsentedConfigWriteCopy.removalSucceededHeadline,
                lines: [ConsentedConfigWriteCopy.liveLine],
                activation: .live,
                offersBackupDeletion: offersDeletion
            )))
        }
        phases.append(.record(ConsentedConfigRecord(
            outcome: .failed(reason: ConsentedConfigWriteCopy.failedHeadline),
            headline: ConsentedConfigWriteCopy.failedHeadline,
            lines: [ConsentedConfigWriteCopy.failedHeadline]
        )))

        var sections = phases.compactMap { ClientKeyConsentSurface.display(phase: $0).section }
        for mode in [ClientKeyHelperWiring.legacyMode, ClientKeyHelperWiring.perProfileMode] {
            for settingsWired in [true, false] {
                for shellEnvWired: Bool? in [true, false, nil] {
                    for complete in [true, false] {
                        let wiring = ClientKeyHelperWiring(
                            accountId: "placeholder-a", mode: mode,
                            service: "cli-proxy-api-client.placeholder-a",
                            stage: complete ? "complete" : "settings",
                            settingsWired: settingsWired, shellEnvWired: shellEnvWired,
                            legacySharedKeyStillAdmitted: true, complete: complete
                        )
                        if let section = ClientKeyAttributionSurface.display(wiring: wiring).section {
                            sections.append(section)
                        }
                    }
                }
            }
        }
        return sections
    }

    @Test("every control either acts or explains itself, and every control is spoken")
    func controlsAreNeverMute() {
        for section in Self.allSections() {
            for control in section.controls {
                if control.isEnabled, control.unavailableExplanation != nil {
                    Issue.record("""
                    TRIPWIRE #524 no-dead-controls: '\(control.title)' is enabled but carries an \
                    unavailability reason. The two states have drifted apart; a reader is told \
                    something cannot be done while it can.
                    """)
                }
                if !control.isEnabled, control.unavailableExplanation == nil {
                    Issue.record("""
                    TRIPWIRE #524 no-dead-controls: '\(control.title)' is disabled with no reason \
                    on the surface. PR #435's rule is that an unavailable control explains itself \
                    IN PLACE — a mute disabled button leaves the reader guessing whether ModelDeck \
                    is broken or they are.
                    """)
                }
                if control.accessibilityLabel.isEmpty {
                    Issue.record("""
                    TRIPWIRE #524 labels-present: '\(control.title)' has no accessibility label, so \
                    VoiceOver announces an unnamed button.
                    """)
                }
                if !control.isEnabled, control.accessibilityHint != control.unavailableExplanation {
                    Issue.record("""
                    TRIPWIRE #524 labels-present: '\(control.title)' is disabled but does not SPEAK \
                    its reason — a tooltip never reaches VoiceOver (PR #433).
                    """)
                }
            }
        }
    }

    @Test("evidence lines are never empty, and never smuggled into a control")
    func evidenceStandsOnItsOwn() {
        for section in Self.allSections() {
            #expect(!section.headline.isEmpty)
            for line in section.evidenceLines {
                #expect(!line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if section.controls.contains(where: { $0.title == line }) {
                    Issue.record("""
                    TRIPWIRE #524: an evidence sentence is also a control title, which means the \
                    reader has to press something to finish reading it. Evidence and controls stay \
                    separate (#65/#113/#272).
                    """)
                }
            }
            // A section that offers a control must also say what it is about:
            // a bare button with no sentence above it is the hover-only
            // affordance this class of surface forbids.
            if !section.controls.isEmpty {
                #expect(!section.evidenceLines.isEmpty)
            }
        }
    }
}
