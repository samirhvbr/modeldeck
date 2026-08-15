import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #421 — 1.0 build C: managed proxy lifecycle. Nothing here spawns a
// process, opens port 8317, or touches a real ~/.config/cliproxyapi: the
// process/health seams are fakes and every filesystem test runs in a fresh
// temp directory.

// MARK: - Fakes

private final class FakeProxyProcess: ManagedProxyProcessControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var alive: Set<Int> = []
    private var nextID = 1

    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var startedConfigFiles: [URL] = []
    private(set) var startedExecutables: [URL] = []
    var startError: Error?

    func start(executable: URL, configFile: URL, workingDirectory: URL) throws -> ManagedProxyProcessToken {
        try lock.withLock {
            startCount += 1
            startedConfigFiles.append(configFile)
            startedExecutables.append(executable)
            if let startError { throw startError }
            let id = nextID
            nextID += 1
            alive.insert(id)
            return ManagedProxyProcessToken(id: id, pid: 7_000 + id)
        }
    }

    func isRunning(_ token: ManagedProxyProcessToken) -> Bool {
        lock.withLock { alive.contains(token.id) }
    }

    func stop(_ token: ManagedProxyProcessToken) async {
        lock.withLock {
            stopCount += 1
            alive.remove(token.id)
        }
    }

    /// Test-only: the proxy process dies on its own (the `kill` half of the
    /// acceptance criterion).
    func simulateCrash() {
        lock.withLock { alive.removeAll() }
    }
}

private final class FakeProxyHealth: ManagedProxyHealthProbing, @unchecked Sendable {
    private let lock = NSLock()
    private var _answering: Bool
    private(set) var probeCount = 0

    init(answering: Bool = false) { _answering = answering }

    var answering: Bool {
        get { lock.withLock { _answering } }
        set { lock.withLock { _answering = newValue } }
    }

    func probeProxy() async -> Bool {
        lock.withLock {
            probeCount += 1
            return _answering
        }
    }
}

/// Records every destination the lifecycle asks to have written, so a test
/// can assert on the complete set of writes a full run performs.
private final class RecordingConfigWriter: ManagedProxyConfigWriting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var writes: [URL] = []
    var error: Error?

    func ensureConfig(paths: ManagedProxyPaths, port: Int) throws -> URL {
        if let error { throw error }
        return try lock.withLock {
            // Guarded exactly as the live writer is: the fake may not pretend
            // an unpermitted destination is acceptable either.
            try ManagedProxyWriteGuard.requirePermittedWrite(paths.configFile, paths: paths)
            writes.append(paths.configFile)
            return paths.configFile
        }
    }
}

private struct Harness {
    let model: ManagedProxyModel
    let process: FakeProxyProcess
    let health: FakeProxyHealth
    let config: RecordingConfigWriter
    let paths: ManagedProxyPaths
    let delays: DelayRecorder
}

private final class DelayRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var recorded: [TimeInterval] = []
    /// Lets a test change the world DURING the backoff wait — that is when
    /// the safety rail's post-sleep re-check has to hold.
    var onSleep: (@Sendable () -> Void)?

    func record(_ seconds: TimeInterval) {
        lock.withLock { recorded.append(seconds) }
        onSleep?()
    }
}

private actor RecordingManagedProxyReporter: ManagedProxyReporting {
    private var reports: [ManagedProxyAppReport] = []

    func reportManagedProxy(_ report: ManagedProxyAppReport) async throws {
        reports.append(report)
    }

    func snapshot() -> [ManagedProxyAppReport] { reports }
}

private struct FailingManagedProxyReporter: ManagedProxyReporting {
    struct ReportFailure: Error, LocalizedError {
        var errorDescription: String? { "daemon unavailable" }
    }

    func reportManagedProxy(_ report: ManagedProxyAppReport) async throws {
        throw ReportFailure()
    }
}

private final class ReportFailureRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    func record(_ message: String) { lock.withLock { recorded.append(message) } }
    var messages: [String] { lock.withLock { recorded } }
}

private func awaitReports(
    _ reporter: RecordingManagedProxyReporter,
    count: Int
) async -> [ManagedProxyAppReport] {
    for _ in 0..<1_000 {
        let reports = await reporter.snapshot()
        if reports.count >= count { return reports }
        try? await Task.sleep(for: .milliseconds(1))
    }
    return await reporter.snapshot()
}

@MainActor
private func makeHarness(
    available: Bool = true,
    answering: Bool = false,
    maxRestarts: Int = ManagedProxyRestartPolicy.maxRestarts,
    healthyResetInterval: TimeInterval = 60,
    reporter: any ManagedProxyReporting = NoopManagedProxyReporter(),
    reportFailure: @escaping @Sendable (String) -> Void = { _ in },
    now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 1_000) }
) -> Harness {
    let process = FakeProxyProcess()
    let health = FakeProxyHealth(answering: answering)
    let config = RecordingConfigWriter()
    let paths = ManagedProxyPaths(
        configDirectory: URL(fileURLWithPath: "/tmp/modeldeck-tests-never-written/.config/cliproxyapi", isDirectory: true)
    )
    let delays = DelayRecorder()
    let model = ManagedProxyModel(
        dependencies: .init(
            bundle: available
                ? ManagedProxyBundle(binaryURL: URL(fileURLWithPath: "/fixture/Contents/Resources/cliproxyapi/cliproxyapi"), version: "v7.2.130")
                : .unavailable,
            paths: paths,
            process: process,
            health: health,
            config: config,
            reporter: reporter,
            appVersion: "1.0.0-test",
            reportFailure: reportFailure
        ),
        maxRestarts: maxRestarts,
        healthyResetInterval: healthyResetInterval,
        clock: now,
        sleep: { seconds in delays.record(seconds) }
    )
    return Harness(model: model, process: process, health: health, config: config, paths: paths, delays: delays)
}

// MARK: - Pure decision

@Suite("Issue #421 — managed proxy decision")
struct ManagedProxyDecisionTests {
    @Test("a dev build without the embedded binary manages nothing")
    func unavailableWins() {
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: false, occupant: .none, restartsSoFar: 0
        ) == .unavailable)
        // Even with a foreign proxy answering: a build that can't manage
        // anything has nothing to refuse.
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: false, occupant: .foreign, restartsSoFar: 0
        ) == .unavailable)
    }

    @Test("an external proxy on the port is refused in every desired state")
    func foreignRefusalOutranksIntent() {
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .foreign, restartsSoFar: 0
        ) == .refuseExternalInstance)
        #expect(decideManagedProxy(
            desired: .stopped, binaryAvailable: true, occupant: .foreign, restartsSoFar: 0
        ) == .refuseExternalInstance)
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .foreign, restartsSoFar: 3
        ) == .refuseExternalInstance)
    }

    @Test("a user-initiated stop is never overridden by a crash")
    func stoppedStaysStopped() {
        #expect(decideManagedProxy(
            desired: .stopped, binaryAvailable: true, occupant: .none, restartsSoFar: 0
        ) == .stayStopped)
        #expect(decideManagedProxy(
            desired: .stopped, binaryAvailable: true, occupant: .none, restartsSoFar: 4
        ) == .stayStopped)
    }

    @Test("a live managed process is left alone")
    func managedRuns() {
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .managed, restartsSoFar: 2
        ) == .running)
    }

    @Test("first launch starts; later gaps restart on the backoff ladder")
    func startThenRestart() {
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .none, restartsSoFar: 0
        ) == .start)
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .none, restartsSoFar: 1
        ) == .restart(attempt: 1))
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .none, restartsSoFar: 5, maxRestarts: 5
        ) == .restart(attempt: 5))
    }

    @Test("a crash loop gives up instead of hammering launch")
    func crashLoopGivesUp() {
        #expect(decideManagedProxy(
            desired: .running, binaryAvailable: true, occupant: .none, restartsSoFar: 6, maxRestarts: 5
        ) == .crashLoopGiveUp(attempts: 5))
    }
}

@Suite("Issue #421 — proxy port occupancy")
struct ProxyOccupantTests {
    @Test("process ownership decides who owns the port")
    func occupancyTable() {
        #expect(classifyProxyOccupant(portAnswering: false, managedProcessAlive: false) == .none)
        #expect(classifyProxyOccupant(portAnswering: true, managedProcessAlive: true) == .managed)
        // Coming up: our process exists but hasn't bound the port yet.
        #expect(classifyProxyOccupant(portAnswering: false, managedProcessAlive: true) == .managed)
        // THE safety rail: something answers and it isn't ours.
        #expect(classifyProxyOccupant(portAnswering: true, managedProcessAlive: false) == .foreign)
    }
}

@Suite("Issue #421 — restart backoff")
struct ManagedProxyBackoffTests {
    @Test("bounded exponential backoff, never zero, never unbounded")
    func ladder() {
        #expect(managedProxyRestartDelay(attempt: 1) == 1)
        #expect(managedProxyRestartDelay(attempt: 2) == 2)
        #expect(managedProxyRestartDelay(attempt: 3) == 4)
        #expect(managedProxyRestartDelay(attempt: 4) == 8)
        #expect(managedProxyRestartDelay(attempt: 5) == 16)
        #expect(managedProxyRestartDelay(attempt: 6) == ManagedProxyRestartPolicy.maxDelay)
        #expect(managedProxyRestartDelay(attempt: 400) == ManagedProxyRestartPolicy.maxDelay)
        // A zero or negative attempt must never produce a zero delay — that
        // is the tight crash loop the ticket forbids.
        #expect(managedProxyRestartDelay(attempt: 0) == 1)
        #expect(managedProxyRestartDelay(attempt: -3) == 1)
    }
}

// MARK: - Pin resolution (slice A is the ONE path authority)

@Suite("Issue #421 — CLIProxyAPI pin resolution")
struct CLIProxyPinTests {
    private static let appRoot = URL(fileURLWithPath: "/Applications/ModelDeck.app", isDirectory: true)

    @Test("the pin's bundlePath resolves against the app root")
    func resolvesPinnedPath() {
        let url = resolveCLIProxyBinaryURL(
            appBundleURL: Self.appRoot,
            bundlePath: "Contents/Resources/cliproxyapi/cliproxyapi"
        )
        #expect(url?.path == "/Applications/ModelDeck.app/Contents/Resources/cliproxyapi/cliproxyapi")
    }

    @Test("a malformed pin turns the feature off instead of launching something unexpected")
    func rejectsUnsafePaths() {
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: nil) == nil)
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: "") == nil)
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: "/usr/local/bin/cliproxyapi") == nil)
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: "Contents/Resources/../../../evil") == nil)
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: "Contents/MacOS/cliproxyapi") == nil)
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: "Contents/Resources") == nil)
        #expect(resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: "Contents/Resources//cliproxyapi") == nil)
    }

    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // ModelDeckMacCoreTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // ModelDeckMac
            .deletingLastPathComponent()   // macos
            .deletingLastPathComponent()   // repo root
    }

    /// Pins the seam between slice A and slice C: the pin file slice A ships
    /// is the one this code decodes, and its bundlePath is resolvable. If the
    /// pin's shape ever drifts, the lifecycle finds out here, not at runtime.
    @Test("the shipped scripts/cliproxyapi-pin.json decodes and resolves")
    func shippedPinIsUsable() throws {
        let pinURL = Self.repoRoot().appendingPathComponent("scripts/cliproxyapi-pin.json")
        let data = try Data(contentsOf: pinURL)
        let pin = try JSONDecoder().decode(CLIProxyBundlePin.self, from: data)
        #expect(pin.tag?.isEmpty == false)
        #expect(pin.commit?.isEmpty == false)
        let resolved = resolveCLIProxyBinaryURL(appBundleURL: Self.appRoot, bundlePath: pin.bundlePath)
        #expect(resolved != nil)
    }

    /// TRIPWIRE managed-proxy-pin-is-staged: the app can only resolve the
    /// proxy binary if release-dmg.sh actually stages the pin at the resource
    /// name `CLIProxyBundlePin` looks for. A rename on either side turns the
    /// managed proxy permanently "unavailable" in a shipped build — silently,
    /// because an absent pin is also the legitimate dev-build signal.
    @Test("release-dmg.sh stages the pin at the resource name the app reads")
    func releaseScriptStagesThePin() throws {
        let script = try String(
            contentsOf: Self.repoRoot().appendingPathComponent("scripts/release-dmg.sh"),
            encoding: .utf8
        )
        #expect(
            script.contains("Contents/Resources/\(CLIProxyBundlePin.bundleResourceName).json"),
            "release-dmg.sh no longer stages the CLIProxyAPI pin where CLIProxyBundlePin.load() looks for it"
        )
    }
}

// MARK: - Lifecycle

@Suite("Issue #421 — managed proxy lifecycle")
@MainActor
struct ManagedProxyModelTests {
    @Test("a dev build shows an honest unavailable state and starts nothing")
    func devBuildStandsDown() async {
        let harness = makeHarness(available: false)
        await harness.model.evaluateOnLaunch()
        #expect(harness.model.phase == .unavailable)
        #expect(harness.model.isAvailable == false)
        #expect(harness.process.startCount == 0)
        #expect(harness.config.writes.isEmpty)
        // No offer, and no network activity either.
        #expect(harness.health.probeCount == 0)
    }

    @Test("launch starts the embedded binary against the shared config dir")
    func launchStartsManagedInstance() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        #expect(harness.model.phase == .running)
        #expect(harness.process.startCount == 1)
        #expect(harness.process.startedConfigFiles == [harness.paths.configFile])
        // #398: the SAME directory an external instance uses.
        #expect(harness.paths.configDirectory.path.hasSuffix(".config/cliproxyapi"))
    }

    @Test("killing the proxy restarts it, after a real backoff")
    func crashRestarts() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        #expect(harness.process.startCount == 1)

        harness.process.simulateCrash()
        await harness.model.superviseOnce()

        #expect(harness.process.startCount == 2)
        #expect(harness.model.restartCount == 2)
        #expect(harness.model.phase == .running)
        // Bounded backoff, not a tight loop.
        #expect(harness.delays.recorded == [1])
    }

    @Test("a crash loop stops restarting and surfaces an actionable failure")
    func crashLoopGivesUp() async {
        let harness = makeHarness(maxRestarts: 3)
        await harness.model.evaluateOnLaunch()
        for _ in 0..<5 {
            harness.process.simulateCrash()
            await harness.model.superviseOnce()
        }
        #expect(harness.model.phase == .failed(ManagedProxyModel.crashLoopMessage))
        // 1 initial launch + at most maxRestarts restarts — never a launch per tick.
        #expect(harness.process.startCount == 4)
        // Every wait was a real one.
        #expect(harness.delays.recorded.allSatisfy { $0 > 0 })
        #expect(harness.delays.recorded == [1, 2, 4])
    }

    // PR #430 review (Major): a spawn that always THROWS must climb the same
    // bounded ladder as a crashing child — counting attempts only after a
    // successful start let a doomed launch retry forever.
    @Test("a spawn that always throws exhausts the restart budget and gives up")
    func throwingSpawnGivesUp() async {
        struct SpawnRefused: Error {}
        let harness = makeHarness()
        harness.process.startError = SpawnRefused()
        await harness.model.evaluateOnLaunch()
        for _ in 0..<6 { await harness.model.superviseOnce() }
        #expect(harness.model.phase == .failed(ManagedProxyModel.crashLoopMessage))
        // The failed attempts advanced the same bounded ladder as real
        // crashes — five waits, doubling to the cap, then give-up — and every
        // wait was followed by a real launch attempt (PR #430 round 2).
        #expect(harness.delays.recorded == [1, 2, 4, 8, 16])
        #expect(harness.process.startCount == 6)
    }

    @Test("a user-initiated stop stays down across supervision ticks")
    func userStopStaysDown() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        #expect(harness.process.startCount == 1)

        await harness.model.stopManaging()
        #expect(harness.model.phase == .stopped)
        #expect(harness.process.stopCount == 1)

        for _ in 0..<3 { await harness.model.superviseOnce() }
        #expect(harness.model.phase == .stopped)
        #expect(harness.process.startCount == 1)
        #expect(harness.model.desiredState == .stopped)
    }

    @Test("an explicit start after a stop brings it back")
    func userStartAfterStop() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        await harness.model.stopManaging()
        await harness.model.startManaging()
        #expect(harness.model.phase == .running)
        #expect(harness.process.startCount == 2)
        #expect(harness.model.desiredState == .running)
    }

    @Test("SAFETY RAIL: an external proxy on the port is refused, never joined")
    func externalInstanceRefused() async {
        let harness = makeHarness(answering: true)
        await harness.model.evaluateOnLaunch()

        #expect(harness.model.phase == .externalInstanceDetected)
        // Nothing started, nothing written, nothing of the user's stopped.
        #expect(harness.process.startCount == 0)
        #expect(harness.process.stopCount == 0)
        #expect(harness.config.writes.isEmpty)

        // And it stays refused — the refusal is not a one-shot notice.
        for _ in 0..<3 { await harness.model.superviseOnce() }
        #expect(harness.model.phase == .externalInstanceDetected)
        #expect(harness.process.startCount == 0)
    }

    @Test("SAFETY RAIL: an external proxy that appears before the restart tick is refused")
    func externalInstanceBeforeRestartTick() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        harness.process.simulateCrash()
        harness.health.answering = true
        await harness.model.superviseOnce()

        #expect(harness.model.phase == .externalInstanceDetected)
        #expect(harness.process.startCount == 1)
    }

    @Test("SAFETY RAIL: an external proxy claiming the port DURING the backoff aborts the restart")
    func externalInstanceDuringBackoff() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        harness.process.simulateCrash()
        // Someone else binds the port while we are waiting out the backoff.
        let health = harness.health
        harness.delays.onSleep = { health.answering = true }
        await harness.model.superviseOnce()

        // The restart was already committed to when the port was free; the
        // post-sleep re-check is what stops the double-consume.
        #expect(harness.delays.recorded == [1])
        #expect(harness.model.phase == .externalInstanceDetected)
        #expect(harness.process.startCount == 1)
    }

    @Test("a user stop before the restart tick is honored instead of the restart")
    func userStopBeforeRestartTick() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        harness.process.simulateCrash()
        await harness.model.stopManaging()
        await harness.model.superviseOnce()
        #expect(harness.model.phase == .stopped)
        #expect(harness.process.startCount == 1)
    }

    @Test("health is the port answering, not merely a process existing")
    func healthTracksThePort() async {
        let harness = makeHarness()
        await harness.model.evaluateOnLaunch()
        // Spawned, but nothing has answered yet.
        #expect(harness.model.phase == .running)
        #expect(harness.model.lastHealthyAt == nil)

        harness.health.answering = true
        await harness.model.superviseOnce()
        #expect(harness.model.lastHealthyAt == Date(timeIntervalSince1970: 1_000))
    }

    @Test("an instance that stays up earns a fresh crash budget")
    func sustainedHealthResetsTheLadder() async {
        let harness = makeHarness(healthyResetInterval: 0)
        await harness.model.evaluateOnLaunch()
        #expect(harness.model.restartCount == 1)
        // It came up and answered; the next tick clears the crash budget.
        harness.health.answering = true
        await harness.model.superviseOnce()
        #expect(harness.model.restartCount == 0)
    }

    @Test("a config failure surfaces instead of launching blind")
    func configFailureIsVisible() async {
        let harness = makeHarness()
        harness.config.error = ManagedProxyWriteGuard.Violation.authFileWrite("/fixture/auth/claude.json")
        await harness.model.evaluateOnLaunch()
        guard case .failed(let message) = harness.model.phase else {
            Issue.record("expected a failed phase, got \(harness.model.phase)")
            return
        }
        #expect(message.contains("proxy configuration"))
        #expect(harness.process.startCount == 0)
    }

    @Test("issue #432 lifecycle transitions each produce exactly one report")
    func lifecycleTransitionsReportOnce() async {
        let reporter = RecordingManagedProxyReporter()
        let harness = makeHarness(reporter: reporter)

        await harness.model.evaluateOnLaunch()
        var reports = await awaitReports(reporter, count: 1)
        #expect(reports.map(\.phase) == [ManagedProxyReportPhase.started])
        if let started = reports.first {
            #expect(started.managed)
            #expect(started.pid == 7_001)
            #expect(started.restartCount == 1)
            #expect(started.appVersion == "1.0.0-test")
            #expect(started.reportedAt == "1970-01-01T00:16:40.000Z")
        }

        harness.process.simulateCrash()
        await harness.model.superviseOnce()
        reports = await awaitReports(reporter, count: 2)
        #expect(reports.map(\.phase) == [
            ManagedProxyReportPhase.started,
            ManagedProxyReportPhase.restart,
        ])
        if reports.indices.contains(1) {
            #expect(reports[1].pid == 7_002)
            #expect(reports[1].restartCount == 2)
        }

        await harness.model.stopManaging()
        reports = await awaitReports(reporter, count: 3)
        #expect(reports.map(\.phase) == [
            ManagedProxyReportPhase.started,
            ManagedProxyReportPhase.restart,
            ManagedProxyReportPhase.stopped,
        ])
        if reports.indices.contains(2) {
            #expect(!reports[2].managed)
            #expect(reports[2].pid == nil)
            #expect(reports[2].restartCount == 0)
        }

        // Steady-state stopped ticks are not lifecycle transitions.
        await harness.model.superviseOnce()
        for _ in 0..<20 { await Task.yield() }
        #expect(await reporter.snapshot().count == 3)
    }

    @Test("issue #432 crash give-up and adoption report once each")
    func terminalAndAdoptionTransitionsReportOnce() async {
        let crashReporter = RecordingManagedProxyReporter()
        let crashing = makeHarness(maxRestarts: 1, reporter: crashReporter)
        await crashing.model.evaluateOnLaunch()
        crashing.process.simulateCrash()
        await crashing.model.superviseOnce()
        crashing.process.simulateCrash()
        await crashing.model.superviseOnce()
        // A later monitoring tick remains failed and must not report again.
        await crashing.model.superviseOnce()
        let crashReports = await awaitReports(crashReporter, count: 3)
        #expect(crashReports.map(\.phase) == [
            ManagedProxyReportPhase.started,
            ManagedProxyReportPhase.restart,
            ManagedProxyReportPhase.crashGaveUp,
        ])
        if crashReports.indices.contains(2) {
            #expect(crashReports[2].managed)
            #expect(crashReports[2].pid == nil)
        }

        let adoptionReporter = RecordingManagedProxyReporter()
        let adopted = makeHarness(reporter: adoptionReporter)
        await adopted.model.startManagingAfterAdoption()
        let adoptionReports = await awaitReports(adoptionReporter, count: 1)
        #expect(adoptionReports.map(\.phase) == [ManagedProxyReportPhase.adopted])
    }

    @Test("issue #432 reporting failures are logged and never break lifecycle")
    func reportFailureIsLoggedNotThrown() async {
        let failures = ReportFailureRecorder()
        let harness = makeHarness(
            reporter: FailingManagedProxyReporter(),
            reportFailure: { failures.record($0) }
        )

        await harness.model.evaluateOnLaunch()
        for _ in 0..<1_000 where failures.messages.isEmpty {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(harness.model.phase == .running)
        #expect(harness.process.startCount == 1)
        #expect(failures.messages == ["managed-proxy report failed: daemon unavailable"])
    }

    @Test("issue #432 an unmanaged app emits no report")
    func unmanagedEmitsNothing() async {
        let reporter = RecordingManagedProxyReporter()
        let unavailable = makeHarness(available: false, reporter: reporter)
        await unavailable.model.evaluateOnLaunch()

        let external = makeHarness(answering: true, reporter: reporter)
        await external.model.evaluateOnLaunch()

        let neverStarted = makeHarness(reporter: reporter)
        await neverStarted.model.stopManaging()
        for _ in 0..<20 { await Task.yield() }
        #expect(await reporter.snapshot().isEmpty)
    }
}

// MARK: - Config writer (real code, temp directory)

@Suite("Issue #421 — managed proxy config writer")
struct ManagedProxyConfigWriterTests {
    private func makePaths() -> (ManagedProxyPaths, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("modeldeck-managed-proxy-\(UUID().uuidString)", isDirectory: true)
        return (ManagedProxyPaths(configDirectory: root.appendingPathComponent(".config/cliproxyapi", isDirectory: true)), root)
    }

    @Test("a missing config is seeded with host, port and the shared auth dir")
    func seedsMissingConfig() throws {
        let (paths, root) = makePaths()
        defer { try? FileManager.default.removeItem(at: root) }

        let written = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
        #expect(written == paths.configFile)
        let text = try String(contentsOf: written, encoding: .utf8)
        #expect(text.contains("port: 8317"))
        #expect(text.contains("host: \"127.0.0.1\""))
        #expect(text.contains(paths.authDirectory.path))
        // Provider credentials remain CLIProxyAPI's alone (#398). The
        // management secret is not one of those — #431 seeds it deliberately.
        #expect(!text.lowercased().contains("api-key"))
        #expect(text.contains("secret-key:"))
    }

    @Test("an existing config is never modified — adoption stays non-destructive")
    func neverOverwritesExistingConfig() throws {
        let (paths, root) = makePaths()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        let original = "port: 8317\n# the user's own config, hand-tuned\n"
        try Data(original.utf8).write(to: paths.configFile)

        let written = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
        #expect(written == paths.configFile)
        #expect(try String(contentsOf: paths.configFile, encoding: .utf8) == original)
    }

    @Test("the writer creates the config and its management key, and nothing else")
    func writesExactlyOneFile() throws {
        let (paths, root) = makePaths()
        defer { try? FileManager.default.removeItem(at: root) }

        _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
        let contents = Set(try FileManager.default.contentsOfDirectory(atPath: paths.configDirectory.path))
        #expect(contents == [
            ManagedProxyWriteGuard.configFileName,
            ManagedProxyWriteGuard.managementKeyFileName,
        ])
        // Emphatically: no auth directory was created or populated.
        #expect(!FileManager.default.fileExists(atPath: paths.authDirectory.path))
    }
}

// MARK: - Loopback posture

@Suite("Issue #421 — proxy health probe stays on loopback")
struct ProxyHealthProbeTests {
    @Test("only loopback HTTP URLs are probeable")
    func loopbackOnly() {
        #expect(isLoopbackProxyURL(URL(string: "http://127.0.0.1:8317")!))
        #expect(isLoopbackProxyURL(URL(string: "http://localhost:8317")!))
        #expect(!isLoopbackProxyURL(URL(string: "http://example.com:8317")!))
        #expect(!isLoopbackProxyURL(URL(string: "http://10.0.0.4:8317")!))
        #expect(!isLoopbackProxyURL(URL(string: "file:///etc/passwd")!))
    }

    @Test("a non-loopback base URL never sends a request")
    func nonLoopbackProbeIsInert() async {
        let probe = CLIProxyHealthProbe(baseURL: URL(string: "http://example.com:8317")!)
        #expect(await probe.probeProxy() == false)
    }
}
