import Foundation

// Issue #521 — the consent flow for the §2.6 config write, in the shape the
// repo's other consent flows use (ManagedProxyOnboardingModel): pure decisions
// and copy in Core, one-method seams for everything side-effectful, a Phase
// enum a view renders, and a record emitted on EVERY exit so no path is
// silent (0008/0011).
//
// The order below is the gate, and it is not rearrangeable: the target is
// derived first (a config we cannot name is never written), the coverage
// evidence is checked before the FIRST entry is offered (recon V2: that write
// flips the proxy to enforce-list within ~2 seconds), and only then is consent
// asked — with copy that says so.

/// Where the pre-flight client-coverage evidence comes from. One method,
/// because the gate asks one question: who is using this proxy right now, and
/// what key are they sending?
///
/// Returning nil is an honest "couldn't tell", and the gate treats it as a
/// refusal — never as "nobody is using it".
public protocol ClientCoverageObserving: Sendable {
    func observeClientCoverage() async -> ClientCoverageEvidence?
}

/// One profile's key, on its way into the config. The raw key is tick-local:
/// it lives in this request, goes into the file, and is never persisted by
/// this feature (the provisioning record stores hashes only).
public struct ConsentedConfigAppendEntry: Sendable {
    public var profileID: String
    public var profileLabel: String
    public var key: String

    public init(profileID: String, profileLabel: String, key: String) {
        self.profileID = profileID
        self.profileLabel = profileLabel
        self.key = key
    }
}

public struct ConsentedConfigAppendRequest: Sendable {
    public var source: ConsentedConfigTargetSource
    public var entries: [ConsentedConfigAppendEntry]
    /// The legacy shared Keychain value, when one exists — appended for
    /// live-session continuity (design §2.5, blocker 2).
    public var legacyValue: String?

    public init(
        source: ConsentedConfigTargetSource,
        entries: [ConsentedConfigAppendEntry],
        legacyValue: String? = nil
    ) {
        self.source = source
        self.entries = entries
        self.legacyValue = legacyValue
    }
}

/// Drives the consented write. Owned by the app; the deck surface that renders
/// it is build item 7 (#521 is out of scope for the deck view itself).
@MainActor
public final class ConsentedConfigWriteModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case hidden
        /// The prompt is on screen. `canConfirm` is false when the coverage
        /// gate blocked the first append — the reason is in the prompt, and
        /// the button is disabled rather than the prompt being hidden.
        case consent(ConsentedConfigConsentPrompt, canConfirm: Bool)
        case working(String)
        case record(ConsentedConfigRecord)
    }

    public struct Dependencies {
        public var writer: ConsentedConfigWriter
        public var backups: ConfigBackupStore
        public var coverage: any ClientCoverageObserving
        public var records: any ConfigKeyProvisioningRecordStoring
        public var hash: @Sendable (String) -> String
        public var clock: @Sendable () -> Date

        public init(
            writer: ConsentedConfigWriter,
            backups: ConfigBackupStore,
            coverage: any ClientCoverageObserving,
            records: any ConfigKeyProvisioningRecordStoring,
            hash: @escaping @Sendable (String) -> String = ClientKeyGenerator.sha256Hex,
            clock: @escaping @Sendable () -> Date = { Date() }
        ) {
            self.writer = writer
            self.backups = backups
            self.coverage = coverage
            self.records = records
            self.hash = hash
            self.clock = clock
        }
    }

    @Published public private(set) var phase: Phase = .hidden
    /// The last record, kept after the phase returns to hidden so a settings
    /// surface can still show what happened.
    @Published public private(set) var lastRecord: ConsentedConfigRecord?

    private let deps: Dependencies
    private var pendingAppend: PreparedAppend?
    private var pendingRemoval: PreparedRemoval?

    private struct PreparedAppend {
        var target: URL
        var values: [String]
        var recordEntries: [ConfigKeyProvisioningRecord.Entry]
        var legacyHash: String?
        var isFirstEntry: Bool
        /// The gate's verdict, carried to `confirm` so the block is enforced
        /// by the MODEL, not by a disabled button. A view that forgets to
        /// respect `canConfirm` must not be able to write the first entry
        /// without coverage evidence.
        var coverage: ClientCoverageVerdict
        /// The evidence itself, kept so the gate can be re-run at confirm
        /// against the clock THEN. The prompt can sit on screen for hours;
        /// evidence that was fresh when it went up may be stale by the time
        /// the button is pressed (security review of PR #531, should-fix 1).
        var evidence: ClientCoverageEvidence?
        var appendedKeyHashes: Set<String>
        /// What the consent screen said would happen to enforcement.
        var expectation: ConsentedFlipExpectation
    }

    private struct PreparedRemoval {
        var target: URL
        var record: ConfigKeyProvisioningRecord
        var wouldEmptyList: Bool
        var expectation: ConsentedFlipExpectation
    }

    public init(dependencies: Dependencies) {
        self.deps = dependencies
    }

    // MARK: Append

    /// Derives the target, checks coverage, and shows the prompt — or emits a
    /// refusal record. Writes nothing.
    public func prepareAppend(_ request: ConsentedConfigAppendRequest) async {
        // Nothing has been written and nothing has been agreed to yet, so the
        // progress line may not describe a change (should-fix 4).
        phase = .working(ConsentedConfigWriteCopy.preparingLine)
        guard let target = resolveTarget(request.source) else { return }

        // A duplicate profile id is REFUSED, never deduplicated and never
        // trapped (CodeRabbit on PR #531): `Dictionary(uniqueKeysWithValues:)`
        // crashes the app on a duplicate, and silently collapsing one would
        // write a key whose profile the record then cannot name. Two entries
        // for one profile means the caller is confused about which key that
        // profile holds, and guessing is the one thing this path must not do.
        var hashesByProfileID: [String: String] = [:]
        for entry in request.entries {
            guard hashesByProfileID.updateValue(deps.hash(entry.key), forKey: entry.profileID) == nil else {
                finish(refused: "ModelDeck was asked to add two different keys for the same profile (\(entry.profileLabel)), so it added none of them.")
                return
            }
        }

        let admission = planLegacyKeyAdmission(
            legacyValue: request.legacyValue,
            managedKeyHashesByProfileID: hashesByProfileID,
            hash: deps.hash
        )
        var values = request.entries.map(\.key)
        var legacyHash: String?
        switch admission {
        case .none:
            break
        case .append(let value):
            values.append(value)
            legacyHash = deps.hash(value)
        case .rotateFirst(let profileIDs):
            finish(refused: "The shared key your shells already use is the same value as \(profileIDs.count == 1 ? "a profile's" : "some profiles'") own key, so ModelDeck can't tell their usage apart. Rotate those keys first — nothing was written.")
            return
        case .refuseUnsafeValue:
            finish(refused: "The shared key your shells already use isn't a plain text value, so ModelDeck won't write it into your config. Nothing was changed.")
            return
        }

        let inspected: (document: ConfigAPIKeysDocument, mode: UInt16)
        do {
            inspected = try deps.writer.inspect(target: target)
        } catch {
            finish(refused: describe(error, target: target))
            return
        }

        let isFirstEntry = inspected.document.isEmptyList
        // The recorded V2 gate: evidence is fetched BEFORE the first entry can
        // be offered, and a blocked verdict disables the button rather than
        // hiding the prompt — the user is told exactly who would break.
        let evidence = isFirstEntry ? await deps.coverage.observeClientCoverage() : nil
        let verdict = decideClientCoverage(
            evidence: evidence,
            isFirstEntry: isFirstEntry,
            appendedKeyHashes: Set(request.entries.map { deps.hash($0.key) }),
            legacyValueWillBeAppended: legacyHash != nil,
            now: deps.clock()
        )

        pendingAppend = PreparedAppend(
            target: target,
            values: values,
            recordEntries: request.entries.map {
                .init(profileID: $0.profileID, profileLabel: $0.profileLabel, keySha256: deps.hash($0.key))
            },
            legacyHash: legacyHash,
            isFirstEntry: isFirstEntry,
            coverage: verdict,
            evidence: evidence,
            appendedKeyHashes: Set(request.entries.map { deps.hash($0.key) }),
            expectation: ConsentedFlipExpectation(
                flipsEnforcementOn: isFirstEntry, flipsEnforcementOff: false
            )
        )
        phase = .consent(
            consentedConfigAppendPrompt(
                targetPath: target.path,
                entryCount: values.count,
                appendsLegacyValue: legacyHash != nil,
                currentMode: inspected.mode & 0o777,
                backupDirectoryPath: deps.backups.directory.path,
                coverage: verdict,
                isFirstEntry: isFirstEntry
            ),
            canConfirm: verdict.isCovered
        )
    }

    // MARK: Removal

    /// Shows the removal prompt for what the provisioning record says ModelDeck
    /// wrote. The prompt carries the last-entry disclosure when this would
    /// empty the list.
    public func prepareRemoval(source: ConsentedConfigTargetSource) async {
        // Nothing has been written and nothing has been agreed to yet, so the
        // progress line may not describe a change (should-fix 4).
        phase = .working(ConsentedConfigWriteCopy.preparingLine)
        guard let target = resolveTarget(source) else { return }
        guard let record = deps.records.record else {
            finish(refused: "ModelDeck has no record of adding keys to this config, so it will not remove anything from it.")
            return
        }
        let inspected: (document: ConfigAPIKeysDocument, mode: UInt16)
        do {
            inspected = try deps.writer.inspect(target: target)
        } catch {
            finish(refused: describe(error, target: target))
            return
        }
        let planned: ConfigAPIKeysEdit
        do {
            planned = try inspected.document.removing(record: record, hash: deps.hash)
        } catch {
            finish(refused: describe(error, target: target))
            return
        }
        pendingRemoval = PreparedRemoval(
            target: target, record: record, wouldEmptyList: planned.flipsEnforcementOff,
            expectation: ConsentedFlipExpectation(
                flipsEnforcementOn: false, flipsEnforcementOff: planned.flipsEnforcementOff
            )
        )
        phase = .consent(
            consentedConfigRemovalPrompt(
                targetPath: target.path,
                entryCount: planned.removedLineIndices.count,
                wouldEmptyList: planned.flipsEnforcementOff,
                backupDirectoryPath: deps.backups.directory.path
            ),
            canConfirm: true
        )
    }

    // MARK: Consent answers

    public func decline() {
        let isRemoval = pendingRemoval != nil
        pendingAppend = nil
        pendingRemoval = nil
        finish(refused: isRemoval
            ? ConsentedConfigWriteCopy.removalDeclineConsequence
            : ConsentedConfigWriteCopy.declineConsequence)
    }

    /// The only path that writes. Everything it needs was decided before the
    /// prompt went up, so consent covers exactly what the user read.
    public func confirm(
        settle: TimeInterval = ConsentedConfigWriter.defaultReloadSettleInterval,
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) async {
        if let pending = pendingAppend {
            pendingAppend = nil
            // TRIPWIRE coverage-gate-blocks-first-append (recon V2, condition
            // (a) of the recorded gate): the first entry flips the proxy to
            // enforce-list within ~2 seconds, so it is not written without
            // evidence that every observed client is covered. Enforced here so
            // no caller can route around it.
            //
            // Re-decided against the clock NOW, not the clock at prepare: the
            // prompt can sit on screen indefinitely, and evidence that was
            // fresh when it went up may be stale by the time it is answered.
            let verdict = pending.isFirstEntry
                ? decideClientCoverage(
                    evidence: pending.evidence,
                    isFirstEntry: true,
                    appendedKeyHashes: pending.appendedKeyHashes,
                    legacyValueWillBeAppended: pending.legacyHash != nil,
                    now: deps.clock()
                )
                : pending.coverage
            if case .blocked(let reason, let uncovered) = verdict {
                let error = ConsentedConfigWriteError.clientCoverageUnproven(
                    reason: reason, uncovered: uncovered
                )
                finish(refused: describe(error, target: pending.target))
                return
            }
            await run(
                edit: .append(values: pending.values, origin: "a client key"),
                expecting: pending.expectation,
                target: pending.target,
                headline: ConsentedConfigWriteCopy.appendSucceededHeadline,
                settle: settle, sleep: sleep
            ) { [deps] outcome, activation in
                // MERGED with what is already recorded, never replaced
                // (CodeRabbit on PR #531). Enabling a second profile is a
                // second append; replacing the record would orphan the first
                // profile's key — still live in the config, and no longer
                // removable by the removal path, which works from this record
                // alone.
                deps.records.record = ConsentedConfigWriteModel.merge(
                    into: deps.records.record,
                    targetPath: pending.target.path,
                    entries: pending.recordEntries,
                    legacyValueSha256: pending.legacyHash,
                    backupPath: outcome.backupPath,
                    writtenAt: deps.clock()
                )
                return ConsentedConfigRecord(
                    outcome: .written,
                    headline: ConsentedConfigWriteCopy.appendSucceededHeadline,
                    lines: [
                        ConsentedConfigWriteCopy.appendOperation(
                            entryCount: outcome.addedEntries, targetPath: outcome.targetPath
                        ),
                        outcome.tightenedPermissions
                            ? ConsentedConfigWriteCopy.tightenOperation(
                                targetPath: outcome.targetPath, currentMode: outcome.previousMode)
                            : ConsentedConfigWriteCopy.nothingElseChangesEffect,
                        activation.isLive
                            ? ConsentedConfigWriteCopy.liveLine
                            : ConsentedConfigWriteCopy.takingEffectNowLine,
                    ],
                    backupPath: outcome.backupPath,
                    activation: activation,
                    offersBackupDeletion: false
                )
            }
            return
        }
        guard let pending = pendingRemoval else { return }
        pendingRemoval = nil
        let hash = deps.hash
        await run(
            edit: .remove(record: pending.record, hash: hash),
            expecting: pending.expectation,
            target: pending.target,
            headline: ConsentedConfigWriteCopy.removalSucceededHeadline,
            settle: settle, sleep: sleep
        ) { [deps] outcome, activation in
            deps.records.record = nil
            var lines = [
                ConsentedConfigWriteCopy.removalOperation(
                    entryCount: outcome.removedEntries, targetPath: outcome.targetPath
                ),
            ]
            if outcome.flipsEnforcementOff { lines.append(ConsentedConfigWriteCopy.lastEntryRemovalDisclosure) }
            lines.append(activation.isLive
                ? ConsentedConfigWriteCopy.liveLine
                : ConsentedConfigWriteCopy.takingEffectNowLine)
            // should-fix 6: the backup still holds the keys just removed, so
            // its deletion is offered only once removal is CONFIRMED live —
            // until then it is the rollback path and must survive.
            if activation.isLive { lines.append(ConsentedConfigWriteCopy.backupDeletionOffer) }
            return ConsentedConfigRecord(
                outcome: .written,
                headline: ConsentedConfigWriteCopy.removalSucceededHeadline,
                lines: lines,
                backupPath: outcome.backupPath,
                // Every backup taken while these keys were live still holds
                // them — with appends now merging, that is one per append, not
                // just the newest. Offering only the last would leave the
                // earlier copies outliving the keys they carry.
                staleBackupPaths: pending.record.backupPaths,
                activation: activation,
                offersBackupDeletion: activation.isLive
            )
        }
    }

    /// Deletes the backups the last record offered. Reachable only from a
    /// record whose `offersBackupDeletion` is true.
    @discardableResult
    public func deleteOfferedBackups() -> [URL] {
        guard let record = lastRecord, record.offersBackupDeletion else { return [] }
        let paths = ([record.backupPath].compactMap { $0 } + record.staleBackupPaths)
        let unique = NSOrderedSet(array: paths.map { URL(fileURLWithPath: $0) })
        let deleted = deps.backups.delete(unique.compactMap { $0 as? URL })
        lastRecord = ConsentedConfigRecord(
            outcome: record.outcome,
            headline: record.headline,
            lines: record.lines,
            backupPath: nil,
            staleBackupPaths: [],
            activation: record.activation,
            offersBackupDeletion: false
        )
        if case .record = phase, let updated = lastRecord { phase = .record(updated) }
        return deleted
    }

    /// Folds one append into the provisioning record.
    ///
    /// Merged by profile id (a re-provisioned profile's newer hash wins), the
    /// legacy hash preserved when this append did not carry one, and backups
    /// accumulated newest-last so every copy that still holds live keys stays
    /// named. A record for a DIFFERENT file is replaced rather than merged:
    /// entries from another config are not removable from this one, and
    /// carrying them would make the removal path refuse against a file that
    /// never held them.
    static func merge(
        into existing: ConfigKeyProvisioningRecord?,
        targetPath: String,
        entries: [ConfigKeyProvisioningRecord.Entry],
        legacyValueSha256: String?,
        backupPath: String,
        writtenAt: Date
    ) -> ConfigKeyProvisioningRecord {
        let carried = existing.flatMap { $0.targetPath == targetPath ? $0 : nil }
        var merged = carried?.entries ?? []
        for entry in entries {
            if let index = merged.firstIndex(where: { $0.profileID == entry.profileID }) {
                merged[index] = entry
            } else {
                merged.append(entry)
            }
        }
        return ConfigKeyProvisioningRecord(
            targetPath: targetPath,
            writtenAt: writtenAt,
            entries: merged,
            legacyValueSha256: legacyValueSha256 ?? carried?.legacyValueSha256,
            backupPaths: (carried?.backupPaths ?? []) + [backupPath]
        )
    }

    // MARK: Plumbing

    private func run(
        edit: ConsentedConfigEdit,
        expecting: ConsentedFlipExpectation,
        target: URL,
        headline: String,
        settle: TimeInterval,
        sleep: @escaping @Sendable (TimeInterval) async -> Void,
        onSuccess: (ConsentedConfigWriteOutcome, ConsentedConfigActivation) -> ConsentedConfigRecord
    ) async {
        phase = .working(ConsentedConfigWriteCopy.applyingLine)
        let outcome: ConsentedConfigWriteOutcome
        do {
            outcome = try deps.writer.apply(edit, to: target, expecting: expecting)
        } catch {
            finish(failed: describe(error, target: target))
            return
        }
        let activation = await deps.writer.verifyActivation(
            target: target, publishedSha256: outcome.publishedSha256, settle: settle, sleep: sleep
        )
        emit(onSuccess(outcome, activation))
    }

    private func resolveTarget(_ source: ConsentedConfigTargetSource) -> URL? {
        switch resolveConsentedConfigTarget(source) {
        case .file(let url):
            return url
        case .refused(let reason):
            finish(refused: reason)
            return nil
        }
    }

    private func describe(_ error: any Error, target: URL) -> String {
        let text = (error as? LocalizedError)?.errorDescription
            ?? (error as? ManagedProxyWriteGuard.Violation)?.errorDescription
            ?? "\(error)"
        return text + "\n\n" + ConsentedConfigWriteCopy.manualSnippet(targetPath: target.path)
    }

    private func finish(refused reason: String) {
        emit(ConsentedConfigRecord(
            outcome: .refused(reason: reason),
            headline: ConsentedConfigWriteCopy.refusedHeadline,
            lines: [reason]
        ))
    }

    private func finish(failed reason: String) {
        emit(ConsentedConfigRecord(
            outcome: .failed(reason: reason),
            headline: ConsentedConfigWriteCopy.failedHeadline,
            lines: [reason]
        ))
    }

    private func emit(_ record: ConsentedConfigRecord) {
        lastRecord = record
        phase = .record(record)
    }
}
