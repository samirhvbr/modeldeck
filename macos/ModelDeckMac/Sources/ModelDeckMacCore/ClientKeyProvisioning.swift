import Foundation

// Issue #520 — client-key provisioning (app-side), build item 3 of
// docs/keys-with-riders-design.md §5, under decision 0036.
//
// What this file owns: generating one ModelDeck client key per Claude
// profile, writing it to a per-profile Keychain item, and building the
// hash→profile report the daemon stores as `client_key_map`.
//
// Three properties are load-bearing and every one of them is asserted by a
// test in Tests/ModelDeckMacCoreTests/Issue520ClientKeyProvisioningTests.swift:
//
//  1. NO SECRET IN argv (design §3.5). The item is created by feeding the
//     command to `/usr/bin/security -i` over stdin; `arguments` for that
//     invocation is exactly ["-i"]. A process listing can never show a key.
//  2. NO GUI PROMPT, EVER (recon V5, docs/research/keys-riders-recon-v1-v5.md).
//     Items created via SecItemAdd get an ACL that does not include
//     /usr/bin/security, so the shell helper's read raises a SecurityAgent
//     dialog — in a headless child that is a hang, which is the exact #277
//     failure the helper exists to prevent. The shipping create path is
//     therefore the stdin-fed CLI with `-T /usr/bin/security`, and every
//     provisioning verifies the read back through /usr/bin/security under a
//     hard deadline with NO retry. A read that does not answer is an honest
//     failure (`keychainReadNotPromptFree`), never a silent success.
//  3. NO INJECTION (design §2.1/§3.5). Every value interpolated into a
//     command line is charset-validated first: the slug is the profile's
//     stable machine id (`[a-z0-9-]`), the key is our own base64url
//     (`[A-Za-z0-9_-]`), and the optional keychain path is a restricted file
//     path. A value that fails its charset refuses the operation rather than
//     being escaped — there is no escaping code path to get wrong.
//
// These are ModelDeck-generated LOCAL PROXY CLIENT KEYS, not provider
// credentials. Nothing here reads, writes, copies, or is aware of an OAuth
// token or an auth file (decisions 0006/0016 are about that material and are
// untouched).

// MARK: - Profiles and slugs

/// A key-enabled Claude profile, as the provisioner sees it.
///
/// `id` is the profile's **stable machine identifier** (the daemon's account
/// id) and is the only thing that becomes a slug. `label` is free text: it
/// reaches SQLite and the UI, and it never enters a command string.
public struct ClientKeyProfile: Equatable, Sendable {
    public var id: String
    public var label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// Charset gates. Each is an allowlist; anything else refuses.
public enum ClientKeyCharset {
    /// Profile slugs: the design's `[a-z0-9-]` (the daemon mints account ids
    /// with `crypto.randomUUID()`, a strict subset). Bounded so a hostile or
    /// corrupt id cannot produce an unbounded service name.
    public static let slugMaximumLength = 64
    /// Generated keys: base64url, unpadded.
    public static let keyMaximumLength = 128
    /// Scratch-keychain paths (tests only in practice; production passes nil).
    public static let keychainPathMaximumLength = 1024

    public static func isValidSlug(_ value: String) -> Bool {
        isBounded(value, max: slugMaximumLength)
            && value.allSatisfy { $0.isASCII && ($0.isLowercaseLatinLetter || $0.isASCIIDigit || $0 == "-") }
    }

    public static func isValidGeneratedKey(_ value: String) -> Bool {
        isBounded(value, max: keyMaximumLength)
            && value.allSatisfy { $0.isASCII && ($0.isLatinLetter || $0.isASCIIDigit || $0 == "-" || $0 == "_") }
    }

    public static func isValidKeychainPath(_ value: String) -> Bool {
        isBounded(value, max: keychainPathMaximumLength)
            && value.allSatisfy {
                $0.isASCII && ($0.isLatinLetter || $0.isASCIIDigit || "-_./".contains($0))
            }
    }

    private static func isBounded(_ value: String, max: Int) -> Bool {
        !value.isEmpty && value.count <= max
    }
}

private extension Character {
    var isASCIIDigit: Bool { self >= "0" && self <= "9" }
    var isLowercaseLatinLetter: Bool { self >= "a" && self <= "z" }
    var isLatinLetter: Bool { isLowercaseLatinLetter || (self >= "A" && self <= "Z") }
}

// MARK: - Errors

/// Provisioning failures. **No case carries key material** — services, slugs,
/// labels, and statuses only. `security` stderr is never surfaced either: it
/// can echo a command line back.
public enum ClientKeyProvisioningError: Error, Equatable, Sendable {
    /// The profile's stable id is not a usable slug (design §2.1's charset).
    case invalidSlug(profileID: String)
    /// Two key-enabled profiles carry the same label (design §2.2). Receipts
    /// store the label only, so a collision would produce indistinguishable
    /// rows — refused at provisioning, never disambiguated at read time.
    case duplicateLabel(String)
    /// The same profile appeared twice in one full-state provisioning.
    case duplicateProfile(profileID: String)
    /// A service name that is not `cli-proxy-api-client.<valid slug>`. Refused
    /// at the store layer so no caller can route an unchecked string into a
    /// command line.
    case invalidService(String)
    /// A report older than the newest one this app has built was handed to
    /// `send`. Resending it would replay a superseded mapping.
    case supersededReport(reportGeneration: Int, currentGeneration: Int)
    case keyGenerationFailed(status: Int32)
    /// Self-check: a generated key that is not base64url would be about to
    /// enter a command line. Structurally impossible; refused anyway.
    case generatedKeyRejected
    case invalidKeychainPath
    case keychainCommandFailed(service: String, operation: String, status: Int32)
    /// The item was written but reading it back through /usr/bin/security did
    /// not answer within the deadline — the recon-V5 prompting-ACL state. The
    /// read is NOT retried; provisioning fails honestly.
    case keychainReadNotPromptFree(service: String)
    /// The read-back returned something other than what we just wrote.
    case keychainReadBackMismatch(service: String)
    /// Duplicate cleanup did not converge inside its bound — refuse rather
    /// than loop against the Keychain forever.
    case duplicateCleanupExceeded(service: String)
    /// Refused before it could reach the report: the daemon must never hold
    /// the hash of the empty string, because a keyless request's `api_key` is
    /// `""` (recon V1) and would otherwise attribute to a real profile.
    case emptyKeyHashRejected
}

// MARK: - Seams

public struct SecurityCommandResult: Equatable, Sendable {
    public var status: Int32
    public var output: String

    public init(status: Int32, output: String) {
        self.status = status
        self.output = output
    }

    /// The synthetic status a runner reports when the tool could not be
    /// launched or did not finish inside its deadline. A *read* that ends
    /// this way is treated as the prompting-ACL state, never retried.
    public static let didNotAnswer: Int32 = 127
}

/// The one door to `/usr/bin/security`. Kept narrow on purpose: tests fake it
/// and assert, per invocation, that no secret appears in `arguments`.
public protocol SecurityCommandRunning: Sendable {
    func run(arguments: [String], stdin: String?, deadline: TimeInterval) async -> SecurityCommandResult
}

/// Where the app's monotonic report generation lives across launches
/// (design §2.1: the daemon rejects a report older than the last one it
/// applied, so replay or out-of-order delivery can never resurrect a rotated
/// key or a removed profile).
public protocol ClientKeyGenerationStoring: Sendable {
    func lastGeneration() -> Int
    /// Persists and returns `lastGeneration() + 1`. Must never go backwards.
    func nextGeneration() -> Int
    /// Raises the persisted generation to at least `generation`, never lowers
    /// it. The recovery path for the one way this counter can desync: app
    /// preferences wiped (or a fresh app against an existing daemon DB) would
    /// restart at 1, and the daemon would reject every report from then on —
    /// attribution silently dead. The daemon's rejection states the generation
    /// it holds, so the app adopts it and moves past it.
    func adopt(atLeast generation: Int)
}

/// What the daemon says it did with a report.
public struct ClientKeyReportAck: Equatable, Sendable {
    /// False when the daemon rejected the report as stale — nothing changed.
    public var applied: Bool
    /// The generation the daemon holds after the call.
    public var generation: Int

    public init(applied: Bool, generation: Int) {
        self.applied = applied
        self.generation = generation
    }
}

/// The app→daemon report channel (`POST /api/client-keys/report`).
public protocol ClientKeyReporting: Sendable {
    @discardableResult
    func reportClientKeys(_ report: ClientKeyReport) async throws -> ClientKeyReportAck
}

// MARK: - Report wire shape

public struct ClientKeyReportEntry: Codable, Equatable, Sendable {
    public var keySha256: String
    public var profileID: String
    public var profileLabel: String

    public init(keySha256: String, profileID: String, profileLabel: String) {
        self.keySha256 = keySha256
        self.profileID = profileID
        self.profileLabel = profileLabel
    }

    enum CodingKeys: String, CodingKey {
        case keySha256 = "key_sha256"
        case profileID = "profile_id"
        case profileLabel = "profile_label"
    }
}

/// A complete statement of every key-enabled profile, not a delta. The daemon
/// applies it in one transaction as a full replacement: entries absent here
/// are deleted, so a rotation or a profile removal takes effect at the next
/// report and a removed key thereafter resolves to honest NULL.
public struct ClientKeyReport: Codable, Equatable, Sendable {
    public var generation: Int
    public var entries: [ClientKeyReportEntry]

    public init(generation: Int, entries: [ClientKeyReportEntry]) {
        self.generation = generation
        self.entries = entries
    }
}

// MARK: - Keychain store

/// Reads and writes the per-profile client-key items.
///
/// Service naming (design §2.1, security-review blocker 1): per-profile items
/// live under `cli-proxy-api-client.<slug>` and the bare `cli-proxy-api-client`
/// stays EXCLUSIVELY the legacy shared item. `find-generic-password -s` without
/// `-a` returns the first match, so if per-profile items shared the legacy
/// service a stale shell — the pinned env file is only rewritten at activation
/// — could fetch another profile's key and silently mis-attribute. The service
/// name disambiguates alone; no `-a` flag is needed at read time.
public struct KeychainClientKeyStore: Sendable {
    public static let legacySharedService = "cli-proxy-api-client"
    public static let servicePrefix = "cli-proxy-api-client."
    public static let securityBinary = "/usr/bin/security"
    /// The reader we trust on the item at creation. This single argument is
    /// what makes the shell helper's read prompt-free (recon V5).
    public static let trustedReader = "/usr/bin/security"
    /// Duplicate cleanup deletes one item per pass; bounded so a Keychain that
    /// never converges refuses instead of spinning.
    public static let maximumCleanupPasses = 64
    /// `security`'s errSecItemNotFound exit status — the ONLY delete failure
    /// that means "there is nothing left under this service".
    public static let itemNotFoundStatus: Int32 = 44

    private let runner: any SecurityCommandRunning
    /// nil = the user's default keychain (production). Tests pass a scratch
    /// keychain path so no probe can ever touch the login Keychain.
    private let keychainPath: String?
    private let writeDeadline: TimeInterval
    private let readDeadline: TimeInterval

    public init(
        runner: any SecurityCommandRunning,
        keychainPath: String? = nil,
        writeDeadline: TimeInterval = 10,
        readDeadline: TimeInterval = 10
    ) {
        self.runner = runner
        self.keychainPath = keychainPath
        self.writeDeadline = writeDeadline
        self.readDeadline = readDeadline
    }

    /// The per-profile service name for a validated slug.
    public static func service(forSlug slug: String) -> String {
        servicePrefix + slug
    }

    /// A service name this store is allowed to touch: the per-profile prefix
    /// followed by a valid slug, and nothing else.
    ///
    /// The gate lives here rather than only in the provisioner because every
    /// mutating entry point is public — a caller reaching the store directly
    /// must not be able to hand `addCommand` a service string that escapes the
    /// command line. It also makes the legacy shared item structurally
    /// unreachable: bare `cli-proxy-api-client` has no prefix, so this store
    /// can never write or delete the user-created item (D6).
    public static func isManagedService(_ service: String) -> Bool {
        guard service.hasPrefix(servicePrefix) else { return false }
        return ClientKeyCharset.isValidSlug(String(service.dropFirst(servicePrefix.count)))
    }

    private static func requireManagedService(_ service: String) throws {
        guard isManagedService(service) else {
            throw ClientKeyProvisioningError.invalidService(service)
        }
    }

    /// Removes every item under `service`, one per pass, until the Keychain
    /// reports none left. This is the duplicate half of the deterministic
    /// create-or-replace (design §2.1, CWE-345): duplicates cannot accumulate,
    /// and a re-provision always converges on exactly one item.
    @discardableResult
    public func removeAll(service: String) async throws -> Int {
        try Self.requireManagedService(service)
        var removed = 0
        while removed < Self.maximumCleanupPasses {
            var arguments = ["delete-generic-password", "-s", service]
            try appendKeychain(to: &arguments)
            let result = await runner.run(arguments: arguments, stdin: nil, deadline: writeDeadline)
            if result.status == 0 {
                removed += 1
                continue
            }
            // ONLY "item not found" is convergence. Every other failure — a
            // locked keychain, a denied ACL, a runner that never answered —
            // means items may still be there, and the retirement path has no
            // read-back to catch it: reporting a profile retired while its key
            // still works would be a lie about a live credential.
            guard result.status == Self.itemNotFoundStatus else {
                throw ClientKeyProvisioningError.keychainCommandFailed(
                    service: service, operation: "delete", status: result.status
                )
            }
            return removed
        }
        throw ClientKeyProvisioningError.duplicateCleanupExceeded(service: service)
    }

    /// Creates the item by feeding the command to `security -i` over stdin.
    /// The key never appears in `argv` (design §3.5).
    public func add(service: String, key: String) async throws {
        try Self.requireManagedService(service)
        guard ClientKeyCharset.isValidGeneratedKey(key) else {
            throw ClientKeyProvisioningError.generatedKeyRejected
        }
        let command = try addCommand(service: service, key: key)
        let result = await runner.run(arguments: ["-i"], stdin: command, deadline: writeDeadline)
        guard result.status == 0 else {
            throw ClientKeyProvisioningError.keychainCommandFailed(
                service: service, operation: "add", status: result.status
            )
        }
    }

    /// The exact stdin line fed to `security -i`. `-T /usr/bin/security` is
    /// the whole point: it trusts the shell helper's reader on this item at
    /// creation time, which is what recon V5 proved makes the read
    /// prompt-free. Values are charset-validated above, so the quoting here
    /// is belt-and-braces over an allowlist, not an escaping scheme.
    func addCommand(service: String, key: String) throws -> String {
        // Gated at the interpolation site too, not only at `add`: this is the
        // one place a service string becomes command text.
        try Self.requireManagedService(service)
        guard ClientKeyCharset.isValidGeneratedKey(key) else {
            throw ClientKeyProvisioningError.generatedKeyRejected
        }
        var command = #"add-generic-password -s "\#(service)" -a "" -w "\#(key)" -T \#(Self.trustedReader)"#
        if let keychainPath {
            guard ClientKeyCharset.isValidKeychainPath(keychainPath) else {
                throw ClientKeyProvisioningError.invalidKeychainPath
            }
            command += " \"\(keychainPath)\""
        }
        return command + "\n"
    }

    /// Reads the item back the way the shell helper will: absolute
    /// `/usr/bin/security`, service name only, hard deadline, NO retry.
    ///
    /// A read that does not answer means a SecurityAgent dialog is waiting on
    /// a screen the helper's headless child does not have. That is the #277
    /// hang, and it surfaces as `keychainReadNotPromptFree` rather than being
    /// retried into a second dialog (the recorded recon probe-design incident).
    public func readBack(service: String) async throws -> String {
        try Self.requireManagedService(service)
        var arguments = ["find-generic-password", "-s", service, "-w"]
        try appendKeychain(to: &arguments)
        let result = await runner.run(arguments: arguments, stdin: nil, deadline: readDeadline)
        if result.status == SecurityCommandResult.didNotAnswer {
            throw ClientKeyProvisioningError.keychainReadNotPromptFree(service: service)
        }
        guard result.status == 0 else {
            throw ClientKeyProvisioningError.keychainCommandFailed(
                service: service, operation: "read", status: result.status
            )
        }
        return result.output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Deterministic create-or-replace: remove every existing item under the
    /// service, write exactly one, then prove it reads back prompt-free.
    /// On rotation the old value dies with the replaced item.
    @discardableResult
    public func replace(service: String, key: String) async throws -> Int {
        try Self.requireManagedService(service)
        let removed = try await removeAll(service: service)
        try await add(service: service, key: key)
        let readBack = try await readBack(service: service)
        guard readBack == key else {
            throw ClientKeyProvisioningError.keychainReadBackMismatch(service: service)
        }
        return removed
    }

    private func appendKeychain(to arguments: inout [String]) throws {
        guard let keychainPath else { return }
        guard ClientKeyCharset.isValidKeychainPath(keychainPath) else {
            throw ClientKeyProvisioningError.invalidKeychainPath
        }
        arguments.append(keychainPath)
    }
}

// MARK: - Provisioner

/// What one full-state provisioning did, with **no key material in it**: the
/// raw keys never leave `provision(_:)`. They go to the Keychain; their
/// hashes go to the daemon.
public struct ClientKeyProvisioningOutcome: Equatable, Sendable {
    public struct Provisioned: Equatable, Sendable {
        public var profileID: String
        public var label: String
        public var slug: String
        public var service: String
        public var keySha256: String
        /// Pre-existing items removed under this service before the write —
        /// >1 means duplicates had accumulated and were cleaned up.
        public var duplicatesRemoved: Int
    }

    public var provisioned: [Provisioned]
    /// Services emptied because their profile is no longer key-enabled
    /// (rotation/removal cleanup, design §2.1).
    public var retiredServices: [String]
    public var report: ClientKeyReport
}

/// Generates keys, writes per-profile Keychain items, and builds the report.
public struct ClientKeyProvisioner: Sendable {
    private let store: KeychainClientKeyStore
    private let generateKey: @Sendable () throws -> String
    private let generations: any ClientKeyGenerationStoring
    private let hash: @Sendable (String) -> String

    public init(
        store: KeychainClientKeyStore,
        generations: any ClientKeyGenerationStoring,
        generateKey: @escaping @Sendable () throws -> String = ClientKeyGenerator.generate,
        hash: @escaping @Sendable (String) -> String = ClientKeyGenerator.sha256Hex
    ) {
        self.store = store
        self.generations = generations
        self.generateKey = generateKey
        self.hash = hash
    }

    /// Provisions the complete set of key-enabled profiles.
    ///
    /// Fail-closed order: every refusal that can be decided from the inputs
    /// (bad slug, duplicate profile, duplicate label) happens BEFORE the first
    /// Keychain write, so a refused operation leaves the Keychain untouched.
    ///
    /// If a write fails partway through, the profiles already written hold
    /// fresh keys that no report mentions. That state is honest, not corrupt:
    /// an unreported key resolves to NULL (design §2.2), and the next
    /// successful full-state provisioning re-reports everything. Nothing is
    /// half-applied on the daemon, because the report is only built and sent
    /// once every write has succeeded.
    ///
    /// - Parameter previouslyProvisionedSlugs: slugs from the provisioning
    ///   record. Any slug not in the new set has its item removed — the
    ///   rotation/removal cleanup half of §2.1.
    public func provision(
        profiles: [ClientKeyProfile],
        previouslyProvisionedSlugs: Set<String> = []
    ) async throws -> ClientKeyProvisioningOutcome {
        // --- Preflight refusals, before any write ---
        var seenIDs = Set<String>()
        var seenLabels = Set<String>()
        for profile in profiles {
            guard ClientKeyCharset.isValidSlug(profile.id) else {
                throw ClientKeyProvisioningError.invalidSlug(profileID: profile.id)
            }
            guard seenIDs.insert(profile.id).inserted else {
                throw ClientKeyProvisioningError.duplicateProfile(profileID: profile.id)
            }
            // §2.2: rows store the label only, so ambiguity among key-enabled
            // profiles is refused here with an honest rename prompt upstream.
            // Compared case- and whitespace-insensitively: "Work" and "work "
            // are indistinguishable on a receipt.
            let normalized = Self.normalizedLabel(profile.label)
            guard seenLabels.insert(normalized).inserted else {
                throw ClientKeyProvisioningError.duplicateLabel(profile.label)
            }
        }

        // --- Writes ---
        var provisioned: [ClientKeyProvisioningOutcome.Provisioned] = []
        var entries: [ClientKeyReportEntry] = []
        for profile in profiles {
            let service = KeychainClientKeyStore.service(forSlug: profile.id)
            let key = try generateKey()
            guard ClientKeyCharset.isValidGeneratedKey(key) else {
                throw ClientKeyProvisioningError.generatedKeyRejected
            }
            let removed = try await store.replace(service: service, key: key)
            let digest = hash(key)
            guard digest != ClientKeyGenerator.sha256OfEmptyString else {
                throw ClientKeyProvisioningError.emptyKeyHashRejected
            }
            provisioned.append(.init(
                profileID: profile.id,
                label: profile.label,
                slug: profile.id,
                service: service,
                keySha256: digest,
                duplicatesRemoved: removed
            ))
            entries.append(.init(keySha256: digest, profileID: profile.id, profileLabel: profile.label))
        }

        // --- Rotation / removal cleanup ---
        var retired: [String] = []
        for slug in previouslyProvisionedSlugs.subtracting(seenIDs).sorted() {
            guard ClientKeyCharset.isValidSlug(slug) else {
                throw ClientKeyProvisioningError.invalidSlug(profileID: slug)
            }
            let service = KeychainClientKeyStore.service(forSlug: slug)
            try await store.removeAll(service: service)
            retired.append(service)
        }

        return ClientKeyProvisioningOutcome(
            provisioned: provisioned,
            retiredServices: retired,
            report: ClientKeyReport(generation: generations.nextGeneration(), entries: entries)
        )
    }

    /// Sends a report and, if the daemon rejects it as stale, adopts the
    /// daemon's generation and resends exactly once.
    ///
    /// **Only the newest report this app has built may be sent.** The
    /// generation store is the single monotonic authority, so a report whose
    /// generation is not the current one is by definition superseded — a
    /// cached or replayed outcome — and is refused before anything is sent.
    /// Without that gate the resync path is a weapon: adopt-then-bump would
    /// carry a stale mapping *past* the daemon's generation gate and
    /// resurrect exactly the rotated hashes the gate exists to bury.
    ///
    /// The retry is bounded to one: a second rejection is a real disagreement
    /// to surface, not something to loop on. It carries the same entries,
    /// which the guard has just proven are the current provisioned state.
    ///
    /// **Recorded consequence — two apps, one daemon.** Nothing serializes
    /// two ModelDeck instances reporting to the same daemon; the mapping is
    /// last-writer-wins, so the instance that reports second overwrites the
    /// first's full state, and any profile only the first knows about
    /// attributes to honest NULL until it reports again.
    @discardableResult
    public func send(
        _ report: ClientKeyReport,
        via reporter: any ClientKeyReporting
    ) async throws -> ClientKeyReportAck {
        let current = generations.lastGeneration()
        guard report.generation == current else {
            throw ClientKeyProvisioningError.supersededReport(
                reportGeneration: report.generation, currentGeneration: current
            )
        }
        let first = try await reporter.reportClientKeys(report)
        guard !first.applied else { return first }
        generations.adopt(atLeast: first.generation)
        let retry = ClientKeyReport(generation: generations.nextGeneration(), entries: report.entries)
        return try await reporter.reportClientKeys(retry)
    }

    static func normalizedLabel(_ label: String) -> String {
        label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
