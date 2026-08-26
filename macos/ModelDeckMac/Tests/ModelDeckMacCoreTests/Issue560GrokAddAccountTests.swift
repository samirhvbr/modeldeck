import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #560 — connecting an existing grok CLI home as a subscription.
//
// The properties that are load-bearing and easy to regress silently:
//   1. the Grok flow NEVER asks for a login command, launches Terminal, or
//      activates a profile — decision 0035's read-only posture is the whole
//      reason this flow exists instead of the Claude/Codex one;
//   2. "Grok is connected" is only ever said once a real billing reading
//      landed; a folder that can't be read rolls its reference back rather
//      than leaving a card that will never fill in;
//   3. every refusal is decided from the daemon's own discovery fields, so
//      the sheet and `POST /api/accounts` can never disagree about whether a
//      folder is usable;
//   4. the discovery block keeps its OWN spoken label. This repo has been
//      bitten three times (#65, #113, #272) by a parent label suppressing
//      its children's elements, so the string is derived in Core and pinned
//      here.
//
// Placeholder identities only — never a real account (spec privacy rule).

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
}

private func readyCandidate(
    path: String = "/placeholder/home/.grok",
    lastSessionAt: String? = nil
) -> GrokHomeCandidate {
    GrokHomeCandidate(
        path: path,
        exists: true,
        isDirectory: true,
        ownedByCurrentUser: true,
        writableByOthers: false,
        permissionsOk: true,
        hasCredentials: true,
        lastSessionAt: lastSessionAt,
        readFiles: ["\(path)/auth.json", "\(path)/sessions/*/*/updates.jsonl"]
    )
}

@Suite("Grok home discovery verdicts (issue #560)")
struct GrokHomeCandidateTests {
    /// CodeRabbit round: step 1 proves a credential FILE is there, nothing
    /// more. Claiming "signed in" before the billing reading in step 2 would
    /// promise something this check can't see.
    @Test("A ready home claims a credential exists, never that it works")
    func readyConnects() {
        let candidate = readyCandidate(lastSessionAt: iso(-2 * 86_400))
        #expect(candidate.verdict == .ready)
        #expect(candidate.canConnect)
        #expect(candidate.remedyCommand() == nil)
        #expect(candidate.statusText(now: now) == "Credentials found · last session 2 days ago")
        #expect(!candidate.statusText(now: now).lowercased().contains("signed in"))
    }

    @Test("A home with no recorded session says so instead of inventing an age")
    func readyWithoutSessionHistory() {
        let candidate = readyCandidate()
        #expect(candidate.statusText(now: now) == "Credentials found · no sessions recorded yet")
    }

    @Test("A missing home refuses and offers the grok command, never a launch")
    func missingHome() {
        var candidate = readyCandidate()
        candidate.exists = false
        candidate.isDirectory = false
        candidate.hasCredentials = false
        #expect(candidate.verdict == .noHome)
        #expect(!candidate.canConnect)
        #expect(candidate.remedyCommand() == "grok")
        #expect(candidate.statusText(now: now) == "No grok CLI home found")
    }

    @Test("A home the grok CLI never signed into refuses with the same command")
    func homeWithoutCredentials() {
        var candidate = readyCandidate()
        candidate.hasCredentials = false
        #expect(candidate.verdict == .notSignedIn)
        #expect(!candidate.canConnect)
        #expect(candidate.remedyCommand() == "grok")
    }

    @Test("A home other local users can write refuses with the exact chmod")
    func writableByOthers() {
        var candidate = readyCandidate()
        candidate.writableByOthers = true
        candidate.permissionsOk = false
        #expect(candidate.verdict == .writableByOthers)
        #expect(!candidate.canConnect)
        #expect(candidate.remedyCommand(home: "/nowhere") == "chmod g-w,o-w /placeholder/home/.grok")
    }

    @Test("A folder owned by someone else refuses without a command to run")
    func notOwned() {
        var candidate = readyCandidate()
        candidate.ownedByCurrentUser = false
        candidate.permissionsOk = false
        #expect(candidate.verdict == .notOwned)
        #expect(candidate.remedyCommand() == nil)
    }

    @Test("Another provider's registered home refuses — the credential-crossing guard")
    func registeredElsewhere() {
        var candidate = readyCandidate(path: "/placeholder/.codex-profiles/studio")
        candidate.alreadyRegisteredAs = "codex"
        #expect(candidate.verdict == .registeredElsewhere("codex"))
        #expect(!candidate.canConnect)
        #expect(candidate.statusText(now: now) == "Already registered as a Codex subscription's home")
        #expect(candidate.explanation.contains("Codex"))
    }

    /// Fix round 1's blocker: the daemon sets a hint for EVERY refusal, so
    /// preferring it made Tim's approved copy dead code and showed developer
    /// strings instead.
    @Test("Approved copy wins over the daemon's hint for every refusal this build knows")
    func approvedCopyWinsOverDaemonHint() {
        var candidate = readyCandidate()
        candidate.hasCredentials = false
        candidate.hint = "Grok profile does not contain stored credentials."
        #expect(candidate.explanation.contains("grok CLI has already signed in"))

        candidate = readyCandidate()
        candidate.writableByOthers = true
        candidate.permissionsOk = false
        candidate.hint = "Grok profile home must not be writable by anyone else (chmod g-w,o-w /x)"
        #expect(candidate.explanation.contains("swap in their own credentials"))
    }

    /// Confirm round N1: the sheet keys its dot, its paragraph and its Connect
    /// button off `canConnect`, so a refusal only a newer daemon understands
    /// has to make the folder UNUSABLE — not merely swap a paragraph, which
    /// would have shown green with a live Connect button.
    @Test("A hint on an otherwise-fine folder refuses the folder, not just the copy")
    func unknownRefusalIsUnusable() {
        var candidate = readyCandidate()
        candidate.hint = "Grok home is quarantined by a newer rule."
        #expect(candidate.verdict == .ready)
        #expect(candidate.unknownRefusal)
        #expect(!candidate.canConnect)
        #expect(candidate.statusText(now: now) == "Found, but ModelDeck can't use it yet")
        #expect(candidate.explanation == "Grok home is quarantined by a newer rule.")
    }

    @Test("A folder already connected as Grok refuses in plain words")
    func alreadyConnectedAsGrok() {
        var candidate = readyCandidate()
        candidate.alreadyRegisteredAs = "grok"
        candidate.hint = "this directory is already registered as a grok subscription's home"
        #expect(candidate.verdict == .registeredElsewhere("grok"))
        #expect(!candidate.canConnect)
        #expect(candidate.statusText(now: now) == "Already connected as another Grok subscription")
        #expect(candidate.explanation.contains("already connected as another Grok subscription"))
        // Issue #459: user-facing copy never calls a deck member an account.
        #expect(!candidate.explanation.lowercased().contains("account"))
    }

    @Test("The folder reads home-relative, in the sheet and in the command")
    func displayPathIsHomeRelative() {
        let candidate = readyCandidate(path: "/placeholder/home/.grok")
        #expect(candidate.displayPath(home: "/placeholder/home") == "~/.grok")
        #expect(candidate.displayPath(home: "/somewhere/else") == "/placeholder/home/.grok")

        var writable = candidate
        writable.writableByOthers = true
        writable.permissionsOk = false
        #expect(writable.remedyCommand(home: "/placeholder/home") == "chmod g-w,o-w ~/.grok")
    }

    @Test("A folder name with a space still pastes into a shell correctly")
    func spacedFolderIsQuoted() {
        var candidate = readyCandidate(path: "/placeholder/home/my grok")
        candidate.writableByOthers = true
        candidate.permissionsOk = false
        #expect(candidate.remedyCommand(home: "/placeholder/home") == "chmod g-w,o-w ~/'my grok'")
    }

    @Test("The discovery block's spoken label carries path and state itself")
    func accessibilityLabelIsSelfContained() {
        let candidate = readyCandidate(lastSessionAt: iso(-2 * 86_400))
        let label = candidate.accessibilityLabel(now: now, home: "/placeholder/home")
        #expect(label.contains("~/.grok"))
        #expect(label.contains("Credentials found"))
    }

    @Test("The read-only promise is one plain sentence, stated in Core")
    func readOnlyPromise() {
        #expect(GrokHomeCandidate.readOnlyPromise.contains("never writes"))
        #expect(GrokHomeCandidate.readOnlyPromise.contains("never copies"))
    }

    @Test("A minimal payload from an older daemon decodes as unusable, never a crash")
    func tolerantDecoding() throws {
        let json = #"{"path":"/placeholder/home/.grok"}"#
        let candidate = try JSONDecoder().decode(GrokHomeCandidate.self, from: Data(json.utf8))
        #expect(candidate.path == "/placeholder/home/.grok")
        #expect(!candidate.canConnect)
        #expect(candidate.readFiles.isEmpty)
    }

    @Test("The full daemon payload decodes every field the sheet renders")
    func fullDecoding() throws {
        let json = #"""
        {"path":"/placeholder/home/.grok","exists":true,"isDirectory":true,
         "ownedByCurrentUser":true,"writableByOthers":false,"permissionsOk":true,
         "hasCredentials":true,"alreadyRegisteredAs":null,
         "lastSessionAt":"2026-08-23T19:20:21.000Z","hint":null,
         "readFiles":["/placeholder/home/.grok/auth.json",
                      "/placeholder/home/.grok/sessions/*/*/updates.jsonl"]}
        """#
        let candidate = try JSONDecoder().decode(GrokHomeCandidate.self, from: Data(json.utf8))
        #expect(candidate.canConnect)
        #expect(candidate.readFiles.count == 2)
        #expect(candidate.lastSessionAt == "2026-08-23T19:20:21.000Z")
    }
}

@Suite("Grok add-account wire format (issue #560)")
struct GrokAddAccountWireTests {
    @Test("A Claude/Codex create still sends no profileRef — the daemon builds the home")
    func createOmitsProfileRefForOwnedProviders() throws {
        let create = AccountCreate(provider: "claude", label: "Work", purpose: "", color: nil)
        let body = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(create)
        ) as? [String: Any]
        #expect(body?["profileRef"] == nil)
    }

    @Test("A Grok connect sends the discovered folder as the profileRef")
    func connectSendsProfileRef() throws {
        let create = AccountCreate(
            provider: "grok",
            label: "Side Project",
            purpose: "",
            color: "#48a868",
            profileRef: "/placeholder/home/.grok"
        )
        let body = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(create)
        ) as? [String: Any]
        #expect(body?["provider"] as? String == "grok")
        #expect(body?["profileRef"] as? String == "/placeholder/home/.grok")
    }

    /// Fix round 1: the daemon token-gates discovery (it walks a
    /// caller-supplied path), so an unauthenticated read would 403 every time.
    @Test("Discovery is token-gated, with the folder as a query item")
    func discoveryRequestShape() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-560"}"#),
            .init(status: 200, body: #"{"path":"/placeholder/home/.grok","exists":true}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        _ = try await client.grokHomeCandidate(path: "/placeholder/other grok")
        let request = transport.requests[1]
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/api/grok/home-candidate")
        #expect(request.url?.query == "path=/placeholder/other%20grok")
        #expect(request.value(forHTTPHeaderField: "x-modeldeck-token") == "tok-560")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "modeldeck_session=tok-560")
    }

    /// CodeRabbit round: the daemon parses the query with `URLSearchParams`,
    /// where a literal `+` decodes to a space — so `my+grok` would be
    /// inspected as `my grok` unless the client encodes it.
    @Test("A folder path with a plus or a space survives the query intact")
    func awkwardPathsSurviveTheQuery() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-560"}"#),
            .init(status: 200, body: #"{"path":"/placeholder/home/my+grok","exists":true}"#),
            .init(status: 200, body: #"{"token":"tok-560"}"#),
            .init(status: 200, body: #"{"path":"/placeholder/home/my grok","exists":true}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)

        _ = try await client.grokHomeCandidate(path: "/placeholder/home/my+grok")
        #expect(transport.requests[1].url?.query == "path=/placeholder/home/my%2Bgrok")

        _ = try await client.grokHomeCandidate(path: "/placeholder/home/my grok")
        #expect(transport.requests[3].url?.query == "path=/placeholder/home/my%20grok")
    }

    @Test("Default discovery asks the daemon which folder it would use")
    func defaultDiscoveryRequestShape() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-560"}"#),
            .init(status: 200, body: #"{"path":"/placeholder/home/.grok","exists":true}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        _ = try await client.grokHomeCandidate(path: nil)
        #expect(transport.requests[1].url?.query == nil)
    }
}

/// Holds a connect open at its first daemon call until the test releases it.
private actor Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false

    func wait() async {
        guard !opened else { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
    }
}

@Suite("Grok connect flow (issue #560)")
@MainActor
struct GrokConnectFlowTests {
    private func makeModel(_ backend: StubOnboardingBackend) -> AddAccountModel {
        AddAccountModel(onboarding: backend, launcher: backend, stateProvider: backend, activator: backend)
    }

    /// State the daemon reports after a successful connect + refresh: the
    /// account exists and one Grok billing snapshot landed against it.
    private func connectedState(remaining: Double = 59) -> DeckState {
        DeckState(
            accounts: [
                DeckAccount(
                    id: "acct-1",
                    provider: "grok",
                    label: "Side Project",
                    profileRef: "/placeholder/home/.grok"
                ),
            ],
            usage: [
                UsageSnapshot(
                    accountId: "acct-1",
                    scope: "weekly",
                    remainingPercent: remaining,
                    resetsAt: iso(3 * 86_400),
                    observedAt: iso(0),
                    source: "grok-billing-api"
                ),
            ]
        )
    }

    @Test("The picker offers Grok alongside the two sign-in providers")
    func grokIsAddable() {
        #expect(DeckProvider.addableCases == [.claude, .codex, .grok])
    }

    @Test("Discovery hands the daemon's verdict to the sheet")
    func discovery() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        let model = makeModel(backend)

        await model.discoverGrokHome()
        #expect(model.grokCandidate?.canConnect == true)
        #expect(backend.grokCandidateRequests == [nil])
        #expect(model.lastError == nil)
    }

    @Test("A failed discovery is honest and leaves nothing connectable")
    func discoveryFailure() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidateError = DaemonClientError.httpStatus(503)
        let model = makeModel(backend)

        await model.discoverGrokHome()
        #expect(model.grokCandidate == nil)
        #expect(model.lastError != nil)
    }

    @Test("Happy path: connect saves the folder, refreshes, and shows the real reading")
    func connectHappyPath() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = connectedState()
        let model = makeModel(backend)
        var publishedStates = 0
        model.onStateChanged = { _ in publishedStates += 1 }

        await model.discoverGrokHome()
        let connected = await model.connectGrok(label: "  Side Project  ", purpose: "", colorHex: "#48a868")
        #expect(connected)
        #expect(model.step == .confirm)
        #expect(backend.created == [AccountCreate(
            provider: "grok",
            label: "Side Project",
            purpose: "",
            color: "#48a868",
            profileRef: "/placeholder/home/.grok"
        )])
        #expect(backend.refreshCalls == 1)
        #expect(model.connectedWindow?.remainingText == "59% left")
        #expect(model.connectedWindow?.title == "Weekly · all models")
        #expect(publishedStates == 1)
        // Decision 0035: no sign-in handoff exists for Grok, and none is faked.
        #expect(backend.loginCommandRequests.isEmpty)
        #expect(backend.launchedCommands.isEmpty)
        #expect(backend.activatedIDs.isEmpty)
        #expect(backend.verifiedIDs.isEmpty)
    }

    @Test("An unusable folder never reaches the daemon")
    func refusedFolderNeverPosts() async {
        let backend = StubOnboardingBackend()
        var candidate = readyCandidate()
        candidate.hasCredentials = false
        backend.grokCandidate = candidate
        let model = makeModel(backend)

        await model.discoverGrokHome()
        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(backend.created.isEmpty)
        #expect(model.step == .details)
    }

    @Test("Connecting before discovery finished never posts either")
    func connectWithoutCandidate() async {
        let backend = StubOnboardingBackend()
        let model = makeModel(backend)
        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(backend.created.isEmpty)
    }

    @Test("An empty label never reaches the daemon")
    func emptyLabel() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        let model = makeModel(backend)
        await model.discoverGrokHome()

        let connected = await model.connectGrok(label: "   ", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(backend.created.isEmpty)
        #expect(model.lastError != nil)
    }

    @Test("No billing reading means no connection: the reference is rolled back")
    func noReadingRollsBack() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        // The account saved, but the refresh produced no snapshot for it.
        backend.stateAfterMutation = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "grok", label: "Side Project"),
        ])
        let model = makeModel(backend)
        await model.discoverGrokHome()

        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(model.step == .details)
        #expect(model.account == nil)
        #expect(backend.deletedIDs == ["acct-1"])
        #expect(model.lastError?.contains("billing") == true)
    }

    @Test("The daemon's own refresh error is what the failure says")
    func refreshErrorMessageSurfaces() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = DeckState(accounts: [
            DeckAccount(
                id: "acct-1",
                provider: "grok",
                label: "Side Project",
                lastRefreshError: AccountRefreshError(message: "Grok usage refresh failed: 401")
            ),
        ])
        let model = makeModel(backend)
        await model.discoverGrokHome()

        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(model.lastError?.contains("401") == true)
        #expect(backend.deletedIDs == ["acct-1"])
    }

    @Test("A rollback that fails is admitted, never silently left half-connected")
    func rollbackFailureIsAdmitted() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "grok", label: "Side Project"),
        ])
        backend.deleteError = DaemonClientError.httpStatus(503)
        let model = makeModel(backend)
        await model.discoverGrokHome()

        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(model.lastError?.contains("still in the deck") == true)
    }

    // MARK: - Fix round 1: the connect's lifecycle

    /// Start a connect and leave it parked at its first daemon call.
    private func startGatedConnect(
        _ backend: StubOnboardingBackend,
        _ model: AddAccountModel,
        gate: Gate
    ) async -> Task<Bool, Never> {
        backend.beforeCreate = { await gate.wait() }
        await model.discoverGrokHome()
        let connect = Task { await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil) }
        for _ in 0..<1_000 where !backend.createStarted {
            await Task.yield()
        }
        // Proves the connect really is parked mid-flight — otherwise the
        // cancellation tests below would prove nothing.
        #expect(backend.createStarted)
        return connect
    }

    @Test("Reopening the sheet mid-connect cancels it and rolls back exactly once")
    func resetMidFlightCancelsAndRollsBack() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = connectedState()
        let model = makeModel(backend)
        let gate = Gate()
        let connect = await startGatedConnect(backend, model, gate: gate)

        // The sheet reappeared while the connect was still in the daemon.
        model.reset()
        await gate.open()
        let connected = await connect.value

        #expect(!connected)
        #expect(model.step == .details)
        #expect(model.connectedWindow == nil)
        #expect(model.account == nil)
        #expect(backend.deletedIDs == ["acct-1"])
        // The busy flag belongs to the operation, not to reset(): once the
        // cancelled connect finished, a fresh sheet is usable again.
        #expect(!model.isBusy)
    }

    @Test("A second connect can't start while one is in flight")
    func overlappingConnectsRefused() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = connectedState()
        let model = makeModel(backend)
        let gate = Gate()
        let connect = await startGatedConnect(backend, model, gate: gate)

        let second = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!second)
        await gate.open()
        _ = await connect.value
        #expect(backend.created.count == 1)
    }

    @Test("Dismissing mid-connect never lands a card — the reference rolls back")
    func dismissMidConnectRollsBack() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = connectedState()
        let model = makeModel(backend)
        var publishedStates = 0
        model.onStateChanged = { _ in publishedStates += 1 }
        let gate = Gate()
        let connect = await startGatedConnect(backend, model, gate: gate)

        // What the sheet's onDisappear does.
        model.cancelPendingConnect()
        await gate.open()
        let connected = await connect.value

        #expect(!connected)
        #expect(model.step != .confirm)
        #expect(model.connectedWindow == nil)
        #expect(backend.deletedIDs == ["acct-1"])
        // Nothing landed, so nothing was published as landed.
        #expect(publishedStates == 0)
    }

    /// The view-facing half of N1: the properties the sheet actually reads.
    @Test("A hint-on-ready folder can't be connected and offers a retry instead")
    func unknownRefusalBlocksConnectInTheSheet() async {
        let backend = StubOnboardingBackend()
        var candidate = readyCandidate()
        candidate.hint = "Grok home is quarantined by a newer rule."
        backend.grokCandidate = candidate
        let model = makeModel(backend)
        await model.discoverGrokHome()

        #expect(model.grokCandidate?.canConnect == false)
        #expect(model.offersGrokRetry)
        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(backend.created.isEmpty)
    }

    /// Confirm round N3: a cancel is not a failure anybody asked about, and a
    /// message set here lands on the freshly reset sheet.
    @Test("A connect cancelled during the save leaves no error on the reopened sheet")
    func cancellationLeavesNoStrayError() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = connectedState()
        // The daemon call is torn down by the cancellation, exactly as a
        // cancelled URL request behaves.
        backend.createError = CancellationError()
        let model = makeModel(backend)
        let gate = Gate()
        let connect = await startGatedConnect(backend, model, gate: gate)

        model.reset()
        await gate.open()
        let connected = await connect.value

        #expect(!connected)
        #expect(model.lastError == nil)
        #expect(model.step == .details)
    }

    /// CodeRabbit round: the sheet renders `lastError` on every step, so a
    /// failed Grok discovery used to leave red text under the Claude form.
    @Test("Switching provider drops a failed discovery's message")
    func providerSwitchClearsTheError() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidateError = DaemonClientError.httpStatus(403)
        let model = makeModel(backend)
        await model.discoverGrokHome()
        #expect(model.lastError != nil)

        // What the sheet's provider onChange does.
        model.clearLastError()
        #expect(model.lastError == nil)
    }

    @Test("Discovery that fails outright still offers a retry")
    func failedDiscoveryOffersRetry() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidateError = DaemonClientError.httpStatus(403)
        let model = makeModel(backend)
        await model.discoverGrokHome()

        #expect(model.grokCandidate == nil)
        #expect(model.offersGrokRetry)
        #expect(model.grokRetryPath == nil)

        // The retry itself works, and lands a usable folder.
        backend.grokCandidateError = nil
        backend.grokCandidate = readyCandidate()
        await model.discoverGrokHome(path: model.grokRetryPath)
        #expect(model.grokCandidate?.canConnect == true)
        #expect(!model.offersGrokRetry)
    }

    /// The daemon refuses a second Grok subscription on one folder (fix round
    /// 1). It arrives as an ordinary daemon error and reads as one.
    @Test("A duplicate-folder refusal surfaces through the normal error surface")
    func duplicateFolderRefusal() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.createError = DaemonClientError.daemonError(
            message: "this directory is already registered as a grok subscription's home; "
                + "a Grok subscription needs its own",
            status: 400
        )
        let model = makeModel(backend)
        await model.discoverGrokHome()

        let connected = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)
        #expect(!connected)
        #expect(model.step == .details)
        #expect(model.lastError?.contains("already registered") == true)
        #expect(backend.deletedIDs.isEmpty)
        #expect(!model.isBusy)
    }

    @Test("Reset clears the discovered folder so a reopened sheet re-checks")
    func resetClearsCandidate() async {
        let backend = StubOnboardingBackend()
        backend.grokCandidate = readyCandidate()
        backend.stateAfterMutation = connectedState()
        let model = makeModel(backend)
        await model.discoverGrokHome()
        _ = await model.connectGrok(label: "Side Project", purpose: "", colorHex: nil)

        model.reset()
        #expect(model.grokCandidate == nil)
        #expect(model.connectedWindow == nil)
        #expect(model.step == .details)
    }
}
