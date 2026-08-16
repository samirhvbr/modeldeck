import AppKit
import Combine
import SwiftUI
import WebKit
import ModelDeckMacCore

// Issue #423 (1.0 build E) — the app window. A plain AppKit window (same
// reasoning as the floating deck, #295: frame autosave for free, reliable
// close detection through the delegate) hosting a WKWebView pointed at the
// daemon's own /dashboard over loopback. Exactly what Safari rendered; now
// in a real window.
//
// The ATS exception that permits the http:// load is scoped to 127.0.0.1 in
// Support/Info.plist — never NSAllowsArbitraryLoads (#402(a)); the tripwire
// lives in test/mac-app-window-ats.test.mjs.

/// `NSWindow` satisfies the one-window rule's single operation. Activation
/// is explicit: with the accessory activation policy a bare `orderFront` can
/// land behind the frontmost app (the #45 Settings lesson).
extension NSWindow: DashboardHostingWindow {
    public func bringToFront() {
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// Issue #423: the window's lifecycle. One window per app run — the
/// presenter (Core) decides create-vs-focus, this owns the AppKit pieces.
@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate {
    static let frameAutosaveName = "ModelDeckDashboardWindow"

    private let model: DashboardWindowModel
    private let presenter = DashboardWindowPresenter()
    /// Issue #444: while this window is open the app runs `.regular` — Dock
    /// icon and the standard app menu, like any app with a full-size window
    /// — and drops back to the menu-bar-agent `.accessory` when it closes.
    /// The decision is Core's (tested both directions); this only applies it.
    private var activationPolicy = AppActivationPolicyControl()
    private var cancellables: Set<AnyCancellable> = []
    /// Issue #424 (#402(d)): the daemon's own session token, fetched the same
    /// way every other client fetches it (`GET /api/session`). Nil when the
    /// daemon isn't answering — the page load is attempted anyway, because
    /// `/dashboard` is a GET and the daemon gates only mutations.
    private let sessionToken: () async -> String?

    init(model: DashboardWindowModel, sessionToken: @escaping () async -> String?) {
        self.model = model
        self.sessionToken = sessionToken
    }

    /// Mirrors the deck's own daemon health into the window: it already
    /// knows (connection status + the #96 setup phase), so the window never
    /// probes anything itself.
    func observe(status: MenuBarStatusModel, setup: DaemonSetupModel) {
        status.$connection
            .combineLatest(setup.$phase)
            .sink { [weak model, weak setup] connection, phase in
                model?.apply(
                    connection: connection,
                    setupPhase: phase,
                    bundledServiceAvailable: setup?.bundledServiceAvailable ?? false
                )
            }
            .store(in: &cancellables)
    }

    /// Opens the window, or fronts the one that already exists — landed on
    /// the position this entry means (issue #424). The route is set BEFORE
    /// the window is built, so a first open loads that position directly
    /// rather than loading the overview and then navigating off it.
    func show(jumpPoint: DashboardJumpPoint) {
        model.open(DashboardRoute.landing(for: jumpPoint, restored: model.route))
        presenter.present { self.makeWindow() }
    }

    private func makeWindow() -> NSWindow {
        let hosting = NSHostingController(
            rootView: DashboardWindowRootView(model: model, sessionToken: sessionToken)
        )
        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.title = DashboardWindowState.windowTitle
        window.level = .normal
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 1100, height: 760))
        window.contentMinSize = NSSize(width: 720, height: 480)
        window.setFrameAutosaveName(Self.frameAutosaveName)
        window.delegate = self
        // Issue #444: flip BEFORE the presenter fronts the window, so the
        // activation that follows lands with the app already regular and the
        // app menu takes the top-left slot on the first click.
        apply(activationPolicy.windowOpened(ObjectIdentifier(window)))
        return window
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        window.delegate = nil
        presenter.windowDidClose()
        apply(activationPolicy.windowClosed(ObjectIdentifier(window)))
    }

    /// Applies a policy change, and only a change — `nil` means the app is
    /// already where it should be (re-fronting the one window), and
    /// re-issuing `setActivationPolicy` would churn activation for nothing.
    private func apply(_ policy: AppActivationPolicy?) {
        switch policy {
        case .regular: NSApp.setActivationPolicy(.regular)
        case .accessory: NSApp.setActivationPolicy(.accessory)
        case nil: break
        }
    }
}

/// The window's content: the live dashboard, or the honest empty state.
struct DashboardWindowRootView: View {
    @ObservedObject var model: DashboardWindowModel
    let sessionToken: () async -> String?

    var body: some View {
        switch model.phase {
        case .live(let url):
            DashboardWebView(
                url: url,
                generation: model.loadGeneration,
                sessionToken: sessionToken,
                onLoadFailure: { model.noteLoadFailure() },
                onRouteReported: { model.noteReportedRoute(json: $0) }
            )
        case .daemonDown(let state):
            VStack(spacing: 12) {
                Text(state.message)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button(state.actionTitle) { model.start() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(32)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The loopback web view. No custom scheme handler, no bundled copy of the
/// page: the daemon's HTTP surface is the only source (#423).
struct DashboardWebView: NSViewRepresentable {
    /// The daemon's `/dashboard` with the route on its FRAGMENT (#424). A
    /// fragment never reaches the server, so a route cannot land in a request
    /// log — and the token is not here at all (see `load` below).
    let url: URL
    /// Changes when the window (re)enters the live phase, or when a jump
    /// point points it somewhere new — the signal to (re)load, so a daemon
    /// that came back doesn't leave a stale failure and a deep link re-runs
    /// the bundle's own parser rather than being navigated from this side.
    let generation: Int
    let sessionToken: () async -> String?
    let onLoadFailure: () -> Void
    let onRouteReported: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoadFailure: onLoadFailure, onRouteReported: onRouteReported)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The bundle's one-way report of where the reader navigated to, so a
        // relaunch can restore it. Nothing is injected INTO the page: the
        // handler only receives.
        configuration.userContentController.add(
            context.coordinator,
            name: DashboardRouteCodec.bridgeName
        )
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        // The daemon serves the deck's own page; no right-click "Reload"
        // chrome is needed and back/forward has nowhere to go.
        webView.allowsBackForwardNavigationGestures = false
        load(webView, context: context)
        return webView
    }

    /// `WKUserContentController` retains its message handlers strongly, so a
    /// window closed and reopened would strand the old coordinator (and the
    /// web view behind it) for the app's life. Removing the handler is the
    /// whole of the teardown.
    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: DashboardRouteCodec.bridgeName)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onLoadFailure = onLoadFailure
        context.coordinator.onRouteReported = onRouteReported
        guard context.coordinator.loadedGeneration != generation else { return }
        load(webView, context: context)
    }

    /// Load with the daemon token attached the way the daemon asks for it
    /// (#402(d), src/server.mjs `mutationAllowed`): the `x-modeldeck-token`
    /// header on the navigation itself, and the `modeldeck_session` session
    /// cookie so the page's own subresource and `fetch` requests carry it too
    /// — WKWebView cannot put a custom header on those.
    ///
    /// The token is NEVER written into `url`. It is not in the path, not in
    /// the query, not in the fragment, so it cannot reach the back/forward
    /// list, a bookmark, a referrer, or any log that records a URL.
    private func load(_ webView: WKWebView, context: Context) {
        context.coordinator.loadedGeneration = generation
        let target = url
        let startedGeneration = generation
        let coordinator = context.coordinator
        Task { @MainActor in
            var request = URLRequest(url: target)
            if let token = await sessionToken(), !token.isEmpty {
                if let cookie = DashboardWindowAuth.sessionCookie(token: token, dashboardURL: target),
                   let httpCookie = HTTPCookie(properties: cookie.properties) {
                    await webView.configuration.websiteDataStore.httpCookieStore.setCookie(httpCookie)
                }
                request.setValue(token, forHTTPHeaderField: DashboardWindowAuth.headerField)
            }
            // Two loads race on COMPLETION order, not start order (PR #429
            // review): if a newer load stamped the coordinator while this one
            // awaited the token, loading now would land the window on the
            // older route. The newest stamp wins; this one bails.
            guard coordinator.loadedGeneration == startedGeneration else { return }
            // No token (the daemon isn't answering yet) still loads:
            // `/dashboard` is a GET and the daemon gates only mutations, so
            // refusing to load here would invent an outage.
            webView.load(request)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onLoadFailure: () -> Void
        var onRouteReported: (String) -> Void
        var loadedGeneration: Int?

        init(onLoadFailure: @escaping () -> Void, onRouteReported: @escaping (String) -> Void) {
            self.onLoadFailure = onLoadFailure
            self.onRouteReported = onRouteReported
        }

        /// The page reporting its position. Treated as untrusted input — it
        /// is only ever a string handed to the same defensive decoder the
        /// stored route goes through, never evaluated.
        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == DashboardRouteCodec.bridgeName,
                  let json = message.body as? String
            else { return }
            onRouteReported(json)
        }

        /// A deep-link arrival should leave the keyboard in the page, not on
        /// the window chrome (#363 class); the bundle then parks focus on the
        /// breadcrumb trail, the one landmark present at every level.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.window?.makeFirstResponder(webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onLoadFailure()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            onLoadFailure()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            // An HTTP error status is a successful navigation to WKWebView;
            // route non-2xx to the same fallback as a connection failure
            // (DashboardWindowState.responseStatusAllows).
            if let response = navigationResponse.response as? HTTPURLResponse,
               !DashboardWindowState.responseStatusAllows(response.statusCode) {
                decisionHandler(.cancel)
                onLoadFailure()
                return
            }
            decisionHandler(.allow)
        }
    }
}
