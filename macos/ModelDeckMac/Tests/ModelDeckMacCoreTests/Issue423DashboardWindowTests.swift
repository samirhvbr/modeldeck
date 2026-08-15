import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #423 (1.0 build E) — the app window's decidable parts: which phase
// the window is in, which single action the daemon-down state offers, and
// the ONE-window rule. WKWebView pixels are deliberately untested; every
// rule the acceptance criteria name lives in these pure pieces.

private let dashboardURL = URL(string: "http://127.0.0.1:3867/dashboard")!

@Suite("Dashboard window state (issue #423)")
struct Issue423DashboardWindowStateTests {
    @Test func dashboardURLIsTheDaemonsOwnLoopbackRoute() {
        // No second serving mechanism: the window's URL is the SAME
        // derivation the browser entry used.
        let url = UsageAnalytics.dashboardURL(base: DaemonConfiguration().baseURL)
        #expect(url.absoluteString == "http://127.0.0.1:3867/dashboard")
        #expect(url.scheme == "http")
        #expect(url.host == "127.0.0.1")
    }

    @Test func connectedDaemonRendersTheLiveDashboard() {
        let phase = DashboardWindowState.phase(
            connection: .connected,
            dashboardURL: dashboardURL,
            setupPhase: .quiet,
            bundledServiceAvailable: true
        )
        #expect(phase == .live(dashboardURL))
    }

    @Test func unreachableDaemonRendersTheEmptyState() {
        let phase = DashboardWindowState.phase(
            connection: .unreachable("connection refused"),
            dashboardURL: dashboardURL,
            setupPhase: .startingUp,
            bundledServiceAvailable: true
        )
        guard case .daemonDown(let down) = phase else {
            Issue.record("expected the daemon-down state, got \(phase)")
            return
        }
        #expect(down.message == DashboardWindowState.daemonDownMessage)
    }

    @Test func unknownConnectionIsNotTreatedAsLive() {
        // Before the first health read nobody has confirmed the port.
        // Loading anyway would show WebKit's error page — the opposite of an
        // honest empty state.
        let phase = DashboardWindowState.phase(
            connection: .unknown,
            dashboardURL: dashboardURL,
            setupPhase: .checking,
            bundledServiceAvailable: true
        )
        #expect(phase != .live(dashboardURL))
    }

    @Test func theEmptyStateIsOneMessageAndOneAction() {
        let down = DashboardWindowState.daemonDown(
            setupPhase: .declined,
            bundledServiceAvailable: true
        )
        // Minimal-first: one sentence, not a wall of setup prose.
        #expect(!down.message.isEmpty)
        #expect(!down.message.contains("\n"))
        #expect(down.message.filter { $0 == "." }.count == 1)
        #expect(!down.actionTitle.isEmpty)
    }

    @Test func installIsOfferedOnlyWhenTheServiceIsInstallable() {
        for phase in [DaemonSetupModel.Phase.consentNeeded, .declined] {
            #expect(DashboardWindowState.startAction(
                setupPhase: phase,
                bundledServiceAvailable: true
            ) == .installService)
        }
    }

    @Test func everyOtherDownStateReprobesInsteadOfClaimingItCanInstall() {
        let phases: [DaemonSetupModel.Phase] = [
            .idle, .checking, .quiet, .installing, .awaitingApproval,
            .startingUp, .legacyNotRunning, .failed("boom"),
        ]
        for phase in phases {
            #expect(DashboardWindowState.startAction(
                setupPhase: phase,
                bundledServiceAvailable: true
            ) == .checkAgain, "\(phase) should re-probe, not offer an install")
        }
    }

    @Test func devBuildsWithoutABundledServiceNeverOfferAnInstall() {
        // No bundled service to install — the button must not lie.
        #expect(DashboardWindowState.startAction(
            setupPhase: .consentNeeded,
            bundledServiceAvailable: false
        ) == .checkAgain)
    }

    @Test func actionTitlesMatchTheDecksExistingWording() {
        // The same button must never carry two names across surfaces.
        #expect(DashboardWindowState.actionTitle(for: .installService)
                == "Install Background Service")
        #expect(DashboardWindowState.actionTitle(for: .checkAgain) == "Check Again")
    }
}

@MainActor
@Suite("Dashboard window model (issue #423)")
struct Issue423DashboardWindowModelTests {
    @Test func aWindowOpenedWithTheDaemonDownStartsInTheEmptyState() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL)
        guard case .daemonDown = model.phase else {
            Issue.record("a fresh window must not claim the daemon is up")
            return
        }
        #expect(model.loadGeneration == 0)
    }

    @Test func theWindowRecoversLiveOnceTheDaemonAnswers() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL)
        model.apply(
            connection: .unreachable("refused"),
            setupPhase: .startingUp,
            bundledServiceAvailable: true
        )
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        #expect(model.phase == .live(dashboardURL))
        // The load signal fired exactly once — the web view now has a page.
        #expect(model.loadGeneration == 1)
    }

    @Test func aSteadyDaemonNeverReloadsThePageUnderTheUser() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL)
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        let generation = model.loadGeneration
        for _ in 0..<5 {
            model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        }
        #expect(model.loadGeneration == generation)
    }

    @Test func aDaemonThatDiesMidSessionFallsBackToTheEmptyStateAndReloadsOnReturn() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL)
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        model.apply(
            connection: .unreachable("refused"),
            setupPhase: .startingUp,
            bundledServiceAvailable: true
        )
        guard case .daemonDown = model.phase else {
            Issue.record("a dead daemon must show the empty state, not a stale page")
            return
        }
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        #expect(model.loadGeneration == 2, "the recovered window must reload, not sit on the failure")
    }

    @Test func aWebViewLoadFailureShowsTheEmptyStateWithItsLastHonestAction() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL)
        model.apply(
            connection: .unreachable("refused"),
            setupPhase: .declined,
            bundledServiceAvailable: true
        )
        model.apply(connection: .connected, setupPhase: .declined, bundledServiceAvailable: true)
        model.noteLoadFailure()
        guard case .daemonDown(let down) = model.phase else {
            Issue.record("a failed load must not leave WebKit's error page showing")
            return
        }
        #expect(down.action == .installService)
    }

    @Test func theStartButtonRunsTheResolvedAction() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL)
        var actions: [DashboardStartAction] = []
        model.onStart = { actions.append($0) }

        model.apply(
            connection: .unreachable("refused"),
            setupPhase: .consentNeeded,
            bundledServiceAvailable: true
        )
        model.start()
        model.apply(
            connection: .unreachable("refused"),
            setupPhase: .startingUp,
            bundledServiceAvailable: true
        )
        model.start()
        #expect(actions == [.installService, .checkAgain])

        // Live: there is no button, so a stray call does nothing.
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        model.start()
        #expect(actions.count == 2)
    }
}

@MainActor
private final class FakeDashboardWindow: DashboardHostingWindow {
    private(set) var frontCount = 0
    func bringToFront() { frontCount += 1 }
}

@MainActor
@Suite("Dashboard window lifecycle (issue #423)")
struct Issue423DashboardWindowLifecycleTests {
    @Test func reInvokingTheMenuBarEntryFocusesTheExistingWindow() {
        let presenter = DashboardWindowPresenter()
        var built = 0
        let window = FakeDashboardWindow()
        let make: () -> DashboardHostingWindow = {
            built += 1
            return window
        }

        #expect(presenter.present(make: make) == .created)
        #expect(presenter.present(make: make) == .focusedExisting)
        #expect(presenter.present(make: make) == .focusedExisting)
        // ONE window (#402(c)), and every invocation raises it.
        #expect(built == 1)
        #expect(window.frontCount == 3)
    }

    @Test func closingTheWindowLetsTheNextInvocationBuildAFreshOne() {
        let presenter = DashboardWindowPresenter()
        var built = 0
        let make: () -> DashboardHostingWindow = {
            built += 1
            return FakeDashboardWindow()
        }

        presenter.present(make: make)
        #expect(presenter.hasWindow)
        presenter.windowDidClose()
        #expect(!presenter.hasWindow)
        #expect(presenter.present(make: make) == .created)
        #expect(built == 2)
    }
}

// PR #426 review (CodeRabbit, fixed by the orchestrator): WKWebView treats
// an HTTP error status as a successful navigation, so the web view's
// response policy consults this predicate to route non-2xx to the same
// fallback as a connection failure.
@Suite("Dashboard window response policy (issue #423)")
struct Issue423DashboardResponsePolicyTests {
    @Test func everySuccessStatusIsAllowed() {
        for status in [200, 204, 299] {
            #expect(DashboardWindowState.responseStatusAllows(status))
        }
    }

    @Test func errorStatusesRouteToTheFallback() {
        // 404 is the live case: the analytics flag turned off while the
        // window is open makes /dashboard answer 404, which must show the
        // honest empty state, never the daemon's raw error body.
        for status in [301, 401, 404, 500, 503] {
            #expect(!DashboardWindowState.responseStatusAllows(status))
        }
    }
}
