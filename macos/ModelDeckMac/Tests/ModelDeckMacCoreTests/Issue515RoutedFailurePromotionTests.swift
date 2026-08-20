import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #515 — the state Tim hit on 2026-08-18 must be unrepresentable.
//
// The deck shouted "7 routed requests failed in a row (HTTP 401). Sign in
// again to restore proxy routing." (the copy of the day; #537 later
// shortened it) while Settings showed the same account
// green and kept the #396 repair in the hover-only ⋯ menu: the banner reads
// MEASURED request outcomes, the promotion read the RECORDED credential the
// proxy had not marked broken yet. Doctrine 0034 breaks the tie in favour of
// the wire.
//
// Placeholder identities only — this repo mirrors publicly.

private func member(
    id: String = "placeholder-account",
    label: String = "Placeholder Sub",
    proxyPool: String? = "member",
    proxyCredential: String? = "ok",
    proxyRelogin: ProxyReloginCapability? = ProxyReloginCapability(available: true)
) -> DeckAccount {
    DeckAccount(
        id: id, provider: "claude", label: label,
        enabled: true, isDefault: false,
        authState: "ok",
        proxyPool: proxyPool,
        proxyCredential: proxyCredential,
        proxyRelogin: proxyRelogin
    )
}

private func streak(
    accountID: String = "placeholder-account",
    failures: Int = 7,
    statusCode: Int? = 401
) -> MemberBlackoutAlert {
    MemberBlackoutAlert(
        accountId: accountID,
        provider: "claude",
        label: "Placeholder Sub",
        consecutiveFailures: failures,
        statusCode: statusCode
    )
}

@Suite("Routed-401 streak promotes the repair (issue #515)")
@MainActor
struct Issue515RoutedFailurePromotionTests {
    /// THE TRIPWIRE. A healthy recorded credential plus a live routed-401
    /// streak is exactly the morning's state: the deck banner must be
    /// actionable and the Settings row must show the promoted repair. Both
    /// read this one presentation, so one assertion covers both surfaces —
    /// and the source anchors below prove each surface renders it.
    @Test func aRoutedStreakOnAHealthyCredentialPromotesTheFixOnBothSurfaces() {
        let model = makeModel()
        let account = member(proxyCredential: "ok")
        let alert = streak()

        // Before #515 this was the whole bug: the recorded credential is fine.
        #expect(ProxyRelogin.credentialIsBroken(account) == false)
        #expect(model.presentation(for: account)?.display == .action(prominent: false))

        // With the deck's own wire evidence, the repair is promoted and the
        // streak is the stated reason.
        let promoted = model.presentation(for: account, routedFailures: alert)
        #expect(promoted?.display == .action(prominent: true))
        #expect(promoted?.credentialIsBroken == true)
        #expect(promoted?.credentialText == "last 7 requests failed (HTTP 401)")
    }

    @Test func theDeckBannerRendersTheRepairItNames() throws {
        let source = try viewSource("Sources/ModelDeckMac/DeckPopoverView.swift")
        // The banner reads the SAME presentation the Settings row reads…
        #expect(source.contains("proxyReloginModel.presentation(for: $0, routedFailures: alert)"))
        // …and arms a real button behind the existing confirmation, never a
        // hover-only affordance and never a direct launch.
        #expect(source.contains("Button(ProxyRelogin.actionTitle) { isConfirming = true }"))
        #expect(source.contains("ProxyReloginConfirmView(label: account.label)"))
        // The disclosure is Settings' own sentence, never a second copy.
        #expect(source.contains("Text(ProxyRelogin.confirmation(label: label))"))
        #expect(source.contains("Button(\"Open Sign-in\", action: onConfirm)"))
        // The evidence line keeps its #395 voice and its own VoiceOver label
        // (#537: the visible line drops the remedy; VoiceOver keeps it).
        #expect(source.contains("Label(visible, systemImage: \"exclamationmark.octagon.fill\")"))
        #expect(source.contains("Pool alert. \\(message)"))
        // Every new control names its account for VoiceOver.
        #expect(source.contains("Fix the proxy sign-in for \\(account.label)"))
        #expect(source.contains("Stop the proxy sign-in for \\(account.label)"))
        // A repair the proxy cannot run explains itself in place (PR #435).
        #expect(source.contains("Proxy sign-in unavailable. \\(reason)"))
    }

    /// CodeRabbit (PR #516). The banner renders on WIRE evidence, so it can
    /// reach a member the streak does not promote — a benched one, where
    /// signing in again would not help. The deck must hide the visible fix in
    /// exactly the states the Settings row hides it, or the surfaces disagree
    /// again, this time via the surface added to stop that.
    @Test func aBenchedMemberWithAStreakOffersNoDeckButtonEither() throws {
        let model = makeModel()
        let benched = member(proxyCredential: "disabled")
        // Reachable: the banner has an alert for this account, and the
        // presentation it hands the banner is a NON-prominent action.
        let presentation = try #require(model.presentation(for: benched, routedFailures: streak()))
        #expect(presentation.display == .action(prominent: false))
        #expect(presentation.credentialText == "Benched in the proxy pool")

        let deck = try viewSource("Sources/ModelDeckMac/DeckPopoverView.swift")
        // The deck destructures and gates, rather than matching every action…
        #expect(deck.contains("case .action(let prominent):"))
        #expect(deck.contains("if prominent {"))
        #expect(!deck.contains("case .action:"))
        // …and the non-promoted branch says why instead of going silent.
        #expect(deck.contains("} else if let credentialText = relogin.credentialText {"))
        #expect(deck.contains("Proxy sign-in. \\(credentialText)"))

        // The Settings row gates the same visible button on the same flag —
        // the two surfaces are pinned to one condition, not to each other's
        // good intentions.
        let settings = try viewSource("Sources/ModelDeckMac/SettingsWindowView.swift")
        #expect(settings.contains("case .action(let prominent):"))
        #expect(settings.contains("if prominent, let onProxyFixSignIn {"))
    }

    @Test func settingsPromotesFromTheSameWireEvidence() throws {
        let source = try viewSource("Sources/ModelDeckMac/SettingsWindowView.swift")
        // The row's presentation is built WITH the streak…
        #expect(source.contains("routedFailures: ProxyRelogin.routedFailures(for: account, in: state)"))
        // …the promoted state renders the visible button, not a menu item…
        #expect(source.contains("Button(ProxyRelogin.actionTitle, action: onProxyFixSignIn)"))
        #expect(source.contains("Fix the proxy sign-in for \\(account.label)"))
        // …and the row never re-derives brokenness more calmly than the deck.
        #expect(source.contains("relogin.credentialIsBroken ? .orange : .secondary"))
        #expect(!source.contains("ProxyRelogin.credentialIsBroken(account) ? .orange"))
    }

    @Test func theStreakIsFoundByAccountAndSurvivesDaemonSkew() {
        let account = member()
        let state = DeckState(
            accounts: [account],
            usage: [],
            memberBlackout: MemberBlackoutStatus(threshold: 3, alerts: [streak()])
        )
        #expect(ProxyRelogin.routedFailures(for: account, in: state)?.consecutiveFailures == 7)
        // Another account's streak is not this row's news.
        #expect(ProxyRelogin.routedFailures(for: member(id: "other"), in: state) == nil)
        // A daemon that omits the block (or no state at all) changes nothing.
        #expect(ProxyRelogin.routedFailures(for: account, in: DeckState(accounts: [], usage: [])) == nil)
        #expect(ProxyRelogin.routedFailures(for: account, in: nil) == nil)
    }

    @Test func theRecordedCredentialStillSpeaksFirstWhenItIsBroken() {
        // Wire evidence promotes; it does not overwrite the proxy's own
        // sentence, which is more specific than a failure count.
        let model = makeModel()
        let broken = member(proxyCredential: "error")
        let presentation = model.presentation(for: broken, routedFailures: streak())
        #expect(presentation?.credentialText == "Proxy sign-in expired")
        #expect(presentation?.display == .action(prominent: true))
    }

    @Test func aBenchedMemberIsStillNotPromoted() {
        // Signing in again would not un-bench it — the #396 rule survives the
        // new evidence path.
        let model = makeModel()
        let benched = member(proxyCredential: "disabled")
        let presentation = model.presentation(for: benched, routedFailures: streak())
        #expect(presentation?.credentialIsBroken == false)
        #expect(presentation?.display == .action(prominent: false))
        #expect(presentation?.credentialText == "Benched in the proxy pool")
    }

    @Test func anUnrunnableRepairSaysWhyInsteadOfPromotingADeadControl() {
        let reason = "This CLIProxyAPI install has no management key yet."
        let model = makeModel()
        let account = member(
            proxyCredential: "ok",
            proxyRelogin: ProxyReloginCapability(available: false, reason: reason)
        )
        let presentation = model.presentation(for: account, routedFailures: streak())
        #expect(presentation?.display == .unavailable(reason: reason))
        // …and the row still states the streak, so the surface is not silent.
        #expect(presentation?.credentialText == "last 7 requests failed (HTTP 401)")
    }

    @Test func aMachineWithoutTheProxyStaysSilentEvenUnderAStreak() {
        // The #149/#174 discipline outranks everything: no pool, no capability,
        // no invented control.
        let model = makeModel()
        let plain = member(proxyPool: nil, proxyCredential: nil, proxyRelogin: nil)
        #expect(model.presentation(for: plain, routedFailures: streak()) == nil)
    }

    @Test func aSingleFailureReadsAsOneRequest() {
        #expect(ProxyRelogin.routedFailureText(streak(failures: 1))
            == "last 1 request failed (HTTP 401)")
        // A daemon that reports no status code still gets a clean sentence.
        #expect(ProxyRelogin.routedFailureText(streak(failures: 4, statusCode: nil))
            == "last 4 requests failed")
    }
}

// MARK: - Helpers

@MainActor
private func makeModel() -> ProxyReloginModel {
    ProxyReloginModel(
        manager: SilentReloginStub(),
        stateProvider: SilentReloginStub(),
        browser: SilentReloginStub(),
        pollInterval: .zero,
        sleep: { _ in }
    )
}

/// No network, no browser, no daemon — these tests only exercise derivations.
private struct SilentReloginStub: ProxyReloginManaging, DeckStateProviding, BrowserOpening {
    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        ProxyReloginState(phase: "idle")
    }

    func proxyReloginState(accountID: String) async throws -> ProxyReloginState {
        ProxyReloginState(phase: "idle")
    }

    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        ProxyReloginState(phase: "cancelled")
    }

    func deckState() async throws -> DeckState { DeckState(accounts: [], usage: []) }

    func open(_ url: URL) {}
}

private func viewSource(_ relativePath: String) throws -> String {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    return try String(
        contentsOf: packageRoot.appendingPathComponent(relativePath),
        encoding: .utf8
    )
}
