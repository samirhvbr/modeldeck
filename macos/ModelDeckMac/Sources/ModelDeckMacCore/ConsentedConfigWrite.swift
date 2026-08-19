import Foundation

// Issue #521 — the consented config write path (build item 4 of
// docs/keys-with-riders-design.md §5, the §2.6 operation), under decision 0036
// and Tim's recorded acceptance of the §2.6 residual risk (PR #506 comment,
// 2026-08-18).
//
// This file is the PURE half: target derivation, the api-keys editor, the
// pre-flight coverage gate, legacy-key admission, the provisioning record, and
// every user-facing string. It performs no filesystem work at all — the writes
// live in ConsentedConfigWriteLive.swift behind one guarded writer, which is
// what the write-guard tripwire scans for.
//
// Three facts from recon (docs/research/keys-riders-recon-v1-v5.md) are
// load-bearing here and are the reason several things read the way they do:
//
//  V2 — an empty or absent `api-keys` list means ACCEPT-ALL. Writing the FIRST
//       entry flips the proxy to enforce-list. Every client that is not
//       carrying a listed key 401s from that moment. Hence the pre-flight
//       coverage gate: the first append is refused without evidence that every
//       currently-routing client is covered.
//  V3 — config.yaml HOT-RELOADS (150 ms debounce, SHA-256 short-circuit,
//       survives atomic rename). There is no restart step in either direction,
//       so no copy in this file may promise one, and removal is live in
//       seconds too — including the last-entry removal that silently reopens
//       accept-all.
//  Startup side-finding — the proxy REWRITES config.yaml at first boot
//       (bcrypt of the management secret). The proxy is a concurrent writer
//       even with no management traffic, so the TOCTOU baseline must be
//       re-taken per attempt (that half lives in the live writer).

// MARK: - Target derivation (design §2.6, review should-fix 5)

/// Where a candidate config path came from. The proxy takes `-config <file>`,
/// so the target is DERIVED from what is actually running — never defaulted.
public enum ConsentedConfigTargetSource: Equatable, Sendable {
    /// ModelDeck's own managed proxy: we launched it, so we know its file.
    case managed(configFile: URL)
    /// A foreign proxy discovered as a plain process; `command` is the full
    /// command line `findCLIProxyServerProcess` already captures.
    case runningProcess(command: String)
    /// A foreign proxy supervised by launchd; the plist's ProgramArguments are
    /// the same authority as a process's argv.
    case launchAgent(programArguments: [String])
    /// Nothing identified it. Refuse — see `ConsentedConfigTarget.refused`.
    case unknown
}

/// The resolved target, or an honest refusal. Writing the default-path file
/// when the proxy was launched against another one would plant raw keys in a
/// file nothing reads and leave the feature claiming success forever.
public enum ConsentedConfigTarget: Equatable, Sendable {
    case file(URL)
    case refused(reason: String)

    public var fileURL: URL? {
        if case .file(let url) = self { return url }
        return nil
    }
}

/// Pulls the `-config <file>` argument out of an argv-shaped token list.
/// Accepts the four spellings the flag can take (`-config`, `--config`, and
/// either with `=`), and returns nil when the flag is absent — which is a
/// refusal, not a licence to guess the default path.
public func configPathArgument(inArguments arguments: [String]) -> String? {
    var index = 0
    while index < arguments.count {
        let token = arguments[index]
        if token == "-config" || token == "--config" {
            let next = index + 1
            guard next < arguments.count else { return nil }
            let value = arguments[next]
            return value.isEmpty ? nil : value
        }
        for prefix in ["-config=", "--config="] where token.hasPrefix(prefix) {
            let value = String(token.dropFirst(prefix.count))
            return value.isEmpty ? nil : value
        }
        index += 1
    }
    return nil
}

/// Splits a `ps`-style command line into tokens, honouring single and double
/// quotes so a quoted path containing spaces survives. `ps` output is lossy
/// about original quoting; an unbalanced quote yields tokens we then fail to
/// resolve, which lands in the refusal path rather than in a wrong path.
public func commandLineTokens(_ command: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    var quote: Character?
    var started = false
    for character in command {
        if let active = quote {
            if character == active { quote = nil } else { current.append(character) }
            continue
        }
        if character == "\"" || character == "'" {
            quote = character
            started = true
            continue
        }
        if character == " " || character == "\t" {
            if started { tokens.append(current) }
            current = ""
            started = false
            continue
        }
        current.append(character)
        started = true
    }
    if started { tokens.append(current) }
    return tokens
}

/// Resolves a source to the file the running proxy actually reads.
///
/// Every path that cannot be established refuses with the reason the user
/// sees. A relative `-config` path is refused too: it resolves against the
/// proxy's working directory, which `ps` does not report, and resolving it
/// against ours would name a different file with total confidence.
public func resolveConsentedConfigTarget(_ source: ConsentedConfigTargetSource) -> ConsentedConfigTarget {
    switch source {
    case .managed(let configFile):
        return .file(configFile.standardizedFileURL)
    case .runningProcess(let command):
        return resolve(arguments: commandLineTokens(command))
    case .launchAgent(let arguments):
        return resolve(arguments: arguments)
    case .unknown:
        return .refused(reason: ConsentedConfigWriteCopy.targetUnknownReason)
    }
}

private func resolve(arguments: [String]) -> ConsentedConfigTarget {
    guard let path = configPathArgument(inArguments: arguments) else {
        return .refused(reason: ConsentedConfigWriteCopy.targetNoConfigFlagReason)
    }
    guard path.hasPrefix("/") else {
        return .refused(reason: ConsentedConfigWriteCopy.targetRelativePathReason(path))
    }
    return .file(URL(fileURLWithPath: path).standardizedFileURL)
}

// MARK: - Errors

/// Failures of the consented write. **No case carries key material**: entries
/// are named by profile label or by position, never by value — an error string
/// reaches logs and UI, and a key must reach neither.
public enum ConsentedConfigWriteError: Error, Equatable, Sendable, LocalizedError {
    /// The file is not something the surgical editor can confidently edit
    /// (anchors, aliases, tags, merge keys, flow sequences, duplicate keys,
    /// CRLF, tabs, unexpected structure). Refused BEFORE any write.
    case unsupportedConfigStructure(reason: String)
    /// A value that cannot be written as a plain double-quoted YAML scalar.
    /// Refused rather than escaped — there is no escaping code path to get
    /// wrong. `origin` names where the value came from, never the value.
    case valueNotSafelyQuotable(origin: String)
    /// The target could not be derived from what is running (should-fix 5).
    case targetPathUnknown(reason: String)
    /// What the file would do no longer matches what the consent screen said
    /// it would do — the list emptied or filled between the prompt and the
    /// confirm. Refused before writing: consent covers the effect the user
    /// read about, not whatever the effect has since become (security review
    /// of PR #531, should-fix 1).
    case consentedEffectChanged(expected: String, actual: String)
    /// The first append was attempted without pre-flight client-coverage
    /// evidence, or with evidence that does not cover every observed client.
    /// This is the recorded V2 gate; it fails closed.
    case clientCoverageUnproven(reason: String, uncovered: [String])
    /// The file changed under us between the read and the publish, on every
    /// allowed attempt. Nothing was written.
    case concurrentWriteDetected(attempts: Int)
    /// Post-write verification failed and the rollback could not run safely
    /// because the file had already changed again. Nothing was restored; the
    /// backup path is named so the user can restore by hand.
    case rollbackRefusedFileChanged(backupPath: String)
    /// The published file is not owner-only and cannot be made so (should-fix
    /// 4). The append is refused rather than leaving keys world-readable.
    case permissionsTightenFailed(path: String)
    /// A recorded entry appears in the file more often than the provisioning
    /// record says ModelDeck wrote it — the user placed one of their own.
    /// Automatic removal refuses and surfaces it.
    case removalRefusedDuplicate(profileLabel: String)
    /// The record names a different file than the one now being edited.
    case recordTargetMismatch(recorded: String, current: String)
    case backupWriteFailed(path: String)
    case backupOutsideStateDirectory(path: String)
    case configReadFailed(path: String)
    case configWriteFailed(path: String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedConfigStructure(let reason):
            return "ModelDeck won't edit this proxy config automatically: \(reason)"
        case .valueNotSafelyQuotable(let origin):
            return "ModelDeck refused to write a key that isn't a plain text value (\(origin)). Nothing was changed."
        case .targetPathUnknown(let reason):
            return reason
        case .consentedEffectChanged(let expected, let actual):
            return "Your proxy config changed while ModelDeck was asking. You agreed to a change that would \(expected), but doing it now would \(actual) — so nothing was written. Start again and read the new prompt."
        case .clientCoverageUnproven(let reason, let uncovered):
            let names = uncovered.isEmpty ? "" : " (\(uncovered.joined(separator: ", ")))"
            return "\(reason)\(names)"
        case .concurrentWriteDetected(let attempts):
            return "The proxy rewrote its own config while ModelDeck was editing it (\(attempts) attempts). Nothing was changed — try again."
        case .rollbackRefusedFileChanged(let backupPath):
            return "ModelDeck's edit didn't verify, and the file changed again before it could be put back — so it was left alone rather than overwritten. The copy taken before the edit is at \(backupPath)."
        case .permissionsTightenFailed(let path):
            return "ModelDeck couldn't make \(path) owner-only, so it did not add any keys to it. Run: chmod 600 \(path)"
        case .removalRefusedDuplicate(let profileLabel):
            return "The api-keys list carries more entries for \(profileLabel) than ModelDeck added, so one of them is yours. ModelDeck removed nothing and left the list for you to edit."
        case .recordTargetMismatch(let recorded, let current):
            return "ModelDeck recorded its keys in \(recorded), but the proxy now reads \(current). Nothing was removed."
        case .backupWriteFailed(let path):
            return "ModelDeck couldn't save a copy of the config at \(path), so it did not edit the original."
        case .backupOutsideStateDirectory(let path):
            return "ModelDeck refused to save a config copy outside its own storage (\(path))."
        case .configReadFailed(let path):
            return "ModelDeck couldn't read \(path)."
        case .configWriteFailed(let path):
            return "ModelDeck couldn't write \(path)."
        }
    }
}

// MARK: - Safe scalar charset

/// Values ModelDeck is willing to write into the config as a double-quoted
/// scalar: printable ASCII, no quote, no backslash, bounded. Our own generated
/// keys are base64url and pass trivially; the LEGACY shared value comes out of
/// a user-created Keychain item and is therefore untrusted input on its way
/// into a config file — a value failing this refuses the operation instead of
/// being escaped (design §3.5's structural posture).
public enum ConsentedConfigScalar {
    public static let maximumLength = 512

    public static func isSafe(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maximumLength else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 0x20 && scalar.value <= 0x7E
                && scalar != "\"" && scalar != "\\"
        }
    }

    public static func quoted(_ value: String, origin: String) throws -> String {
        guard isSafe(value) else {
            throw ConsentedConfigWriteError.valueNotSafelyQuotable(origin: origin)
        }
        return "\"\(value)\""
    }
}

// MARK: - The surgical editor (design §2.6)

/// One parsed `api-keys` entry: its value and the line it lives on.
public struct ConfigAPIKeyEntry: Equatable, Sendable {
    public var value: String
    public var lineIndex: Int
}

/// A config document parsed only as far as the `api-keys` list — deliberately
/// NOT a YAML round-trip. Re-serialising would destroy the user's comments and
/// formatting, which is a soft form of the destruction the never-modify rule
/// exists to prevent (design §2.6). Anything this parser cannot read with
/// confidence refuses before a byte is written.
public struct ConfigAPIKeysDocument: Equatable, Sendable {
    /// The exact original text, unmodified.
    public let text: String
    /// Lines, split on "\n" (CRLF files are refused at parse).
    public let lines: [String]
    /// Parsed entries, in file order.
    public let entries: [ConfigAPIKeyEntry]
    /// Index of the top-level `api-keys:` line, when the key exists.
    public let keyLineIndex: Int?
    /// Where a new item line must be inserted, and with what indent.
    public let insertionIndex: Int
    public let itemIndent: Int
    /// The `auth-dir` value, when the document declares one. Read only so the
    /// write guard can prove the target is not inside the proxy's auth
    /// directory (decision 0006 — auth files are never ours to touch).
    public let declaredAuthDirectory: String?

    public var isEmptyList: Bool { entries.isEmpty }

    private static let tokensRefused: [(String, String)] = [
        ("&", "it uses YAML anchors"),
        ("*", "it uses YAML aliases"),
        ("<<:", "it uses YAML merge keys"),
        ("!", "it uses YAML tags or includes"),
    ]

    /// Parses, or refuses. The refusals are deliberately broad: an
    /// over-refusal costs the user a copy-pasteable snippet, an under-refusal
    /// costs them their config.
    public static func parse(_ text: String) throws -> ConfigAPIKeysDocument {
        func refuse(_ reason: String) -> ConsentedConfigWriteError {
            .unsupportedConfigStructure(reason: reason)
        }
        guard !text.contains("\r") else {
            throw refuse("the file uses Windows line endings, which ModelDeck won't rewrite.")
        }
        var lines = text.components(separatedBy: "\n")
        // A trailing "\n" yields a final empty component; keep it out of the
        // structural scan and restore it when rendering.
        let hasTrailingNewline = lines.last == "" && lines.count > 1
        if hasTrailingNewline { lines.removeLast() }

        var authDirectory: String?
        var keyLineIndex: Int?
        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") || trimmed.isEmpty { continue }
            guard !line.contains("\t") else {
                throw refuse("line \(index + 1) is indented with tabs, which YAML forbids and ModelDeck won't guess at.")
            }
            // Multi-document files (nit 9): with a `---` or `...` marker the
            // file holds more than one document and the proxy reads one of
            // them. An append could land in a document nothing loads, while
            // the post-write verify — which only compares bytes — would report
            // the change live. Refuse rather than write into the wrong half.
            guard !(trimmed == "---" || trimmed == "..." || line.hasPrefix("--- ") || line.hasPrefix("... ")) else {
                throw refuse("it holds more than one YAML document (line \(index + 1)), and ModelDeck can't prove which one your proxy reads.")
            }
            let significant = significantPart(of: line)
            for (token, reason) in tokensRefused where significant.contains(token) {
                // A `*` or `!` inside a quoted scalar is harmless, but the
                // cheap test cannot tell — refuse and hand over a snippet.
                throw refuse("\(reason) (line \(index + 1)), so ModelDeck can't prove an edit changes only the api-keys list.")
            }
            guard let key = topLevelKey(of: line) else { continue }
            if key == "auth-dir" {
                authDirectory = scalarValue(afterKey: key, in: significant)
            }
            guard key == "api-keys" else { continue }
            guard keyLineIndex == nil else {
                throw refuse("it declares api-keys twice (lines \(keyLineIndex! + 1) and \(index + 1)).")
            }
            let inlineValue = scalarValue(afterKey: key, in: significant)
            if let inlineValue, !inlineValue.isEmpty {
                throw refuse("its api-keys list is written inline on line \(index + 1); ModelDeck only edits the one-entry-per-line form.")
            }
            keyLineIndex = index
        }

        var entries: [ConfigAPIKeyEntry] = []
        var insertionIndex = lines.count
        var itemIndent = 2
        if let keyLineIndex {
            var lastItemLine = keyLineIndex
            var index = keyLineIndex + 1
            while index < lines.count {
                let line = lines[index]
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty || trimmed.hasPrefix("#") { index += 1; continue }
                let indent = line.prefix(while: { $0 == " " }).count
                if indent == 0 { break }
                guard trimmed.hasPrefix("- ") || trimmed == "-" else {
                    throw refuse("its api-keys list holds something other than one value per line (line \(index + 1)).")
                }
                let raw = String(trimmed.dropFirst(1)).trimmingCharacters(in: .whitespaces)
                let value = try itemScalar(raw, line: index + 1)
                entries.append(ConfigAPIKeyEntry(value: value, lineIndex: index))
                itemIndent = indent
                lastItemLine = index
                index += 1
            }
            insertionIndex = lastItemLine + 1
        }

        return ConfigAPIKeysDocument(
            text: text,
            lines: lines,
            entries: entries,
            keyLineIndex: keyLineIndex,
            insertionIndex: insertionIndex,
            itemIndent: itemIndent,
            declaredAuthDirectory: authDirectory
        )
    }

    /// The part of a line outside quoted scalars and trailing comments — what
    /// the structural checks look at, so a `#` inside a quoted key is not read
    /// as a comment.
    static func significantPart(of line: String) -> String {
        var result = ""
        var quote: Character?
        var previous: Character?
        for character in line {
            if let active = quote {
                result.append(character)
                if character == active { quote = nil }
                previous = character
                continue
            }
            if character == "\"" || character == "'" {
                quote = character
                result.append(character)
                previous = character
                continue
            }
            if character == "#" && (previous == nil || previous == " ") { break }
            result.append(character)
            previous = character
        }
        return result
    }

    /// `foo:` / `foo: bar` at column 0 → "foo". Anything indented, or not of
    /// that shape, is not a top-level key.
    static func topLevelKey(of line: String) -> String? {
        guard let first = line.first, first != " ", first != "-", first != "#" else { return nil }
        let significant = significantPart(of: line)
        guard let colon = significant.firstIndex(of: ":") else { return nil }
        let key = String(significant[significant.startIndex..<colon])
        guard !key.isEmpty, key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." })
        else { return nil }
        return key
    }

    /// The scalar after `key:` on the same line, unquoted. nil when the line
    /// carries no value.
    static func scalarValue(afterKey key: String, in significant: String) -> String? {
        guard let colon = significant.firstIndex(of: ":") else { return nil }
        let rest = String(significant[significant.index(after: colon)...])
            .trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : unquote(rest)
    }

    /// One `- value` item's scalar, refusing the ambiguous forms.
    static func itemScalar(_ raw: String, line: Int) throws -> String {
        guard !raw.isEmpty else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "its api-keys list has an empty item on line \(line)."
            )
        }
        if raw.hasPrefix("\"") || raw.hasPrefix("'") {
            let quote = raw.first!
            guard raw.count >= 2, raw.hasSuffix(String(quote)) else {
                throw ConsentedConfigWriteError.unsupportedConfigStructure(
                    reason: "an api-keys entry spans more than one line (line \(line))."
                )
            }
            return String(raw.dropFirst().dropLast())
        }
        let plain = significantPart(of: raw).trimmingCharacters(in: .whitespaces)
        guard !plain.contains(":"), !plain.contains("{"), !plain.contains("[") else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "an api-keys entry on line \(line) isn't a plain value."
            )
        }
        return plain
    }

    static func unquote(_ value: String) -> String {
        guard let first = value.first, first == "\"" || first == "'",
              value.count >= 2, value.hasSuffix(String(first))
        else { return value }
        return String(value.dropFirst().dropLast())
    }
}

/// The enforcement change the CONSENT SCREEN described, carried into the write
/// so the two can be compared (security review of PR #531, should-fix 1).
///
/// The prepare→confirm window is unbounded — the user can sit on the prompt —
/// and `apply` deliberately re-plans from fresh bytes on every attempt. Without
/// this, a list emptied in that window turns a "this adds a key, enforcement is
/// unchanged" consent into an ungated, undisclosed first-entry flip; a list
/// filled in that window turns a disclosed last-entry removal into an
/// undisclosed one, or the reverse. The writer already computes both flags; it
/// now has to agree with what was shown.
public struct ConsentedFlipExpectation: Equatable, Sendable {
    public var flipsEnforcementOn: Bool
    public var flipsEnforcementOff: Bool

    public init(flipsEnforcementOn: Bool, flipsEnforcementOff: Bool) {
        self.flipsEnforcementOn = flipsEnforcementOn
        self.flipsEnforcementOff = flipsEnforcementOff
    }

    /// The consent said enforcement does not change in either direction.
    public static let noEnforcementChange = ConsentedFlipExpectation(
        flipsEnforcementOn: false, flipsEnforcementOff: false
    )

    /// Plain-English description, used in the mismatch refusal so the user is
    /// told which promise stopped being true.
    public var description: String {
        if flipsEnforcementOn { return "start your proxy refusing clients without a key" }
        if flipsEnforcementOff { return "return your proxy to accepting every local request without a key" }
        return "leave who your proxy accepts unchanged"
    }
}

/// The result of an edit: the new text, plus what changed, plus the proof that
/// nothing else did.
public struct ConfigAPIKeysEdit: Equatable, Sendable {
    public var text: String
    public var addedValues: [String]
    public var removedLineIndices: [Int]
    public var entriesAfterEdit: Int
    /// True when this edit writes the FIRST entry into a previously empty or
    /// absent list — the V2 enforcement flip.
    public var flipsEnforcementOn: Bool
    /// True when this edit removes the LAST entry, silently returning the
    /// proxy to accept-all (recon V3 amendment). The removal UX must say so.
    public var flipsEnforcementOff: Bool
}

public extension ConfigAPIKeysDocument {
    /// Appends entries as `- "value"` lines, either into the existing block or
    /// as a new block at the end of the document. Pure line insertion — user
    /// comments, ordering, and formatting elsewhere are untouched by
    /// construction, and `verifyInsertionOnly` re-proves it.
    func appending(_ values: [String], origin: String = "a client key") throws -> ConfigAPIKeysEdit {
        guard !values.isEmpty else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(reason: "there were no entries to add.")
        }
        let quoted = try values.map { try ConsentedConfigScalar.quoted($0, origin: origin) }
        var newLines = lines
        var inserted: [String] = []
        let indent = String(repeating: " ", count: max(itemIndent, 2))
        if keyLineIndex == nil {
            inserted.append("api-keys:")
        }
        inserted.append(contentsOf: quoted.map { "\(indent)- \($0)" })
        newLines.insert(contentsOf: inserted, at: min(insertionIndex, newLines.count))
        let text = render(newLines)
        try Self.verifyInsertionOnly(
            original: self.text, edited: text,
            insertedAt: min(insertionIndex, lines.count), inserted: inserted
        )
        let after = try ConfigAPIKeysDocument.parse(text)
        guard after.entries.map(\.value) == entries.map(\.value) + values else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "the edited file did not re-read as the original list plus the new entries."
            )
        }
        return ConfigAPIKeysEdit(
            text: text,
            addedValues: values,
            removedLineIndices: [],
            entriesAfterEdit: after.entries.count,
            flipsEnforcementOn: entries.isEmpty,
            flipsEnforcementOff: false
        )
    }

    /// Removes exactly the entries the provisioning record claims — matched by
    /// SHA-256 of the entry value, so no raw key is ever persisted in the
    /// record. Refuses when a recorded hash appears MORE often than the record
    /// says ModelDeck wrote it: value match alone cannot prove an entry is
    /// ours (design §2.6).
    func removing(
        record: ConfigKeyProvisioningRecord,
        hash: (String) -> String
    ) throws -> ConfigAPIKeysEdit {
        var counts: [String: Int] = [:]
        for entry in entries where !entry.value.isEmpty {
            counts[hash(entry.value), default: 0] += 1
        }
        var targeted: [Int] = []
        for recorded in record.entries {
            let present = counts[recorded.keySha256] ?? 0
            guard present <= recorded.occurrences else {
                throw ConsentedConfigWriteError.removalRefusedDuplicate(profileLabel: recorded.profileLabel)
            }
            guard present > 0 else { continue }
            targeted.append(contentsOf: entries
                .filter { !$0.value.isEmpty && hash($0.value) == recorded.keySha256 }
                .map(\.lineIndex))
        }
        if let legacyHash = record.legacyValueSha256 {
            let present = counts[legacyHash] ?? 0
            guard present <= 1 else {
                throw ConsentedConfigWriteError.removalRefusedDuplicate(
                    profileLabel: ConsentedConfigWriteCopy.legacyEntryName
                )
            }
            targeted.append(contentsOf: entries
                .filter { !$0.value.isEmpty && hash($0.value) == legacyHash }
                .map(\.lineIndex))
        }
        let removalSet = Set(targeted)
        guard !removalSet.isEmpty else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "none of the keys ModelDeck recorded are in the file any more."
            )
        }
        var newLines: [String] = []
        for (index, line) in lines.enumerated() where !removalSet.contains(index) {
            newLines.append(line)
        }
        let text = render(newLines)
        let after = try ConfigAPIKeysDocument.parse(text)
        let expected = entries.filter { !removalSet.contains($0.lineIndex) }.map(\.value)
        guard after.entries.map(\.value) == expected else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "the edited file did not re-read as the original list minus ModelDeck's entries."
            )
        }
        return ConfigAPIKeysEdit(
            text: text,
            addedValues: [],
            removedLineIndices: removalSet.sorted(),
            entriesAfterEdit: after.entries.count,
            flipsEnforcementOn: false,
            flipsEnforcementOff: !entries.isEmpty && after.entries.isEmpty
        )
    }

    private func render(_ newLines: [String]) -> String {
        let hadTrailingNewline = text.hasSuffix("\n") || text.isEmpty
        return newLines.joined(separator: "\n") + (hadTrailingNewline ? "\n" : "")
    }

    /// Proves the edit is exactly an insertion of `inserted` at `insertedAt`
    /// and nothing else: delete those lines back out and the original must
    /// return byte for byte. This is the "differs in exactly the api-keys
    /// additions and nothing else" check, done on bytes rather than on trust.
    static func verifyInsertionOnly(
        original: String, edited: String, insertedAt: Int, inserted: [String]
    ) throws {
        var lines = edited.components(separatedBy: "\n")
        let hadTrailing = lines.last == "" && lines.count > 1
        if hadTrailing { lines.removeLast() }
        guard insertedAt + inserted.count <= lines.count,
              Array(lines[insertedAt..<(insertedAt + inserted.count)]) == inserted
        else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "ModelDeck could not verify its own edit, so it wrote nothing."
            )
        }
        lines.removeSubrange(insertedAt..<(insertedAt + inserted.count))
        let restored = lines.joined(separator: "\n") + (hadTrailing ? "\n" : "")
        guard restored == original else {
            throw ConsentedConfigWriteError.unsupportedConfigStructure(
                reason: "ModelDeck's edit changed something outside the api-keys list, so it wrote nothing."
            )
        }
    }
}

// MARK: - Pre-flight client coverage (the recorded V2 gate)

/// One client currently observed routing through the proxy, and what will
/// cover it once the api-keys list exists.
public struct ObservedProxyClient: Equatable, Sendable {
    public enum Coverage: Equatable, Sendable {
        /// Sends a per-profile key ModelDeck is about to write.
        case provisionedKey(sha256: String)
        /// Sends the legacy shared key — covered only if the legacy value is
        /// appended too (design §2.5's live-session continuity).
        case legacySharedKey
        /// Sends no key at all. NOTHING covers this client; the first append
        /// 401s it within ~2 seconds.
        case none
    }

    public var name: String
    public var coverage: Coverage

    public init(name: String, coverage: Coverage) {
        self.name = name
        self.coverage = coverage
    }
}

/// The evidence the gate demands before the FIRST entry is written. It is
/// evidence, not an assertion: it names when it was taken, over what window,
/// and whether the observation could see everything.
public struct ClientCoverageEvidence: Equatable, Sendable {
    public var observedAt: Date
    /// Plain-English description of the window the observation covers, shown
    /// on the consent screen ("the last 24 hours of proxy requests").
    public var windowDescription: String
    public var clients: [ObservedProxyClient]
    /// False when the observation source could not enumerate every client —
    /// e.g. the usage corpus was unreachable. An incomplete observation can
    /// never prove coverage.
    public var isComplete: Bool

    public init(observedAt: Date, windowDescription: String, clients: [ObservedProxyClient], isComplete: Bool) {
        self.observedAt = observedAt
        self.windowDescription = windowDescription
        self.clients = clients
        self.isComplete = isComplete
    }
}

public enum ClientCoverageVerdict: Equatable, Sendable {
    /// Every observed client carries a key that will be in the written list.
    case covered(clientCount: Int)
    /// The list is already non-empty, so the proxy is ALREADY enforcing and
    /// this append cannot 401 anyone who works today. Distinct from `.covered`
    /// on purpose: no check ran, and saying "ModelDeck saw no clients" about a
    /// check that never happened is a lie the user would reasonably act on
    /// (security review of PR #531, should-fix 5).
    case stoodDown
    /// The append must not be offered. `uncovered` names the clients that
    /// would 401 — by client name, never by key.
    case blocked(reason: String, uncovered: [String])

    /// True when the write may proceed. Both `.covered` and `.stoodDown`
    /// qualify; they differ in what the user is TOLD, not in what is allowed.
    public var isCovered: Bool {
        switch self {
        case .covered, .stoodDown: return true
        case .blocked: return false
        }
    }
}

/// The gate. Fails closed on every axis: missing evidence, stale evidence,
/// incomplete observation, a keyless client, a legacy-key client when the
/// legacy value is not being appended, or a key whose hash is not in the set
/// about to be written.
///
/// `isFirstEntry` is the whole reason this exists: once the list is non-empty
/// the proxy is ALREADY enforcing, so a later append cannot 401 anyone who is
/// working today, and the gate stands down rather than blocking maintenance.
public func decideClientCoverage(
    evidence: ClientCoverageEvidence?,
    isFirstEntry: Bool,
    appendedKeyHashes: Set<String>,
    legacyValueWillBeAppended: Bool,
    now: Date = Date(),
    maximumEvidenceAge: TimeInterval = 600
) -> ClientCoverageVerdict {
    guard isFirstEntry else { return .stoodDown }
    guard let evidence else {
        return .blocked(reason: ConsentedConfigWriteCopy.coverageMissingReason, uncovered: [])
    }
    guard evidence.isComplete else {
        return .blocked(reason: ConsentedConfigWriteCopy.coverageIncompleteReason, uncovered: [])
    }
    let age = now.timeIntervalSince(evidence.observedAt)
    guard age >= 0, age <= maximumEvidenceAge else {
        return .blocked(reason: ConsentedConfigWriteCopy.coverageStaleReason, uncovered: [])
    }
    var uncovered: [String] = []
    for client in evidence.clients {
        switch client.coverage {
        case .none:
            uncovered.append(client.name)
        case .legacySharedKey:
            if !legacyValueWillBeAppended { uncovered.append(client.name) }
        case .provisionedKey(let sha256):
            if !appendedKeyHashes.contains(sha256) { uncovered.append(client.name) }
        }
    }
    guard uncovered.isEmpty else {
        return .blocked(reason: ConsentedConfigWriteCopy.coverageUncoveredReason, uncovered: uncovered)
    }
    return .covered(clientCount: evidence.clients.count)
}

// MARK: - Legacy shared key admission (design §2.5, blocker 2)

/// What migration does with the legacy shared Keychain value.
public enum LegacyKeyAdmission: Equatable, Sendable {
    /// No legacy item exists — nothing to admit.
    case none
    /// Append it alongside the per-profile keys so live shells keep working.
    case append(value: String)
    /// The legacy value hashes to the same domain as a managed profile key
    /// (realistically: the user copied a managed key into the shared item).
    /// Those profiles must be ROTATED before any mapping ships, or legacy
    /// traffic would misattribute to them. Until disjoint, nothing is written.
    case rotateFirst(profileIDs: [String])
    /// The legacy value is not a plain text scalar; it is refused rather than
    /// escaped into the config.
    case refuseUnsafeValue
}

/// Enforces hash-domain disjointness at migration (design §2.5, CodeRabbit on
/// PR #506). Called BEFORE the append plan is built, so a collision blocks the
/// write rather than being discovered after keys are on disk.
public func planLegacyKeyAdmission(
    legacyValue: String?,
    managedKeyHashesByProfileID: [String: String],
    hash: (String) -> String
) -> LegacyKeyAdmission {
    guard let legacyValue, !legacyValue.isEmpty else { return .none }
    guard ConsentedConfigScalar.isSafe(legacyValue) else { return .refuseUnsafeValue }
    let legacyHash = hash(legacyValue)
    let colliding = managedKeyHashesByProfileID
        .filter { $0.value == legacyHash }
        .keys
        .sorted()
    guard colliding.isEmpty else { return .rotateFirst(profileIDs: colliding) }
    return .append(value: legacyValue)
}

// MARK: - Provisioning record

/// What ModelDeck wrote, by hash — never by value. This is the authority the
/// removal path uses; a raw key never lands in it, so the record itself is not
/// secret-bearing (unlike the config backups, which are).
public struct ConfigKeyProvisioningRecord: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var profileID: String
        public var profileLabel: String
        public var keySha256: String
        /// How many entries ModelDeck added carrying this value — always 1
        /// today, recorded explicitly so refuse-on-duplicate compares counts
        /// rather than assuming.
        public var occurrences: Int

        public init(profileID: String, profileLabel: String, keySha256: String, occurrences: Int = 1) {
            self.profileID = profileID
            self.profileLabel = profileLabel
            self.keySha256 = keySha256
            self.occurrences = occurrences
        }
    }

    /// The exact file the entries were written into (should-fix 5: removal
    /// must not fire at a different file than the append did).
    public var targetPath: String
    public var writtenAt: Date
    public var entries: [Entry]
    public var legacyValueSha256: String?
    /// Backups taken for this record, newest last. Retained as the rollback
    /// path until removal is verified live (should-fix 6).
    public var backupPaths: [String]

    public init(
        targetPath: String,
        writtenAt: Date,
        entries: [Entry],
        legacyValueSha256: String? = nil,
        backupPaths: [String] = []
    ) {
        self.targetPath = targetPath
        self.writtenAt = writtenAt
        self.entries = entries
        self.legacyValueSha256 = legacyValueSha256
        self.backupPaths = backupPaths
    }
}

/// Persists the provisioning record across launches.
public protocol ConfigKeyProvisioningRecordStoring: AnyObject, Sendable {
    var record: ConfigKeyProvisioningRecord? { get set }
}

/// UserDefaults-backed, same convention as the onboarding store.
public final class UserDefaultsConfigKeyProvisioningRecordStore: ConfigKeyProvisioningRecordStoring, @unchecked Sendable {
    public static let defaultsKey = "modeldeck.clientKeys.configProvisioningRecord"
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = defaultsKey) {
        self.defaults = defaults
        self.key = key
    }

    public var record: ConfigKeyProvisioningRecord? {
        get {
            guard let data = defaults.data(forKey: key) else { return nil }
            return try? JSONDecoder().decode(ConfigKeyProvisioningRecord.self, from: data)
        }
        set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                defaults.removeObject(forKey: key)
                return
            }
            defaults.set(data, forKey: key)
        }
    }
}

// MARK: - Activation (recon V3: hot reload, no restart in either direction)

/// How live the change is. There is no "pending restart" state in either
/// direction — recon V3 contradicted that half of the design, and this enum is
/// the amendment.
public enum ConsentedConfigActivation: Equatable, Sendable {
    /// Written; the proxy re-reads within its debounce. Enforcement is
    /// arriving right now, not on some later event.
    case takingEffectNow
    /// Settled: after the reload window the file on disk still carries exactly
    /// what ModelDeck wrote. This is a file-state proof, not a request-level
    /// one — no probe is made, because probing the proxy with a key is a
    /// request we refuse to invent.
    case live
    /// The file changed again after our publish; ModelDeck will not claim its
    /// change is in force.
    case superseded(reason: String)

    public var isLive: Bool { self == .live }
}

// MARK: - Consent prompt (design §2.6, gate conditions b and c)

/// Everything the user reads BEFORE anything happens: the exact file, the
/// exact changes (both of them), where the backup goes, how to undo, and — the
/// recorded V2/V3 gate — that it takes effect immediately.
public struct ConsentedConfigConsentPrompt: Equatable, Sendable {
    public var title: String
    /// The two operations, named separately. Never collapsed into "update your
    /// config": the permissions tighten is a change to the user's file too.
    public var operations: [String]
    /// Immediacy plus, on a first append, the enforcement flip.
    public var effects: [String]
    public var backupLine: String
    public var undoLine: String
    public var coverageLine: String
    public var confirmButtonTitle: String
    public var declineButtonTitle: String
    public var declineConsequence: String
}

/// Builds the consent prompt for an append.
public func consentedConfigAppendPrompt(
    targetPath: String,
    entryCount: Int,
    appendsLegacyValue: Bool,
    currentMode: UInt16?,
    backupDirectoryPath: String,
    coverage: ClientCoverageVerdict,
    isFirstEntry: Bool
) -> ConsentedConfigConsentPrompt {
    var operations = [ConsentedConfigWriteCopy.appendOperation(entryCount: entryCount, targetPath: targetPath)]
    if appendsLegacyValue {
        operations.append(ConsentedConfigWriteCopy.legacyAppendOperation)
    }
    operations.append(ConsentedConfigWriteCopy.tightenOperation(targetPath: targetPath, currentMode: currentMode))
    var effects = [ConsentedConfigWriteCopy.immediacyEffect]
    if isFirstEntry { effects.append(ConsentedConfigWriteCopy.enforcementFlipEffect) }
    effects.append(ConsentedConfigWriteCopy.nothingElseChangesEffect)
    let coverageLine: String
    switch coverage {
    case .covered(let count):
        coverageLine = ConsentedConfigWriteCopy.coverageCoveredLine(clientCount: count)
    case .stoodDown:
        coverageLine = ConsentedConfigWriteCopy.coverageStoodDownLine
    case .blocked(let reason, let uncovered):
        coverageLine = uncovered.isEmpty ? reason : "\(reason) (\(uncovered.joined(separator: ", ")))"
    }
    return ConsentedConfigConsentPrompt(
        title: ConsentedConfigWriteCopy.appendTitle,
        operations: operations,
        effects: effects,
        backupLine: ConsentedConfigWriteCopy.backupLine(directoryPath: backupDirectoryPath),
        undoLine: ConsentedConfigWriteCopy.undoLine,
        coverageLine: coverageLine,
        confirmButtonTitle: ConsentedConfigWriteCopy.appendConfirmButtonTitle,
        declineButtonTitle: ConsentedConfigWriteCopy.declineButtonTitle,
        declineConsequence: ConsentedConfigWriteCopy.declineConsequence
    )
}

/// Builds the consent prompt for a removal. `wouldEmptyList` carries the gate's
/// third condition: removing the last entry silently reopens accept-all.
public func consentedConfigRemovalPrompt(
    targetPath: String,
    entryCount: Int,
    wouldEmptyList: Bool,
    backupDirectoryPath: String
) -> ConsentedConfigConsentPrompt {
    var effects = [ConsentedConfigWriteCopy.immediacyEffect]
    if wouldEmptyList { effects.append(ConsentedConfigWriteCopy.lastEntryRemovalDisclosure) }
    effects.append(ConsentedConfigWriteCopy.nothingElseChangesEffect)
    return ConsentedConfigConsentPrompt(
        title: ConsentedConfigWriteCopy.removalTitle,
        operations: [ConsentedConfigWriteCopy.removalOperation(entryCount: entryCount, targetPath: targetPath)],
        effects: effects,
        backupLine: ConsentedConfigWriteCopy.backupLine(directoryPath: backupDirectoryPath),
        undoLine: ConsentedConfigWriteCopy.undoLine,
        coverageLine: ConsentedConfigWriteCopy.removalCoverageLine,
        confirmButtonTitle: ConsentedConfigWriteCopy.removalConfirmButtonTitle,
        declineButtonTitle: ConsentedConfigWriteCopy.declineButtonTitle,
        declineConsequence: ConsentedConfigWriteCopy.removalDeclineConsequence
    )
}

// MARK: - The visible record (never silent, 0008/0011)

/// Emitted by every outcome of the operation — success, refusal, or failure.
/// Its existence is the never-silent rule made structural.
public struct ConsentedConfigRecord: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        case written
        case refused(reason: String)
        case failed(reason: String)
    }

    public var outcome: Outcome
    public var headline: String
    public var lines: [String]
    public var backupPath: String?
    /// Earlier backups that also still hold the keys this operation removed —
    /// one per append, now that appends merge into the provisioning record
    /// rather than replacing it.
    public var staleBackupPaths: [String]
    public var activation: ConsentedConfigActivation?
    /// Only offered once removal is verified live: a secret-bearing backup
    /// must not silently outlive the keys it holds (should-fix 6).
    public var offersBackupDeletion: Bool

    public init(
        outcome: Outcome,
        headline: String,
        lines: [String],
        backupPath: String? = nil,
        staleBackupPaths: [String] = [],
        activation: ConsentedConfigActivation? = nil,
        offersBackupDeletion: Bool = false
    ) {
        self.outcome = outcome
        self.headline = headline
        self.lines = lines
        self.backupPath = backupPath
        self.staleBackupPaths = staleBackupPaths
        self.activation = activation
        self.offersBackupDeletion = offersBackupDeletion
    }

    public var succeeded: Bool {
        if case .written = outcome { return true }
        return false
    }
}

// MARK: - Copy (TRIPWIRE consent-copy-states-immediacy)

/// Every string the consented write path shows. It lives in Core so the
/// load-bearing sentences are pinned by tests — the same reason
/// `ManagedProxyOnboardingCopy` and `SystemPromptCoaching` do.
///
/// TWO RULES ARE ENFORCED BY TRIPWIRE, both from the recorded V2 gate:
///  1. Every consent and removal string states the change is IMMEDIATE. No
///     string in this enum may contain the word "restart" — recon V3 proved
///     config.yaml hot-reloads, so a restart framing would be a lie that costs
///     the user 401s they were told to expect later.
///  2. The removal copy states that removing the last entry returns the proxy
///     to accepting every local request without a key.
public enum ConsentedConfigWriteCopy {
    // Names
    public static let legacyEntryName = "the shared key your shells already use"

    // Append consent
    public static let appendTitle = "Add ModelDeck's client keys to your proxy config?"

    public static func appendOperation(entryCount: Int, targetPath: String) -> String {
        let noun = entryCount == 1 ? "one entry" : "\(entryCount) entries"
        return "Add \(noun) to the api-keys list in \(targetPath). Nothing else in that file is touched — your comments, ordering, and every other setting stay exactly as they are."
    }

    public static let legacyAppendOperation = "Also add the shared key your shells already use, so sessions already running keep working instead of failing mid-run."

    public static func tightenOperation(targetPath: String, currentMode: UInt16?) -> String {
        let modeText = currentMode.map { String(format: "%03o", $0 & 0o777) }
        let from = modeText.map { " It is \($0) today." } ?? ""
        return "Make \(targetPath) readable and writable by you only (chmod 600).\(from) The file is about to hold key material, and anything looser leaves it readable by every process on this Mac."
    }

    // Effects — condition (b) of the recorded V2 gate.
    public static let immediacyEffect = "This takes effect immediately. The proxy watches this file and re-reads it about two seconds after it is saved — there is no later step, no grace period, and no second confirmation."
    public static let enforcementFlipEffect = "Right now your proxy answers every local request, key or no key. The moment the first entry lands it starts refusing — with 401 Missing API key — every client that is not sending one of the listed keys."
    public static let nothingElseChangesEffect = "Nothing else changes: no sign-ins are touched, no provider is contacted, and no traffic is sent anywhere."

    public static func backupLine(directoryPath: String) -> String {
        "ModelDeck saves a timestamped copy of the file first, readable by you only, in \(directoryPath). It holds the same secrets the config does, so it is kept there and nowhere else, and old copies are pruned."
    }

    public static let undoLine = "To undo by hand: copy the saved file back over your config. The proxy picks it up within seconds, the same way it picks up this change."

    public static let appendConfirmButtonTitle = "Add the keys now"
    public static let declineButtonTitle = "Leave my config alone"
    public static let declineConsequence = "ModelDeck changes nothing and per-profile attribution stays unavailable — receipts keep showing usage without saying which profile spent it."

    // Coverage (condition (a) of the recorded V2 gate)
    public static func coverageCoveredLine(clientCount: Int) -> String {
        clientCount == 0
            ? "ModelDeck saw no clients using this proxy in the checked window, so nothing loses access when the list starts being enforced."
            : "ModelDeck checked every client using this proxy (\(clientCount)) and each one already sends a key that will be in the list."
    }

    /// Shown when the list is already non-empty. It must NOT claim a check
    /// found nothing — no check ran (security review of PR #531, should-fix 5).
    public static let coverageStoodDownLine = "Your key list is already in force, so this adds a key without changing who the proxy accepts. Nothing that works today stops working."

    public static let coverageMissingReason = "ModelDeck has not checked which clients are using this proxy right now, so it will not switch the proxy over to key-only."
    public static let coverageIncompleteReason = "ModelDeck could not see every client using this proxy, so it cannot promise none of them stops working."
    public static let coverageStaleReason = "The check of which clients are using this proxy is too old to rely on. Run it again."
    public static let coverageUncoveredReason = "These clients send no key ModelDeck is about to list, so they would start failing the moment your key list takes effect"

    // Target derivation (should-fix 5)
    public static let targetUnknownReason = "ModelDeck can't tell which config file your proxy is reading, so it will not write to one. Add the keys yourself, or let ModelDeck manage the proxy."
    public static let targetNoConfigFlagReason = "Your proxy was started without a -config path, so ModelDeck can't prove which file it reads. Writing to the default path could leave keys in a file nothing loads."
    public static func targetRelativePathReason(_ path: String) -> String {
        "Your proxy was started with a relative config path (\(path)), which points somewhere different depending on where it was launched from. ModelDeck won't guess."
    }

    // Removal — condition (c) of the recorded V2 gate.
    public static let removalTitle = "Remove ModelDeck's client keys from your proxy config?"

    public static func removalOperation(entryCount: Int, targetPath: String) -> String {
        let noun = entryCount == 1 ? "the one entry" : "the \(entryCount) entries"
        return "Remove \(noun) ModelDeck added to the api-keys list in \(targetPath), and nothing else. An entry ModelDeck did not add is never removed — if one of its keys appears more times than it wrote it, it removes nothing and says so."
    }

    public static let lastEntryRemovalDisclosure = "This empties the api-keys list, and an empty list means your proxy goes back to answering every local request without a key — unauthenticated, as it was before. That happens immediately too, and nothing else will warn you about it."
    public static let removalCoverageLine = "Clients still sending a ModelDeck key keep working only while the list is empty; if you add your own entries later, they will need one of yours."
    public static let removalConfirmButtonTitle = "Remove the keys now"
    public static let removalDeclineConsequence = "ModelDeck changes nothing and the keys stay in your config."

    // Progress
    /// Shown while the operation is still LOOKING — before consent, before any
    /// write. It may not describe a change that has not happened (security
    /// review of PR #531, should-fix 4): the user reading "Written" before
    /// they have agreed to anything is told a change landed that did not.
    public static let preparingLine = "Checking your proxy config…"
    /// Shown between confirm and the file landing.
    public static let applyingLine = "Saving the change…"

    // Activation and backups
    public static let takingEffectNowLine = "Written. The proxy re-reads the file within about two seconds — ModelDeck is confirming the change stuck."
    public static let liveLine = "Confirmed: the file still holds exactly what ModelDeck wrote, and the proxy has re-read it."
    public static func supersededLine(_ reason: String) -> String {
        "ModelDeck wrote the change, but the file has changed again since (\(reason)). It will not claim the change is in force."
    }
    public static let backupDeletionOffer = "The saved copy still holds the keys that were just removed. Now that the removal is confirmed, you can delete it."

    // Headlines
    public static let appendSucceededHeadline = "ModelDeck added its client keys to your proxy config"
    public static let removalSucceededHeadline = "ModelDeck removed its client keys from your proxy config"
    public static let refusedHeadline = "ModelDeck did not change your proxy config"
    public static let failedHeadline = "ModelDeck could not finish the change to your proxy config"

    /// The copy-pasteable fallback for every refusal. Never contains a key —
    /// the placeholder is literal, and the user pastes their own value in.
    public static func manualSnippet(targetPath: String) -> String {
        """
        # Add to \(targetPath), then run: chmod 600 \(targetPath)
        api-keys:
          - "<paste the key ModelDeck shows you>"
        """
    }

    /// Every string the tripwire holds to the immediacy rule. Listed
    /// explicitly so a new consent sentence has to be added here on purpose.
    /// Strings shown BEFORE consent is given. None of them may claim a write
    /// happened — the tripwire enforces that (should-fix 4).
    public static let preConsentStrings: [String] = [
        preparingLine,
        appendTitle,
        removalTitle,
        coverageStoodDownLine,
        coverageMissingReason,
        coverageIncompleteReason,
        coverageStaleReason,
        coverageUncoveredReason,
    ]

    public static let immediacyGovernedStrings: [String] = [
        immediacyEffect,
        coverageStoodDownLine,
        preparingLine,
        applyingLine,
        enforcementFlipEffect,
        nothingElseChangesEffect,
        lastEntryRemovalDisclosure,
        removalCoverageLine,
        takingEffectNowLine,
        liveLine,
        undoLine,
        appendTitle,
        removalTitle,
        declineConsequence,
        removalDeclineConsequence,
    ]
}
