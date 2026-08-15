import Foundation
import os

// Issue #422 — live implementations of the first-launch seams. Constructed
// only by the app target; unit tests use fakes and never touch port 8317,
// never read a real management key, and never stop a process.
//
// Two rules bind everything in this file:
//   * detection makes exactly ONE named management call (an authenticated
//     GET /v0/management/config), never a walk over management endpoints;
//   * nothing here runs unless the user pressed a button in the flow.

// MARK: - Detection

/// Port probe + the single named management handshake, in one round-trip the
/// caller can't decompose. The management key is read INSIDE the call and
/// dropped immediately — it is never stored on this object, logged, or shown,
/// the same discipline src/usage-queue-consumer.mjs keeps on the Node side.
public struct CLIProxyExternalDetector: ExternalProxyDetecting {
    private let baseURL: URL
    private let managementKeyPath: URL
    private let session: URLSession

    public init(baseURL: URL, managementKeyPath: URL, timeout: TimeInterval = 3) {
        self.baseURL = baseURL
        self.managementKeyPath = managementKeyPath
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        session = URLSession(configuration: configuration)
    }

    /// The one non-destructive management endpoint the project already names
    /// (scripts/build-cliproxyapi.sh's release handshake and the #420 pin
    /// compatibility suite). `/v0/management/usage-queue` must never be used
    /// for identification: its read CONSUMES the queue (#400).
    static let handshakePath = "v0/management/config"

    public func detectExternalProxy() async -> ExternalProxyProbe {
        guard isLoopbackProxyURL(baseURL) else { return .silent }
        guard await portAnswers() else { return .silent }
        return ExternalProxyProbe(portAnswering: true, handshake: await handshake())
    }

    private func portAnswers() async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent("healthz"))
        request.httpMethod = "GET"
        guard let (_, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse
        else { return false }
        // Any HTTP answer proves the port is occupied — the same read slice
        // C's occupancy probe takes.
        return (200..<500).contains(http.statusCode)
    }

    private func handshake() async -> ManagementHandshake {
        guard let key = readManagementKey(), !key.isEmpty else { return .keyUnavailable }
        var request = URLRequest(url: baseURL.appendingPathComponent(Self.handshakePath))
        request.httpMethod = "GET"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        guard let (_, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse
        else { return .inconclusive }
        return classifyManagementHandshakeStatus(http.statusCode)
    }

    /// Read and trim, never retain. A missing or unreadable file is the
    /// honest "couldn't confirm", not an error worth surfacing a path for.
    private func readManagementKey() -> String? {
        guard let data = try? Data(contentsOf: managementKeyPath),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// HTTP status → handshake outcome, kept pure for tests.
public func classifyManagementHandshakeStatus(_ status: Int) -> ManagementHandshake {
    switch status {
    case 200..<300: return .confirmed
    case 401, 403: return .rejected
    default: return .inconclusive
    }
}

// MARK: - Supervision discovery

/// Finds how the user's own CLIProxyAPI is kept alive: the SERVING process
/// first, then the launchd job that owns exactly that process. Read-only — it
/// inspects, it never acts. Anything it cannot name comes back `.unknown`,
/// which makes adoption REFUSE rather than half-stop something.
///
/// Identification is by EXECUTABLE, never by name. A real install (the #422
/// field case) also runs `com.cliproxyapi.rebalance-weights` — a python job
/// whose label AND arguments both contain "cliproxyapi". Matching on the word
/// would have booted out the rebalance cron, the very user-run op #401a says
/// adoption must tolerate, while leaving the actual server running.
public struct CLIProxySupervisionInspector: ExternalProxySupervisionInspecting {
    private let launchAgentsDirectory: URL

    public init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        launchAgentsDirectory = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    public func inspectSupervision() async -> ExternalProxySupervision {
        let processes = await runTool("/bin/ps", ["-Ao", "pid=,command="])
        guard let running = findCLIProxyServerProcess(
            psOutput: processes.output,
            ownPID: ProcessInfo.processInfo.processIdentifier
        ) else { return .unknown }
        if let agent = launchAgent(runningExecutable: running.executable) { return agent }
        return .plainProcess(pid: running.pid, command: running.command)
    }

    /// The launchd job that runs THIS executable, if any.
    private func launchAgent(runningExecutable: String) -> ExternalProxySupervision? {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: launchAgentsDirectory,
            includingPropertiesForKeys: nil
        ) else { return nil }
        for url in entries.sorted(by: { $0.path < $1.path }) where url.pathExtension == "plist" {
            guard let data = try? Data(contentsOf: url),
                  let plist = try? PropertyListSerialization.propertyList(
                      from: data, options: [], format: nil
                  ) as? [String: Any],
                  let label = plist["Label"] as? String,
                  isCLIProxyServerLaunchAgent(
                      label: label,
                      program: plist["Program"] as? String,
                      arguments: plist["ProgramArguments"] as? [String],
                      runningExecutable: runningExecutable
                  )
            else { continue }
            return .launchAgent(label: label, plistPath: url.path)
        }
        return nil
    }
}

/// One `ps` row that is a CLIProxyAPI SERVER.
public struct CLIProxyProcess: Equatable, Sendable {
    public var pid: Int32
    /// The full command line, as the record quotes it back to the user.
    public var command: String
    /// The executable path — the identity the launchd match keys on.
    public var executable: String
}

/// Picks the serving proxy out of `ps -Ao pid=,command=`. A row qualifies only
/// when its EXECUTABLE is named `cliproxyapi`; a job that merely mentions the
/// word in a path or a label is not a proxy.
public func findCLIProxyServerProcess(psOutput: String, ownPID: Int32) -> CLIProxyProcess? {
    for line in psOutput.split(whereSeparator: \.isNewline) {
        let row = line.trimmingCharacters(in: .whitespaces)
        guard let split = row.firstIndex(of: " "),
              let pid = Int32(row[row.startIndex..<split]), pid > 0, pid != ownPID
        else { continue }
        let command = String(row[row.index(after: split)...])
            .trimmingCharacters(in: .whitespaces)
        guard let executable = command.split(separator: " ").first.map(String.init),
              isCLIProxyExecutable(executable)
        else { continue }
        return CLIProxyProcess(pid: pid, command: command, executable: executable)
    }
    return nil
}

/// True iff the path's last component is the proxy binary itself.
public func isCLIProxyExecutable(_ path: String) -> Bool {
    (path as NSString).lastPathComponent.lowercased() == "cliproxyapi"
}

/// True iff a LaunchAgent plist runs exactly the executable the serving proxy
/// is running — and is not one of ModelDeck's own jobs, which this flow must
/// never touch.
public func isCLIProxyServerLaunchAgent(
    label: String,
    program: String?,
    arguments: [String]?,
    runningExecutable: String
) -> Bool {
    guard !label.lowercased().contains("modeldeck") else { return false }
    guard let executable = program ?? arguments?.first,
          isCLIProxyExecutable(executable)
    else { return false }
    return executable == runningExecutable
}

// MARK: - Stopping the user's proxy

/// Stops the user's own proxy — the ONE side effect in this flow that touches
/// something ModelDeck didn't start, reached only from the explicit adoption
/// button. A plain process gets exactly one polite SIGTERM; ModelDeck never
/// SIGKILLs a process it did not spawn.
public struct CLIProxyExternalStopper: ExternalProxyStopping {
    private let uid: UInt32
    private let graceSeconds: TimeInterval

    public init(uid: UInt32 = getuid(), graceSeconds: TimeInterval = 5) {
        self.uid = uid
        self.graceSeconds = graceSeconds
    }

    public func stopExternalProxy(_ plan: AdoptionPlan) async -> Bool {
        switch plan {
        case .stopLaunchAgent(let label, _):
            let result = await runTool("/bin/launchctl", ["bootout", "gui/\(uid)/\(label)"])
            // 113 is launchctl's "could not find service" — the job is
            // already gone, which is the goal state (same classification
            // slice #96's launchd control uses).
            return result.status == 0 || result.status == 113
        case .terminateProcess(let pid, let command):
            // The pid was read at inspection time; the user reads the offer
            // before clicking (PR #433 review). If the proxy exited in that
            // window and macOS reused the pid, SIGTERM would hit an unrelated
            // process while the record claimed we stopped the proxy.
            // Re-confirm the pid still runs the same command line.
            let recheck = await runTool("/bin/ps", ["-o", "command=", "-p", "\(pid)"])
            let current = recheck.output.trimmingCharacters(in: .whitespacesAndNewlines)
            guard recheck.status == 0, current == command else { return false }
            guard kill(pid, SIGTERM) == 0 else { return false }
            let deadline = Date().addingTimeInterval(graceSeconds)
            while Date() < deadline {
                if kill(pid, 0) != 0 { return true }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            // Still alive after the grace period: say so instead of
            // escalating to a kill the user never agreed to.
            return kill(pid, 0) != 0
        case .refuse:
            // Unreachable by construction — the model never stops on a
            // refusal — and defensively a no-op if it ever were reached.
            return false
        }
    }
}

// MARK: - Remembered choice

/// UserDefaults-backed record of the first-launch answer, plus the
/// supervision adoption took over from (the rollback's only input about the
/// user's own setup). Same storage convention as the daemon setup's marker.
public final class UserDefaultsManagedProxyOnboardingStore: ManagedProxyOnboardingStoring, @unchecked Sendable {
    private static let choiceKey = "managedProxyOnboardingChoice"
    private static let supervisionKey = "managedProxyAdoptedSupervision"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var choice: ManagedProxyOnboardingChoice? {
        get {
            guard let raw = defaults.string(forKey: Self.choiceKey) else { return nil }
            return ManagedProxyOnboardingChoice(rawValue: raw)
        }
        set {
            if let newValue {
                defaults.set(newValue.rawValue, forKey: Self.choiceKey)
            } else {
                defaults.removeObject(forKey: Self.choiceKey)
            }
        }
    }

    public var adoptedSupervision: ExternalProxySupervision? {
        get {
            guard let data = defaults.data(forKey: Self.supervisionKey) else { return nil }
            return try? JSONDecoder().decode(ExternalProxySupervision.self, from: data)
        }
        set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                defaults.removeObject(forKey: Self.supervisionKey)
                return
            }
            defaults.set(data, forKey: Self.supervisionKey)
        }
    }
}

// MARK: - Small process runner

/// Runs a read-only tool without blocking the calling actor and with a hard
/// deadline, returning its exit status and stdout. Mirrors the daemon setup's
/// launchctl runner; a hung tool reports the synthetic 127 the callers treat
/// as "don't know".
func runTool(
    _ executablePath: String,
    _ arguments: [String],
    deadline: TimeInterval = 5
) async -> (status: Int32, output: String) {
    await withCheckedContinuation { continuation in
        let resumeOnce = ToolResumeOnce(continuation)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        // CodeRabbit (PR #433 full review): the pipe is drained WHILE the tool
        // runs. Reading only after termination let a response larger than the
        // pipe buffer (a full `ps -Ao` easily is) block the child, ride into
        // the deadline, and turn a healthy answer into the synthetic 127 —
        // which inspectSupervision() reads as "don't know" and refuses
        // adoption over.
        let drain = ToolOutputDrain(pipe.fileHandleForReading)
        process.terminationHandler = { finished in
            resumeOnce.resume(finished.terminationStatus, drain.awaitOutput())
        }
        drain.begin()
        do {
            try process.run()
        } catch {
            // The child never existed, so nothing will ever close the write
            // end — close it here or the drain thread waits forever.
            try? pipe.fileHandleForWriting.close()
            resumeOnce.resume(127, "")
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + deadline) {
            guard process.isRunning else { return }
            process.terminate()
            resumeOnce.resume(127, "")
        }
    }
}

/// Drains a tool's stdout on a background thread while the tool runs, so the
/// pipe buffer can never fill and block the child (CodeRabbit, PR #433).
/// EOF arrives when the child's write end closes at exit; `awaitOutput` then
/// hands the accumulated bytes to the termination handler.
private final class ToolOutputDrain: @unchecked Sendable {
    private let handle: FileHandle
    private let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var data = Data()

    init(_ handle: FileHandle) {
        self.handle = handle
    }

    func begin() {
        DispatchQueue.global().async {
            let read = (try? self.handle.readToEnd()) ?? nil
            self.lock.lock()
            self.data = read ?? Data()
            self.lock.unlock()
            self.finished.signal()
        }
    }

    /// Waits briefly for the drain's EOF; a tool that somehow keeps the pipe
    /// open yields empty output — callers already treat an incomplete answer
    /// as "don't know".
    func awaitOutput() -> String {
        _ = finished.wait(timeout: .now() + 2)
        lock.lock()
        defer { lock.unlock() }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

/// Serializes exactly one resume across the termination handler, the launch
/// failure, and the deadline.
private final class ToolResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<(status: Int32, output: String), Never>?

    init(_ continuation: CheckedContinuation<(status: Int32, output: String), Never>) {
        self.continuation = continuation
    }

    func resume(_ status: Int32, _ output: String) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: (status, output))
    }
}

// MARK: - Assembly

extension ManagedProxyOnboardingModel.Dependencies {
    /// The app's production wiring. The lifecycle callbacks are slice C's
    /// model — this flow decides WHETHER to manage; that model still owns
    /// every start, stop, and restart.
    @MainActor
    public static func live(
        proxy: ManagedProxyModel,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        port: Int = ManagedProxyDefaults.port,
        defaults: UserDefaults = .standard
    ) -> Self {
        let paths = ManagedProxyPaths.standard(home: home)
        return .init(
            detector: CLIProxyExternalDetector(
                baseURL: loopbackBaseURL(port: port),
                // src/paths.mjs CLIPROXY_MANAGEMENT_KEY_PATH. One authority
                // for the path now that seeding may create it (#431); this
                // detector still only READS whatever is there.
                managementKeyPath: paths.managementKeyFile
            ),
            supervision: CLIProxySupervisionInspector(home: home),
            stopper: CLIProxyExternalStopper(),
            store: UserDefaultsManagedProxyOnboardingStore(defaults: defaults),
            bundleAvailable: proxy.isAvailable,
            startManagedProxy: { [weak proxy] in await proxy?.startManaging() },
            stopManagedProxy: { [weak proxy] in await proxy?.stopManaging() },
            adoptManagedProxy: { [weak proxy] in await proxy?.startManagingAfterAdoption() }
        )
    }
}
