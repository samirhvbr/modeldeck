import CryptoKit
import Foundation

// Issue #521 — the effectful half of the consented config write path (design
// §2.6). Every filesystem call in this feature lives inside one of the two
// guarded writer types below (`ConfigBackupStore`, `ConsentedConfigWriter`),
// which is what the write-guard tripwire scans for: a write API anywhere else
// in this feature's sources fails the build.
//
// Unit tests drive this against FIXTURE configs in temp directories. Nothing
// here may ever be pointed at a running proxy's live config by a test, and no
// test spawns a proxy, touches ports 8317/3867, or reads the Keychain.

// MARK: - Guard (extends the managed-proxy write guard to this operation)

/// The managed lifecycle's guard admits exactly two files inside ModelDeck's
/// own proxy directory. The consented write cannot use it as-is — a coexist
/// proxy's config is wherever `-config` said it was — so this guard keeps the
/// same property in the same shape: an ENUMERABLE set of destinations, derived
/// per operation, with an auth-file attempt raising its own named violation.
///
/// Admitted destinations, and nothing else:
///  1. the derived target config file itself;
///  2. a `.modeldeck-config.*` temp alongside it (the atomic-publish staging);
///  3. nothing in ModelDeck's proxy directory beyond what the managed guard
///     already admits — backups live in ModelDeck's own state directory (D2),
///     enforced by `requireBackupDestination`.
public enum ConsentedConfigWriteGuard {
    /// Temp files staged next to the target. Named so a crashed publish leaves
    /// something obviously ours rather than an anonymous dotfile.
    public static let temporaryPrefix = ".modeldeck-config."

    /// Throws unless `destination` is the derived target, or its staging temp.
    /// An auth-file destination raises `ManagedProxyWriteGuard.Violation
    /// .authFileWrite` — the same named violation the managed lifecycle uses,
    /// so one grep finds every place the rule is enforced.
    public static func requireConsentedConfigWrite(
        _ destination: URL,
        target: URL,
        declaredAuthDirectory: String? = nil
    ) throws {
        let candidate = standardizedPath(destination)
        let targetPath = standardizedPath(target)
        let directory = target.deletingLastPathComponent()
        // Auth files first: an auth destination must never be reported as a
        // generic "unmanaged path", because the two failures deserve different
        // alarm (decision 0006).
        if isInsideAuthDirectory(destination, configDirectory: directory, declared: declaredAuthDirectory) {
            throw ManagedProxyWriteGuard.Violation.authFileWrite(candidate)
        }
        if candidate == targetPath { return }
        let temporaryRoot = standardizedPath(directory) + "/" + temporaryPrefix
        guard candidate.hasPrefix(temporaryRoot) else {
            throw ManagedProxyWriteGuard.Violation.unmanagedPathWrite(candidate)
        }
    }

    /// Throws unless `destination` is inside ModelDeck's own state directory —
    /// and never inside a proxy directory (decision D2: the proxy-dir guard
    /// stays at exactly two files, so backups may not widen it).
    public static func requireBackupDestination(
        _ destination: URL,
        stateDirectory: URL,
        forbiddenDirectories: [URL]
    ) throws {
        let candidate = standardizedPath(destination)
        let root = standardizedPath(stateDirectory) + "/"
        for forbidden in forbiddenDirectories {
            let path = standardizedPath(forbidden)
            if candidate == path || candidate.hasPrefix(path + "/") {
                throw ConsentedConfigWriteError.backupOutsideStateDirectory(path: candidate)
            }
        }
        guard candidate.hasPrefix(root) else {
            throw ConsentedConfigWriteError.backupOutsideStateDirectory(path: candidate)
        }
    }

    static func isInsideAuthDirectory(
        _ url: URL, configDirectory: URL, declared: String?
    ) -> Bool {
        let candidate = standardizedPath(url)
        var roots = [standardizedPath(ManagedProxyPaths(configDirectory: configDirectory).authDirectory)]
        if let declared, !declared.isEmpty {
            let expanded = (declared as NSString).expandingTildeInPath
            let resolved = expanded.hasPrefix("/")
                ? URL(fileURLWithPath: expanded)
                : configDirectory.appendingPathComponent(expanded)
            roots.append(standardizedPath(resolved))
        }
        return roots.contains { candidate == $0 || candidate.hasPrefix($0 + "/") }
    }

    static func standardizedPath(_ url: URL) -> String {
        url.standardizedFileURL.path
    }
}

// MARK: - Byte-exact digest

/// SHA-256 over the config's RAW BYTES.
///
/// The activation check asks "is the file still exactly what we published?", so
/// it has to hash what is on disk, not a decoded rendering of it. Hashing a
/// lossily-decoded string would fold every malformed byte sequence onto U+FFFD
/// and let a different file answer yes (CodeRabbit on PR #531).
public enum ConsentedConfigDigest {
    public static let sha256Hex: @Sendable (Data) -> String = { data in
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - ModelDeck's own state directory

/// Where ModelDeck keeps its own files. The daemon's authority for this is
/// src/paths.mjs; the override name matches so the two halves of the product
/// never disagree about where ModelDeck's storage is.
public struct ModelDeckStatePaths: Equatable, Sendable {
    public static let dataDirectoryEnvironmentKey = "MODELDECK_DATA_DIR"
    public static let configBackupsDirectoryName = "proxy-config-backups"

    public let stateDirectory: URL

    public init(stateDirectory: URL) {
        self.stateDirectory = stateDirectory
    }

    public var configBackupsDirectory: URL {
        stateDirectory.appendingPathComponent(Self.configBackupsDirectoryName, isDirectory: true)
    }

    public static func standard(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ModelDeckStatePaths {
        if let override = environment[dataDirectoryEnvironmentKey], override.hasPrefix("/") {
            return ModelDeckStatePaths(stateDirectory: URL(fileURLWithPath: override, isDirectory: true))
        }
        return ModelDeckStatePaths(
            stateDirectory: home.appendingPathComponent("Library/Application Support/ModelDeck", isDirectory: true)
        )
    }
}

// MARK: - Backups (GUARDED WRITER)

/// Timestamped copies of the config taken immediately before each publish.
///
/// These files hold client keys AND the proxy's management secret, so they get
/// the full secret-file discipline: 0600 from birth (never chmod'ed after the
/// fact), inside ModelDeck's own state directory only, and pruned to a small
/// retained count so secret-bearing copies do not accumulate forever.
public struct ConfigBackupStore: Sendable {
    public static let filePrefix = "config-"
    public static let fileSuffix = ".yaml.bak"
    public static let defaultRetained = 10

    public let directory: URL
    private let retained: Int
    private let stateDirectory: URL

    public init(
        paths: ModelDeckStatePaths = .standard(),
        retained: Int = defaultRetained
    ) {
        self.directory = paths.configBackupsDirectory
        self.stateDirectory = paths.stateDirectory
        self.retained = max(1, retained)
    }

    /// Writes `bytes` as a new backup and returns its URL. `forbiddenDirectories`
    /// is the proxy directory the operation is editing: the guard proves the
    /// backup does not land there (D2).
    public func write(
        _ bytes: Data,
        at moment: Date = Date(),
        forbiddenDirectories: [URL] = []
    ) throws -> URL {
        let destination = directory.appendingPathComponent(Self.fileName(at: moment))
        try ConsentedConfigWriteGuard.requireBackupDestination(
            destination, stateDirectory: stateDirectory, forbiddenDirectories: forbiddenDirectories
        )
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            throw ConsentedConfigWriteError.backupWriteFailed(path: destination.path)
        }
        // The create-time mode only covers a directory WE created (nit 10). An
        // existing one — from an older build, a restore, a permissive umask —
        // may be group- or world-readable, and the files about to land in it
        // hold client keys and the management secret. Tighten it, or refuse:
        // 0600 files under a 0755 directory still leak their names, sizes, and
        // timing, and the next build to relax file mode would leak more.
        try tightenDirectoryOrRefuse(destination: destination)
        guard publishOwnerOnly(bytes, at: destination, exclusive: true) else {
            throw ConsentedConfigWriteError.backupWriteFailed(path: destination.path)
        }
        return destination
    }

    /// Deletes all but the newest `retained` backups. Best effort by design: a
    /// prune failure must not fail a write that already succeeded, and the
    /// files it leaves behind are already owner-only.
    @discardableResult
    public func prune() -> [URL] {
        let existing = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        let backups = existing
            .filter { $0.lastPathComponent.hasPrefix(Self.filePrefix) && $0.lastPathComponent.hasSuffix(Self.fileSuffix) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard backups.count > retained else { return [] }
        let stale = Array(backups.prefix(backups.count - retained))
        for url in stale { try? FileManager.default.removeItem(at: url) }
        return stale
    }

    /// The verified-live deletion offer (should-fix 6). Only called once a
    /// removal is confirmed live — until then these files ARE the rollback.
    @discardableResult
    public func delete(_ urls: [URL]) -> [URL] {
        var deleted: [URL] = []
        for url in urls {
            guard url.path.hasPrefix(directory.path + "/") else { continue }
            if (try? FileManager.default.removeItem(at: url)) != nil { deleted.append(url) }
        }
        return deleted
    }

    /// Makes the backups directory owner-only, or refuses the backup — and
    /// therefore the whole operation, since the write path takes no step
    /// without one.
    private func tightenDirectoryOrRefuse(destination: URL) throws {
        var info = stat()
        guard lstat(directory.path, &info) == 0 else {
            throw ConsentedConfigWriteError.backupWriteFailed(path: destination.path)
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR else {
            throw ConsentedConfigWriteError.backupWriteFailed(path: destination.path)
        }
        if info.st_mode & 0o777 == 0o700 { return }
        guard chmod(directory.path, 0o700) == 0 else {
            throw ConsentedConfigWriteError.backupWriteFailed(path: destination.path)
        }
        var confirmed = stat()
        guard lstat(directory.path, &confirmed) == 0, confirmed.st_mode & 0o777 == 0o700 else {
            throw ConsentedConfigWriteError.backupWriteFailed(path: destination.path)
        }
    }

    static func fileName(at moment: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmssSSS'Z'"
        return filePrefix + formatter.string(from: moment) + "-" + String(UInt32.random(in: 0..<0xFFFF), radix: 16) + fileSuffix
    }

    /// mkstemp (owner-only by construction) + rename. A secret-bearing file
    /// never exists world-readable, not even briefly, and never exists torn.
    private func publishOwnerOnly(_ bytes: Data, at destination: URL, exclusive: Bool) -> Bool {
        OwnerOnlyPublisher.publish(
            bytes, at: destination, exclusive: exclusive, temporaryPrefix: ".backup."
        )
    }
}

// MARK: - The write (GUARDED WRITER)

/// Test seams for the concurrency the design cannot otherwise reach: the proxy
/// is a separate process that honours no advisory lock, so the only way to
/// exercise the TOCTOU guard is to inject the concurrent write ourselves.
/// Production always uses `.none` — every hook is a no-op closure.
public struct ConsentedConfigWriteHooks: Sendable {
    /// Runs immediately before the pre-rename byte-compare of each attempt.
    public var beforeCompare: @Sendable (_ attempt: Int, _ target: URL) -> Void
    /// Runs immediately after the rename of each attempt.
    public var afterPublish: @Sendable (_ attempt: Int, _ target: URL) -> Void
    /// Forces post-write verification to fail, to exercise the rollback.
    public var failVerification: @Sendable (_ attempt: Int) -> Bool

    public static let none = ConsentedConfigWriteHooks(
        beforeCompare: { _, _ in },
        afterPublish: { _, _ in },
        failVerification: { _ in false }
    )

    public init(
        beforeCompare: @escaping @Sendable (_ attempt: Int, _ target: URL) -> Void = { _, _ in },
        afterPublish: @escaping @Sendable (_ attempt: Int, _ target: URL) -> Void = { _, _ in },
        failVerification: @escaping @Sendable (_ attempt: Int) -> Bool = { _ in false }
    ) {
        self.beforeCompare = beforeCompare
        self.afterPublish = afterPublish
        self.failVerification = failVerification
    }
}

/// What one edit is.
public enum ConsentedConfigEdit: Sendable {
    case append(values: [String], origin: String)
    case remove(record: ConfigKeyProvisioningRecord, hash: @Sendable (String) -> String)
}

/// What the operation did. Carries no key material — counts, paths, and modes.
public struct ConsentedConfigWriteOutcome: Equatable, Sendable {
    public var targetPath: String
    public var backupPath: String
    public var attempts: Int
    public var addedEntries: Int
    public var removedEntries: Int
    public var entriesAfterEdit: Int
    /// The file's mode before the edit, when it was looser than owner-only.
    public var previousMode: UInt16?
    public var tightenedPermissions: Bool
    public var flipsEnforcementOn: Bool
    public var flipsEnforcementOff: Bool
    public var publishedSha256: String
}

/// Applies a consented edit to a derived target config.
///
/// The sequence, per attempt, is the design's §2.6 verbatim:
///   read baseline → parse → edit → (hook) → RE-READ AND BYTE-COMPARE against
///   THIS attempt's baseline → back up THIS attempt's baseline → publish via
///   mkstemp+rename (0600 by construction) → re-read and verify.
///
/// The re-baseline is the point: a retry that reused the first attempt's
/// snapshot would restore stale bytes over the very intervening change the
/// retry detected (CodeRabbit on PR #506). Every attempt therefore takes its
/// own baseline, writes its own backup, and any rollback restores only the
/// current attempt's snapshot — guarded by the same byte-compare before the
/// restore.
///
/// Residual risk, accepted on the record (Tim, PR #506 comment 2026-08-18):
/// the compare-to-rename gap cannot be closed unilaterally — the concurrent
/// writer is a Go process honouring no advisory lock, and macOS rename cannot
/// be made conditional on content. The window is narrowed to microseconds, the
/// edit happens only at a consented moment, and a lost concurrent write is
/// detected after publish and reported loudly rather than silently absorbed.
public struct ConsentedConfigWriter: Sendable {
    public static let defaultMaximumAttempts = 3
    /// The proxy's own reload window: 150 ms debounce plus rename settling,
    /// observed live at ~2 s in recon V3. Activation is confirmed after this.
    public static let defaultReloadSettleInterval: TimeInterval = 2
    /// How old a staging temp must be before the sweep treats it as abandoned
    /// rather than as another publish in flight.
    public static let staleTemporaryAge: TimeInterval = 60

    private let backups: ConfigBackupStore
    private let hooks: ConsentedConfigWriteHooks
    private let maximumAttempts: Int
    private let clock: @Sendable () -> Date
    private let digest: @Sendable (Data) -> String

    public init(
        backups: ConfigBackupStore,
        hooks: ConsentedConfigWriteHooks = .none,
        maximumAttempts: Int = defaultMaximumAttempts,
        clock: @escaping @Sendable () -> Date = { Date() },
        // Hashes the RAW BYTES, never a decoded string (CodeRabbit on PR #531):
        // lossy decoding maps every malformed sequence onto U+FFFD, so two
        // different files can produce the same digest and `verifyActivation`
        // would report a change live that is not the one we published.
        digest: @escaping @Sendable (Data) -> String = ConsentedConfigDigest.sha256Hex
    ) {
        self.backups = backups
        self.hooks = hooks
        self.maximumAttempts = max(1, maximumAttempts)
        self.clock = clock
        self.digest = digest
    }

    /// Reads the target and returns its parsed api-keys document plus its
    /// current mode — what the consent screen needs to name both operations
    /// before anything happens.
    public func inspect(target: URL) throws -> (document: ConfigAPIKeysDocument, mode: UInt16) {
        let document = try ConfigAPIKeysDocument.parse(decodeStrictly(try read(target), at: target))
        return (document, try mode(of: target))
    }

    /// Decodes config bytes as UTF-8 or REFUSES.
    ///
    /// `String(decoding:as:)` is lossy: it maps malformed sequences onto U+FFFD
    /// and hands back a string that no longer represents the file. Rewriting
    /// from that string would silently replace the user's bytes with
    /// replacement characters — corruption of exactly the kind the
    /// never-modify rule exists to prevent (CodeRabbit on PR #531).
    private func decodeStrictly(_ bytes: Data, at target: URL) throws -> String {
        guard let text = String(data: bytes, encoding: .utf8) else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "the file isn't valid UTF-8 text, so ModelDeck can't edit it without changing bytes it doesn't understand."
            )
        }
        return text
    }

    /// - Parameter expecting: the enforcement change the CONSENT SCREEN
    ///   described. Required, with no default: a caller reaching this method
    ///   directly must still state what the user agreed to, so there is no
    ///   spelling of `apply` that skips the check (security review of PR #531,
    ///   should-fix 1).
    public func apply(
        _ edit: ConsentedConfigEdit,
        to target: URL,
        expecting: ConsentedFlipExpectation
    ) throws -> ConsentedConfigWriteOutcome {
        try requireRegularFile(target)
        sweepStaleTemporaries(besides: target)
        var attempt = 0
        while attempt < maximumAttempts {
            attempt += 1
            let baseline = try read(target)
            let document = try ConfigAPIKeysDocument.parse(decodeStrictly(baseline, at: target))
            let previousMode = try mode(of: target)
            let planned: ConfigAPIKeysEdit
            switch edit {
            case .append(let values, let origin):
                planned = try document.appending(values, origin: origin)
            case .remove(let record, let hash):
                guard ConsentedConfigWriteGuard.standardizedPath(target) == ConsentedConfigWriteGuard.standardizedPath(URL(fileURLWithPath: record.targetPath)) else {
                    throw ConsentedConfigWriteError.recordTargetMismatch(
                        recorded: record.targetPath,
                        current: ConsentedConfigWriteGuard.standardizedPath(target)
                    )
                }
                planned = try document.removing(record: record, hash: hash)
            }
            // The consent gate, re-asserted against THESE bytes. `planned` was
            // computed from the file as it is now, not as it was when the
            // prompt went up, so this is the one place that can catch the list
            // emptying or filling in the prepare→confirm window.
            let actual = ConsentedFlipExpectation(
                flipsEnforcementOn: planned.flipsEnforcementOn,
                flipsEnforcementOff: planned.flipsEnforcementOff
            )
            guard actual == expecting else {
                throw ConsentedConfigWriteError.consentedEffectChanged(
                    expected: expecting.description, actual: actual.description
                )
            }
            let payload = Data(planned.text.utf8)

            hooks.beforeCompare(attempt, target)
            // TOCTOU guard: the proxy rewrites this file on its own (recon's
            // first-boot bcrypt finding), so a mismatch here is expected
            // behaviour, not an exotic race. Abort THIS attempt and re-run
            // parse-append from the fresh bytes.
            let beforePublish = try read(target)
            guard beforePublish == baseline else { continue }

            let backup = try backups.write(
                baseline,
                at: clock(),
                forbiddenDirectories: [target.deletingLastPathComponent()]
            )
            backups.prune()

            try publish(payload, to: target, declaredAuthDirectory: document.declaredAuthDirectory)
            hooks.afterPublish(attempt, target)

            let published = try read(target)
            guard published == payload, !hooks.failVerification(attempt) else {
                try rollback(to: baseline, target: target, published: payload, backupPath: backup.path,
                             declaredAuthDirectory: document.declaredAuthDirectory)
                throw ConsentedConfigWriteError.configWriteFailed(path: target.path)
            }
            // 0600 tighten-or-refuse (should-fix 4): the publish makes the file
            // owner-only by construction, so there is no window in which the
            // appended key material is world-readable. If it somehow is not,
            // the change goes back rather than standing.
            let publishedMode = try mode(of: target)
            guard publishedMode & 0o777 == 0o600 else {
                try rollback(to: baseline, target: target, published: payload, backupPath: backup.path,
                             declaredAuthDirectory: document.declaredAuthDirectory)
                throw ConsentedConfigWriteError.permissionsTightenFailed(path: target.path)
            }

            return ConsentedConfigWriteOutcome(
                targetPath: target.path,
                backupPath: backup.path,
                attempts: attempt,
                addedEntries: planned.addedValues.count,
                removedEntries: planned.removedLineIndices.count,
                entriesAfterEdit: planned.entriesAfterEdit,
                previousMode: (previousMode & 0o777) == 0o600 ? nil : previousMode & 0o777,
                tightenedPermissions: (previousMode & 0o777) != 0o600,
                flipsEnforcementOn: planned.flipsEnforcementOn,
                flipsEnforcementOff: planned.flipsEnforcementOff,
                publishedSha256: digest(payload)
            )
        }
        throw ConsentedConfigWriteError.concurrentWriteDetected(attempts: maximumAttempts)
    }

    /// Confirms the change is actually in force: after the proxy's reload
    /// window the file must still hold exactly what we published.
    ///
    /// This is a FILE-STATE proof, deliberately. Proving it request-side would
    /// mean sending the proxy a request carrying a key, and this feature does
    /// not invent traffic to reassure itself.
    public func verifyActivation(
        target: URL,
        publishedSha256: String,
        settle: TimeInterval = defaultReloadSettleInterval,
        sleep: @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) async -> ConsentedConfigActivation {
        await sleep(settle)
        guard let bytes = try? read(target) else {
            return .superseded(reason: "the file could not be read back")
        }
        return digest(bytes) == publishedSha256 ? .live : .superseded(reason: "its contents changed after the edit")
    }

    // MARK: Effects

    /// Deletes stale staging temps left by a crash between mkstemp and rename
    /// (nit 8). Those files are 0600 but they hold the full config — client
    /// keys and the management secret — and nothing else would ever remove
    /// them.
    ///
    /// Deliberately narrow: only ModelDeck's own `.modeldeck-config.` prefix,
    /// only in the target config's own directory, and only files older than a
    /// minute, so a second ModelDeck mid-publish cannot have its temp pulled
    /// out from under it.
    private func sweepStaleTemporaries(besides target: URL) {
        let directory = target.deletingLastPathComponent()
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let cutoff = clock().addingTimeInterval(-Self.staleTemporaryAge)
        for url in entries
        where url.lastPathComponent.hasPrefix(ConsentedConfigWriteGuard.temporaryPrefix) {
            // Guarded like every other destination: a sweep is a delete, and a
            // delete outside the admitted set is the same violation as a write.
            guard (try? ConsentedConfigWriteGuard.requireConsentedConfigWrite(url, target: target)) != nil
            else { continue }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate
            guard let modified, modified < cutoff else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func read(_ url: URL) throws -> Data {
        guard let data = FileManager.default.contents(atPath: url.path) else {
            throw ConsentedConfigWriteError.configReadFailed(path: url.path)
        }
        return data
    }

    private func mode(of url: URL) throws -> UInt16 {
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            throw ConsentedConfigWriteError.configReadFailed(path: url.path)
        }
        return info.st_mode
    }

    /// Refuses anything that is not a plain file — a symlinked config would be
    /// replaced by the atomic rename, quietly detaching the user's own
    /// arrangement (or landing our bytes wherever the link pointed).
    private func requireRegularFile(_ url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            throw ConsentedConfigWriteError.configReadFailed(path: url.path)
        }
        guard (info.st_mode & S_IFMT) == S_IFREG else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "the config path is not a plain file, so ModelDeck won't replace it."
            )
        }
    }

    private func publish(_ bytes: Data, to target: URL, declaredAuthDirectory: String?) throws {
        try ConsentedConfigWriteGuard.requireConsentedConfigWrite(
            target, target: target, declaredAuthDirectory: declaredAuthDirectory
        )
        guard OwnerOnlyPublisher.publish(
            bytes, at: target, exclusive: false,
            temporaryPrefix: ConsentedConfigWriteGuard.temporaryPrefix
        ) else {
            throw ConsentedConfigWriteError.configWriteFailed(path: target.path)
        }
    }

    /// Restores THIS attempt's snapshot, and only if the file still holds
    /// exactly what we published — the pre-restore byte-compare (should-fix 3).
    /// If someone wrote again in between, restoring would clobber their change
    /// with bytes they never had; refuse and name the backup instead.
    private func rollback(
        to baseline: Data, target: URL, published: Data, backupPath: String,
        declaredAuthDirectory: String?
    ) throws {
        let current = try read(target)
        guard current == published else {
            throw ConsentedConfigWriteError.rollbackRefusedFileChanged(backupPath: backupPath)
        }
        try publish(baseline, to: target, declaredAuthDirectory: declaredAuthDirectory)
    }
}

// MARK: - Shared atomic publish (GUARDED WRITER)

/// mkstemp + rename, owner-only from birth. Its only callers are the two
/// guarded writers above; it is deliberately not a general file-writing helper,
/// and it is a named type precisely so the write-guard tripwire can enumerate
/// it alongside them.
///
/// `exclusive` publishes with `renamex_np(RENAME_EXCL)` (never clobber, for
/// backups); otherwise a plain rename replaces the target atomically, which is
/// what an edit of an existing config must do.
struct OwnerOnlyPublisher {
    static func publish(
        _ bytes: Data,
        at destination: URL,
        exclusive: Bool,
        temporaryPrefix: String
    ) -> Bool {
        let directory = destination.deletingLastPathComponent().path
        var template = Array("\(directory)/\(temporaryPrefix)XXXXXX".utf8CString)
        let fd = mkstemp(&template)
        guard fd >= 0 else { return false }
        let temporaryPath = String(
            decoding: template.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self
        )
        defer { close(fd) }
        // mkstemp creates 0600; assert it rather than assume, since every
        // caller is writing secret-bearing bytes.
        guard fchmod(fd, 0o600) == 0 else {
            unlink(temporaryPath)
            return false
        }
        let payload = [UInt8](bytes)
        var written = 0
        while written < payload.count {
            let n = payload.withUnsafeBytes {
                write(fd, $0.baseAddress!.advanced(by: written), $0.count - written)
            }
            if n > 0 { written += n; continue }
            if n < 0 && errno == EINTR { continue }
            unlink(temporaryPath)
            return false
        }
        // Durability before visibility (CodeRabbit on PR #531): rename makes
        // the new file appear atomically, but it does not push the bytes to
        // stable storage. Without this, a power loss right after the rename can
        // leave the config visible and EMPTY — the proxy would then read a
        // config with no api-keys, which is the accept-all state. F_FULLFSYNC,
        // not fsync: on APFS plain fsync only flushes to the drive's cache.
        guard fcntl(fd, F_FULLFSYNC) != -1 else {
            unlink(temporaryPath)
            return false
        }
        if exclusive {
            guard renamex_np(temporaryPath, destination.path, UInt32(RENAME_EXCL)) == 0 else {
                unlink(temporaryPath)
                return false
            }
            syncDirectory(of: destination)
            return true
        }
        guard rename(temporaryPath, destination.path) == 0 else {
            unlink(temporaryPath)
            return false
        }
        syncDirectory(of: destination)
        return true
    }

    /// Flushes the DIRECTORY entry, so the rename itself survives power loss
    /// rather than only the file's contents. Best effort: the publish already
    /// succeeded, and a directory that cannot be opened is not a reason to
    /// report a completed write as failed.
    private static func syncDirectory(of destination: URL) {
        let directory = destination.deletingLastPathComponent().path
        let fd = open(directory, O_RDONLY)
        guard fd >= 0 else { return }
        _ = fcntl(fd, F_FULLFSYNC)
        close(fd)
    }
}
