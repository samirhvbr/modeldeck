import Foundation

// Issue #560 — `GET /api/grok/home-candidate`, the read-only discovery the
// add-subscription sheet shows before its Connect button goes live.
//
// Decision 0035: the grok CLI owns `~/.grok` and its own sign-in, so there is
// no profile home for ModelDeck to create and no login for it to launch. The
// Grok flow points at the folder that already exists instead, and every
// refusal below is decided from the daemon's own fields — the same inspection
// `POST /api/accounts` validates registration with, so the sheet and the
// daemon can never disagree about whether a folder is usable.

/// The daemon's report on one candidate Grok home. Every field except `path`
/// decodes tolerantly (the #149/#174 precedent): a daemon that omits one is
/// read as "not proven", which refuses rather than connects.
public struct GrokHomeCandidate: Codable, Equatable, Sendable {
    public var path: String
    public var exists: Bool
    public var isDirectory: Bool
    public var ownedByCurrentUser: Bool
    public var writableByOthers: Bool
    public var permissionsOk: Bool
    public var hasCredentials: Bool
    /// "claude" / "codex" when this folder is already some other
    /// subscription's home, nil otherwise.
    public var alreadyRegisteredAs: String?
    public var lastSessionAt: String?
    /// The daemon's own explanation of the refusal, preferred over the
    /// built-in copy so the two halves never drift.
    public var hint: String?
    /// The files ModelDeck reads inside this home, named by the daemon. The
    /// sheet lists these verbatim — it never hardcodes its own list.
    public var readFiles: [String]

    public init(
        path: String,
        exists: Bool = false,
        isDirectory: Bool = false,
        ownedByCurrentUser: Bool = false,
        writableByOthers: Bool = false,
        permissionsOk: Bool = false,
        hasCredentials: Bool = false,
        alreadyRegisteredAs: String? = nil,
        lastSessionAt: String? = nil,
        hint: String? = nil,
        readFiles: [String] = []
    ) {
        self.path = path
        self.exists = exists
        self.isDirectory = isDirectory
        self.ownedByCurrentUser = ownedByCurrentUser
        self.writableByOthers = writableByOthers
        self.permissionsOk = permissionsOk
        self.hasCredentials = hasCredentials
        self.alreadyRegisteredAs = alreadyRegisteredAs
        self.lastSessionAt = lastSessionAt
        self.hint = hint
        self.readFiles = readFiles
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            path: try container.decode(String.self, forKey: .path),
            exists: try container.decodeIfPresent(Bool.self, forKey: .exists) ?? false,
            isDirectory: try container.decodeIfPresent(Bool.self, forKey: .isDirectory) ?? false,
            ownedByCurrentUser: try container.decodeIfPresent(Bool.self, forKey: .ownedByCurrentUser) ?? false,
            writableByOthers: try container.decodeIfPresent(Bool.self, forKey: .writableByOthers) ?? false,
            permissionsOk: try container.decodeIfPresent(Bool.self, forKey: .permissionsOk) ?? false,
            hasCredentials: try container.decodeIfPresent(Bool.self, forKey: .hasCredentials) ?? false,
            alreadyRegisteredAs: try container.decodeIfPresent(String.self, forKey: .alreadyRegisteredAs),
            lastSessionAt: try container.decodeIfPresent(String.self, forKey: .lastSessionAt),
            hint: try container.decodeIfPresent(String.self, forKey: .hint),
            readFiles: try container.decodeIfPresent([String].self, forKey: .readFiles) ?? []
        )
    }

    /// The one-line promise shown under the folder. Stated here so the sheet
    /// and its test read the same sentence.
    public static let readOnlyPromise =
        "ModelDeck reads this folder. It never writes to it, never signs you in or out, "
        + "and never copies your credentials."

    /// Why this folder can or can't be connected. The order matches the
    /// daemon's own hint precedence, so the verdict and the hint always
    /// describe the same problem.
    public var verdict: GrokHomeVerdict {
        if !exists || !isDirectory { return .noHome }
        if !ownedByCurrentUser { return .notOwned }
        if writableByOthers || !permissionsOk { return .writableByOthers }
        if let other = alreadyRegisteredAs?.trimmingCharacters(in: .whitespacesAndNewlines),
           !other.isEmpty {
            return .registeredElsewhere(other)
        }
        if !hasCredentials { return .notSignedIn }
        return .ready
    }

    /// A hint on a folder whose fields all look fine means a newer daemon is
    /// refusing for a reason this build has no name for. Confirm round: that
    /// has to make the folder unusable, not merely change a paragraph — the
    /// sheet keys its dot, its copy and its Connect button off `canConnect`,
    /// so a verdict-only treatment would show green and let the connect run.
    public var unknownRefusal: Bool {
        guard verdict == .ready else { return false }
        let hint = hint?.trimmingCharacters(in: .whitespacesAndNewlines)
        return hint?.isEmpty == false
    }

    public var canConnect: Bool { verdict == .ready && !unknownRefusal }

    /// The short line under the folder path.
    public func statusText(now: Date = Date()) -> String {
        if unknownRefusal { return "Found, but ModelDeck can't use it yet" }
        switch verdict {
        case .ready:
            // CodeRabbit round: the daemon proves `auth.json` EXISTS, never
            // that it works — being connected is what step 2 earns.
            return "Credentials found · \(lastSessionText(now: now))"
        case .noHome:
            return "No grok CLI home found"
        case .notOwned:
            return "Found, but another user on this Mac owns it"
        case .writableByOthers:
            return "Found, but other users on this Mac can write to it"
        case .registeredElsewhere(let provider):
            return provider.lowercased() == DeckProvider.grok.rawValue
                ? "Already connected as another Grok subscription"
                : "Already registered as a \(Self.providerName(provider)) subscription's home"
        case .notSignedIn:
            return "Found, but the grok CLI hasn't signed in here yet"
        }
    }

    /// The paragraph explaining a refusal, in the words Tim approved.
    ///
    /// Fix round 1: the daemon sets a `hint` for EVERY non-ready state, so
    /// preferring it made the approved copy dead code and put developer
    /// strings ("Grok profile home must not be writable by anyone else") in
    /// front of people. The copy below wins for every state this app
    /// recognizes; the hint is the fallback for a refusal a newer daemon
    /// knows about and this build doesn't — which shows up here as a hint
    /// arriving on an otherwise ready-looking folder.
    public var explanation: String {
        if unknownRefusal, let hint = hint?.trimmingCharacters(in: .whitespacesAndNewlines) {
            return hint
        }
        switch verdict {
        case .ready:
            return Self.readOnlyPromise
        case .noHome, .notSignedIn:
            return "ModelDeck can only watch a Grok subscription the grok CLI has already signed in. "
                + "Run this once in Terminal, sign in as normal, then come back."
        case .notOwned:
            return "That folder belongs to a different macOS user, so ModelDeck can't read it on your "
                + "behalf. Pick the folder the grok CLI uses for you."
        case .writableByOthers:
            return "Anyone who can write to that folder could swap in their own credentials, and ModelDeck "
                + "would send theirs instead of yours. Tighten the permissions, then check again."
        case .registeredElsewhere(let provider) where provider.lowercased() == DeckProvider.grok.rawValue:
            // Fix round 1: the daemon now refuses a second Grok subscription
            // on the same folder — two would poll xAI for one pool and read
            // as two independent subscriptions in the deck.
            return "That folder is already connected as another Grok subscription. Each one needs "
                + "its own grok home, so pick a different folder."
        case .registeredElsewhere(let provider):
            let name = Self.providerName(provider)
            return "That folder belongs to a \(name) subscription. Connecting it as Grok would send a "
                + "\(name) credential to xAI. Pick the folder the grok CLI actually uses."
        }
    }

    /// The folder as a person reads it: `~/.grok`, not the expanded home.
    /// `home` is injectable so this is testable without touching the real one.
    public func displayPath(home: String = NSHomeDirectory()) -> String {
        guard !home.isEmpty, home != "/" else { return path }
        if path == home { return "~" }
        guard path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }

    /// The command the person runs themselves to fix this. ModelDeck never
    /// runs it for them — driving grok's own auth is exactly the line
    /// decision 0035 drew.
    public func remedyCommand(home: String = NSHomeDirectory()) -> String? {
        switch verdict {
        case .noHome, .notSignedIn: return "grok"
        case .writableByOthers: return "chmod g-w,o-w \(shellPath(home: home))"
        case .ready, .notOwned, .registeredElsewhere: return nil
        }
    }

    /// The folder as it can be pasted into a shell: `~/.grok` normally, with
    /// the part after `~/` quoted when the name contains whitespace (quoting
    /// the tilde itself would stop it expanding).
    private func shellPath(home: String) -> String {
        let display = displayPath(home: home)
        guard display.contains(where: \.isWhitespace) else { return display }
        if display.hasPrefix("~/") {
            return "~/'" + display.dropFirst(2) + "'"
        }
        return "'" + display + "'"
    }

    /// The discovery block's own spoken label. Explicit and self-contained:
    /// #65/#113/#272 all came from a parent label swallowing the strings its
    /// children carried.
    public func accessibilityLabel(now: Date = Date(), home: String = NSHomeDirectory()) -> String {
        "Grok home \(displayPath(home: home)). \(statusText(now: now))."
    }

    private func lastSessionText(now: Date) -> String {
        guard let date = DeckDateParsing.date(from: lastSessionAt) else {
            return "no sessions recorded yet"
        }
        return "last session \(DeckFreshness.ageText(observedAt: date, now: now))"
    }

    private static func providerName(_ raw: String) -> String {
        DeckProvider.from(raw)?.displayName ?? raw
    }
}

public enum GrokHomeVerdict: Equatable, Sendable {
    /// A real, owner-only folder the grok CLI has signed into.
    case ready
    case noHome
    case notSignedIn
    case notOwned
    case writableByOthers
    case registeredElsewhere(String)
}
