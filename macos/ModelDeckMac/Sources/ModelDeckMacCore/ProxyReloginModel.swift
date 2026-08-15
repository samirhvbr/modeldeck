import Foundation

// Issue #396 — the UI half of the in-app credential repair.
//
// The field incident: a pool credential expired and the only recovery was
// Tim hand-running `cliproxyapi -claude-login` in a terminal. This model is
// the reason that never has to happen again. It does NOT perform a login:
// it asks the daemon to have CLIProxyAPI start the PROXY'S OWN OAuth (#398 —
// the proxy remains the sole writer of auth files), opens the authorize page
// the proxy hands back, and then reports the proxy's own verdict until the
// flow settles.
//
// The #149/#174 discipline holds throughout: a machine with no pool, or a
// daemon that does not report the #396 fields, renders NOTHING.

/// Daemon seam for the repair; `DaemonClient` conforms, tests stub.
public protocol ProxyReloginManaging: Sendable {
    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState
    func proxyReloginState(accountID: String) async throws -> ProxyReloginState
    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState
}

extension DaemonClient: ProxyReloginManaging {}

/// Opening the provider's page is the one step that leaves the app. Behind a
/// seam so tests drive the whole flow without a browser ever appearing.
public protocol BrowserOpening: Sendable {
    func open(_ url: URL)
}

/// Pure derivations + every sentence this surface speaks, in one tested
/// place — the `ProxyPool` precedent.
public enum ProxyRelogin {
    /// The phases the daemon reports, mirrored so the UI never matches on
    /// raw strings. An unrecognized phase is treated as `idle`: a newer
    /// daemon must not strand a row in a state this build cannot leave.
    public enum Phase: String, Equatable, Sendable {
        case idle
        case starting
        case awaitingBrowser = "awaiting-browser"
        case succeeded
        case failed
        case cancelled

        public init(daemon value: String?) {
            self = Phase(rawValue: value?.lowercased() ?? "") ?? .idle
        }

        public var isSettled: Bool {
            self == .succeeded || self == .failed || self == .cancelled
        }

        public var isRunning: Bool {
            self == .starting || self == .awaitingBrowser
        }
    }

    /// Whether the proxy says this member's credential is broken. The FIX is
    /// promoted to a visible button only here; everywhere else it stays a
    /// quiet menu item, because a working account does not need a button
    /// telling it to sign in again.
    public static func credentialIsBroken(_ account: DeckAccount) -> Bool {
        account.proxyCredential?.lowercased() == "error"
    }

    /// The row's honest one-liner about a non-ok credential, or nil.
    public static func credentialText(for account: DeckAccount) -> String? {
        switch account.proxyCredential?.lowercased() {
        case "error":
            guard let detail = account.proxyCredentialDetail, !detail.isEmpty else {
                return "Proxy sign-in expired"
            }
            return "Proxy sign-in expired (\(detail))"
        case "disabled":
            // Benched is not broken, and signing in again would not un-bench
            // it — say what it is instead of offering the wrong remedy.
            return "Benched in the proxy pool"
        default:
            return nil
        }
    }

    /// Whether the repair is reachable at all for this account. Reachable
    /// does NOT mean the credential is broken: a user may want to re-sign a
    /// member the proxy still believes in.
    public static func isOffered(for account: DeckAccount) -> Bool {
        guard account.proxyPool?.lowercased() == "member" else { return false }
        return account.proxyRelogin != nil
    }

    public static func isAvailable(for account: DeckAccount) -> Bool {
        isOffered(for: account) && account.proxyRelogin?.available == true
    }

    /// Why the repair cannot run, in the daemon's words. Never nil when the
    /// action is offered but unavailable — an unexplained dead control is
    /// the thing this issue exists to remove.
    public static func unavailableReason(for account: DeckAccount) -> String? {
        guard isOffered(for: account), account.proxyRelogin?.available != true else { return nil }
        return account.proxyRelogin?.reason ?? unavailableFallbackText
    }

    // MARK: - Copy

    public static let actionTitle = "Fix sign-in…"
    public static let menuTitle = "Fix proxy sign-in…"

    public static let unavailableFallbackText =
        "The local proxy cannot start a sign-in right now."

    /// The disclosure before the browser opens: the surprising step is named
    /// up front, and so is the fact that ModelDeck never sees the credential.
    public static func confirmation(label: String) -> String {
        "A browser sign-in for \(label) will open. The local proxy runs the sign-in "
            + "and stores the result itself — ModelDeck never handles the credential. "
            + "Nothing changes until you finish it in the browser."
    }

    public static let startingText = "Asking the proxy to start a sign-in…"
    public static let awaitingBrowserText = "Finish the sign-in in your browser…"
    public static let succeededText =
        "Signed in again. The proxy is using this account once more."
    public static let cancelledText = "Sign-in stopped. Nothing changed."
    public static let cancelTooltip =
        "Stop the sign-in. The proxy drops it too, so nothing keeps waiting."
    public static let browserOpenFailedText =
        "The sign-in page could not be opened. Nothing is waiting — try again."

    /// The daemon always sends a sentence with a failure; this is only the
    /// floor for a daemon that somehow did not.
    public static let failedFallbackText =
        "The sign-in did not complete. Try again."

    public static func settledText(phase: Phase, detail: String?) -> String? {
        switch phase {
        case .succeeded: return succeededText
        case .cancelled: return cancelledText
        case .failed:
            guard let detail, !detail.isEmpty else { return failedFallbackText }
            return detail
        default: return nil
        }
    }
}

/// What the row's trailing slot shows for the repair, in strict precedence
/// (the #199 rule the pool line already follows): progress → an unread
/// outcome → the armed action.
public struct ProxyReloginRowPresentation: Equatable, Sendable {
    public enum Display: Equatable, Sendable {
        /// The flow is running; `canCancel` while the proxy holds a session.
        case running(text: String, canCancel: Bool)
        case note(String)
        case error(String)
        /// The armed FIX. `prominent` when the proxy says the credential is
        /// actually broken; otherwise it stays a quiet menu-only offer.
        case action(prominent: Bool)
        /// Offered but not runnable, with the reason as help text.
        case unavailable(reason: String)
        /// Nothing actionable — the credential line, if any, stands alone.
        case quiet
    }

    /// The credential one-liner beside the pool's own status text, or nil.
    public var credentialText: String?
    public var display: Display

    public init(credentialText: String?, display: Display) {
        self.credentialText = credentialText
        self.display = display
    }
}

/// The repair's state machine (issue #396), built on the `ProxyPoolModel`
/// shape: per-account phase, decided outcomes held until dismissed, a
/// generation guard so a stale poll can never mutate a newer attempt, and a
/// fresh `GET /api/state` after every settled attempt so the restored member
/// is the daemon's truth rather than an optimistic echo.
@MainActor
public final class ProxyReloginModel: ObservableObject {
    @Published public private(set) var phases: [String: ProxyRelogin.Phase] = [:]
    @Published public private(set) var notes: [String: String] = [:]
    @Published public private(set) var errors: [String: String] = [:]

    public var onStateChanged: ((DeckState) -> Void)?

    private let manager: any ProxyReloginManaging
    private let stateProvider: any DeckStateProviding
    private let browser: any BrowserOpening
    private let pollInterval: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private var generations: [String: Int] = [:]
    /// Held so a cancel can stop the local poll immediately, without waiting
    /// for the next tick.
    private(set) var tasks: [String: Task<Void, Never>] = [:]

    public init(
        manager: any ProxyReloginManaging,
        stateProvider: any DeckStateProviding,
        browser: any BrowserOpening,
        pollInterval: Duration = .seconds(2),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.manager = manager
        self.stateProvider = stateProvider
        self.browser = browser
        self.pollInterval = pollInterval
        self.sleep = sleep
    }

    public func phase(for accountID: String) -> ProxyRelogin.Phase? { phases[accountID] }

    /// The row's complete repair rendering, or nil when nothing about this
    /// account's repair should appear anywhere.
    public func presentation(for account: DeckAccount) -> ProxyReloginRowPresentation? {
        let phase = phases[account.id]
        let note = notes[account.id]
        let error = errors[account.id]
        let credential = ProxyRelogin.credentialText(for: account)
        guard ProxyRelogin.isOffered(for: account) || phase != nil || note != nil || error != nil else {
            return nil
        }
        let display: ProxyReloginRowPresentation.Display
        if let phase, phase.isRunning {
            display = .running(
                text: phase == .starting ? ProxyRelogin.startingText : ProxyRelogin.awaitingBrowserText,
                canCancel: phase == .awaitingBrowser
            )
        } else if let error {
            display = .error(error)
        } else if let note {
            display = .note(note)
        } else if let reason = ProxyRelogin.unavailableReason(for: account) {
            display = .unavailable(reason: reason)
        } else if ProxyRelogin.isAvailable(for: account) {
            display = .action(prominent: ProxyRelogin.credentialIsBroken(account))
        } else if credential != nil {
            display = .quiet
        } else {
            return nil
        }
        return ProxyReloginRowPresentation(credentialText: credential, display: display)
    }

    /// Start the repair (AFTER the view's confirmation — the "ask each time"
    /// gate lives at the click site). Opens the authorize page the PROXY
    /// generated, then polls the proxy's own verdict until it settles.
    public func begin(account: DeckAccount) {
        guard phases[account.id] == nil else { return }
        let accountID = account.id
        phases[accountID] = .starting
        notes[accountID] = nil
        errors[accountID] = nil
        generations[accountID, default: 0] += 1
        let generation = generations[accountID]
        tasks[accountID] = Task { [weak self] in
            guard let self else { return }
            do {
                let started = try await self.manager.startProxyRelogin(accountID: accountID)
                guard self.isCurrent(accountID, generation) else { return }
                let phase = ProxyRelogin.Phase(daemon: started.phase)
                self.phases[accountID] = phase
                // The one step that leaves the app. A URL the daemon did not
                // send, or one that is not openable, is said out loud rather
                // than leaving the row spinning at a browser that never came.
                if let raw = started.url, let url = URL(string: raw), url.scheme?.lowercased() == "https" {
                    self.browser.open(url)
                } else if phase.isRunning {
                    // CodeRabbit (PR #435): no browser means nobody can ever
                    // finish this sign-in — settle the attempt terminally and
                    // have the proxy drop its own pending session, instead of
                    // polling a flow whose error the running row would hide.
                    self.phases[accountID] = nil
                    self.errors[accountID] = ProxyRelogin.browserOpenFailedText
                    _ = try? await self.manager.cancelProxyRelogin(accountID: accountID)
                    guard self.generations[accountID] == generation else { return }
                    self.tasks[accountID] = nil
                    await self.refreshState(accountID: accountID)
                    return
                }
                if phase.isSettled {
                    self.settle(accountID: accountID, phase: phase, detail: started.detail)
                } else {
                    await self.poll(accountID: accountID, generation: generation)
                }
            } catch is CancellationError {
                return // cancel() already wrote the honest note
            } catch {
                guard self.isCurrent(accountID, generation) else { return }
                self.phases[accountID] = nil
                // 409 (no key / already running) and 502 land here with the
                // daemon's sanitized sentence.
                self.errors[accountID] = SettingsSyncModel.message(for: error)
            }
            guard self.generations[accountID] == generation else { return }
            self.tasks[accountID] = nil
            await self.refreshState(accountID: accountID)
        }
    }

    private func isCurrent(_ accountID: String, _ generation: Int?) -> Bool {
        generations[accountID] == generation && phases[accountID] != nil
    }

    private func poll(accountID: String, generation: Int?) async {
        while true {
            do { try await sleep(pollInterval) } catch { return }
            guard isCurrent(accountID, generation) else { return }
            let state: ProxyReloginState
            do {
                state = try await manager.proxyReloginState(accountID: accountID)
            } catch is CancellationError {
                return
            } catch {
                guard isCurrent(accountID, generation) else { return }
                phases[accountID] = nil
                errors[accountID] = SettingsSyncModel.message(for: error)
                return
            }
            guard isCurrent(accountID, generation) else { return }
            let phase = ProxyRelogin.Phase(daemon: state.phase)
            if phase.isSettled {
                settle(accountID: accountID, phase: phase, detail: state.detail)
                return
            }
            phases[accountID] = phase
        }
    }

    private func settle(accountID: String, phase: ProxyRelogin.Phase, detail: String?) {
        phases[accountID] = nil
        let text = ProxyRelogin.settledText(phase: phase, detail: detail)
        if phase == .failed {
            errors[accountID] = text
        } else {
            notes[accountID] = text
        }
    }

    /// Stop the sign-in. The daemon asks the PROXY to drop its own pending
    /// session, so this genuinely stops the flow rather than only stopping
    /// our watching of it.
    public func cancel(accountID: String) {
        guard phases[accountID]?.isRunning == true else { return }
        // Invalidate BEFORE cancelling so a task already past its await
        // cannot overwrite the stopped state (the ProxyPoolModel lesson).
        generations[accountID, default: 0] += 1
        let generation = generations[accountID]
        tasks.removeValue(forKey: accountID)?.cancel()
        phases[accountID] = nil
        notes[accountID] = ProxyRelogin.cancelledText
        Task { [weak self] in
            guard let self else { return }
            _ = try? await self.manager.cancelProxyRelogin(accountID: accountID)
            guard self.generations[accountID] == generation else { return }
            await self.refreshState(accountID: accountID)
        }
    }

    public func dismissOutcome(accountID: String) {
        guard phases[accountID] == nil else { return }
        notes[accountID] = nil
        errors[accountID] = nil
    }

    private var refreshGeneration = 0

    /// Internal (not private) so tests can drive overlapping refreshes — the
    /// `ProxyPoolModel.refreshState` precedent, including its M7 rule that a
    /// failed re-read is SAID rather than swallowed.
    func refreshState(accountID: String) async {
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let fresh = try await stateProvider.deckState()
            guard generation == refreshGeneration else { return }
            onStateChanged?(fresh)
        } catch {
            guard generation == refreshGeneration else { return }
            let line = ProxyPool.stateRefreshFailedText
            if let existing = errors[accountID] {
                if !existing.contains(line) { errors[accountID] = existing + " " + line }
            } else if let existing = notes[accountID] {
                if !existing.contains(line) { notes[accountID] = existing + " " + line }
            } else {
                notes[accountID] = line
            }
        }
    }
}
