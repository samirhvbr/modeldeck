import Foundation
import Observation

// Issue #7 — usage notifications. Spec: "macOS banner when any account
// crosses a configurable remaining-% threshold." Alerts fire only on a
// worsening state TRANSITION (healthy → warning, warning → critical, …),
// never on every refresh at the same level, and re-arm once the worst
// remaining recovers above the threshold.

/// Alert level derived from the worst remaining % against the configured
/// thresholds. Ordered so "worse" compares greater.
public enum UsageAlertLevel: Int, Comparable, Equatable, Sendable {
    case none = 0
    case warning = 1
    case critical = 2

    public static func < (lhs: UsageAlertLevel, rhs: UsageAlertLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public static func level(for worst: WorstRemaining?, thresholds: UsageThresholds) -> UsageAlertLevel {
        guard let worst else { return .none }
        if worst.percent <= thresholds.criticalPercent { return .critical }
        if worst.percent <= thresholds.warningPercent { return .warning }
        return .none
    }
}

/// A banner ready to post.
public struct UsageAlert: Equatable, Sendable {
    public var level: UsageAlertLevel
    public var title: String
    public var body: String
    /// Notification-coalescing key (CodeRabbit, PR #472). The poster derived
    /// its identifier from the LEVEL alone, which is right for usage alerts —
    /// one banner per level, a newer one replacing the stale one — but wrong
    /// for any alert class where two can be live at once. Nil preserves
    /// exactly that historical behaviour; a non-nil key gives the alert its
    /// own coalescing space.
    public var identityKey: String?

    public init(level: UsageAlertLevel, title: String, body: String, identityKey: String? = nil) {
        self.level = level
        self.title = title
        self.body = body
        self.identityKey = identityKey
    }
}

/// Pure transition logic: given the previous level and the new worst
/// remaining, decide whether a banner is due and compose it. Testable
/// without UserNotifications.
public enum UsageAlertPlanner {
    /// Non-nil only when the level WORSENED (that's the state transition the
    /// spec notifies on). Same level or recovery → nil.
    public static func alert(
        previous: UsageAlertLevel,
        worst: WorstRemaining?,
        state: DeckState?,
        thresholds: UsageThresholds
    ) -> UsageAlert? {
        let level = UsageAlertLevel.level(for: worst, thresholds: thresholds)
        guard level > previous, let worst else { return nil }
        let label = accountLabel(for: worst.accountId, in: state)
        let window = DeckBuilder.windowTitle(for: worst.scope)
        let percent = worst.displayPercent
        switch level {
        case .critical:
            return UsageAlert(
                level: .critical,
                title: "\(label) is critically low",
                body: "\(percent)% left on the \(window) window."
            )
        case .warning:
            return UsageAlert(
                level: .warning,
                title: "\(label) is running low",
                body: "\(percent)% left on the \(window) window (threshold \(Int(thresholds.warningPercent))%)."
            )
        case .none:
            return nil
        }
    }

    static func accountLabel(for accountId: String, in state: DeckState?) -> String {
        guard let account = state?.accounts.first(where: { $0.id == accountId }) else {
            return "A subscription"
        }
        if let provider = DeckProvider.from(account.provider) {
            return "\(account.label) (\(provider.displayName))"
        }
        return account.label
    }
}

// Issue #377 — a mid-session model drop is loud, not just visible.
//
// A deck banner only exists while the popover is open, and the whole point of
// this issue is that the drop went UNNOTICED for the rest of a session. So the
// same macOS banner path the usage alerts use posts once per drop, at the
// moment it lands, and once more when the model becomes available again.
// Reuses the #7 poster seam untouched: no second notification stack.

/// Pure transition logic over successive `/api/state.modelDrop` reads.
/// Testable without UserNotifications.
public enum ModelDropAlertPlanner {
    /// What the coordinator has already announced about one session.
    public enum Announced: Equatable, Sendable {
        case dropped
        case available
    }

    /// The banner due for one drop given what was already announced about it,
    /// or nil when there is nothing new to say. Deliberately at most two
    /// banners per drop — the deck header carries the standing state.
    ///
    /// Each drop carries its own identity key (CodeRabbit, PR #472): two
    /// sessions dropping in the same pass are both .critical, so keying on
    /// level alone lost one of them, and a drop banner and a usage banner
    /// clobbered each other. Keyed by the drop's id, a session's later
    /// available-again banner replaces its OWN drop banner and nothing else.
    public static func alert(drop: ModelDropAlert, announced: Announced?) -> UsageAlert? {
        let identityKey = "modeldrop.\(drop.id)"
        switch (announced, drop.available) {
        case (nil, _):
            return UsageAlert(
                level: .critical,
                title: "Model dropped: \(drop.fromName) → \(drop.toName)",
                body: "\(drop.explanation) \(drop.remedy)",
                identityKey: identityKey
            )
        case (.dropped, true):
            return UsageAlert(
                level: .warning,
                title: "\(drop.fromName) is available again",
                body: drop.remedy,
                identityKey: identityKey
            )
        default:
            return nil
        }
    }

    public static func announced(for drop: ModelDropAlert) -> Announced {
        drop.available ? .available : .dropped
    }
}

/// Posts a banner the first time a session's drop is seen, and again when the
/// dropped model comes back. Keyed by the alert's identity, so a drop that
/// clears and later recurs announces again — that is a new event.
@MainActor
public final class ModelDropNotificationCoordinator: ObservableObject {
    @Published public private(set) var announced: [String: ModelDropAlertPlanner.Announced] = [:]

    private let poster: any UserNotificationPosting

    public init(poster: any UserNotificationPosting) {
        self.poster = poster
    }

    /// Feed every fresh daemon state through here — the same hook the usage
    /// notifications use. A state with no `modelDrop` block (older daemon)
    /// leaves the memory untouched rather than forgetting live drops.
    public func evaluate(state: DeckState?) async {
        guard let drops = state?.modelDrop?.drops else { return }
        var pending: [UsageAlert] = []
        var next: [String: ModelDropAlertPlanner.Announced] = [:]
        for drop in drops {
            let previous = announced[drop.id]
            if let alert = ModelDropAlertPlanner.alert(drop: drop, announced: previous) {
                pending.append(alert)
            }
            next[drop.id] = ModelDropAlertPlanner.announced(for: drop)
        }
        // Drops absent from this state have cleared; drop their memory so a
        // later recurrence is announced as the new event it is.
        announced = next
        for alert in pending {
            await poster.post(alert)
        }
    }
}

/// Seam over UserNotifications so the coordinator is testable. The real
/// implementation (app target) wraps UNUserNotificationCenter and requests
/// authorization lazily, on the first post.
public protocol UserNotificationPosting: Sendable {
    func post(_ alert: UsageAlert) async
}

/// Tracks the alert level across refreshes and posts banners only on
/// worsening transitions. Recovery (level drops) silently re-arms.
@MainActor
public final class UsageNotificationCoordinator: ObservableObject {
    @Published public private(set) var currentLevel: UsageAlertLevel = .none

    /// Thresholds mirror the Settings notification threshold (warning) and
    /// the fixed critical line; updated live by the settings sync.
    public var thresholds: UsageThresholds

    private let poster: any UserNotificationPosting

    public init(poster: any UserNotificationPosting, thresholds: UsageThresholds = .default) {
        self.poster = poster
        self.thresholds = thresholds
    }

    /// Feed every fresh daemon state through here (refresh ticks, manual
    /// refreshes, post-activate verification reads). Never spams: a banner
    /// goes out only when the level worsens.
    public func evaluate(worst: WorstRemaining?, state: DeckState?) async {
        let level = UsageAlertLevel.level(for: worst, thresholds: thresholds)
        let alert = UsageAlertPlanner.alert(
            previous: currentLevel,
            worst: worst,
            state: state,
            thresholds: thresholds
        )
        currentLevel = level
        if let alert {
            await poster.post(alert)
        }
    }
}
