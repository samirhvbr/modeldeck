import CryptoKit
import Foundation
import Security

// Issue #520 — the live edges of client-key provisioning: the key generator,
// the SHA-256 helper, the `/usr/bin/security` runner that feeds commands over
// stdin, and the persisted monotonic report generation.
//
// Deliberately NOT here: SecItemAdd. Recon V5
// (docs/research/keys-riders-recon-v1-v5.md) proved an item created in-process
// raises a SecurityAgent dialog when `/usr/bin/security` reads it — a hang in
// the headless children the helper exists to serve (#277). The stdin-fed CLI
// with `-T /usr/bin/security` is the shipping create path. A static tripwire
// test fails the build if SecItemAdd or a kSecClass constant appears in the
// client-key sources.

// MARK: - Key generation and hashing

public enum ClientKeyGenerator {
    /// 32 random bytes, base64url, unpadded — the same shape and generator
    /// discipline as the management secret
    /// (`ManagedProxyLive.generateManagementSecret`). Design §2.1.
    public static let generate: @Sendable () throws -> String = {
        var bytes = [UInt8](repeating: 0, count: 32)
        let rc = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard rc == errSecSuccess else {
            throw ClientKeyProvisioningError.keyGenerationFailed(status: rc)
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Lowercase hex SHA-256. The only key-derived value that ever leaves the
    /// app: the daemon stores hashes of our own 256-bit random keys, which are
    /// not recoverable key material (design §2.2, §3.1).
    public static let sha256Hex: @Sendable (String) -> String = { value in
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// SHA-256 of "". Recon V1: a keyless request's usage record carries
    /// `"api_key": ""`, so this hash must never enter the mapping or every
    /// unauthenticated request would attribute to whichever profile held it.
    public static let sha256OfEmptyString =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}

// MARK: - The /usr/bin/security runner

/// Runs `/usr/bin/security` with a hard deadline, optionally feeding a command
/// over stdin. Absolute path always — no PATH resolution for a credential
/// operation (design §3.5).
///
/// `arguments` NEVER carries key material: the create path passes `["-i"]` and
/// puts the command on stdin. stderr is discarded because `security` echoes
/// the offending command line into it.
public struct SecurityCommandRunner: SecurityCommandRunning {
    private let executablePath: String

    public init(executablePath: String = KeychainClientKeyStore.securityBinary) {
        self.executablePath = executablePath
    }

    public func run(arguments: [String], stdin: String?, deadline: TimeInterval) async -> SecurityCommandResult {
        await withCheckedContinuation { continuation in
            let resumeOnce = SecurityResumeOnce(continuation)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executablePath)
            process.arguments = arguments
            let outputPipe = Pipe()
            process.standardOutput = outputPipe
            process.standardError = FileHandle.nullDevice
            let inputPipe: Pipe? = stdin == nil ? nil : Pipe()
            process.standardInput = inputPipe ?? FileHandle.nullDevice
            let drain = SecurityOutputDrain(outputPipe.fileHandleForReading)
            process.terminationHandler = { finished in
                resumeOnce.resume(finished.terminationStatus, drain.awaitOutput())
            }
            drain.begin()
            do {
                try process.run()
            } catch {
                try? outputPipe.fileHandleForWriting.close()
                try? inputPipe?.fileHandleForWriting.close()
                resumeOnce.resume(SecurityCommandResult.didNotAnswer, "")
                return
            }
            if let stdin, let inputPipe {
                // The commands are a single short line, far under the pipe
                // buffer, so this cannot block. Closing the write end is what
                // makes `security -i` stop reading and exit.
                try? inputPipe.fileHandleForWriting.write(contentsOf: Data(stdin.utf8))
                try? inputPipe.fileHandleForWriting.close()
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + deadline) {
                guard process.isRunning else { return }
                // A read that reached here is waiting on a SecurityAgent
                // dialog. Terminate and report `didNotAnswer`; the caller
                // turns that into an honest failure and does NOT retry — a
                // retry is a second dialog on the user's screen.
                process.terminate()
                resumeOnce.resume(SecurityCommandResult.didNotAnswer, "")
            }
        }
    }
}

private final class SecurityResumeOnce: @unchecked Sendable {
    private let continuation: CheckedContinuation<SecurityCommandResult, Never>
    private let lock = NSLock()
    private var resumed = false

    init(_ continuation: CheckedContinuation<SecurityCommandResult, Never>) {
        self.continuation = continuation
    }

    func resume(_ status: Int32, _ output: String) {
        lock.lock()
        let shouldResume = !resumed
        resumed = true
        lock.unlock()
        guard shouldResume else { return }
        continuation.resume(returning: SecurityCommandResult(status: status, output: output))
    }
}

/// Drains stdout while the tool runs so the pipe buffer can never block the
/// child (the same discipline as `runTool`'s drain, CodeRabbit PR #433).
private final class SecurityOutputDrain: @unchecked Sendable {
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

    func awaitOutput() -> String {
        _ = finished.wait(timeout: .now() + 2)
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Persisted report generation

/// The monotonic generation the daemon uses to reject stale reports
/// (design §2.1). Persisted in UserDefaults: an app restart must not hand the
/// daemon a generation it has already applied, or a replayed older report
/// could resurrect a rotated key.
public struct UserDefaultsClientKeyGenerationStore: ClientKeyGenerationStoring {
    public static let defaultsKey = "modeldeck.clientKeys.reportGeneration"

    // UserDefaults is documented thread-safe but is not annotated Sendable.
    nonisolated(unsafe) private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = defaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    public func lastGeneration() -> Int {
        max(0, defaults.integer(forKey: key))
    }

    public func nextGeneration() -> Int {
        let next = lastGeneration() + 1
        defaults.set(next, forKey: key)
        return next
    }

    public func adopt(atLeast generation: Int) {
        guard generation > lastGeneration() else { return }
        defaults.set(generation, forKey: key)
    }
}
