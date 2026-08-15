import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #424 (1.0 build F) — the window as a navigation target: route
// serialisation, restore, landing selection, and how the daemon token is
// attached. WKWebView pixels stay untested; every rule the acceptance
// criteria name is decided in the pure pieces below.
//
// THE NAMED TRIPWIRES of this slice:
//
//   TRIPWIRE deeplink-token-not-in-url — 'no route URL the app can build
//   carries the daemon token'. The regression it guards is the obvious wrong
//   fix: authenticating the web view by appending `?token=…`, which is
//   invisible in a diff that "just adds auth" and puts the credential in the
//   back/forward list, in bookmarks, in referrers, and in any future access
//   log. VERIFIED TO FAIL by having DashboardRouteCodec.url append a
//   `token` query item.
//
//   TRIPWIRE deeplink-route-rides-the-fragment — 'the route is a fragment,
//   never a query'. A fragment is not sent to the server; a query is. Moving
//   the route to the query string would silently start shipping the reader's
//   project and session keys to the daemon on every open. VERIFIED TO FAIL
//   by assigning `components.percentEncodedQuery` instead of
//   `percentEncodedFragment`.
//
//   TRIPWIRE deeplink-wire-shape — 'the fragment's JSON keys are the
//   bundle's own route vocabulary, byte for byte'. Swift and
//   dashboard/src/route.js are two halves of one contract with no shared
//   type; renaming a property here compiles, ships, and lands every deep link
//   on the overview. The same literal is pinned in
//   test/dashboard-deeplink.test.mjs, where it is parsed. VERIFIED TO FAIL by
//   dropping `.withoutEscapingSlashes` from the encoder — a JSON-level
//   encoding change no reviewer would connect to a broken deep link.
//
// Placeholder identities and synthetic paths only.

private let dashboardURL = URL(string: "http://127.0.0.1:3867/dashboard")!

private let projectRoute = DashboardRoute(
    level: .project,
    projectKey: "/placeholder/projects/alpha",
    projectName: "alpha",
    rangeKey: "30d",
    scope: "codex"
)

private func throwawayDefaults() -> UserDefaults {
    UserDefaults(suiteName: "issue424-tests-\(UUID().uuidString)")!
}

@Suite("Dashboard deep-link codec (issue #424)")
struct Issue424RouteCodecTests {
    @Test func theOverviewIsJustTheDashboardURL() {
        // A deep link to the landing is the dashboard. An empty `#route=`
        // would be noise in the address bar and a fragment to parse for
        // nothing.
        #expect(DashboardRouteCodec.url(base: dashboardURL, route: .overview) == dashboardURL)
        #expect(DashboardRouteCodec.fragment(for: .overview) == nil)
    }

    @Test func aDrillRouteRidesTheFragmentAndLeavesTheBaseURLAlone() {
        // TRIPWIRE deeplink-route-rides-the-fragment.
        let url = DashboardRouteCodec.url(base: dashboardURL, route: projectRoute)
        #expect(url.scheme == "http")
        #expect(url.host == "127.0.0.1")
        #expect(url.port == 3867)
        #expect(url.path == "/dashboard")
        #expect(url.query == nil, "a route in the query string would be sent to the daemon")
        #expect(url.fragment != nil)
        #expect(url.absoluteString.hasPrefix("http://127.0.0.1:3867/dashboard#route="))
    }

    @Test func noRouteURLCarriesTheDaemonToken() {
        // TRIPWIRE deeplink-token-not-in-url. Every level, including ones
        // whose own fields are long and opaque — nothing about a route may
        // ever look like a place to put a credential.
        let token = "placeholder-session-token-value"
        let routes: [DashboardRoute] = [
            .overview,
            projectRoute,
            DashboardRoute(
                level: .activity,
                projectKey: "/placeholder/projects/alpha",
                pick: "claude-opus-5",
                pickLabel: "Opus 5"
            ),
            DashboardRoute(
                level: .session,
                projectKey: "/placeholder/projects/alpha",
                sessionKey: "placeholder-lane-session",
                sessionTitle: "Lane"
            ),
            DashboardRoute(level: .detail, detail: "model-effort"),
        ]
        for route in routes {
            let url = DashboardRouteCodec.url(base: dashboardURL, route: route)
            let text = url.absoluteString
            #expect(!text.contains(token))
            #expect(!text.lowercased().contains(DashboardWindowAuth.headerField))
            #expect(!text.contains(DashboardWindowAuth.cookieName))
            #expect(url.query == nil)
        }
    }

    @Test func theWireShapeIsTheBundlesOwnRouteVocabulary() {
        // TRIPWIRE deeplink-wire-shape. Held on the JSON itself, because the
        // parser on the other side is JavaScript and shares no type with us.
        let route = DashboardRoute(
            level: .session,
            projectKey: "/placeholder/projects/alpha",
            projectName: "alpha",
            pick: "claude-opus-5",
            pickLabel: "Opus 5",
            sessionKey: "placeholder-lane-session",
            sessionTitle: "Lane",
            detail: "sessions",
            selection: DashboardRoute.Selection(from: "2026-08-01", to: "2026-08-07"),
            rangeKey: "7d",
            scope: ""
        )
        let json = DashboardRouteCodec.json(route)
        #expect(json == """
        {"detail":"sessions","level":"session","pick":"claude-opus-5",\
        "pickLabel":"Opus 5","projectKey":"/placeholder/projects/alpha",\
        "projectName":"alpha","rangeKey":"7d","scope":"",\
        "selection":{"from":"2026-08-01","to":"2026-08-07"},\
        "sessionKey":"placeholder-lane-session","sessionTitle":"Lane"}
        """)
    }

    @Test func theFragmentBytesArePinnedOnBothSidesOfTheContract() {
        // The SAME literal is asserted in test/dashboard-deeplink.test.mjs,
        // where it is parsed by the bundle. Two halves of one contract with
        // no shared type: pinning the bytes is what makes them one thing.
        #expect(DashboardRouteCodec.fragment(for: projectRoute) == """
        route=%7B%22level%22%3A%22project%22%2C%22projectKey%22%3A%22%2Fplaceholder\
        %2Fprojects%2Falpha%22%2C%22projectName%22%3A%22alpha%22%2C%22rangeKey%22\
        %3A%2230d%22%2C%22scope%22%3A%22codex%22%7D
        """)
    }

    @Test func absentFieldsAreOmittedRatherThanSentAsNull() {
        // The bundle reads a missing key and an explicit null the same way,
        // but an overview route that spells out nine nulls is a fragment
        // four times the size it needs to be.
        let json = DashboardRouteCodec.json(DashboardRoute(level: .overview))
        #expect(json == #"{"level":"overview"}"#)
    }

    @Test func aRouteSurvivesTheRoundTrip() {
        let json = DashboardRouteCodec.json(projectRoute)
        #expect(json != nil)
        #expect(DashboardRouteCodec.route(fromJSON: json!) == projectRoute)
    }

    @Test func theFragmentIsOpaqueToAnythingThatReadsAURL() {
        // Percent-encoding to the unreserved set: no braces, quotes, commas
        // or slashes survive, so nothing downstream can mistake a piece of
        // the route for URL structure.
        let fragment = DashboardRouteCodec.fragment(for: projectRoute)
        #expect(fragment != nil)
        for character in ["{", "}", "\"", ",", "/", ":"] {
            #expect(!fragment!.dropFirst("route=".count).contains(character))
        }
    }

    @Test func garbageNeverDecodesIntoARoute() {
        for text in ["", "not json", "[]", "null", "42", #"{"level":"nowhere"}"#] {
            #expect(DashboardRouteCodec.route(fromJSON: text) == nil, "decoded \(text)")
        }
    }

    @Test func aLevelWithoutTheKeysItsPageReadsIsNotALevel() {
        // Both ends reject the same incoherent routes: a project drill with
        // no project would render a page about nothing.
        #expect(!DashboardRoute(level: .project).isCoherent)
        #expect(!DashboardRoute(level: .project, projectKey: "").isCoherent)
        #expect(!DashboardRoute(level: .activity, projectKey: "alpha").isCoherent)
        #expect(!DashboardRoute(level: .session, projectKey: "alpha").isCoherent)
        #expect(DashboardRoute(level: .overview).isCoherent)
        #expect(DashboardRoute(level: .detail).isCoherent)
        #expect(DashboardRoute(level: .project, projectKey: "alpha").isCoherent)
        #expect(DashboardRoute(level: .activity, projectKey: "a", pick: "p").isCoherent)
        #expect(DashboardRoute(level: .session, projectKey: "a", sessionKey: "s").isCoherent)
    }

    @Test func anIncoherentRouteIsNeverPutOnAURL() {
        let url = DashboardRouteCodec.url(
            base: dashboardURL,
            route: DashboardRoute(level: .project)
        )
        #expect(url == dashboardURL)
    }
}

@Suite("Dashboard route restore (issue #424)")
struct Issue424RouteStoreTests {
    @Test func relaunchReopensWhereTheReaderWas() {
        let defaults = throwawayDefaults()
        DashboardRouteStore(defaults: defaults).record(projectRoute)
        // A fresh store is what a relaunch actually builds. The restored
        // route carries the IDENTIFIERS only — labels are re-derived by the
        // dashboard (PR #429 review, below).
        var expected = projectRoute
        expected.projectName = nil
        #expect(DashboardRouteStore(defaults: defaults).restored() == expected)
    }

    // PR #429 review (CWE-359): display labels can carry prompt-derived text
    // (session titles) and UserDefaults is a plist on disk — only identifiers
    // are ever persisted.
    @Test func persistedRoutesCarryNoDisplayLabels() {
        let defaults = throwawayDefaults()
        DashboardRouteStore(defaults: defaults).record(DashboardRoute(
            level: .session,
            projectKey: "/placeholder/projects/alpha",
            projectName: "alpha",
            sessionKey: "session-fixture-key",
            sessionTitle: "a prompt-derived title that must never land in a plist"
        ))
        let stored = defaults.string(forKey: DashboardRouteStore.defaultsKey) ?? ""
        #expect(!stored.isEmpty)
        #expect(!stored.contains("prompt-derived"))
        #expect(!stored.contains("projectName"))
        #expect(!stored.contains("sessionTitle"))
        let restored = DashboardRouteStore(defaults: defaults).restored()
        #expect(restored.sessionKey == "session-fixture-key")
        #expect(restored.sessionTitle == nil)
    }

    @Test func aFreshInstallOpensOnTheLanding() {
        #expect(DashboardRouteStore(defaults: throwawayDefaults()).restored() == .overview)
    }

    // PR #429 round 2: an overview route carrying filters is still overview.
    @Test func overviewWithFiltersClearsTheStoreToo() {
        let defaults = throwawayDefaults()
        let store = DashboardRouteStore(defaults: defaults)
        store.record(projectRoute)
        store.record(DashboardRoute(level: .overview, rangeKey: "7d", scope: "codex"))
        #expect(defaults.string(forKey: DashboardRouteStore.defaultsKey) == nil)
        #expect(store.restored() == .overview)
    }

    // PR #429 round 2: the Swift side rejects invalid dimensions like the
    // bundle does — neither sendable nor restorable.
    @Test func anInvalidDimensionIsIncoherent() {
        var route = projectRoute
        route.dimension = "bogus"
        #expect(!route.isCoherent)
        route.dimension = "model"
        #expect(route.isCoherent)
        let defaults = throwawayDefaults()
        let store = DashboardRouteStore(defaults: defaults)
        var bad = projectRoute
        bad.dimension = "bogus"
        store.record(bad)
        #expect(store.restored() == .overview)
    }

    @Test func navigatingHomeClearsTheStoredPositionRatherThanStoringADefault() {
        let defaults = throwawayDefaults()
        let store = DashboardRouteStore(defaults: defaults)
        store.record(projectRoute)
        store.record(.overview)
        #expect(defaults.string(forKey: DashboardRouteStore.defaultsKey) == nil)
        #expect(store.restored() == .overview)
    }

    @Test func aStoredValueThatNoLongerDecodesIsNotAPositionToReturnTo() {
        let defaults = throwawayDefaults()
        defaults.set("{ not a route", forKey: DashboardRouteStore.defaultsKey)
        #expect(DashboardRouteStore(defaults: defaults).restored() == .overview)
        // An incoherent one too — a drill naming no project renders nothing.
        defaults.set(#"{"level":"project"}"#, forKey: DashboardRouteStore.defaultsKey)
        #expect(DashboardRouteStore(defaults: defaults).restored() == .overview)
    }

    @Test func anIncoherentRouteIsNeverRecorded() {
        let defaults = throwawayDefaults()
        let store = DashboardRouteStore(defaults: defaults)
        store.record(projectRoute)
        store.record(DashboardRoute(level: .session, projectKey: "alpha"))
        #expect(store.restored() == .overview)
    }

    @Test func persistenceCanBeTurnedOffOutright() {
        let store = DashboardRouteStore(defaults: nil)
        store.record(projectRoute)
        #expect(store.restored() == .overview)
    }
}

@Suite("Dashboard jump points (issue #424)")
struct Issue424JumpPointTests {
    @Test func theDecksAnalyticsEntryReopensWhereTheReaderLeftOff() {
        // The deck's ONE existing entry ("Usage Analytics…", wired from the
        // popover and from the floating deck) carries no scope of its own,
        // so the honest landing is the last recorded position.
        #expect(DashboardRoute.landing(for: .usageAnalytics, restored: projectRoute)
                == projectRoute)
    }

    @Test func aJumpPointNeverLandsOnAPositionThatDoesNotCohere() {
        #expect(DashboardRoute.landing(
            for: .usageAnalytics,
            restored: DashboardRoute(level: .activity, projectKey: "alpha")
        ) == .overview)
    }

    @Test func everyJumpPointResolvesToACoherentLanding() {
        // A case added later without a landing rule must not compile into a
        // silently broken entry.
        for jumpPoint in DashboardJumpPoint.allCases {
            #expect(DashboardRoute.landing(for: jumpPoint, restored: .overview).isCoherent)
            #expect(DashboardRoute.landing(for: jumpPoint, restored: projectRoute).isCoherent)
        }
    }
}

@MainActor
@Suite("Dashboard window routing (issue #424)")
struct Issue424WindowRoutingTests {
    private func liveModel(route: DashboardRoute = .overview) -> DashboardWindowModel {
        let model = DashboardWindowModel(dashboardURL: dashboardURL, route: route)
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        return model
    }

    @Test func aRestoredWindowLoadsTheRestoredPositionDirectly() {
        // Not "load the overview, then navigate": the first load already
        // carries the fragment, so the reader never sees the wrong page.
        let model = liveModel(route: projectRoute)
        #expect(model.phase == .live(DashboardRouteCodec.url(base: dashboardURL, route: projectRoute)))
        #expect(model.loadGeneration == 1)
    }

    @Test func aJumpPointToANewPositionReloadsAtItsFragment() {
        let model = liveModel()
        model.open(projectRoute)
        #expect(model.route == projectRoute)
        #expect(model.phase == .live(DashboardRouteCodec.url(base: dashboardURL, route: projectRoute)))
        #expect(model.loadGeneration == 2, "the bundle's parser only runs on a load")
    }

    @Test func reInvokingTheSameEntryFrontsWithoutThrowingThePageAway() {
        let model = liveModel(route: projectRoute)
        let generation = model.loadGeneration
        model.open(projectRoute)
        model.open(projectRoute)
        #expect(model.loadGeneration == generation)
    }

    @Test func anIncoherentRequestFallsBackToTheLanding() {
        let model = liveModel(route: projectRoute)
        model.open(DashboardRoute(level: .project))
        #expect(model.route == .overview)
    }

    @Test func aWindowOpenedWithTheDaemonDownStillRemembersWhereItIsPointed() {
        let model = DashboardWindowModel(dashboardURL: dashboardURL, route: .overview)
        model.open(projectRoute)
        #expect(model.route == projectRoute)
        #expect(model.loadGeneration == 0, "nothing to reload — there is no page yet")
        model.apply(connection: .connected, setupPhase: .quiet, bundledServiceAvailable: true)
        #expect(model.phase == .live(DashboardRouteCodec.url(base: dashboardURL, route: projectRoute)))
    }

    @Test func theBundleReportingItsPositionRecordsItWithoutReloading() {
        let model = liveModel()
        var recorded: [DashboardRoute] = []
        model.onRouteChanged = { recorded.append($0) }
        let generation = model.loadGeneration

        model.noteReportedRoute(json: DashboardRouteCodec.json(projectRoute)!)
        #expect(model.route == projectRoute)
        #expect(recorded == [projectRoute])
        // The page is already showing it — reloading would be the Swift side
        // navigating, which is the one thing it must never do.
        #expect(model.loadGeneration == generation)
    }

    @Test func anUntrustworthyReportIsIgnoredRatherThanStored() {
        let model = liveModel(route: projectRoute)
        var recorded: [DashboardRoute] = []
        model.onRouteChanged = { recorded.append($0) }
        for text in ["", "not json", "[]", #"{"level":"nowhere"}"#, #"{"level":"session"}"#] {
            model.noteReportedRoute(json: text)
        }
        #expect(model.route == projectRoute)
        #expect(recorded.isEmpty)
    }

    @Test func everyPositionChangeIsOfferedToTheStoreExactlyOnce() {
        let model = liveModel()
        var recorded: [DashboardRoute] = []
        model.onRouteChanged = { recorded.append($0) }
        model.open(projectRoute)
        model.open(projectRoute)
        model.noteReportedRoute(json: DashboardRouteCodec.json(projectRoute)!)
        model.noteReportedRoute(json: DashboardRouteCodec.json(.overview)!)
        #expect(recorded == [projectRoute, .overview])
    }
}

@Suite("Dashboard window auth (issue #424, #402(d))")
struct Issue424WindowAuthTests {
    @Test func theWindowPresentsTheTokenTheWayTheDaemonAsksForIt() {
        // src/server.mjs `mutationAllowed` requires BOTH, and the app's own
        // API calls already send both (DaemonClient.authorizedRequest).
        #expect(DashboardWindowAuth.headerField == "x-modeldeck-token")
        #expect(DashboardWindowAuth.cookieName == "modeldeck_session")
    }

    @Test func theCookieIsScopedToTheLoopbackDaemonAndNothingElse() {
        let cookie = DashboardWindowAuth.sessionCookie(
            token: "placeholder-token",
            dashboardURL: dashboardURL
        )
        #expect(cookie?.domain == "127.0.0.1")
        #expect(cookie?.path == "/")
        #expect(cookie?.name == "modeldeck_session")
    }

    @Test func theCookieNeverOutlivesTheProcessAndIsNeverReadableFromThePage() {
        // Session-only keeps the token out of WebKit's on-disk cookie jar;
        // strict keeps it off any cross-site request; HTTP-only keeps it out
        // of `document.cookie`. Losing any one of the three is a one-word
        // edit, which is why they are asserted rather than assumed.
        let cookie = DashboardWindowAuth.sessionCookie(
            token: "placeholder-token",
            dashboardURL: dashboardURL
        )
        #expect(cookie?.isSessionOnly == true)
        #expect(cookie?.isSameSiteStrict == true)
        #expect(cookie?.isHTTPOnly == true)

        let bag = cookie!.properties
        #expect(bag[.expires] == nil, "any expiry writes the token to disk")
        #expect(bag[.sameSitePolicy] as? HTTPCookieStringPolicy == .sameSiteStrict)
        #expect(bag[HTTPCookiePropertyKey("HttpOnly")] as? String == "TRUE")
        // And it is a cookie WebKit will actually take.
        #expect(HTTPCookie(properties: bag) != nil)
    }

    @Test func theCookieIsEncodedTheWayTheServerDecodesIt() {
        // The server reads it back through decodeURIComponent; two different
        // encodings of one cookie only diverge on a token that happens to
        // contain a reserved character, which is the worst kind of bug.
        let token = "abc+/=xyz~-_."
        #expect(DashboardWindowAuth.cookieEncoded(token) == DaemonClient.cookieEncoded(token))
        let cookie = DashboardWindowAuth.sessionCookie(token: token, dashboardURL: dashboardURL)
        #expect(cookie?.value == DaemonClient.cookieEncoded(token))
    }

    @Test func thereIsNoCookieWithoutAHostToScopeItTo() {
        #expect(DashboardWindowAuth.sessionCookie(
            token: "placeholder-token",
            dashboardURL: URL(string: "file:///tmp/dashboard")!
        ) == nil)
        #expect(DashboardWindowAuth.sessionCookie(token: "", dashboardURL: dashboardURL) == nil)
    }
}
