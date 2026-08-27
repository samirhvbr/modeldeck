import Foundation
import Observation

// Issue #8 — the add-account flow's view model (spec "Add account",
// mockups §05). Three steps:
//   1. details  — provider + label + purpose + color; the daemon creates the
//                 isolated owner-only profile home.
//   2. signIn   — the provider's own login command runs in the user's
//                 terminal; browser OAuth is entirely the provider's flow and
//                 ModelDeck never sees or stores credentials.
//   3. confirm  — the daemon reads back the authenticated identity ("Signed
//                 in as …"), pulls the first usage snapshot, and the account
//                 lands in the deck.
// Safety: nothing here (or in the daemon endpoints it calls) ever runs
// `claude auth logout` — the known pitfall in docs/HANDOFF.md.
//
// Issue #560 adds a second shape for Grok, which has neither a profile home
// ModelDeck can create nor a sign-in it can launch (decision 0035). It runs
// in two steps:
//   1. details — the same fields, plus the existing grok CLI home the daemon
//                discovered, read-only, with every refusal shown before the
//                Connect button goes live.
//   2. confirm — the account is saved, one billing reading is taken, and the
//                card that landed is shown. No reading, no connection: the
//                reference rolls back rather than leaving a card that can
//                never fill in.

/// Daemon seam for the add-account flow; `DaemonClient` conforms.
public protocol AccountOnboarding: Sendable {
    func createAccount(_ create: AccountCreate) async throws -> DeckAccount
    /// Issue #560: read-only discovery of an existing grok CLI home.
    func grokHomeCandidate(path: String?) async throws -> GrokHomeCandidate
    func loginCommand(accountID: String) async throws -> LoginCommand
    func verifyAccount(accountID: String) async throws -> AccountVerification
    func refreshUsage() async throws
    func deleteAccount(id: String) async throws
    /// Issue #586: resolve the first-run `active-link-blocked` dead end —
    /// adopt (or, startFresh, move aside) the legacy real `~/.claude`.
    func adoptLegacyHome(accountID: String, startFresh: Bool) async throws -> LegacyHomeAdoption
}

extension DaemonClient: AccountOnboarding {}

/// Seam for step 2's "drive the provider's login": the app layer opens the
/// user's terminal with the exact command the daemon returned. Kept as a
/// protocol so the flow is testable without touching Terminal.
public protocol LoginLaunching: Sendable {
    func launchLogin(command: String) throws
}

@MainActor
public final class AddAccountModel: ObservableObject {
    public enum Step: Equatable, Sendable {
        case details
        /// Issue #586: a real legacy `~/.claude` blocked the activation the
        /// sign-in needs. Offers in-app adoption instead of a dead-end error.
        case adoptLegacy
        case signIn
        case confirm
    }

    @Published public private(set) var step: Step = .details
    @Published public private(set) var isBusy = false
    @Published public private(set) var lastError: String?
    /// The account created in step 1 (nil until then).
    @Published public private(set) var account: DeckAccount?
    /// The provider's login command — kept visible so the user can copy and
    /// run it manually if the terminal launch fails or they close the window.
    @Published public private(set) var loginCommand: String?
    /// The identity the provider reported after verification; nil when the
    /// provider's status output doesn't reveal one.
    @Published public private(set) var identity: String?
    /// Non-fatal step 3 problem (e.g. the first usage pull failed). The flow
    /// still completes; the deck will fill in on the next refresh.
    @Published public private(set) var completionWarning: String?
    /// Issue #560: the grok CLI home the daemon reported for the Grok flow,
    /// nil until discovery runs (and on every other provider).
    @Published public private(set) var grokCandidate: GrokHomeCandidate?
    /// Issue #560: the billing window read back at connect time — the proof
    /// the card is real. Only ever set alongside `step == .confirm`.
    @Published public private(set) var connectedWindow: DeckWindow?
    /// Issue #99: true when the daemon's conservative login spec required
    /// activating the new profile before the sign-in. The sheet explains the
    /// flip; the daemon owns version-specific flow selection.
    @Published public private(set) var didActivateForLogin = false

    /// Issue #560: the connect in flight, owned by the model so a sheet that
    /// closes or reopens can cancel it (fix round 1). Non-nil for exactly as
    /// long as one is running.
    private var connectTask: Task<Bool, Never>?

    /// Issue #99: the provider's previously active account, captured before
    /// the sign-in activation so it can be restored once the flow settles.
    private var priorActiveAccountID: String?
    /// True when the pre-activation state read FAILED — distinct from a
    /// genuine "no prior active account". A failed lookup means the restore
    /// silently can't happen, and honesty demands saying so instead of
    /// leaving the new profile active with zero warning.
    private var priorActiveLookupFailed = false

    /// Fresh daemon state after the flow lands (or after a cancel that
    /// removed the created account); pushed into `MenuBarStatusModel`.
    public var onStateChanged: ((DeckState) -> Void)?

    private let onboarding: any AccountOnboarding
    private let launcher: any LoginLaunching
    private let stateProvider: any DeckStateProviding
    private let activator: any AccountActivating

    public init(
        onboarding: any AccountOnboarding,
        launcher: any LoginLaunching,
        stateProvider: any DeckStateProviding,
        activator: any AccountActivating
    ) {
        self.onboarding = onboarding
        self.launcher = launcher
        self.stateProvider = stateProvider
        self.activator = activator
    }

    /// Step 1 → 2: create the account (the daemon builds the profile home),
    /// fetch the provider's login command, and kick it off in the terminal.
    /// A failed terminal launch is not fatal — the command stays available
    /// for copy/paste and retry.
    @discardableResult
    public func begin(provider: DeckProvider, label: String, purpose: String, colorHex: String?) async -> Bool {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLabel.isEmpty else {
            lastError = "The label can't be empty."
            return false
        }
        guard !isBusy else { return false }
        isBusy = true
        lastError = nil
        defer { isBusy = false }
        do {
            let created = try await onboarding.createAccount(AccountCreate(
                provider: provider.rawValue,
                label: trimmedLabel,
                purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                color: colorHex
            ))
            account = created
            let login = try await onboarding.loginCommand(accountID: created.id)
            // Issue #99: the daemon's selected flow demands activating the
            // new profile BEFORE the plain login so affected Claude versions
            // land the credential against the intended profile.
            // The prior active account is captured first (best effort) so
            // a successful flow can put it back.
            if login.needsActivationFirst {
                priorActiveAccountID = await priorActiveAccountID(
                    provider: created.provider,
                    excluding: created.id
                )
                do {
                    _ = try await activator.activateAccount(id: created.id)
                } catch {
                    // Issue #586: a real legacy ~/.claude blocks the flip
                    // (the clobber guard). Every Mac that ever ran Claude
                    // Code hits this on its FIRST add — never a dead end:
                    // offer in-app adoption instead of the raw refusal.
                    guard provider == .claude,
                          case DaemonClientError.daemonCodedError(_, let code, _) = error,
                          code == DaemonClientError.activeLinkBlockedCode
                    else { throw error }
                    // Review #590 round 2: the command fetched above is kept
                    // as the fallback, so the flow can always reach a
                    // sign-in step with something to run even if the
                    // post-adoption re-fetch fails.
                    loginCommand = login.command
                    step = .adoptLegacy
                    return true
                }
                didActivateForLogin = true
            }
            loginCommand = login.command
            step = .signIn
            launchLogin()
            return true
        } catch {
            lastError = SettingsSyncModel.message(for: error)
            return false
        }
    }

    // MARK: - Issue #586: legacy ~/.claude adoption

    /// Resolve the blocked first activation. Adopt copies the legacy
    /// `~/.claude` into this account's profile home so the existing sign-in
    /// and settings carry over; startFresh only moves it aside. The daemon
    /// keeps the original as a timestamped backup either way and finishes
    /// with the activation flip. After adopting, the flow verifies
    /// immediately — an adopted home is usually already signed in and lands
    /// straight on the confirm step with no login at all.
    @discardableResult
    public func resolveLegacyHome(startFresh: Bool) async -> Bool {
        guard step == .adoptLegacy, let account, !isBusy else { return false }
        isBusy = true
        lastError = nil
        var adoptionWarnings: [String] = []
        do {
            let adoption = try await onboarding.adoptLegacyHome(accountID: account.id, startFresh: startFresh)
            adoptionWarnings = adoption.warnings
            didActivateForLogin = true
        } catch {
            // Review #590: the daemon may have finished the adoption after
            // this client gave up (big-copy timeout) — a 409 "already
            // managed" on the retry means exactly that, so it proceeds as
            // the success it is instead of dead-ending the offer.
            guard Self.isAlreadyManagedRefusal(error) else {
                isBusy = false
                lastError = SettingsSyncModel.message(for: error)
                return false
            }
            didActivateForLogin = true
        }
        // Fetch the login command so the sign-in step has something to run —
        // adoption already flipped activation, so no second flip runs. The
        // command fetched in `begin` stays as the fallback (review #590
        // round 2): a failed re-fetch after a SUCCESSFUL adoption must never
        // dead-end the flow or leave the sign-in step commandless, so the
        // fresh command replaces the fallback only when the request
        // succeeds. The honest-error dead end below survives only for the
        // impossible-by-construction case of no fallback at all.
        do {
            let login = try await onboarding.loginCommand(accountID: account.id)
            loginCommand = login.command
        } catch {
            guard loginCommand != nil else {
                isBusy = false
                lastError = "The setup was adopted, but fetching the sign-in command failed — try again. (\(SettingsSyncModel.message(for: error)))"
                return false
            }
        }
        isBusy = false
        var verified = false
        if !startFresh { verified = await confirmSignedIn() }
        // Review #590: the daemon's adopt-time running-session warnings are
        // surfaced the same way the activate path surfaces its (issue #66,
        // never-silent contract).
        if !adoptionWarnings.isEmpty {
            completionWarning = ([completionWarning] + adoptionWarnings).compactMap { $0 }.joined(separator: " ")
        }
        if verified { return true }
        // Not signed in (fresh mode, a signed-out legacy home, or a verify
        // hiccup — confirmSignedIn's honest message stays visible): fall into
        // the normal sign-in step.
        step = .signIn
        launchLogin()
        return true
    }

    /// The daemon's "there is no legacy Claude directory to adopt — … already
    /// managed" refusal (409): after a client-side timeout it is the proof
    /// the earlier adoption landed.
    static func isAlreadyManagedRefusal(_ error: Error) -> Bool {
        switch error {
        case DaemonClientError.daemonError(let message, 409),
             DaemonClientError.daemonCodedError(let message, _, 409):
            return message.contains("already managed")
        default:
            return false
        }
    }

    // MARK: - Issue #560: connect an existing grok CLI home

    /// Ask the daemon what it finds at `path` (its default `~/.grok` when
    /// nil). Read-only, and the only thing that decides whether Connect is
    /// live — the sheet never judges a folder itself.
    public func discoverGrokHome(path: String? = nil) async {
        guard !isBusy, connectTask == nil else { return }
        isBusy = true
        lastError = nil
        defer { isBusy = false }
        do {
            grokCandidate = try await onboarding.grokHomeCandidate(path: path)
        } catch {
            grokCandidate = nil
            lastError = SettingsSyncModel.message(for: error)
        }
    }

    /// Whether the sheet should offer a "Check Again" button: any Grok state
    /// that isn't connectable, INCLUDING a discovery that failed outright and
    /// left no candidate behind (fix round 1 — that state used to be a dead
    /// end with a red error and no way to retry).
    public var offersGrokRetry: Bool {
        grokCandidate?.canConnect != true
    }

    /// The folder a retry should re-check: the one already on screen, or the
    /// daemon's default when discovery never produced one.
    public var grokRetryPath: String? {
        grokCandidate?.path
    }

    /// Step 1 → 2 for Grok: save the account against the discovered folder,
    /// take one billing reading, and only then call it connected. A reading
    /// that never lands removes ModelDeck's reference again — a card that can
    /// never fill in is worse than no card, and nothing inside the folder was
    /// ever ModelDeck's to begin with.
    ///
    /// Fix round 1: the work runs in a Task the MODEL owns, so a sheet that
    /// closes (or reopens) mid-connect cancels it instead of letting it
    /// publish a landed card into a sheet nobody is looking at. Cancellation
    /// rolls a created account back exactly once.
    @discardableResult
    public func connectGrok(label: String, purpose: String, colorHex: String?) async -> Bool {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let candidate = grokCandidate, candidate.canConnect else { return false }
        guard !trimmedLabel.isEmpty else {
            lastError = "The label can't be empty."
            return false
        }
        guard !isBusy, connectTask == nil else { return false }
        isBusy = true
        lastError = nil
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            return await self.performGrokConnect(
                candidate: candidate,
                label: trimmedLabel,
                purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                colorHex: colorHex
            )
        }
        connectTask = task
        let connected = await task.value
        connectTask = nil
        isBusy = false
        return connected
    }

    /// Drop the message under the form. Used when the sheet switches to a
    /// different provider (CodeRabbit round): a failed Grok discovery's red
    /// text has nothing to say about the Claude or Codex form that replaced it.
    public func clearLastError() {
        lastError = nil
    }

    /// Cancel a connect still in flight (the sheet closed, or is reopening).
    /// The task itself performs the rollback — see `performGrokConnect`.
    public func cancelPendingConnect() {
        connectTask?.cancel()
    }

    private func performGrokConnect(
        candidate: GrokHomeCandidate,
        label trimmedLabel: String,
        purpose: String,
        colorHex: String?
    ) async -> Bool {
        let created: DeckAccount
        do {
            created = try await onboarding.createAccount(AccountCreate(
                provider: DeckProvider.grok.rawValue,
                label: trimmedLabel,
                purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                color: colorHex,
                profileRef: candidate.path
            ))
        } catch {
            // Known residual (confirm round, N2): a cancel that lands while
            // this POST is in flight can leave a created reference behind with
            // nothing to roll back — the daemon may have saved the account
            // before the request was torn down, and this side never learns its
            // id. Millisecond window; it lands honestly as a card, and the
            // daemon's own duplicate-folder refusal bounds the damage to one.
            //
            // A cancellation is not a failure the person asked about — the
            // sheet that would have shown this is already gone, and a message
            // set here would land on a freshly reset one (N3).
            if !Task.isCancelled {
                lastError = SettingsSyncModel.message(for: error)
            }
            return false
        }
        account = created
        // The sheet went away while the account was being saved. It was never
        // confirmed, so it must not stay in the deck.
        if Task.isCancelled {
            await rollBackUnverifiedGrok(created, reason: nil)
            return false
        }
        // The refresh failing is not itself the verdict: the state read below
        // is, because that is where a real reading either exists or doesn't.
        try? await onboarding.refreshUsage()
        let state = try? await stateProvider.deckState()
        if Task.isCancelled {
            await rollBackUnverifiedGrok(created, reason: nil)
            return false
        }
        guard let state else {
            await rollBackUnverifiedGrok(
                created,
                reason: "ModelDeck couldn't read back the deck to confirm this subscription's billing reading."
            )
            return false
        }
        let landed = state.accounts.first { $0.id == created.id }
        let window = DeckBuilder.rows(state: state)
            .first { $0.account.id == created.id }?
            .headlineWindow(isExpanded: false)
        guard let window, window.remainingPercent != nil else {
            let reported = landed?.lastRefreshError?.message?.trimmingCharacters(in: .whitespacesAndNewlines)
            await rollBackUnverifiedGrok(created, reason: reported?.isEmpty == false
                ? "ModelDeck couldn't read this subscription's billing from that folder: \(reported!)"
                : "ModelDeck couldn't read this subscription's billing from that folder, "
                    + "so there's nothing to show on a card yet.")
            return false
        }
        account = landed ?? created
        connectedWindow = window
        step = .confirm
        onStateChanged?(state)
        return true
    }

    /// Undo a connect whose reading never landed. Removing an account is a
    /// reference-only delete — the grok home is untouched either way — so the
    /// only honest failure mode is admitting the reference stayed.
    ///
    /// A nil `reason` means the flow was cancelled (the sheet closed): there
    /// is nobody to read a message, so a failed removal publishes fresh state
    /// instead, and the deck shows the unread card for what it is.
    ///
    /// The delete runs in its own unstructured Task because the caller may
    /// already be cancelled, and a cancelled URL request would abandon the
    /// rollback — leaving exactly the half-connected subscription this exists
    /// to prevent.
    private func rollBackUnverifiedGrok(_ created: DeckAccount, reason: String?) async {
        let onboarding = self.onboarding
        let deletion = Task { try await onboarding.deleteAccount(id: created.id) }
        do {
            try await deletion.value
            account = nil
            lastError = reason
        } catch {
            guard let reason else {
                await publishFreshState()
                return
            }
            lastError = reason + " It's still in the deck without a reading — remove it from "
                + "Settings → Subscriptions. (\(SettingsSyncModel.message(for: error)))"
        }
    }

    /// The provider's current default (active) account id, for restoring
    /// after an activation-driven sign-in. A failed state read is tracked in
    /// `priorActiveLookupFailed` — never conflated with a genuine
    /// "no prior active account", which stays silent.
    private func priorActiveAccountID(provider: String, excluding accountID: String) async -> String? {
        priorActiveLookupFailed = false
        do {
            let state = try await stateProvider.deckState()
            return state.accounts.first {
                $0.provider == provider && $0.isDefault && $0.id != accountID
            }?.id
        } catch {
            priorActiveLookupFailed = true
            return nil
        }
    }

    /// Issue #99: put the previously active account back after an
    /// activation-driven sign-in settled (verified success or cancel).
    /// Best effort — a failed restore is reported, never fatal.
    private func restorePriorActiveIfNeeded() async -> String? {
        guard didActivateForLogin, let prior = priorActiveAccountID else { return nil }
        do {
            _ = try await activator.activateAccount(id: prior)
            priorActiveAccountID = nil
            return nil
        } catch {
            return "The previously active subscription could not be restored — "
                + "re-activate it from Settings → Subscriptions. "
                + "(\(SettingsSyncModel.message(for: error)))"
        }
    }

    /// (Re-)open the terminal with the provider's login command.
    public func launchLogin() {
        guard let loginCommand else { return }
        do {
            try launcher.launchLogin(command: loginCommand)
        } catch {
            lastError = "Couldn't open Terminal — copy the command below and run it yourself. (\(error.localizedDescription))"
        }
    }

    /// Step 2 → 3: ask the daemon to read back the authenticated identity.
    /// Stays on the sign-in step (returning false) while the provider still
    /// reports the profile as signed out.
    @discardableResult
    public func confirmSignedIn() async -> Bool {
        guard let account, !isBusy else { return false }
        isBusy = true
        lastError = nil
        defer { isBusy = false }
        let verification: AccountVerification
        do {
            verification = try await onboarding.verifyAccount(accountID: account.id)
        } catch {
            lastError = SettingsSyncModel.message(for: error)
            return false
        }
        guard verification.authenticated else {
            lastError = verification.verifyHint
                ?? "This profile isn't signed in yet. Finish the provider's login in Terminal, then try again."
            return false
        }
        // Issue #99: the daemon refused the sign-in because the resulting
        // identity belongs to a different account. Never a success — stay on
        // the sign-in step with an honest message. The target profile stays
        // active so a corrective /login lands in the right place.
        if let mismatch = verification.identityMismatch {
            lastError = Self.identityMismatchMessage(mismatch)
            return false
        }
        self.account = verification.account
        identity = verification.identity
        step = .confirm
        // First usage snapshot + fresh state. Failures here are soft: the
        // account exists and is signed in; the deck fills in on next refresh.
        do {
            try await onboarding.refreshUsage()
        } catch {
            completionWarning = "Signed in, but the first usage refresh failed: \(SettingsSyncModel.message(for: error))"
        }
        // Issue #99: the sign-in is verified, so the pre-flow active account
        // can come back now (adding an account never used to change the
        // active one). Restore happens strictly AFTER verification — the
        // identity read-back is only trustworthy while the target is active.
        if let warning = await restorePriorActiveIfNeeded() {
            completionWarning = [completionWarning, warning].compactMap { $0 }.joined(separator: " ")
        }
        // A failed pre-activation lookup means the restore above silently
        // had nothing to work with — say so instead of leaving the switch
        // unannounced (never-silent, per this file's contract).
        if didActivateForLogin, priorActiveLookupFailed {
            let warning = "ModelDeck couldn't read which subscription was active before this "
                + "sign-in, so nothing was restored — this profile is now the active one. "
                + "Re-activate another subscription from Settings → Subscriptions if needed."
            completionWarning = [completionWarning, warning].compactMap { $0 }.joined(separator: " ")
        }
        await publishFreshState()
        return true
    }

    /// Honest, provider-neutral mismatch message (issue #99). Identities are
    /// shown in the UI only — never logged.
    static func identityMismatchMessage(_ mismatch: AccountVerification.IdentityMismatch) -> String {
        let actual = mismatch.actual ?? "a different identity"
        let expected = mismatch.expected ?? "the intended identity"
        return "The sign-in landed as \(actual), but this subscription expects \(expected). "
            + "Nothing was recorded. Run the login again and sign in as \(expected)."
    }

    /// Cancel mid-flow. When an account was already created, `discardAccount`
    /// decides whether to remove ModelDeck's reference (reference-only delete
    /// — provider credentials are never touched) or keep it for a later
    /// sign-in from the roster. Returns false — leaving the flow state and
    /// `lastError` intact so the sheet stays open and shows the failure —
    /// when the requested removal didn't happen.
    @discardableResult
    public func cancel(discardAccount: Bool) async -> Bool {
        // Issue #99: an activation-driven flow flipped the active account to
        // the new profile — a cancelled flow must not silently leave it
        // there. Restore FIRST (so a discarded account is never the default
        // when it gets deleted); a failed restore keeps the sheet open with
        // the honest error rather than silently abandoning the flip.
        if let warning = await restorePriorActiveIfNeeded() {
            lastError = warning
            return false
        }
        if discardAccount, let account {
            do {
                try await onboarding.deleteAccount(id: account.id)
            } catch {
                lastError = SettingsSyncModel.message(for: error)
                return false
            }
        }
        if discardAccount || didActivateForLogin {
            await publishFreshState()
        }
        reset()
        return true
    }

    /// Back to a pristine step 1 (used when the sheet reopens).
    ///
    /// Fix round 1: a connect still in flight is CANCELLED rather than
    /// abandoned, and `isBusy` is left alone while it finishes — clearing it
    /// out from under a live operation is what let two connects overlap.
    public func reset() {
        cancelPendingConnect()
        step = .details
        if connectTask == nil { isBusy = false }
        lastError = nil
        account = nil
        loginCommand = nil
        identity = nil
        completionWarning = nil
        grokCandidate = nil
        connectedWindow = nil
        didActivateForLogin = false
        priorActiveAccountID = nil
        priorActiveLookupFailed = false
    }

    private func publishFreshState() async {
        guard let onStateChanged else { return }
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged(fresh)
        }
    }
}
