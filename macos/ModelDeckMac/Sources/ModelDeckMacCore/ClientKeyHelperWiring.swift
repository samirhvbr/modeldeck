import Foundation

/// Issue #522 — the daemon's honest report of one Claude profile's client-key
/// helper wiring: which Keychain item its `settings.json` and pinned shell env
/// point at, and, when a legacy→per-profile migration stopped between those
/// two files, exactly how far it got.
///
/// Decoded tolerantly like every other daemon payload (DaemonModels' leniency
/// contract): a daemon that predates #522 answers nothing, which reads as the
/// legacy shared item with no migration in flight — the truth for such an
/// install.
public struct ClientKeyHelperWiring: Codable, Equatable, Sendable {
    /// The daemon's two mode values, named once. Every reader compares against
    /// these rather than a literal: a rename on the daemon side would otherwise
    /// make each surface fall through to its "legacy" branch silently, and
    /// tests carrying the same literal would keep passing while the UI told
    /// every user their per-profile keys were off (CodeRabbit on PR #534).
    public static let legacyMode = "legacy"
    public static let perProfileMode = "per-profile"

    public var accountId: String
    /// `legacy` (the shared `cli-proxy-api-client` item) or `per-profile`.
    public var mode: String
    public var service: String
    /// `nil` when no migration has run; `settings` when only `settings.json`
    /// was repointed; `complete` when the shell env followed.
    public var stage: String?
    public var settingsWired: Bool
    /// `nil` when this profile is not the active one, so there is no pinned
    /// shell env of its own to judge — absent evidence, never a false `false`.
    public var shellEnvWired: Bool?
    /// D6 / design §2.5: the user-created shared item and its `api-keys` entry
    /// stay in place, so shells that read the legacy key at startup keep
    /// working; their requests attribute as honest NULL, never guessed.
    public var legacySharedKeyStillAdmitted: Bool
    public var complete: Bool

    public init(
        accountId: String,
        mode: String,
        service: String,
        stage: String? = nil,
        settingsWired: Bool = false,
        shellEnvWired: Bool? = nil,
        legacySharedKeyStillAdmitted: Bool = false,
        complete: Bool = false
    ) {
        self.accountId = accountId
        self.mode = mode
        self.service = service
        self.stage = stage
        self.settingsWired = settingsWired
        self.shellEnvWired = shellEnvWired
        self.legacySharedKeyStillAdmitted = legacySharedKeyStillAdmitted
        self.complete = complete
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.accountId = (try? container.decodeIfPresent(String.self, forKey: .accountId)) ?? ""
        self.mode = (try? container.decodeIfPresent(String.self, forKey: .mode)) ?? Self.legacyMode
        self.service = (try? container.decodeIfPresent(String.self, forKey: .service))
            ?? KeychainClientKeyStore.legacySharedService
        self.stage = (try? container.decodeIfPresent(String.self, forKey: .stage)) ?? nil
        self.settingsWired = (try? container.decodeIfPresent(Bool.self, forKey: .settingsWired)) ?? false
        self.shellEnvWired = (try? container.decodeIfPresent(Bool.self, forKey: .shellEnvWired)) ?? nil
        self.legacySharedKeyStillAdmitted =
            (try? container.decodeIfPresent(Bool.self, forKey: .legacySharedKeyStillAdmitted)) ?? false
        self.complete = (try? container.decodeIfPresent(Bool.self, forKey: .complete)) ?? false
    }

    /// Whether this profile is on its own key rather than the shared item.
    /// The one place the mode string is interpreted.
    public var isPerProfile: Bool { mode == Self.perProfileMode }

    /// The migration's own definition of done: BOTH files repointed. The
    /// `complete` flag alone is not trusted over the evidence behind it, so a
    /// half-applied migration can never render as finished.
    public var isFullyWired: Bool {
        complete && settingsWired && (shellEnvWired ?? true)
    }

    /// The user-facing truth for a migration that stopped between its files.
    /// `nil` when there is nothing partial to say.
    public var partialStateDescription: String? {
        if isFullyWired || !isPerProfile { return nil }
        if settingsWired && shellEnvWired == false {
            return "This profile's settings point at its own key, but the pinned terminal environment"
                + " still needs to be refreshed. Running the migration again finishes it."
        }
        if !settingsWired {
            return "This profile is not wired to its own key yet."
        }
        return nil
    }
}
