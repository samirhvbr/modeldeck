import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #521 — the consented config write path (design §2.6).
//
// SAFETY CONTRACT for this whole file, and it is structural, not a promise:
// every test builds a FIXTURE config in a fresh temp directory and points the
// writer at that. Nothing here reads or writes ~/.config/cliproxyapi, spawns a
// proxy, contacts ports 8317/3867, touches the Keychain, makes a provider
// call, or raises a GUI prompt. Backups go to a temp state directory passed in
// through ModelDeckStatePaths, never the real one.

// MARK: - Fixtures

/// A config in the shape an adopted install actually has: comments the user
/// wrote, keys in their order, and a management secret already bcrypt-hashed
/// by the proxy's own first boot (the recon startup side-finding).
private let adoptedConfig = """
# my own proxy, do not touch
host: "127.0.0.1"
port: 18521
remote-management:
  allow-remote: false
  secret-key: "$2a$10$placeholderplaceholderplaceholderplaceholderplaceholder"
auth-dir: "/tmp/md521-fixture-auths"
debug: false

"""

private let configWithKeys = """
host: "127.0.0.1"
api-keys:
  - "md521-placeholder-existing"
port: 18521

"""

/// A temp root holding two SEPARATE directories: `proxy/` stands in for the
/// user's `~/.config/cliproxyapi`, and `state/` for ModelDeck's Application
/// Support directory. They are siblings on purpose — decision D2 forbids a
/// secret-bearing backup landing anywhere inside the proxy's directory, and a
/// fixture that nested them would hide that rule rather than exercise it.
private func temporaryRoot(_ label: String) throws -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("modeldeck-521-\(label)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
        at: root.appendingPathComponent("proxy", isDirectory: true), withIntermediateDirectories: true
    )
    return root
}

/// The fixture proxy directory — where a fixture config.yaml lives.
private func proxyConfig(in root: URL, named name: String = "config.yaml") -> URL {
    root.appendingPathComponent("proxy", isDirectory: true).appendingPathComponent(name)
}

private func writeFixture(_ text: String, at url: URL, mode: UInt16 = 0o600) throws {
    try text.write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: mode)], ofItemAtPath: url.path)
}

private func mode(of url: URL) -> UInt16 {
    var info = stat()
    _ = lstat(url.path, &info)
    return info.st_mode & 0o777
}

private func makeWriter(
    root: URL, hooks: ConsentedConfigWriteHooks = .none, attempts: Int = 3
) -> (writer: ConsentedConfigWriter, backups: ConfigBackupStore) {
    let backups = ConfigBackupStore(
        paths: ModelDeckStatePaths(stateDirectory: root.appendingPathComponent("state", isDirectory: true)),
        retained: 3
    )
    return (ConsentedConfigWriter(backups: backups, hooks: hooks, maximumAttempts: attempts), backups)
}

/// Placeholder keys only — base64url-shaped, never real material.
private let keyA = "md521-placeholder-key-AAAA"
private let keyB = "md521-placeholder-key-BBBB"
private let legacyValue = "md521-placeholder-legacy-shared"

private func sha(_ value: String) -> String { ClientKeyGenerator.sha256Hex(value) }

/// What the consent screen said, for fixtures that start from an empty list
/// (the append flips enforcement ON) or empty it (removal flips it OFF).
private let firstEntryFlip = ConsentedFlipExpectation(flipsEnforcementOn: true, flipsEnforcementOff: false)
private let lastEntryFlip = ConsentedFlipExpectation(flipsEnforcementOn: false, flipsEnforcementOff: true)

// MARK: - Target derivation (review should-fix 5)

@Suite("Issue #521 — the config path is derived from what is running, never defaulted")
struct Issue521TargetDerivationTests {
    @Test("a managed proxy's own config file is the target")
    func managedTarget() {
        let paths = ManagedProxyPaths(configDirectory: URL(fileURLWithPath: "/tmp/md521-managed"))
        let target = resolveConsentedConfigTarget(.managed(configFile: paths.configFile))
        #expect(target.fileURL?.path == "/tmp/md521-managed/config.yaml")
    }

    @Test("-config is read out of the running process's command line")
    func runningProcessTarget() {
        let target = resolveConsentedConfigTarget(
            .runningProcess(command: "/usr/local/bin/cliproxyapi -config /opt/cpa/live.yaml -local-model")
        )
        #expect(target.fileURL?.path == "/opt/cpa/live.yaml")
    }

    @Test("--config= and quoted paths with spaces are read too")
    func flagSpellings() {
        #expect(configPathArgument(inArguments: ["--config=/a/b.yaml"]) == "/a/b.yaml")
        #expect(configPathArgument(inArguments: ["-config=/a/b.yaml"]) == "/a/b.yaml")
        let target = resolveConsentedConfigTarget(
            .runningProcess(command: "/bin/cliproxyapi -config \"/Users/x/My Proxy/config.yaml\"")
        )
        #expect(target.fileURL?.path == "/Users/x/My Proxy/config.yaml")
    }

    @Test("a launch agent's ProgramArguments are the same authority")
    func launchAgentTarget() {
        let target = resolveConsentedConfigTarget(
            .launchAgent(programArguments: ["/usr/local/bin/cliproxyapi", "-config", "/etc/cpa.yaml"])
        )
        #expect(target.fileURL?.path == "/etc/cpa.yaml")
    }

    @Test("no -config flag REFUSES rather than writing the default path")
    func refusesWithoutFlag() {
        guard case .refused(let reason) = resolveConsentedConfigTarget(
            .runningProcess(command: "/usr/local/bin/cliproxyapi -local-model")
        ) else {
            Issue.record("a proxy with no -config must refuse, never default")
            return
        }
        #expect(reason == ConsentedConfigWriteCopy.targetNoConfigFlagReason)
    }

    @Test("a relative -config path REFUSES: it resolves against a working directory we cannot see")
    func refusesRelativePath() {
        guard case .refused = resolveConsentedConfigTarget(
            .runningProcess(command: "cliproxyapi -config config.yaml")
        ) else {
            Issue.record("a relative config path must refuse")
            return
        }
    }

    @Test("an unidentified proxy REFUSES")
    func refusesUnknown() {
        guard case .refused(let reason) = resolveConsentedConfigTarget(.unknown) else {
            Issue.record("an unknown supervision must refuse")
            return
        }
        #expect(reason == ConsentedConfigWriteCopy.targetUnknownReason)
    }
}

// MARK: - The surgical editor

@Suite("Issue #521 — the api-keys editor appends surgically or refuses")
struct Issue521EditorTests {
    @Test("appending to a config without api-keys adds the block and changes nothing else")
    func appendsNewBlock() throws {
        let document = try ConfigAPIKeysDocument.parse(adoptedConfig)
        #expect(document.isEmptyList)
        let edit = try document.appending([keyA, keyB])
        #expect(edit.flipsEnforcementOn)
        #expect(edit.entriesAfterEdit == 2)
        // Everything the user wrote survives, byte for byte.
        #expect(edit.text.hasPrefix("# my own proxy, do not touch\n"))
        #expect(edit.text.contains("secret-key: \"$2a$10$placeholder"))
        #expect(edit.text.contains("api-keys:\n  - \"\(keyA)\"\n  - \"\(keyB)\""))
        // And the edit is exactly an insertion: delete the added lines and the
        // original returns.
        let restored = edit.text
            .replacingOccurrences(of: "api-keys:\n  - \"\(keyA)\"\n  - \"\(keyB)\"\n", with: "")
        #expect(restored == adoptedConfig)
    }

    @Test("appending to an existing list keeps the existing entries and the keys around it")
    func appendsToExistingBlock() throws {
        let document = try ConfigAPIKeysDocument.parse(configWithKeys)
        #expect(!document.isEmptyList)
        let edit = try document.appending([keyA])
        #expect(!edit.flipsEnforcementOn, "the proxy is already enforcing; this append flips nothing")
        #expect(edit.entriesAfterEdit == 2)
        #expect(edit.text.contains("  - \"md521-placeholder-existing\"\n  - \"\(keyA)\"\nport: 18521"))
    }

    @Test("a declared-but-empty api-keys block is filled in place")
    func appendsToEmptyDeclaredBlock() throws {
        let document = try ConfigAPIKeysDocument.parse("host: \"127.0.0.1\"\napi-keys:\nport: 18521\n")
        let edit = try document.appending([keyA])
        #expect(edit.flipsEnforcementOn)
        #expect(edit.text == "host: \"127.0.0.1\"\napi-keys:\n  - \"\(keyA)\"\nport: 18521\n")
    }

    @Test("the editor REFUSES anything it cannot confidently edit")
    func refusesUnsupportedStructures() throws {
        let unsupported: [(String, String)] = [
            ("api-keys: [\"a\", \"b\"]\n", "an inline flow list"),
            ("api-keys:\n  - \"a\"\napi-keys:\n  - \"b\"\n", "a duplicated key"),
            ("base: &anchor\n  host: x\napi-keys:\n  - \"a\"\n", "an anchor"),
            ("api-keys: *alias\n", "an alias"),
            ("defaults:\n  <<: *base\napi-keys:\n", "a merge key"),
            ("api-keys: !!seq\n", "a tag"),
            ("host: x\n\tport: 1\n", "a tab indent"),
            ("host: x\r\napi-keys:\r\n", "Windows line endings"),
            ("api-keys:\n  - key: value\n", "a nested mapping entry"),
            // Nit 9: with two documents in the file the append could land in
            // the one the proxy never reads, while the byte-level post-write
            // verify would happily report the change live.
            ("host: x\n---\napi-keys:\n  - \"a\"\n", "a second YAML document"),
            ("api-keys:\n  - \"a\"\n...\nhost: x\n", "an end-of-document marker"),
        ]
        for (text, what) in unsupported {
            #expect(throws: ConsentedConfigWriteError.self, "\(what) must refuse before any write") {
                let document = try ConfigAPIKeysDocument.parse(text)
                _ = try document.appending([keyA])
            }
        }
    }

    @Test("a value that isn't a plain quotable scalar is REFUSED, never escaped")
    func refusesUnsafeScalar() throws {
        let document = try ConfigAPIKeysDocument.parse(adoptedConfig)
        for hostile in ["has \"quote\"", "back\\slash", "new\nline", ""] {
            #expect(throws: ConsentedConfigWriteError.self) {
                _ = try document.appending([hostile])
            }
        }
    }

    @Test("removal takes exactly the recorded entries and leaves the user's own")
    func removesRecordedEntries() throws {
        let text = """
        api-keys:
          - "\(keyA)"
          - "mine-i-added-myself"
          - "\(keyB)"
        port: 18521

        """
        let document = try ConfigAPIKeysDocument.parse(text)
        let record = ConfigKeyProvisioningRecord(
            targetPath: "/tmp/x.yaml", writtenAt: Date(),
            entries: [
                .init(profileID: "a", profileLabel: "Work", keySha256: sha(keyA)),
                .init(profileID: "b", profileLabel: "Personal", keySha256: sha(keyB)),
            ]
        )
        let edit = try document.removing(record: record, hash: sha)
        #expect(edit.removedLineIndices.count == 2)
        #expect(edit.entriesAfterEdit == 1)
        #expect(edit.text.contains("mine-i-added-myself"))
        #expect(!edit.text.contains(keyA))
        #expect(!edit.flipsEnforcementOff, "the list is not empty, so enforcement stays on")
    }

    @Test("removal REFUSES when a recorded key appears more times than ModelDeck wrote it")
    func refusesDuplicateEntry() throws {
        let text = "api-keys:\n  - \"\(keyA)\"\n  - \"\(keyA)\"\n"
        let document = try ConfigAPIKeysDocument.parse(text)
        let record = ConfigKeyProvisioningRecord(
            targetPath: "/tmp/x.yaml", writtenAt: Date(),
            entries: [.init(profileID: "a", profileLabel: "Work", keySha256: sha(keyA), occurrences: 1)]
        )
        #expect(throws: ConsentedConfigWriteError.removalRefusedDuplicate(profileLabel: "Work")) {
            _ = try document.removing(record: record, hash: sha)
        }
    }

    @Test("removing the LAST entry is flagged: an empty list silently reopens accept-all")
    func lastEntryRemovalIsFlagged() throws {
        let document = try ConfigAPIKeysDocument.parse("api-keys:\n  - \"\(keyA)\"\nport: 18521\n")
        let record = ConfigKeyProvisioningRecord(
            targetPath: "/tmp/x.yaml", writtenAt: Date(),
            entries: [.init(profileID: "a", profileLabel: "Work", keySha256: sha(keyA))]
        )
        let edit = try document.removing(record: record, hash: sha)
        #expect(edit.flipsEnforcementOff)
        #expect(edit.entriesAfterEdit == 0)
    }

    @Test("the legacy shared entry is removed by its own recorded hash")
    func removesLegacyEntry() throws {
        let document = try ConfigAPIKeysDocument.parse("api-keys:\n  - \"\(legacyValue)\"\n")
        let record = ConfigKeyProvisioningRecord(
            targetPath: "/tmp/x.yaml", writtenAt: Date(), entries: [], legacyValueSha256: sha(legacyValue)
        )
        let edit = try document.removing(record: record, hash: sha)
        #expect(edit.entriesAfterEdit == 0)
        #expect(edit.flipsEnforcementOff)
    }
}

// MARK: - Legacy admission and hash-domain disjointness (blocker 2)

@Suite("Issue #521 — legacy shared-key admission keeps the hash domains disjoint")
struct Issue521LegacyAdmissionTests {
    @Test("no legacy item means nothing is admitted")
    func noLegacyItem() {
        #expect(planLegacyKeyAdmission(legacyValue: nil, managedKeyHashesByProfileID: [:], hash: sha) == .none)
        #expect(planLegacyKeyAdmission(legacyValue: "", managedKeyHashesByProfileID: [:], hash: sha) == .none)
    }

    @Test("a distinct legacy value is appended so live sessions keep working")
    func appendsLegacyValue() {
        let admission = planLegacyKeyAdmission(
            legacyValue: legacyValue,
            managedKeyHashesByProfileID: ["a": sha(keyA)],
            hash: sha
        )
        #expect(admission == .append(value: legacyValue))
    }

    @Test("a legacy value colliding with a managed key demands ROTATION before anything is written")
    func rotatesOnCollision() {
        let admission = planLegacyKeyAdmission(
            legacyValue: keyA,
            managedKeyHashesByProfileID: ["profile-a": sha(keyA), "profile-b": sha(keyB)],
            hash: sha
        )
        #expect(admission == .rotateFirst(profileIDs: ["profile-a"]))
    }

    @Test("a legacy value that is not a plain scalar is refused, not escaped")
    func refusesUnsafeLegacyValue() {
        #expect(planLegacyKeyAdmission(
            legacyValue: "oops\"\ninjected: true", managedKeyHashesByProfileID: [:], hash: sha
        ) == .refuseUnsafeValue)
    }
}

// MARK: - The write itself

@Suite("Issue #521 — the consented write: backup, atomic publish, 0600, TOCTOU")
struct Issue521WriteTests {
    @Test("a first append writes the entries, keeps a backup, and leaves the file owner-only")
    func happyPath() throws {
        let root = try temporaryRoot("happy")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target, mode: 0o644)
        let (writer, backups) = makeWriter(root: root)

        let outcome = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)

        #expect(outcome.attempts == 1)
        #expect(outcome.addedEntries == 1)
        #expect(outcome.flipsEnforcementOn)
        #expect(outcome.tightenedPermissions)
        #expect(outcome.previousMode == 0o644)
        #expect(mode(of: target) == 0o600, "keys must never sit in a world-readable file")

        let written = try String(contentsOf: target, encoding: .utf8)
        #expect(written.contains("api-keys:\n  - \"\(keyA)\""))
        #expect(written.hasPrefix("# my own proxy, do not touch"))

        let backup = URL(fileURLWithPath: outcome.backupPath)
        #expect(try String(contentsOf: backup, encoding: .utf8) == adoptedConfig)
        #expect(mode(of: backup) == 0o600, "the backup holds the same secrets the config does")
        #expect(backup.path.hasPrefix(backups.directory.path + "/"))
        // Compared against the directory the fixture ACTUALLY uses (CodeRabbit
        // on PR #531): the old assertion named `root/config`, a path the
        // fixture never creates, so it passed no matter where the backup went.
        let proxyDirectory = target.deletingLastPathComponent().path
        #expect(!backup.path.hasPrefix(proxyDirectory + "/"), "a secret-bearing backup must never land in the proxy's own directory (D2)")
    }

    @Test("the pre-rename byte-compare aborts the attempt and re-baselines from the FRESH bytes")
    func toctouRetryRebaselines() throws {
        let root = try temporaryRoot("toctou")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)

        // Exactly the recon finding: the proxy rewrites this file itself.
        let interfered = LockedFlag()
        let hooks = ConsentedConfigWriteHooks(beforeCompare: { attempt, url in
            guard attempt == 1, interfered.setIfUnset() else { return }
            try? (adoptedConfig + "proxy-rewrote-this: true\n").write(to: url, atomically: true, encoding: .utf8)
        })
        let (writer, _) = makeWriter(root: root, hooks: hooks)

        let outcome = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)

        #expect(outcome.attempts == 2, "attempt 1 must abort, not publish over the intervening write")
        let written = try String(contentsOf: target, encoding: .utf8)
        #expect(written.contains("proxy-rewrote-this: true"), "the concurrent change survives")
        #expect(written.contains("- \"\(keyA)\""))
        // Per-retry re-baseline: the backup is attempt 2's snapshot, which
        // already carries the intervening change. A reused first-attempt
        // snapshot would restore stale bytes on any later rollback.
        let backup = try String(contentsOf: URL(fileURLWithPath: outcome.backupPath), encoding: .utf8)
        #expect(backup.contains("proxy-rewrote-this: true"))
        #expect(!backup.contains(keyA))
    }

    @Test("a file that keeps changing is never written to")
    func givesUpRatherThanClobbering() throws {
        let root = try temporaryRoot("busy")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let counter = LockedCounter()
        let hooks = ConsentedConfigWriteHooks(beforeCompare: { _, url in
            try? (adoptedConfig + "churn: \(counter.next())\n").write(to: url, atomically: true, encoding: .utf8)
        })
        let (writer, _) = makeWriter(root: root, hooks: hooks)

        #expect(throws: ConsentedConfigWriteError.concurrentWriteDetected(attempts: 3)) {
            _ = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)
        }
        #expect(!(try String(contentsOf: target, encoding: .utf8)).contains(keyA))
    }

    @Test("a verification failure rolls back to THIS attempt's snapshot, not the first attempt's")
    func rollbackUsesTheCurrentAttemptSnapshot() throws {
        let root = try temporaryRoot("rollback")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let interfered = LockedFlag()
        let hooks = ConsentedConfigWriteHooks(
            beforeCompare: { attempt, url in
                guard attempt == 1, interfered.setIfUnset() else { return }
                try? (adoptedConfig + "proxy-rewrote-this: true\n").write(to: url, atomically: true, encoding: .utf8)
            },
            failVerification: { $0 == 2 }
        )
        let (writer, _) = makeWriter(root: root, hooks: hooks)

        #expect(throws: ConsentedConfigWriteError.self) {
            _ = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)
        }
        let restored = try String(contentsOf: target, encoding: .utf8)
        #expect(restored == adoptedConfig + "proxy-rewrote-this: true\n",
                "the rollback restores attempt 2's bytes, including the intervening change")
        #expect(!restored.contains(keyA))
    }

    @Test("the rollback REFUSES when the file changed again after the publish")
    func rollbackRefusesWhenFileChangedAgain() throws {
        let root = try temporaryRoot("norollback")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let hooks = ConsentedConfigWriteHooks(afterPublish: { _, url in
            try? "someone-else-wrote-this: true\n".write(to: url, atomically: true, encoding: .utf8)
        })
        let (writer, _) = makeWriter(root: root, hooks: hooks, attempts: 1)

        var recorded: ConsentedConfigWriteError?
        do {
            _ = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)
        } catch let error as ConsentedConfigWriteError {
            recorded = error
        }
        guard case .rollbackRefusedFileChanged(let backupPath) = recorded else {
            Issue.record("a file that changed after the publish must not be restored over: \(String(describing: recorded))")
            return
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == "someone-else-wrote-this: true\n",
                "the other writer's bytes stand; ModelDeck does not clobber them")
        #expect(FileManager.default.fileExists(atPath: backupPath), "the backup is named so it can be restored by hand")
    }

    @Test("a symlinked config path is refused rather than replaced")
    func refusesSymlink() throws {
        let root = try temporaryRoot("symlink")
        defer { try? FileManager.default.removeItem(at: root) }
        let real = proxyConfig(in: root, named: "real.yaml")
        try writeFixture(adoptedConfig, at: real)
        let link = proxyConfig(in: root)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        let (writer, _) = makeWriter(root: root)
        #expect(throws: ConsentedConfigWriteError.self) {
            _ = try writer.apply(.append(values: [keyA], origin: "a client key"), to: link, expecting: firstEntryFlip)
        }
    }

    @Test("removal refuses when the record names a different file than the one now in use")
    func removalRefusesTargetMismatch() throws {
        let root = try temporaryRoot("mismatch")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture("api-keys:\n  - \"\(keyA)\"\n", at: target)
        let (writer, _) = makeWriter(root: root)
        let record = ConfigKeyProvisioningRecord(
            targetPath: "/somewhere/else/config.yaml", writtenAt: Date(),
            entries: [.init(profileID: "a", profileLabel: "Work", keySha256: sha(keyA))]
        )
        #expect(throws: ConsentedConfigWriteError.self) {
            _ = try writer.apply(.remove(record: record, hash: sha), to: target, expecting: lastEntryFlip)
        }
        #expect((try String(contentsOf: target, encoding: .utf8)).contains(keyA))
    }

    @Test("activation is confirmed from the file, and reports superseded when it changed again")
    func activationVerification() async throws {
        let root = try temporaryRoot("activation")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let (writer, _) = makeWriter(root: root)
        let outcome = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)

        let live = await writer.verifyActivation(
            target: target, publishedSha256: outcome.publishedSha256, settle: 0, sleep: { _ in }
        )
        #expect(live == .live)

        try "changed-underneath: true\n".write(to: target, atomically: true, encoding: .utf8)
        let superseded = await writer.verifyActivation(
            target: target, publishedSha256: outcome.publishedSha256, settle: 0, sleep: { _ in }
        )
        #expect(!superseded.isLive)
    }

    /// Should-fix 1, direction one: consent said "this adds a key, enforcement
    /// is unchanged"; by confirm time the list is empty, so writing would be an
    /// ungated, undisclosed first-entry flip.
    @Test("an append refuses when the list emptied between consent and the write")
    func refusesWhenListEmptiedUnderConsent() throws {
        let root = try temporaryRoot("flip-on")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let (writer, _) = makeWriter(root: root)

        var recorded: ConsentedConfigWriteError?
        do {
            _ = try writer.apply(
                .append(values: [keyA], origin: "a client key"),
                to: target,
                expecting: .noEnforcementChange
            )
        } catch let error as ConsentedConfigWriteError {
            recorded = error
        }
        guard case .consentedEffectChanged = recorded else {
            Issue.record("a first-entry flip the user was not shown must refuse: \(String(describing: recorded))")
            return
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == adoptedConfig)
    }

    /// Should-fix 1, direction two: consent said "this empties the list and
    /// reopens accept-all"; by confirm time someone added their own entry, so
    /// the disclosure the user read no longer describes what happens.
    @Test("a removal refuses when the disclosed enforcement change no longer applies")
    func refusesWhenRemovalNoLongerEmptiesTheList() throws {
        let root = try temporaryRoot("flip-off")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        let text = "api-keys:\n  - \"\(keyA)\"\n  - \"the-user-added-this\"\n"
        try writeFixture(text, at: target)
        let (writer, _) = makeWriter(root: root)
        let record = ConfigKeyProvisioningRecord(
            targetPath: target.path, writtenAt: Date(),
            entries: [.init(profileID: "a", profileLabel: "Work", keySha256: sha(keyA))]
        )
        #expect(throws: ConsentedConfigWriteError.self) {
            _ = try writer.apply(.remove(record: record, hash: sha), to: target, expecting: lastEntryFlip)
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == text)
        // Stating the truthful expectation lets the same removal through.
        let outcome = try writer.apply(
            .remove(record: record, hash: sha), to: target, expecting: .noEnforcementChange
        )
        #expect(outcome.removedEntries == 1)
        #expect(!outcome.flipsEnforcementOff)
    }

    /// Nit 8: a crash between mkstemp and rename leaves a 0600 temp holding the
    /// whole config — keys and the management secret — that nothing else would
    /// ever remove.
    @Test("stale staging temps are swept, and only ModelDeck's own")
    func sweepsStaleTemporaries() throws {
        let root = try temporaryRoot("sweep")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let directory = target.deletingLastPathComponent()

        let stale = directory.appendingPathComponent("\(ConsentedConfigWriteGuard.temporaryPrefix)ABC123")
        let fresh = directory.appendingPathComponent("\(ConsentedConfigWriteGuard.temporaryPrefix)XYZ789")
        let foreign = directory.appendingPathComponent(".someone-elses.tmp")
        for url in [stale, fresh, foreign] { try writeFixture(adoptedConfig, at: url) }
        let old = Date(timeIntervalSinceNow: -3600)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.path)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: foreign.path)

        let (writer, _) = makeWriter(root: root)
        _ = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)

        #expect(!FileManager.default.fileExists(atPath: stale.path), "an abandoned temp still holds key material")
        #expect(FileManager.default.fileExists(atPath: fresh.path), "a temp that may be another publish in flight is left alone")
        #expect(FileManager.default.fileExists(atPath: foreign.path), "the sweep touches ModelDeck's own prefix only")
    }

    /// CodeRabbit: `String(decoding:as:)` maps malformed bytes onto U+FFFD, so
    /// a rewrite would silently replace bytes ModelDeck never understood.
    @Test("a config that is not valid UTF-8 is refused, not silently rewritten")
    func refusesNonUTF8Config() throws {
        let root = try temporaryRoot("utf8")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        // Valid YAML structure, one invalid UTF-8 byte inside a comment.
        var bytes = Data("# note: \n".utf8)
        bytes.insert(0xFF, at: 8)
        bytes.append(Data("host: \"127.0.0.1\"\n".utf8))
        FileManager.default.createFile(atPath: target.path, contents: bytes)
        let (writer, _) = makeWriter(root: root)

        #expect(throws: ConsentedConfigWriteError.self) { _ = try writer.inspect(target: target) }
        #expect(throws: ConsentedConfigWriteError.self) {
            _ = try writer.apply(.append(values: [keyA], origin: "a client key"), to: target, expecting: firstEntryFlip)
        }
        #expect(try Data(contentsOf: target) == bytes, "the original bytes are untouched")
    }

    /// The activation digest must distinguish byte-distinct files. Hashing a
    /// lossily-decoded string folds every malformed sequence onto U+FFFD, so
    /// these two files would share a digest and a swap would read as live.
    @Test("the activation digest is taken over raw bytes, not a decoded string")
    func digestIsByteExact() {
        let replacement = Data([0xEF, 0xBF, 0xBD])   // valid UTF-8 for U+FFFD
        let malformed = Data([0xFF])                 // decodes to U+FFFD lossily
        #expect(ConsentedConfigDigest.sha256Hex(replacement) != ConsentedConfigDigest.sha256Hex(malformed))
        #expect(ConsentedConfigDigest.sha256Hex(Data("abc".utf8)) == ClientKeyGenerator.sha256Hex("abc"))
    }

    /// Nit 10: the create-time 0700 only covers a directory we created.
    @Test("an existing backups directory that is too open is tightened before anything is written")
    func tightensExistingBackupsDirectory() throws {
        let root = try temporaryRoot("dirmode")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = ModelDeckStatePaths(stateDirectory: root.appendingPathComponent("state", isDirectory: true))
        try FileManager.default.createDirectory(
            at: state.configBackupsDirectory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o755)]
        )
        #expect(mode(of: state.configBackupsDirectory) == 0o755)

        let backups = ConfigBackupStore(paths: state, retained: 3)
        _ = try backups.write(Data("copy".utf8))
        #expect(mode(of: state.configBackupsDirectory) == 0o700,
                "files holding client keys and the management secret must not sit in a world-readable directory")
    }

    @Test("backups are pruned to the retained count and never leave ModelDeck's state directory")
    func backupsPrunedAndContained() throws {
        let root = try temporaryRoot("prune")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = ModelDeckStatePaths(stateDirectory: root.appendingPathComponent("state", isDirectory: true))
        let backups = ConfigBackupStore(paths: state, retained: 2)
        var written: [URL] = []
        for index in 0..<5 {
            written.append(try backups.write(
                Data("copy-\(index)".utf8),
                at: Date(timeIntervalSince1970: 1_700_000_000 + Double(index))
            ))
            backups.prune()
        }
        let remaining = try FileManager.default.contentsOfDirectory(atPath: backups.directory.path)
        #expect(remaining.count == 2)
        #expect(written.allSatisfy { $0.path.hasPrefix(state.stateDirectory.path + "/") })
    }
}

// MARK: - Small locked helpers (hooks are @Sendable and run inline)

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func setIfUnset() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if value { return false }
        value = true
        return true
    }
}

/// A clock the test moves by hand, so "the user left the prompt open" is a
/// deterministic step rather than a sleep.
private final class LockedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ start: Date) { value = start }
    var now: Date { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        value = value.addingTimeInterval(seconds)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int {
        lock.lock(); defer { lock.unlock() }
        value += 1
        return value
    }
}

// MARK: - The model

private struct StubCoverage: ClientCoverageObserving {
    var evidence: ClientCoverageEvidence?
    func observeClientCoverage() async -> ClientCoverageEvidence? { evidence }
}

private final class MemoryRecordStore: ConfigKeyProvisioningRecordStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: ConfigKeyProvisioningRecord?
    var record: ConfigKeyProvisioningRecord? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

@MainActor
@Suite("Issue #521 — the consent model gates, then writes, and is never silent")
struct Issue521ModelTests {
    private func makeModel(
        root: URL, evidence: ClientCoverageEvidence?, records: MemoryRecordStore = MemoryRecordStore()
    ) -> ConsentedConfigWriteModel {
        let (writer, backups) = makeWriter(root: root)
        return ConsentedConfigWriteModel(dependencies: .init(
            writer: writer, backups: backups,
            coverage: StubCoverage(evidence: evidence),
            records: records,
            hash: sha,
            clock: { Date(timeIntervalSince1970: 1_700_000_000) }
        ))
    }

    private func covered(_ hashes: [String]) -> ClientCoverageEvidence {
        ClientCoverageEvidence(
            observedAt: Date(timeIntervalSince1970: 1_700_000_000),
            windowDescription: "the last 24 hours of proxy requests",
            clients: hashes.map { .init(name: "a client", coverage: .provisionedKey(sha256: $0)) },
            isComplete: true
        )
    }

    @Test("with coverage evidence, consent names both operations and the write lands")
    func appendsWithCoverage() async throws {
        let root = try temporaryRoot("model-ok")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target, mode: 0o644)
        let records = MemoryRecordStore()
        let model = makeModel(root: root, evidence: covered([sha(keyA)]), records: records)

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)]
        ))
        guard case .consent(let prompt, let canConfirm) = model.phase else {
            Issue.record("expected the consent prompt, got \(model.phase)")
            return
        }
        #expect(canConfirm)
        #expect(prompt.operations.count == 2, "both operations are named: the append and the tighten")
        #expect(prompt.operations.contains { $0.contains("api-keys") })
        #expect(prompt.operations.contains { $0.contains("chmod 600") })
        #expect(prompt.effects.contains(ConsentedConfigWriteCopy.immediacyEffect))
        #expect(prompt.effects.contains(ConsentedConfigWriteCopy.enforcementFlipEffect))

        await model.confirm(settle: 0, sleep: { _ in })
        guard case .record(let record) = model.phase else {
            Issue.record("expected a visible record, got \(model.phase)")
            return
        }
        #expect(record.succeeded)
        #expect(record.activation == .live)
        #expect(mode(of: target) == 0o600)
        #expect((try String(contentsOf: target, encoding: .utf8)).contains(keyA))
        // The record persists HASHES only: no raw key is written to storage.
        #expect(records.record?.entries.first?.keySha256 == sha(keyA))
        #expect(records.record.map { String(describing: $0).contains(keyA) } == false)
    }

    @Test("the legacy shared value rides along and is recorded by hash")
    func appendsLegacyValue() async throws {
        let root = try temporaryRoot("model-legacy")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let records = MemoryRecordStore()
        let evidence = ClientCoverageEvidence(
            observedAt: Date(timeIntervalSince1970: 1_700_000_000),
            windowDescription: "the last 24 hours of proxy requests",
            clients: [.init(name: "an already-running shell", coverage: .legacySharedKey)],
            isComplete: true
        )
        let model = makeModel(root: root, evidence: evidence, records: records)

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)],
            legacyValue: legacyValue
        ))
        guard case .consent(_, let canConfirm) = model.phase else {
            Issue.record("expected consent, got \(model.phase)")
            return
        }
        #expect(canConfirm, "a shell on the legacy key is covered once the legacy value is appended")
        await model.confirm(settle: 0, sleep: { _ in })
        let written = try String(contentsOf: target, encoding: .utf8)
        #expect(written.contains(legacyValue))
        #expect(records.record?.legacyValueSha256 == sha(legacyValue))
    }

    @Test("a legacy value colliding with a managed key refuses and writes nothing")
    func refusesCollidingLegacyValue() async throws {
        let root = try temporaryRoot("model-collide")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let model = makeModel(root: root, evidence: covered([sha(keyA)]))

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)],
            legacyValue: keyA
        ))
        guard case .record(let record) = model.phase, case .refused = record.outcome else {
            Issue.record("a hash-domain collision must refuse, got \(model.phase)")
            return
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == adoptedConfig)
    }

    @Test("an unidentified coexist proxy refuses with a record, and writes nothing")
    func refusesUnknownTarget() async throws {
        let root = try temporaryRoot("model-unknown")
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root, evidence: covered([]))
        await model.prepareAppend(.init(source: .unknown, entries: []))
        guard case .record(let record) = model.phase, case .refused(let reason) = record.outcome else {
            Issue.record("an unknown target must refuse")
            return
        }
        #expect(reason == ConsentedConfigWriteCopy.targetUnknownReason)
    }

    @Test("removal shows the last-entry disclosure, then offers backup deletion only once live")
    func removalFlow() async throws {
        let root = try temporaryRoot("model-remove")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture("host: \"127.0.0.1\"\napi-keys:\n  - \"\(keyA)\"\n", at: target)
        let records = MemoryRecordStore()
        records.record = ConfigKeyProvisioningRecord(
            targetPath: target.path, writtenAt: Date(),
            entries: [.init(profileID: "a", profileLabel: "Work", keySha256: sha(keyA))]
        )
        let model = makeModel(root: root, evidence: nil, records: records)

        await model.prepareRemoval(source: .managed(configFile: target))
        guard case .consent(let prompt, _) = model.phase else {
            Issue.record("expected the removal prompt, got \(model.phase)")
            return
        }
        #expect(prompt.effects.contains(ConsentedConfigWriteCopy.lastEntryRemovalDisclosure))

        await model.confirm(settle: 0, sleep: { _ in })
        guard case .record(let record) = model.phase else {
            Issue.record("expected a removal record")
            return
        }
        #expect(record.succeeded)
        #expect(record.activation == .live)
        #expect(record.offersBackupDeletion, "a secret-bearing backup must not silently outlive the keys")
        #expect(record.lines.contains(ConsentedConfigWriteCopy.lastEntryRemovalDisclosure))
        #expect(records.record == nil)

        let backupPath = try #require(record.backupPath)
        #expect(FileManager.default.fileExists(atPath: backupPath))
        let deleted = model.deleteOfferedBackups()
        #expect(deleted.count == 1)
        #expect(!FileManager.default.fileExists(atPath: backupPath))
    }

    /// Should-fix 4: before consent, nothing has been written and nothing has
    /// been agreed to. A progress line saying "Written." is a claim about a
    /// change the user has not yet approved.
    @Test("the prepare phase never claims a write happened")
    func preparePhaseIsHonest() async throws {
        let root = try temporaryRoot("model-prepare")
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root, evidence: covered([]))
        // `.unknown` refuses at the first step, so the only phase the model can
        // have passed through on the way is the prepare line.
        await model.prepareAppend(.init(source: .unknown, entries: []))
        for line in ConsentedConfigWriteCopy.preConsentStrings {
            let lowered = line.lowercased()
            #expect(!lowered.contains("written"), "pre-consent copy claims a write: \(line)")
            #expect(!lowered.contains("re-reads"), "pre-consent copy describes the proxy reloading: \(line)")
        }
        #expect(ConsentedConfigWriteCopy.preparingLine != ConsentedConfigWriteCopy.takingEffectNowLine)
    }

    /// Should-fix 1: the prompt can sit on screen indefinitely. Evidence that
    /// was fresh at prepare may be stale by the time the button is pressed.
    @Test("evidence that went stale while the prompt was open blocks the write at confirm")
    func staleEvidenceBlocksAtConfirm() async throws {
        let root = try temporaryRoot("model-stale")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let observedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = LockedClock(observedAt)
        let (writer, backups) = makeWriter(root: root)
        let model = ConsentedConfigWriteModel(dependencies: .init(
            writer: writer, backups: backups,
            coverage: StubCoverage(evidence: ClientCoverageEvidence(
                observedAt: observedAt,
                windowDescription: "the last 24 hours of proxy requests",
                clients: [.init(name: "claude work", coverage: .provisionedKey(sha256: sha(keyA)))],
                isComplete: true
            )),
            records: MemoryRecordStore(),
            hash: sha,
            clock: { clock.now }
        ))

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)]
        ))
        guard case .consent(_, let canConfirm) = model.phase, canConfirm else {
            Issue.record("fresh evidence should have allowed the prompt, got \(model.phase)")
            return
        }
        // The user leaves the prompt open for an hour.
        clock.advance(3600)
        await model.confirm(settle: 0, sleep: { _ in })
        guard case .record(let record) = model.phase, case .refused = record.outcome else {
            Issue.record("stale evidence must block the write at confirm, got \(model.phase)")
            return
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == adoptedConfig)
    }

    /// Should-fix 5: a non-first append never runs a coverage check, so the
    /// prompt must not report one.
    @Test("a non-first append says enforcement is unchanged, not that no clients were seen")
    func standDownCopyIsHonest() async throws {
        let root = try temporaryRoot("model-standdown")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(configWithKeys, at: target)
        let model = makeModel(root: root, evidence: nil)

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)]
        ))
        guard case .consent(let prompt, let canConfirm) = model.phase else {
            Issue.record("expected consent, got \(model.phase)")
            return
        }
        #expect(canConfirm, "the proxy already enforces; this append cannot 401 anyone")
        #expect(prompt.coverageLine == ConsentedConfigWriteCopy.coverageStoodDownLine)
        #expect(!prompt.coverageLine.contains("saw no clients"))
        #expect(!prompt.effects.contains(ConsentedConfigWriteCopy.enforcementFlipEffect))
    }

    /// CodeRabbit: enabling a second profile is a SECOND append. A record that
    /// replaced rather than merged would orphan the first profile's key —
    /// still live in the config, and unreachable by the removal path, which
    /// works from this record alone.
    @Test("two appends then a removal takes BOTH profiles' keys out")
    func twoAppendsThenRemoveClearsBoth() async throws {
        let root = try temporaryRoot("model-merge")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let records = MemoryRecordStore()
        let model = makeModel(root: root, evidence: covered([sha(keyA)]), records: records)

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)]
        ))
        await model.confirm(settle: 0, sleep: { _ in })
        #expect(model.lastRecord?.succeeded == true)

        // Second profile enabled later. The list is now non-empty, so the
        // coverage gate stands down and this append changes no enforcement.
        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "b", profileLabel: "Personal", key: keyB)]
        ))
        await model.confirm(settle: 0, sleep: { _ in })
        #expect(model.lastRecord?.succeeded == true)

        let record = try #require(records.record)
        #expect(record.entries.map(\.profileID).sorted() == ["a", "b"], "both appends are in the record")
        #expect(record.backupPaths.count == 2, "each append's backup stays named while its keys are live")
        let afterAppends = try String(contentsOf: target, encoding: .utf8)
        #expect(afterAppends.contains(keyA) && afterAppends.contains(keyB))

        await model.prepareRemoval(source: .managed(configFile: target))
        await model.confirm(settle: 0, sleep: { _ in })
        let removed = try String(contentsOf: target, encoding: .utf8)
        #expect(!removed.contains(keyA), "the FIRST profile's key must not be orphaned in the config")
        #expect(!removed.contains(keyB))
        #expect(records.record == nil)

        // Every backup taken while those keys were live is offered for deletion.
        let deleted = model.deleteOfferedBackups()
        #expect(deleted.count == 3, "two append backups plus the removal's own")
        #expect(deleted.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
    }

    /// CodeRabbit: `Dictionary(uniqueKeysWithValues:)` traps on a duplicate.
    /// A malformed request must refuse, never crash the app.
    @Test("two keys for one profile refuses instead of trapping")
    func duplicateProfileIDRefuses() async throws {
        let root = try temporaryRoot("model-dupe")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let model = makeModel(root: root, evidence: covered([sha(keyA)]))

        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [
                .init(profileID: "a", profileLabel: "Work", key: keyA),
                .init(profileID: "a", profileLabel: "Work", key: keyB),
            ]
        ))
        guard case .record(let record) = model.phase, case .refused = record.outcome else {
            Issue.record("a duplicate profile id must refuse, got \(model.phase)")
            return
        }
        #expect(try String(contentsOf: target, encoding: .utf8) == adoptedConfig)
    }

    @Test("declining changes nothing and still emits a record")
    func decliningIsNeverSilent() async throws {
        let root = try temporaryRoot("model-decline")
        defer { try? FileManager.default.removeItem(at: root) }
        let target = proxyConfig(in: root)
        try writeFixture(adoptedConfig, at: target)
        let model = makeModel(root: root, evidence: covered([sha(keyA)]))
        await model.prepareAppend(.init(
            source: .managed(configFile: target),
            entries: [.init(profileID: "a", profileLabel: "Work", key: keyA)]
        ))
        model.decline()
        guard case .record(let record) = model.phase, case .refused = record.outcome else {
            Issue.record("declining must still produce a record")
            return
        }
        #expect(record.lines.contains(ConsentedConfigWriteCopy.declineConsequence))
        #expect(try String(contentsOf: target, encoding: .utf8) == adoptedConfig)
    }
}
