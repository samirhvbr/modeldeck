import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #459 — TRIPWIRE copy-says-subscriptions.
//
// Tim's ruling: user-facing copy calls a deck member a SUBSCRIPTION, never an
// "account". Pinning a handful of sentences would only protect the sentences
// that happened to exist the day the sweep ran, so this scans every Swift
// source in the app for display literals carrying the word — the check that
// catches the word coming back in a string nobody thought to assert on.
//
// What is deliberately NOT covered: internal identifiers, API paths, JSON
// keys, persisted setting values, and comments — the scope guard on the issue
// keeps those saying "account". Sentences quoting the PROVIDER's own sign-in
// language ("run /login as that account") are listed in `allowedLiterals`
// with their reason; add to that list only with the same kind of reason.

private let allowedLiterals: [String: String] = [
    // The provider's own flow is what the user must run; /login signs in an
    // identity at the provider, not a ModelDeck deck member.
    "different identity than . Log out and run /login as that account.":
        "quotes the provider's own /login sign-in language",
    "as a different identity — log out and run /login as this account":
        "quotes the provider's own /login sign-in language",
    "log out and run /login as that account.":
        "quotes the provider's own /login sign-in language",
]

/// A walk that found nothing to scan — a moved or unreadable `Sources/` would
/// otherwise leave the tripwire passing on an empty sweep.
private struct EmptySourceWalk: Error, CustomStringConvertible {
    let root: URL
    let found: Int
    var description: String {
        "TRIPWIRE copy-says-subscriptions could not scan the app: \(found) Swift "
            + "file(s) under \(root.path). The sweep must fail closed rather than "
            + "pass on nothing."
    }
}

/// Every Swift file under `Sources/`. Throws when the directory cannot be
/// enumerated, or yields implausibly few files for this package (74 today).
private func sourceFiles() throws -> [URL] {
    let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // .../Tests/ModelDeckMacCoreTests
        .deletingLastPathComponent()   // .../Tests
        .deletingLastPathComponent()   // .../ModelDeckMac (package root)
        .appendingPathComponent("Sources")
    let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
    let files = (walker?.compactMap { $0 as? URL } ?? []).filter { $0.pathExtension == "swift" }
    guard files.count >= 20 else {
        throw EmptySourceWalk(root: root, found: files.count)
    }
    return files
}

/// One string literal found in a source file, with the line it starts on.
private struct FoundLiteral {
    var line: Int
    var body: String
}

/// Every double-quoted literal in a source file. The whole file is one stream,
/// so a `"""` literal spanning lines is scanned as the sentence it is; comments
/// are dropped (the sweep is about what the app SAYS), and interpolations are
/// descended into rather than discarded — `"\(label ?? "the new account")"`
/// hides its copy inside one.
private func displayLiterals(inFile text: String) -> [FoundLiteral] {
    let chars = Array(text)
    var literals: [FoundLiteral] = []
    var index = 0
    var line = 1
    func peek(_ offset: Int) -> Character? {
        let at = index + offset
        return at < chars.count ? chars[at] : nil
    }
    while index < chars.count {
        let character = chars[index]
        if character == "\n" { line += 1; index += 1; continue }
        if character == "/", peek(1) == "/" {
            while index < chars.count, chars[index] != "\n" { index += 1 }
            continue
        }
        if character == "/", peek(1) == "*" {
            var depth = 0
            while index < chars.count {
                if chars[index] == "/", index + 1 < chars.count, chars[index + 1] == "*" {
                    depth += 1; index += 2; continue
                }
                if chars[index] == "*", index + 1 < chars.count, chars[index + 1] == "/" {
                    depth -= 1; index += 2
                    if depth == 0 { break }
                    continue
                }
                if chars[index] == "\n" { line += 1 }
                index += 1
            }
            continue
        }
        guard character == "\"" else { index += 1; continue }
        let multiline = peek(1) == "\"" && peek(2) == "\""
        let startLine = line
        var body = ""
        index += multiline ? 3 : 1
        while index < chars.count {
            let inner = chars[index]
            if inner == "\\", index + 1 < chars.count {
                if chars[index + 1] == "(" {
                    // Interpolation: lift out the expression and scan it too,
                    // then continue after its closing paren.
                    var depth = 0
                    var cursor = index + 1
                    let expressionStart = cursor + 1
                    while cursor < chars.count {
                        if chars[cursor] == "(" { depth += 1 }
                        if chars[cursor] == ")" {
                            depth -= 1
                            if depth == 0 { break }
                        }
                        if chars[cursor] == "\n" { line += 1 }
                        cursor += 1
                    }
                    let expression = String(chars[expressionStart..<min(cursor, chars.count)])
                    for nested in displayLiterals(inFile: expression) {
                        literals.append(FoundLiteral(line: line, body: nested.body))
                    }
                    index = min(cursor + 1, chars.count)
                    continue
                }
                if chars[index + 1] == "\n" { line += 1 }
                body.append(inner)
                body.append(chars[index + 1])
                index += 2
                continue
            }
            if inner == "\n" {
                line += 1
                index += 1
                if multiline { body.append(inner); continue }
                break  // an unterminated single-line literal: stop here.
            }
            if inner == "\"" {
                if multiline {
                    if peek(1) == "\"" && peek(2) == "\"" { index += 3; break }
                    body.append(inner)
                    index += 1
                    continue
                }
                index += 1
                break
            }
            body.append(inner)
            index += 1
        }
        literals.append(FoundLiteral(line: startLine, body: body))
    }
    return literals
}

/// Literals that are protocol rather than copy — JSON keys, API path
/// components, persisted setting values, log tags, and fixture text. The list
/// is exact on purpose: anything not named here counts as copy, so a new
/// "account" string has to be dispositioned instead of matching a heuristic.
private let plumbingLiterals: Set<String> = [
    // DeckHideMode.byAccount's persisted raw value — on disk, not on screen
    // (its `displayName` is what the user reads, and that says subscription).
    "by-account",
    // The daemon's REST path component: /api/accounts/...
    "accounts",
]

private func isPlumbing(_ literal: String) -> Bool {
    // A JSON fixture written inline is protocol by construction.
    if literal.contains("\\\"") || literal.hasPrefix("{") || literal.hasPrefix("[") { return true }
    return plumbingLiterals.contains(literal)
}

/// True when the literal uses "account" or "accounts" as a whole word — the
/// deck-member noun — rather than as part of a longer identifier.
private func saysAccount(_ literal: String) -> Bool {
    let lowered = literal.lowercased()
    func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || character == "_"
    }
    var search = lowered.startIndex..<lowered.endIndex
    while let range = lowered.range(of: "account", range: search) {
        let openBounded = range.lowerBound == lowered.startIndex
            || !isWordCharacter(lowered[lowered.index(before: range.lowerBound)])
        var end = range.upperBound
        if end < lowered.endIndex, lowered[end] == "s" { end = lowered.index(after: end) }
        let closeBounded = end == lowered.endIndex || !isWordCharacter(lowered[end])
        if openBounded && closeBounded { return true }
        search = range.upperBound..<lowered.endIndex
    }
    return false
}

@Suite("Issue #459 — TRIPWIRE copy-says-subscriptions")
struct SubscriptionCopyTripwireTests {

    @Test("no display string in the app calls a deck member an account")
    func noSourceLiteralSaysAccount() throws {
        var offenders: [String] = []
        for file in try sourceFiles() {
            let text = try String(contentsOf: file, encoding: .utf8)
            for found in displayLiterals(inFile: text) where !isPlumbing(found.body) {
                guard saysAccount(found.body) else { continue }
                guard allowedLiterals[found.body] == nil else { continue }
                offenders.append("\(file.lastPathComponent):\(found.line): \"\(found.body)\"")
            }
        }
        #expect(
            offenders.isEmpty,
            """
            TRIPWIRE copy-says-subscriptions: user-facing copy must say \
            "subscription", not "account" (issue #459, Tim's ruling). \
            Offending literals:
            \(offenders.joined(separator: "\n"))
            """
        )
    }

    @Test("the surfaces Tim named speak in subscriptions")
    func namedSurfacesPinTheWording() {
        // The deck column header and the Settings roster count — the two
        // places the word is on screen without any interaction.
        let column = DeckColumn(provider: .claude, rows: [], hiddenAccountCount: 7)
        #expect(column.subscriptionCountText == "7 subscriptions")
        let section = AccountsRosterSection(provider: .claude, accounts: [])
        #expect(section.countText == "0 subscriptions")
        // The hide/show system's mode name and its empty-state callout.
        #expect(DeckPopoverModel.DeckHideMode.byAccount.displayName == "By subscription")
    }
}
