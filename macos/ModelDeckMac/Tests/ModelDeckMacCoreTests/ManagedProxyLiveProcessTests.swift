import Foundation
import Network
import os
import Testing
@testable import ModelDeckMacCore

// Issue #421 — the acceptance criterion "kill the proxy process → the shell
// restarts it" exercised against REAL processes, not fakes: the production
// ManagedProxyProcessController spawning, noticing death, and terminating
// actual children.
//
// Safety: these stand-ins bind NO socket. Nothing here opens port 8317, talks
// to the live daemon, or touches ~/.config/cliproxyapi.
//   * /bin/sleep rejects `-config <file>` and exits immediately — a real
//     process that really dies, i.e. the crash.
//   * /usr/bin/yes accepts the same arguments as operands and runs forever
//     (its output goes to nullDevice) — a real process that must be killed.

private let crashingBinary = URL(fileURLWithPath: "/bin/sleep")
private let longLivedBinary = URL(fileURLWithPath: "/usr/bin/yes")

private func waitUntilNotRunning(
    _ controller: ManagedProxyProcessController,
    _ token: ManagedProxyProcessToken,
    timeout: TimeInterval = 5
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if !controller.isRunning(token) { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return !controller.isRunning(token)
}

@Suite("Issue #421 — live process control (real processes, no sockets)")
struct ManagedProxyLiveProcessTests {
    private func scratch() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("modeldeck-live-proxy-\(UUID().uuidString)", isDirectory: true)
    }

    @Test("a spawned process that exits is really observed as gone")
    func realCrashIsObserved() async throws {
        let root = scratch()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let controller = ManagedProxyProcessController()
        let token = try controller.start(
            executable: crashingBinary,
            configFile: root.appendingPathComponent("config.yaml"),
            workingDirectory: root
        )
        #expect(await waitUntilNotRunning(controller, token))
        // Stopping an already-dead child is safe and does nothing.
        await controller.stop(token)
    }

    @Test("a live child is really terminated by stop, and only ours")
    func realStopTerminates() async throws {
        let root = scratch()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let controller = ManagedProxyProcessController()
        let token = try controller.start(
            executable: longLivedBinary,
            configFile: root.appendingPathComponent("config.yaml"),
            workingDirectory: root
        )
        #expect(controller.isRunning(token))
        await controller.stop(token)
        #expect(!controller.isRunning(token))

        // A token the controller never issued is not ours to touch: it
        // reports not-running and stopping it is a no-op, never a stray kill.
        let foreign = ManagedProxyProcessToken(id: 999_999)
        #expect(!controller.isRunning(foreign))
        await controller.stop(foreign)
    }

    /// The end-to-end criterion: a real process dies, the real supervisor
    /// notices and relaunches a real process, on a bounded backoff, and stops
    /// after the budget rather than looping forever.
    @Test("the supervisor restarts a real crashing process, then gives up")
    @MainActor
    func supervisorRestartsRealProcesses() async throws {
        let root = scratch()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let paths = ManagedProxyPaths(configDirectory: root)
        let delays = LiveDelayLog()
        let model = ManagedProxyModel(
            dependencies: .init(
                bundle: ManagedProxyBundle(binaryURL: crashingBinary, version: "test"),
                paths: paths,
                process: ManagedProxyProcessController(),
                // Nothing is listening — and nothing may listen: an answering
                // port would (correctly) read as a foreign instance.
                health: UnreachableProxyProbe(),
                config: ManagedProxyConfigFileWriter(),
                port: 0
            ),
            maxRestarts: 2,
            sleep: { delays.record($0) }
        )

        await model.evaluateOnLaunch()
        #expect(model.phase == .running)
        #expect(model.restartCount == 1)

        // Each tick after the child has died must relaunch a real process.
        for _ in 0..<3 {
            try? await Task.sleep(nanoseconds: 300_000_000)
            await model.superviseOnce()
        }

        #expect(model.phase == .failed(ManagedProxyModel.crashLoopMessage))
        // 1 launch + 2 restarts, then it stopped trying.
        #expect(model.restartCount == 3)
        #expect(delays.recorded == [1, 2])
        // The config and its seed-time management key (#431) are the only
        // things on disk — no auth directory, no stray files.
        let written = Set(try FileManager.default.contentsOfDirectory(atPath: root.path))
        #expect(written == [
            ManagedProxyWriteGuard.configFileName,
            ManagedProxyWriteGuard.managementKeyFileName,
        ])
    }
}

// MARK: - The 8317 refusal, against a real listener

/// A real HTTP responder on a real loopback socket, so the refusal rail can be
/// exercised with the production probe instead of a fake. Deliberately an
/// EPHEMERAL port bound to 127.0.0.1: the proxy's own 8317 is never bound by
/// this suite, and nothing here is reachable off the machine.
private final class LoopbackResponder: @unchecked Sendable {
    private let listener: NWListener
    private(set) var port: UInt16 = 0

    init() throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
                let body = "ok"
                let response = "HTTP/1.1 200 OK\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
    }

    func start() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resumed = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { [weak listener] state in
                // Terminal states resume too (PR #430 review): a sandbox
                // that forbids binding must FAIL the port expectation, not
                // hang the suite on an unresumed continuation.
                switch state {
                case .ready, .failed(_), .cancelled: break
                default: return
                }
                let alreadyResumed = resumed.withLock { value -> Bool in
                    let was = value
                    value = true
                    return was
                }
                guard !alreadyResumed else { return }
                continuation.resume()
                _ = listener
            }
            listener.start(queue: .global())
        }
        port = listener.port?.rawValue ?? 0
    }

    func stop() { listener.cancel() }
}

@Suite("Issue #421 — SAFETY RAIL against a real listener")
struct ManagedProxyRefusalIntegrationTests {
    /// The production probe against a real socket, then the production
    /// decision: something answers, so ModelDeck starts nothing and writes
    /// nothing. (The port is ephemeral — this suite never binds 8317.)
    @Test("a real answering port makes the shell refuse to start its own proxy")
    @MainActor
    func refusesAgainstRealListener() async throws {
        let responder = try LoopbackResponder()
        await responder.start()
        defer { responder.stop() }
        #expect(responder.port != 0)
        #expect(responder.port != UInt16(ManagedProxyDefaults.port),
                "this test must never bind the real proxy port")

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("modeldeck-refusal-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let probe = CLIProxyHealthProbe(
            baseURL: URL(string: "http://127.0.0.1:\(responder.port)")!
        )
        // The production probe really sees the real listener.
        #expect(await probe.probeProxy())

        let model = ManagedProxyModel(
            dependencies: .init(
                bundle: ManagedProxyBundle(binaryURL: longLivedBinary, version: "test"),
                paths: ManagedProxyPaths(configDirectory: root),
                process: ManagedProxyProcessController(),
                health: probe,
                config: ManagedProxyConfigFileWriter(),
                port: Int(responder.port)
            ),
            sleep: { _ in }
        )

        await model.evaluateOnLaunch()

        #expect(model.phase == .externalInstanceDetected)
        // Nothing started, nothing configured, and the listener is untouched.
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
        #expect(await probe.probeProxy(), "ModelDeck must never stop a proxy the user runs")
    }
}

private final class LiveDelayLog: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var recorded: [TimeInterval] = []
    func record(_ seconds: TimeInterval) { lock.withLock { recorded.append(seconds) } }
}

// TRIPWIRE runtool-pipe-drain (CodeRabbit, PR #433 full review): reading
// stdout only after termination let any response larger than the pipe buffer
// block the child into the deadline's synthetic 127 — and a full `ps -Ao`
// listing is routinely larger. Real process, real pipe: 200 KB must arrive
// intact, well inside the deadline.
struct RunToolPipeDrainTests {
    @Test("a tool whose output exceeds the pipe buffer completes instead of hitting the deadline")
    func drainsLargeOutput() async {
        let result = await runTool(
            "/bin/sh", ["-c", "/usr/bin/yes x | /usr/bin/head -c 200000"],
            deadline: 4
        )
        #expect(result.status == 0)
        #expect(result.output.utf8.count == 200_000)
    }

    @Test("a hung tool still reports the synthetic 127 the callers treat as don't-know")
    func deadlineStillFires() async {
        let began = Date()
        let result = await runTool("/bin/sleep", ["30"], deadline: 0.3)
        // The answer must come from the 0.3s deadline, not the child's own
        // 30s exit — a generous ceiling, but orders of magnitude apart.
        #expect(Date().timeIntervalSince(began) < 2)
        #expect(result.status == 127)
        #expect(result.output.isEmpty)
    }
}
