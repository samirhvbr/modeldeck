import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #520 — client-key provisioning (app-side), build item 3 of
// docs/keys-with-riders-design.md §5. Auth-adjacent: these are the tripwires
// the never-compromise #4 rule requires, and the design's four named test
// cases (duplicate items, replacement, rotation cleanup, report
// replay/rotation/removal) each have a suite section below.
//
// SAFETY CONTRACT. Nothing here touches the live login Keychain or any
// existing ModelDeck / cli-proxy-api item. Every test but one runs against an
// in-memory fake `security`. The one that runs the real binary
// (`V5 re-proof`) creates its own scratch keychain under a temp dir, passes
// that path explicitly to every command, never calls `list-keychains -s`, and
// deletes it afterwards. No probe here can raise a SecurityAgent dialog: the
// create path trusts `/usr/bin/security` at creation (`-T`) exactly as recon
// V5 proved prompt-free, reads run under a hard deadline, and a read that
// does not answer is failed, never retried.

// MARK: - Fake /usr/bin/security

/// An in-memory stand-in for the Keychain, driven through the same seam the
/// production code uses. It records every invocation so tests can assert the
/// no-argv-leak property directly.
private final class FakeSecurity: SecurityCommandRunning, @unchecked Sendable {
    struct Invocation: Sendable {
        var arguments: [String]
        var stdin: String?
    }

    private let lock = NSLock()
    private var items: [String: [String]] = [:]
    private(set) var invocations: [Invocation] = []
    /// Services whose read should hang, i.e. report `didNotAnswer` — the
    /// SecurityAgent-dialog state recon V5 observed for SecItemAdd items.
    var readsThatNeverAnswer: Set<String> = []
    var addFailureStatus: Int32?
    /// A non-zero, non-44 delete status — a locked keychain or a denied ACL,
    /// which is NOT "there is nothing left here".
    var deleteFailureStatus: Int32?

    init(seed: [String: [String]] = [:]) {
        items = seed
    }

    func values(forService service: String) -> [String] {
        lock.withLock { items[service] ?? [] }
    }

    var addInvocations: [Invocation] {
        lock.withLock { invocations.filter { $0.stdin?.contains("add-generic-password") == true } }
    }

    func run(arguments: [String], stdin: String?, deadline: TimeInterval) async -> SecurityCommandResult {
        // Synchronous under the hood: NSLock cannot be taken across an await.
        answer(arguments: arguments, stdin: stdin)
    }

    private func answer(arguments: [String], stdin: String?) -> SecurityCommandResult {
        lock.withLock {
            invocations.append(Invocation(arguments: arguments, stdin: stdin))

            if arguments.first == "-i", let command = stdin {
                guard command.contains("add-generic-password") else { return .init(status: 1, output: "") }
                if let addFailureStatus { return .init(status: addFailureStatus, output: "") }
                guard let service = Self.quotedValue(after: "-s", in: command),
                      let value = Self.quotedValue(after: "-w", in: command) else {
                    return .init(status: 1, output: "")
                }
                items[service, default: []].append(value)
                return .init(status: 0, output: "")
            }

            guard let verb = arguments.first, arguments.count >= 3, arguments[1] == "-s" else {
                return .init(status: 1, output: "")
            }
            let service = arguments[2]

            switch verb {
            case "delete-generic-password":
                if let deleteFailureStatus { return .init(status: deleteFailureStatus, output: "") }
                guard var existing = items[service], !existing.isEmpty else {
                    return .init(status: 44, output: "") // security's "item not found"
                }
                existing.removeFirst()
                items[service] = existing
                return .init(status: 0, output: "")
            case "find-generic-password":
                if readsThatNeverAnswer.contains(service) {
                    return .init(status: SecurityCommandResult.didNotAnswer, output: "")
                }
                // `-s` without `-a` returns the FIRST match — the blocker-1
                // behaviour the per-profile service name exists to work around.
                guard let first = items[service]?.first else { return .init(status: 44, output: "") }
                return .init(status: 0, output: first + "\n")
            default:
                return .init(status: 1, output: "")
            }
        }
    }

    /// Extracts `"value"` following `flag` in a `security -i` command line.
    static func quotedValue(after flag: String, in command: String) -> String? {
        guard let flagRange = command.range(of: "\(flag) \"") else { return nil }
        let rest = command[flagRange.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[rest.startIndex..<end])
    }
}

private final class FakeGenerationStore: ClientKeyGenerationStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int

    init(starting: Int = 0) { value = starting }

    func lastGeneration() -> Int { lock.withLock { value } }

    func nextGeneration() -> Int {
        lock.withLock {
            value += 1
            return value
        }
    }

    func adopt(atLeast generation: Int) {
        lock.withLock { value = max(value, generation) }
    }
}

/// Records reports and can reject the first one as stale, the way a daemon
/// holding a higher generation does.
private final class FakeReporter: ClientKeyReporting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var reports: [ClientKeyReport] = []
    private var rejectBelow: Int

    init(rejectingGenerationsBelow: Int = 0) {
        rejectBelow = rejectingGenerationsBelow
    }

    func reportClientKeys(_ report: ClientKeyReport) async throws -> ClientKeyReportAck {
        lock.withLock {
            reports.append(report)
            if report.generation <= rejectBelow {
                return ClientKeyReportAck(applied: false, generation: rejectBelow)
            }
            return ClientKeyReportAck(applied: true, generation: report.generation)
        }
    }
}

/// Deterministic, base64url-shaped placeholder keys so assertions can name
/// exact values. Never real key material: these only ever reach the fake.
private final class SequencedKeys: @unchecked Sendable {
    private let lock = NSLock()
    private var index = 0

    var generate: @Sendable () throws -> String {
        { [self] in
            lock.withLock {
                index += 1
                return "md520-placeholder-key-\(index)"
            }
        }
    }
}

private let profileA = ClientKeyProfile(id: "0f3a1c22-aaaa-4444-8888-111111111111", label: "Work")
private let profileB = ClientKeyProfile(id: "7b2d9e01-bbbb-4444-8888-222222222222", label: "Personal")

private func serviceA() -> String { KeychainClientKeyStore.service(forSlug: profileA.id) }
private func serviceB() -> String { KeychainClientKeyStore.service(forSlug: profileB.id) }

private func makeProvisioner(
    _ security: FakeSecurity,
    generations: ClientKeyGenerationStoring = FakeGenerationStore(),
    keys: SequencedKeys = SequencedKeys()
) -> ClientKeyProvisioner {
    ClientKeyProvisioner(
        store: KeychainClientKeyStore(runner: security),
        generations: generations,
        generateKey: keys.generate
    )
}

// MARK: - Named test case 1: duplicate items

@Suite("Issue #520 — duplicate items")
struct Issue520DuplicateItemTests {
    @Test("every pre-existing item under the service is removed before the new one is written")
    func duplicatesAreCleanedUp() async throws {
        let security = FakeSecurity(seed: [
            serviceA(): ["md520-stale-a", "md520-stale-b", "md520-stale-c"]
        ])
        let outcome = try await makeProvisioner(security).provision(profiles: [profileA])

        #expect(outcome.provisioned.first?.duplicatesRemoved == 3)
        // Converged on exactly one item, and it is the key we just wrote.
        #expect(security.values(forService: serviceA()) == ["md520-placeholder-key-1"])
    }

    @Test("cleanup that never converges refuses instead of looping against the Keychain")
    func cleanupIsBounded() async throws {
        let stale = (0..<(KeychainClientKeyStore.maximumCleanupPasses + 5)).map { "md520-stale-\($0)" }
        let security = FakeSecurity(seed: [serviceA(): stale])
        await #expect(throws: ClientKeyProvisioningError.duplicateCleanupExceeded(service: serviceA())) {
            _ = try await makeProvisioner(security).provision(profiles: [profileA])
        }
    }

    @Test("a delete that never answers is not mistaken for convergence")
    func hangingDeleteIsNotConvergence() async throws {
        // A `didNotAnswer` status means the tool was killed at its deadline;
        // reading that as "no more items" would leave duplicates in place.
        let store = KeychainClientKeyStore(runner: HangingRunner())
        await #expect(throws: ClientKeyProvisioningError.keychainCommandFailed(
            service: serviceA(), operation: "delete", status: SecurityCommandResult.didNotAnswer
        )) {
            _ = try await store.removeAll(service: serviceA())
        }
    }

    @Test("only 'item not found' is convergence — a failing delete never reports retired")
    func onlyItemNotFoundIsConvergence() async throws {
        // Security review should-fix 3. The retirement path has NO read-back
        // to catch this: a locked keychain or a denied ACL that was read as
        // convergence would report a profile retired while its key still
        // works — a lie about a live credential.
        for status: Int32 in [1, 36, 45, 51, 128] {
            let security = FakeSecurity(seed: [serviceA(): ["md520-stale-a"]])
            security.deleteFailureStatus = status
            let store = KeychainClientKeyStore(runner: security)
            await #expect(throws: ClientKeyProvisioningError.keychainCommandFailed(
                service: serviceA(), operation: "delete", status: status
            )) {
                _ = try await store.removeAll(service: serviceA())
            }
        }

        // The retirement path itself refuses rather than claiming success.
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        _ = try await provisioner.provision(profiles: [profileA, profileB])
        security.deleteFailureStatus = 36 // errSecInteractionNotAllowed-ish
        await #expect(throws: ClientKeyProvisioningError.self) {
            _ = try await provisioner.provision(
                profiles: [profileA],
                previouslyProvisionedSlugs: [profileA.id, profileB.id]
            )
        }
    }

    @Test("status 44 alone means the service is empty")
    func itemNotFoundConverges() async throws {
        let security = FakeSecurity()
        let store = KeychainClientKeyStore(runner: security)
        let removed = try await store.removeAll(service: serviceA())
        #expect(removed == 0)
        #expect(KeychainClientKeyStore.itemNotFoundStatus == 44)
    }
}

private struct HangingRunner: SecurityCommandRunning {
    func run(arguments: [String], stdin: String?, deadline: TimeInterval) async -> SecurityCommandResult {
        SecurityCommandResult(status: SecurityCommandResult.didNotAnswer, output: "")
    }
}

// MARK: - Named test case 2: replacement

@Suite("Issue #520 — replacement")
struct Issue520ReplacementTests {
    @Test("re-provisioning converges on exactly one item holding the current key")
    func reprovisionReplaces() async throws {
        let security = FakeSecurity()
        let keys = SequencedKeys()
        let provisioner = makeProvisioner(security, keys: keys)

        _ = try await provisioner.provision(profiles: [profileA])
        #expect(security.values(forService: serviceA()) == ["md520-placeholder-key-1"])

        let second = try await provisioner.provision(profiles: [profileA])
        #expect(security.values(forService: serviceA()) == ["md520-placeholder-key-2"])
        #expect(second.provisioned.first?.duplicatesRemoved == 1)
    }

    @Test("the write is verified by reading back through /usr/bin/security")
    func readBackVerified() async throws {
        let security = FakeSecurity()
        _ = try await makeProvisioner(security).provision(profiles: [profileA])
        let reads = security.invocations.filter { $0.arguments.first == "find-generic-password" }
        #expect(reads.count == 1)
        // Service name only: `-a` is deliberately absent (design §2.1).
        #expect(reads.first?.arguments == ["find-generic-password", "-s", serviceA(), "-w"])
    }

    @Test("a failed add refuses rather than reporting a hash for a key nobody can read")
    func failedAddRefuses() async throws {
        let security = FakeSecurity()
        security.addFailureStatus = 45
        await #expect(throws: ClientKeyProvisioningError.self) {
            _ = try await makeProvisioner(security).provision(profiles: [profileA])
        }
    }
}

// MARK: - Named test case 3: rotation cleanup

@Suite("Issue #520 — rotation cleanup")
struct Issue520RotationCleanupTests {
    @Test("rotation destroys the old value with the replaced item")
    func rotationDropsOldValue() async throws {
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        _ = try await provisioner.provision(profiles: [profileA])
        _ = try await provisioner.provision(profiles: [profileA])
        #expect(!security.values(forService: serviceA()).contains("md520-placeholder-key-1"))
    }

    @Test("a profile that is no longer key-enabled has its item removed")
    func retiredProfileItemRemoved() async throws {
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        _ = try await provisioner.provision(profiles: [profileA, profileB])
        #expect(security.values(forService: serviceB()).count == 1)

        let outcome = try await provisioner.provision(
            profiles: [profileA],
            previouslyProvisionedSlugs: [profileA.id, profileB.id]
        )
        #expect(outcome.retiredServices == [serviceB()])
        #expect(security.values(forService: serviceB()).isEmpty)
    }

    @Test("cleanup never touches the legacy shared item")
    func legacySharedItemUntouched() async throws {
        // D6: the shared `cli-proxy-api-client` item is user-created; removal
        // is offered, never automatic.
        let security = FakeSecurity(seed: [
            KeychainClientKeyStore.legacySharedService: ["md520-legacy-placeholder"]
        ])
        let provisioner = makeProvisioner(security)
        _ = try await provisioner.provision(
            profiles: [profileA],
            previouslyProvisionedSlugs: [profileA.id, profileB.id]
        )
        #expect(security.values(forService: KeychainClientKeyStore.legacySharedService)
            == ["md520-legacy-placeholder"])
        let touchedLegacy = security.invocations.contains { invocation in
            invocation.arguments.contains(KeychainClientKeyStore.legacySharedService)
                || invocation.stdin?.contains("\"\(KeychainClientKeyStore.legacySharedService)\"") == true
        }
        #expect(!touchedLegacy)
    }
}

// MARK: - Named test case 4: report replay / rotation / removal

@Suite("Issue #520 — report replay, rotation, removal")
struct Issue520ReportTests {
    @Test("report replay — every report carries a strictly greater generation")
    func generationIsMonotonic() async throws {
        let security = FakeSecurity()
        let generations = FakeGenerationStore()
        let provisioner = makeProvisioner(security, generations: generations)

        var seen: [Int] = []
        for _ in 0..<3 {
            seen.append(try await provisioner.provision(profiles: [profileA]).report.generation)
        }
        #expect(seen == [1, 2, 3])
        #expect(zip(seen, seen.dropFirst()).allSatisfy { $0 < $1 })
    }

    @Test("report replay — a restarted app never reissues a generation the daemon applied")
    func generationSurvivesRestart() async throws {
        let suiteName = "modeldeck.tests.clientkeys.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let key = "modeldeck.tests.clientKeyGeneration"

        let first = UserDefaultsClientKeyGenerationStore(defaults: defaults, key: key)
        #expect(first.nextGeneration() == 1)
        #expect(first.nextGeneration() == 2)
        // A fresh store is what a relaunched app builds.
        let afterRestart = UserDefaultsClientKeyGenerationStore(defaults: defaults, key: key)
        #expect(afterRestart.lastGeneration() == 2)
        #expect(afterRestart.nextGeneration() == 3)
    }

    @Test("report rotation — the rotated key's hash replaces its predecessor's")
    func rotationReplacesHashInReport() async throws {
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        let before = try await provisioner.provision(profiles: [profileA])
        let after = try await provisioner.provision(profiles: [profileA])

        let oldHash = try #require(before.report.entries.first?.keySha256)
        let newHash = try #require(after.report.entries.first?.keySha256)
        #expect(oldHash != newHash)
        // Full-state: the old hash is simply absent, so the daemon's atomic
        // replacement deletes it.
        #expect(!after.report.entries.contains { $0.keySha256 == oldHash })
        #expect(after.report.entries.map(\.profileID) == [profileA.id])
    }

    @Test("report removal — a removed profile is absent from the next full-state report")
    func removalDropsEntry() async throws {
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        let both = try await provisioner.provision(profiles: [profileA, profileB])
        #expect(both.report.entries.count == 2)

        let onlyA = try await provisioner.provision(
            profiles: [profileA],
            previouslyProvisionedSlugs: [profileA.id, profileB.id]
        )
        #expect(onlyA.report.entries.map(\.profileID) == [profileA.id])
        #expect(!onlyA.report.entries.contains { $0.profileID == profileB.id })
    }

    @Test("report replay — a wiped generation counter resyncs instead of stranding attribution")
    func staleReportResyncs() async throws {
        // Preferences wiped, or a fresh app against an existing daemon DB:
        // the app would restart at generation 1 and the daemon — holding 7 —
        // would reject every report forever, killing attribution silently.
        let security = FakeSecurity()
        let generations = FakeGenerationStore()
        let provisioner = makeProvisioner(security, generations: generations)
        let reporter = FakeReporter(rejectingGenerationsBelow: 7)

        let outcome = try await provisioner.provision(profiles: [profileA])
        #expect(outcome.report.generation == 1)
        let ack = try await provisioner.send(outcome.report, via: reporter)

        #expect(ack.applied)
        #expect(reporter.reports.map(\.generation) == [1, 8])
        // The resend carries identical entries — the retry cannot apply
        // anything the first attempt would not have.
        #expect(reporter.reports[0].entries == reporter.reports[1].entries)
        #expect(generations.lastGeneration() == 8)
    }

    @Test("report replay — a superseded report is refused before anything is sent")
    func supersededReportRefused() async throws {
        // Security review should-fix 2. Without this gate the resync path is a
        // weapon: handed a cached older report, `send` would adopt the
        // daemon's generation, bump past it, and apply the STALE map —
        // resurrecting exactly the rotated hashes the generation gate exists
        // to bury.
        let security = FakeSecurity()
        let generations = FakeGenerationStore()
        let provisioner = makeProvisioner(security, generations: generations)
        let reporter = FakeReporter(rejectingGenerationsBelow: 7)

        let superseded = try await provisioner.provision(profiles: [profileA])   // generation 1
        let current = try await provisioner.provision(profiles: [profileA])      // generation 2, rotated key
        #expect(superseded.report.entries != current.report.entries)

        await #expect(throws: ClientKeyProvisioningError.supersededReport(
            reportGeneration: 1, currentGeneration: 2
        )) {
            _ = try await provisioner.send(superseded.report, via: reporter)
        }
        // Refused BEFORE the wire: no adopt, no bump, nothing sent.
        #expect(reporter.reports.isEmpty)
        #expect(generations.lastGeneration() == 2)

        // The current report still sends, and still resyncs when stale.
        let ack = try await provisioner.send(current.report, via: reporter)
        #expect(ack.applied)
        #expect(reporter.reports.map(\.entries) == [current.report.entries, current.report.entries])
    }

    @Test("a report the daemon accepts is not resent")
    func acceptedReportIsNotResent() async throws {
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        let reporter = FakeReporter()
        let outcome = try await provisioner.provision(profiles: [profileA])
        _ = try await provisioner.send(outcome.report, via: reporter)
        #expect(reporter.reports.count == 1)
    }

    @Test("the hash of the empty string is never reported")
    func emptyKeyHashRejected() async throws {
        // Recon V1: a keyless request's usage record carries `"api_key": ""`.
        // If its hash were ever in the mapping, every unauthenticated request
        // would attribute to a real profile.
        let security = FakeSecurity()
        let provisioner = ClientKeyProvisioner(
            store: KeychainClientKeyStore(runner: security),
            generations: FakeGenerationStore(),
            generateKey: { "md520-placeholder-key-1" },
            hash: { _ in ClientKeyGenerator.sha256OfEmptyString }
        )
        await #expect(throws: ClientKeyProvisioningError.emptyKeyHashRejected) {
            _ = try await provisioner.provision(profiles: [profileA])
        }
        #expect(ClientKeyGenerator.sha256Hex("") == ClientKeyGenerator.sha256OfEmptyString)
    }

    @Test("the report body is snake_case hashes only — no raw key can ride along")
    func reportWireShape() async throws {
        let report = ClientKeyReport(generation: 7, entries: [
            .init(keySha256: String(repeating: "a", count: 64), profileID: profileA.id, profileLabel: "Work")
        ])
        let data = try JSONEncoder().encode(report)
        let decoded = try JSONSerialization.jsonObject(with: data)
        let json = try #require(decoded as? [String: Any])
        #expect(json["generation"] as? Int == 7)
        let entry = try #require((json["entries"] as? [[String: Any]])?.first)
        #expect(Set(entry.keys) == ["key_sha256", "profile_id", "profile_label"])
    }
}

// MARK: - Security posture

@Suite("Issue #520 — no secret in argv")
struct Issue520ArgvTests {
    @Test("no invocation ever carries key material in its arguments")
    func keysNeverReachArgv() async throws {
        let security = FakeSecurity()
        let provisioner = makeProvisioner(security)
        _ = try await provisioner.provision(profiles: [profileA, profileB])

        for invocation in security.invocations {
            for argument in invocation.arguments {
                #expect(!argument.contains("md520-placeholder-key"))
            }
        }
        // The create path's argv is exactly ["-i"]: the command rides stdin.
        for add in security.addInvocations {
            #expect(add.arguments == ["-i"])
            #expect(add.stdin?.contains("md520-placeholder-key") == true)
        }
    }

    @Test("the create command trusts /usr/bin/security on the item it writes")
    func createCommandTrustsTheReader() throws {
        // Recon V5: this `-T` is what makes the shell helper's read
        // prompt-free. Without it, an item created by another creator raises a
        // SecurityAgent dialog on read, which hangs a headless child (#277).
        let store = KeychainClientKeyStore(runner: FakeSecurity())
        let command = try store.addCommand(service: serviceA(), key: "md520-placeholder-key-1")
        #expect(command.contains("-T /usr/bin/security"))
        #expect(command.hasPrefix("add-generic-password "))
        #expect(command.hasSuffix("\n"))
        // Exactly one line: a second line would be a second `security -i`
        // command smuggled in behind the first.
        #expect(command.filter { $0 == "\n" }.count == 1)
    }

    @Test("only the machine slug is interpolated — free-text labels never enter a command")
    func labelsNeverEnterCommands() async throws {
        let hostile = ClientKeyProfile(
            id: profileA.id,
            label: "\"; rm -rf ~ #"
        )
        let security = FakeSecurity()
        _ = try await makeProvisioner(security).provision(profiles: [hostile])
        for invocation in security.invocations {
            #expect(!(invocation.stdin ?? "").contains("rm -rf"))
            #expect(!invocation.arguments.contains { $0.contains("rm -rf") })
        }
    }

    @Test("a slug outside [a-z0-9-] refuses before any Keychain write")
    func hostileSlugRefused() async throws {
        for hostile in ["a b", "A-B", "a\"b", "a;b", "a/b", "", "a\nb", String(repeating: "a", count: 65)] {
            let security = FakeSecurity()
            let profile = ClientKeyProfile(id: hostile, label: "Work")
            await #expect(throws: ClientKeyProvisioningError.invalidSlug(profileID: hostile)) {
                _ = try await makeProvisioner(security).provision(profiles: [profile])
            }
            #expect(security.invocations.isEmpty)
        }
    }

    @Test("a generated key outside base64url refuses rather than being escaped")
    func hostileKeyRefused() async throws {
        let security = FakeSecurity()
        let provisioner = ClientKeyProvisioner(
            store: KeychainClientKeyStore(runner: security),
            generations: FakeGenerationStore(),
            generateKey: { "\" -T /AppleInternal #" }
        )
        await #expect(throws: ClientKeyProvisioningError.generatedKeyRejected) {
            _ = try await provisioner.provision(profiles: [profileA])
        }
        #expect(security.invocations.isEmpty)
    }

    @Test("the store refuses a hostile service passed directly to it")
    func hostileServiceRefusedAtStoreLayer() async throws {
        // Security review should-fix 1: `add`/`replace`/`removeAll`/`readBack`
        // are public, and `addCommand` is the one place a service becomes
        // command text. A caller reaching the store directly must not be able
        // to escape the command line.
        let hostile = [
            #"cli-proxy-api-client.a" -T /AppleInternal #"#,   // quote escape
            "cli-proxy-api-client.a b",                        // space
            "cli-proxy-api-client.A",                          // uppercase
            "cli-proxy-api-client.",                           // empty slug
            "cli-proxy-api-client",                            // the legacy item
            "Claude Code-credentials",                         // someone else's item
            "cli-proxy-api-client.a\nadd-generic-password -s x", // second command
            "",
        ]
        for service in hostile {
            let security = FakeSecurity()
            let store = KeychainClientKeyStore(runner: security)
            await #expect(throws: ClientKeyProvisioningError.invalidService(service)) {
                try await store.add(service: service, key: "md520-placeholder-key-1")
            }
            await #expect(throws: ClientKeyProvisioningError.invalidService(service)) {
                _ = try await store.removeAll(service: service)
            }
            await #expect(throws: ClientKeyProvisioningError.invalidService(service)) {
                _ = try await store.replace(service: service, key: "md520-placeholder-key-1")
            }
            await #expect(throws: ClientKeyProvisioningError.invalidService(service)) {
                _ = try await store.readBack(service: service)
            }
            #expect(throws: ClientKeyProvisioningError.invalidService(service)) {
                _ = try store.addCommand(service: service, key: "md520-placeholder-key-1")
            }
            // Nothing reached /usr/bin/security at all.
            #expect(security.invocations.isEmpty)
        }
    }

    @Test("the store accepts exactly the per-profile service shape")
    func managedServiceShape() {
        #expect(KeychainClientKeyStore.isManagedService(serviceA()))
        // The legacy shared item is structurally unreachable by this store (D6).
        #expect(!KeychainClientKeyStore.isManagedService(KeychainClientKeyStore.legacySharedService))
    }

    @Test("the real generator produces a 32-byte unpadded base64url key")
    func generatorShape() throws {
        let key = try ClientKeyGenerator.generate()
        #expect(ClientKeyCharset.isValidGeneratedKey(key))
        #expect(key.count == 43) // ceil(32 * 4 / 3) with padding stripped
        #expect(!key.contains("="))
        let second = try ClientKeyGenerator.generate()
        #expect(second != key)
    }
}

@Suite("Issue #520 — per-profile service names")
struct Issue520ServiceNameTests {
    @Test("per-profile items are unreachable by the legacy -s cli-proxy-api-client lookup")
    func perProfileServiceIsDistinct() {
        // Security-review blocker 1: `find-generic-password -s` without `-a`
        // returns the first match, so items sharing the legacy service would
        // let a stale shell fetch another profile's key.
        let service = KeychainClientKeyStore.service(forSlug: profileA.id)
        #expect(service == "cli-proxy-api-client.\(profileA.id)")
        #expect(service != KeychainClientKeyStore.legacySharedService)
        #expect(service.hasPrefix(KeychainClientKeyStore.servicePrefix))
    }

    @Test("distinct profiles get distinct services")
    func servicesDoNotCollide() {
        #expect(serviceA() != serviceB())
    }
}

@Suite("Issue #520 — duplicate label refusal")
struct Issue520DuplicateLabelTests {
    @Test("two key-enabled profiles sharing a label refuse before any Keychain write")
    func duplicateLabelRefused() async throws {
        // §2.2: receipts store the label only, so two key-enabled profiles
        // sharing one would produce indistinguishable rows. Refused at
        // provisioning, not disambiguated at read time.
        let security = FakeSecurity()
        let clash = ClientKeyProfile(id: profileB.id, label: profileA.label)
        await #expect(throws: ClientKeyProvisioningError.duplicateLabel(profileA.label)) {
            _ = try await makeProvisioner(security).provision(profiles: [profileA, clash])
        }
        #expect(security.invocations.isEmpty)
    }

    @Test("labels differing only by case or surrounding space still collide")
    func labelComparisonIsNormalized() async throws {
        let security = FakeSecurity()
        let clash = ClientKeyProfile(id: profileB.id, label: "  work ")
        await #expect(throws: ClientKeyProvisioningError.self) {
            _ = try await makeProvisioner(security).provision(profiles: [profileA, clash])
        }
        #expect(security.invocations.isEmpty)
    }

    @Test("the same profile listed twice refuses")
    func duplicateProfileRefused() async throws {
        let security = FakeSecurity()
        await #expect(throws: ClientKeyProvisioningError.duplicateProfile(profileID: profileA.id)) {
            _ = try await makeProvisioner(security).provision(profiles: [profileA, profileA])
        }
        #expect(security.invocations.isEmpty)
    }
}

@Suite("Issue #520 — no GUI prompt, ever")
struct Issue520PromptFreeTests {
    @Test("a read that does not answer is an honest failure and is never retried")
    func hangingReadFailsWithoutRetry() async throws {
        // A read that reaches its deadline means a SecurityAgent dialog is
        // waiting on a screen the helper's headless child does not have
        // (recon V5 / #277). Retrying is a second dialog on the user's screen
        // — the recorded recon probe-design incident.
        let security = FakeSecurity()
        security.readsThatNeverAnswer = [serviceA()]
        await #expect(throws: ClientKeyProvisioningError.keychainReadNotPromptFree(service: serviceA())) {
            _ = try await makeProvisioner(security).provision(profiles: [profileA])
        }
        let reads = security.invocations.filter { $0.arguments.first == "find-generic-password" }
        #expect(reads.count == 1)
    }

    @Test("no client-key source uses SecItemAdd or a kSecClass constant")
    func sourcesNeverUseSecItemAdd() throws {
        // Recon V5's landmine: an item created in-process gets an ACL without
        // /usr/bin/security, so the shell helper's read prompts. The stdin-fed
        // CLI is the shipping create path; this tripwire fails the build if
        // anyone reintroduces the in-process one.
        //
        // Discovered by glob, not by a hardcoded file list: a THIRD ClientKey*
        // file must not be able to reintroduce SecItemAdd unscanned.
        let banned = ["SecItemAdd", "SecItemUpdate", "kSecClassGenericPassword", "kSecUseKeychain", "SecKeychainOpen"]
        let names = try Self.clientKeySourceNames()
        #expect(names.contains("ClientKeyProvisioning.swift"))
        #expect(names.contains("ClientKeyProvisioningLive.swift"))
        #expect(names.count >= 2)
        for name in names {
            let source = try String(contentsOf: Self.sourceURL(name), encoding: .utf8)
            for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
                // Prose in the header comments explains WHY these are banned.
                if line.trimmingCharacters(in: .whitespaces).hasPrefix("//") { continue }
                for token in banned where line.contains(token) {
                    Issue.record("\(name) uses \(token); the shipping create path is `security -i` (recon V5)")
                }
            }
        }
    }

    @Test("the shipping create path is the stdin-fed CLI")
    func createPathIsCLI() throws {
        let source = try String(contentsOf: Self.sourceURL("ClientKeyProvisioning.swift"), encoding: .utf8)
        #expect(source.contains(#"runner.run(arguments: ["-i"]"#))
        #expect(KeychainClientKeyStore.trustedReader == "/usr/bin/security")
    }

    static func sourceURL(_ name: String) -> URL {
        sourceDirectory.appendingPathComponent(name)
    }

    static var sourceDirectory: URL {
        // Tests/ModelDeckMacCoreTests/<file> → package root → Sources/…
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/ModelDeckMacCore")
    }

    /// Every `ClientKey*.swift` in the core target, found by listing the
    /// directory rather than by a list a new file can silently miss.
    static func clientKeySourceNames() throws -> [String] {
        try FileManager.default
            .contentsOfDirectory(atPath: sourceDirectory.path)
            .filter { $0.hasPrefix("ClientKey") && $0.hasSuffix(".swift") }
            .sorted()
    }
}

// MARK: - V5 re-proof against a scratch keychain

@Suite("Issue #520 — V5 re-proof: the shipping create path reads back prompt-free", .serialized)
struct Issue520ScratchKeychainTests {
    /// Recon V5 required build item 3 to re-prove prompt-freeness for the
    /// shipping create path, still on a scratch keychain, with the recorded
    /// caveat that login-keychain ACL behaviour may differ (this is necessary
    /// evidence, not sufficient — hence the runtime read-back verification in
    /// `KeychainClientKeyStore.replace`, which turns a prompting item into an
    /// honest failure on a real install).
    ///
    /// Everything here is placeholder material on a throwaway keychain that
    /// is created, used by explicit path, and deleted. `list-keychains` is
    /// never called, so the user's search list is untouched, and the login
    /// Keychain is never named by any command.
    @Test("an item created by `security -i` with -T is read back by /usr/bin/security without a prompt")
    func scratchKeychainRoundTrip() async throws {
        let runner = SecurityCommandRunner()
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("modeldeck-520-scratch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let keychain = root.appendingPathComponent("md520-scratch.keychain-db").path
        // Placeholder password for a throwaway keychain holding placeholder
        // values; it is never a credential and the keychain is deleted below.
        let password = "md520-scratch-placeholder-pass"
        // The scratch keychain lives entirely inside `root`; removing the
        // directory removes it even if the test fails early. It was never
        // added to the search list, so nothing else can see it either way.
        defer { try? FileManager.default.removeItem(at: root) }

        let created = await runner.run(
            arguments: ["create-keychain", "-p", password, keychain], stdin: nil, deadline: 15
        )
        // Never fall back to the login Keychain: if the scratch keychain
        // cannot be made, the probe fails rather than probing anything real.
        #expect(created.status == 0)
        guard created.status == 0 else { return }
        // Unlock in-terminal and disable auto-lock: a locked keychain prompts,
        // and that prompt would be a probe-design bug, not a V5 finding.
        _ = await runner.run(arguments: ["set-keychain-settings", keychain], stdin: nil, deadline: 15)
        let unlocked = await runner.run(
            arguments: ["unlock-keychain", "-p", password, keychain], stdin: nil, deadline: 15
        )
        #expect(unlocked.status == 0)

        let store = KeychainClientKeyStore(runner: runner, keychainPath: keychain)
        let service = KeychainClientKeyStore.service(forSlug: "md520-scratch-profile")
        let key = try ClientKeyGenerator.generate()

        // The whole point: `replace` writes via the stdin-fed CLI and then
        // reads back through /usr/bin/security under a hard deadline. If the
        // ACL were prompting, this throws `keychainReadNotPromptFree` rather
        // than hanging or retrying.
        let removed = try await store.replace(service: service, key: key)
        #expect(removed == 0)
        let readBack = try await store.readBack(service: service)
        #expect(readBack == key)

        // Deterministic replacement against the real Keychain too: the
        // duplicate cleanup removes exactly the one prior item.
        let rotated = try ClientKeyGenerator.generate()
        let removedOnRotate = try await store.replace(service: service, key: rotated)
        #expect(removedOnRotate == 1)
        let afterRotation = try await store.readBack(service: service)
        #expect(afterRotation == rotated)

        let cleaned = try await store.removeAll(service: service)
        #expect(cleaned == 1)
        let deleted = await runner.run(arguments: ["delete-keychain", keychain], stdin: nil, deadline: 15)
        #expect(deleted.status == 0)
    }
}

// MARK: - Daemon report channel

@Suite("Issue #520 — report channel")
struct Issue520ReportChannelTests {
    @Test("the app posts the mapping to /api/client-keys/report over the token-gated boundary")
    func postsToReportEndpoint() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"md520-placeholder-session-token"}"#),
            .init(status: 200, body: #"{"clientKeys":{"applied":true,"generation":4,"entries":1}}"#)
        ])
        let client = DaemonClient(
            configuration: DaemonConfiguration(port: 43287),
            transport: transport
        )
        let ack = try await client.reportClientKeys(ClientKeyReport(generation: 4, entries: [
            .init(keySha256: String(repeating: "b", count: 64), profileID: profileA.id, profileLabel: "Work")
        ]))
        #expect(ack == ClientKeyReportAck(applied: true, generation: 4))

        let post = try #require(transport.requests.last)
        #expect(post.httpMethod == "POST")
        #expect(post.url?.path == "/api/client-keys/report")
        #expect(post.value(forHTTPHeaderField: "x-modeldeck-token") == "md520-placeholder-session-token")
        #expect(post.value(forHTTPHeaderField: "Cookie")?.contains("modeldeck_session=") == true)
        let body = try #require(post.httpBody)
        let decoded = try JSONSerialization.jsonObject(with: body)
        let json = try #require(decoded as? [String: Any])
        #expect(json["generation"] as? Int == 4)
        // Hashes only: nothing in the body is a usable credential.
        let raw = String(decoding: body, as: UTF8.self)
        #expect(!raw.contains("md520-placeholder-key"))
    }

    @Test("a daemon rejection is surfaced as applied=false with the generation it holds")
    func staleAckDecoded() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"md520-placeholder-session-token"}"#),
            .init(status: 200, body: #"{"clientKeys":{"applied":false,"reason":"stale-generation","generation":9}}"#)
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 43287), transport: transport)
        let ack = try await client.reportClientKeys(ClientKeyReport(generation: 2, entries: []))
        #expect(ack == ClientKeyReportAck(applied: false, generation: 9))
    }
}
