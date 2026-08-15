import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #421 — TRIPWIRE managed-proxy-never-writes-auth.
//
// #398 is a construction constraint, not a promise: ModelDeck manages the
// proxy's CONFIG and PROCESS, and CLIProxyAPI stays the ONLY writer of auth
// files. Two halves enforce it, because either alone is escapable:
//
//   1. BEHAVIOURAL — drive the whole lifecycle (launch, crash, restart, stop,
//      external refusal) through a filesystem the test owns, and assert the
//      complete set of writes it performed is exactly [config.yaml].
//   2. STATIC — assert the lifecycle SOURCES contain no filesystem write API
//      outside the one guarded writer. A future edit that adds a write path
//      trips this even if no test happens to drive it.
//
// Mutation-verified: seeding `try Data().write(to: paths.authDirectory...)`
// into ManagedProxy.swift fails the static half; a fake writer that records an
// auth destination fails the behavioural half.

// MARK: - Behavioural half

/// A filesystem the test owns completely: every write the lifecycle performs
/// lands here and nowhere else, so "what did it write" is answerable exactly.
private final class SpyConfigWriter: ManagedProxyConfigWriting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var writes: [URL] = []
    /// The real writer's guard, applied to whatever we were asked to write.
    private(set) var guardViolations: [String] = []

    func ensureConfig(paths: ManagedProxyPaths, port: Int) throws -> URL {
        let destination = paths.configFile
        do {
            try ManagedProxyWriteGuard.requirePermittedWrite(destination, paths: paths)
        } catch {
            lock.withLock { guardViolations.append("\(error)") }
            throw error
        }
        lock.withLock { writes.append(destination) }
        return destination
    }
}

private final class TripwireProcess: ManagedProxyProcessControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var alive: Set<Int> = []
    private var nextID = 1
    private(set) var startCount = 0

    func start(executable: URL, configFile: URL, workingDirectory: URL) throws -> ManagedProxyProcessToken {
        lock.withLock {
            startCount += 1
            let id = nextID
            nextID += 1
            alive.insert(id)
            return ManagedProxyProcessToken(id: id)
        }
    }
    func isRunning(_ token: ManagedProxyProcessToken) -> Bool { lock.withLock { alive.contains(token.id) } }
    func stop(_ token: ManagedProxyProcessToken) async { lock.withLock { alive.remove(token.id) } }
    func simulateCrash() { lock.withLock { alive.removeAll() } }
}

private final class TogglingHealth: ManagedProxyHealthProbing, @unchecked Sendable {
    private let lock = NSLock()
    private var _answering = false
    var answering: Bool {
        get { lock.withLock { _answering } }
        set { lock.withLock { _answering = newValue } }
    }
    func probeProxy() async -> Bool { lock.withLock { _answering } }
}

@Suite("Issue #421 — TRIPWIRE managed-proxy-never-writes-auth")
struct ManagedProxyAuthTripwireTests {

    @Test("the write guard refuses every auth-file shape")
    func guardRefusesAuthFiles() {
        let paths = ManagedProxyPaths(
            configDirectory: URL(fileURLWithPath: "/tmp/md-guard/.config/cliproxyapi", isDirectory: true)
        )
        let refused = [
            paths.authDirectory,
            paths.authDirectory.appendingPathComponent("claude-fixture.json"),
            paths.authDirectory.appendingPathComponent("nested/codex-fixture.json"),
            // The escape attempt: a "config" path that walks into auth.
            paths.configDirectory.appendingPathComponent("../cliproxyapi/auth/token.json"),
        ]
        for url in refused {
            #expect(throws: ManagedProxyWriteGuard.Violation.self) {
                try ManagedProxyWriteGuard.requirePermittedWrite(url, paths: paths)
            }
            #expect(ManagedProxyWriteGuard.isAuthFile(url, paths: paths))
            #expect(!ManagedProxyWriteGuard.isPermittedWrite(url, paths: paths))
        }
    }

    /// #431 (Tim 2026-08-14) widened the admitted set from one file to two:
    /// the config and the seed-time management key. Everything else beside
    /// them is still refused, and auth files are still their own violation.
    @Test("the write guard admits the config and the management key, and nothing else beside them")
    func guardAdmitsOnlyConfig() throws {
        let paths = ManagedProxyPaths(
            configDirectory: URL(fileURLWithPath: "/tmp/md-guard/.config/cliproxyapi", isDirectory: true)
        )
        try ManagedProxyWriteGuard.requirePermittedWrite(paths.configFile, paths: paths)
        try ManagedProxyWriteGuard.requirePermittedWrite(paths.managementKeyFile, paths: paths)
        for sibling in ["config.yaml.bak", "settings.json", ".mgmt-key.bak"] {
            let url = paths.configDirectory.appendingPathComponent(sibling)
            #expect(throws: ManagedProxyWriteGuard.Violation.self) {
                try ManagedProxyWriteGuard.requirePermittedWrite(url, paths: paths)
            }
            // Not auth files, but still not ours to write.
            #expect(!ManagedProxyWriteGuard.isAuthFile(url, paths: paths))
        }
    }

    @Test("a full lifecycle run writes the config file and nothing else")
    @MainActor
    func fullLifecycleWritesOnlyConfig() async {
        let writer = SpyConfigWriter()
        let process = TripwireProcess()
        let health = TogglingHealth()
        let paths = ManagedProxyPaths(
            configDirectory: URL(fileURLWithPath: "/tmp/md-tripwire/.config/cliproxyapi", isDirectory: true)
        )
        let model = ManagedProxyModel(
            dependencies: .init(
                bundle: ManagedProxyBundle(
                    binaryURL: URL(fileURLWithPath: "/fixture/Contents/Resources/cliproxyapi/cliproxyapi"),
                    version: "v7.2.130"
                ),
                paths: paths,
                process: process,
                health: health,
                config: writer
            ),
            maxRestarts: 2,
            sleep: { _ in }
        )

        // Every path the lifecycle has: launch, healthy tick, crash+restart,
        // crash loop give-up, user stop, restart from stopped, and the
        // external-instance refusal.
        await model.evaluateOnLaunch()
        health.answering = true
        await model.superviseOnce()
        health.answering = false
        process.simulateCrash()
        await model.superviseOnce()
        process.simulateCrash()
        await model.superviseOnce()
        process.simulateCrash()
        await model.superviseOnce()
        await model.stopManaging()
        await model.startManaging()
        health.answering = true
        process.simulateCrash()
        await model.superviseOnce()

        #expect(model.phase == .externalInstanceDetected)
        #expect(writer.guardViolations.isEmpty)
        #expect(!writer.writes.isEmpty)
        // THE assertion: only ever the admitted destinations (#431 added the
        // management key file; the auth dir remains unreachable).
        #expect(Set(writer.writes).isSubset(of: [paths.configFile, paths.managementKeyFile]))
        #expect(writer.writes.allSatisfy { !ManagedProxyWriteGuard.isAuthFile($0, paths: paths) })
    }

    // MARK: - Static half

    /// Filesystem write APIs. Anything that can create, modify, move or
    /// delete a file. If a lifecycle source gains one of these outside the
    /// guarded writer, this test fails — that is the whole point.
    private static let writeAPIs = [
        ".write(to:",
        "createFile(",
        "createDirectory(",
        "removeItem(",
        "copyItem(",
        "moveItem(",
        "replaceItem",
        "FileHandle(forWritingTo",
        "FileHandle(forUpdating",
        "OutputStream(",
        "fopen(",
        "setAttributes(",
    ]

    /// The type allowed to contain write calls — and the only one.
    private static let guardedWriterType = "ManagedProxyConfigFileWriter"

    private static func lifecycleSource(_ name: String) throws -> String {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // .../Tests/ModelDeckMacCoreTests
            .deletingLastPathComponent()   // .../Tests
            .deletingLastPathComponent()   // .../ModelDeckMac (package root)
            .appendingPathComponent("Sources/ModelDeckMacCore")
        return try String(contentsOf: sources.appendingPathComponent(name), encoding: .utf8)
    }

    /// Lines of `source` outside the guarded writer type's body, with comment
    /// lines dropped (prose about writes is not a write).
    private static func linesOutsideGuardedWriter(_ source: String) -> [(Int, String)] {
        var insideWriter = false
        var depth = 0
        var result: [(Int, String)] = []
        for (index, rawLine) in source.components(separatedBy: "\n").enumerated() {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if !insideWriter, rawLine.contains("struct \(guardedWriterType)") {
                insideWriter = true
                depth = 0
            }
            if insideWriter {
                depth += rawLine.filter { $0 == "{" }.count
                depth -= rawLine.filter { $0 == "}" }.count
                if depth <= 0, rawLine.contains("}"), !rawLine.contains("struct \(guardedWriterType)") {
                    insideWriter = false
                }
                continue
            }
            if line.hasPrefix("//") { continue }
            result.append((index + 1, rawLine))
        }
        return result
    }

    @Test("the managed-proxy lifecycle sources contain no unguarded filesystem write")
    func lifecycleHasNoAuthWritePath() throws {
        for name in ["ManagedProxy.swift", "ManagedProxyLive.swift"] {
            let source = try Self.lifecycleSource(name)
            for (number, line) in Self.linesOutsideGuardedWriter(source) {
                for api in Self.writeAPIs where line.contains(api) {
                    Issue.record("""
                        TRIPWIRE managed-proxy-never-writes-auth: \(name):\(number) \
                        uses the filesystem write API `\(api)` outside \
                        \(Self.guardedWriterType). ModelDeck manages the proxy's config \
                        and process only (#398) — every write must go through the \
                        guarded writer, which admits config.yaml and .mgmt-key (#431) \
                        and nothing else.
                        \(line.trimmingCharacters(in: .whitespaces))
                        """)
                }
            }
        }
    }

    @Test("the guarded writer still checks the guard before writing")
    func guardedWriterCallsTheGuard() throws {
        let source = try Self.lifecycleSource("ManagedProxyLive.swift")
        // Without this, the static test above would be satisfied by a writer
        // that writes anywhere it likes.
        #expect(source.contains("ManagedProxyWriteGuard.requirePermittedWrite"))
        guard let guardIndex = source.range(of: "ManagedProxyWriteGuard.requirePermittedWrite")?.lowerBound,
              let writeIndex = source.range(of: "writeSeededConfig(")?.lowerBound
        else {
            Issue.record("the guarded writer no longer writes the config file through the guard")
            return
        }
        #expect(guardIndex < writeIndex, "the guard must run BEFORE the write, not after")
    }

    /// The auth directory is never mentioned as a write destination anywhere
    /// in the lifecycle — it appears only as the thing being refused and as
    /// the value seeded into the proxy's own config.
    @Test("no lifecycle source writes to the auth directory")
    func noAuthDirectoryWrites() throws {
        for name in ["ManagedProxy.swift", "ManagedProxyLive.swift"] {
            let source = try Self.lifecycleSource(name)
            for (number, line) in Self.linesOutsideGuardedWriter(source) where line.contains("authDirectory") {
                for api in Self.writeAPIs where line.contains(api) {
                    Issue.record("TRIPWIRE managed-proxy-never-writes-auth: \(name):\(number) writes to the auth directory via `\(api)`")
                }
            }
        }
    }
}
