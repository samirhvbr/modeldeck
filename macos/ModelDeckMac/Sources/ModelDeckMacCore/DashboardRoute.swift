import Foundation

// Issue #424 (1.0 build F) — the window as a navigation target (#402(b)(d)).
//
// ONE NAVIGATION SYSTEM. The dashboard's drill position has been a
// serialisable route object since #386/#393 (dashboard/src/App.jsx useRoute).
// Swift does not navigate: it writes one of those objects into the URL
// fragment and the bundle's own parser (dashboard/src/route.js) lands on it.
// Everything in this file is therefore a CODEC and a STORE — there is no
// Swift-side notion of "go up a level", and there must never be one.
//
// THE FRAGMENT, NEVER THE QUERY. A fragment is not sent to the server, so a
// route can never reach a request log, and the daemon's /dashboard handler
// stays the static byte-for-byte page it is today.
//
// THE TOKEN NEVER RIDES THE URL. It travels exactly the way the daemon
// already requires it of every other client (src/server.mjs mutationAllowed):
// the `x-modeldeck-token` header plus the `modeldeck_session` cookie. See
// DashboardWindowAuth at the bottom of this file.

/// A position in the dashboard, in the bundle's own vocabulary. The property
/// names ARE the JSON keys the bundle reads — renaming one here silently
/// breaks the deep link, which is why the wire shape has its own tests.
public struct DashboardRoute: Equatable, Sendable, Codable {
    /// The levels the bundle renders. A level absent from this list is not a
    /// page, and the bundle rejects it rather than rendering a blank drill.
    public enum Level: String, Sendable, Codable, CaseIterable {
        case overview
        case project
        case activity
        case session
        case detail
    }

    /// The chart's time selection — the one filter that is positional (#371),
    /// so it rides the route instead of staying App state.
    public struct Selection: Equatable, Sendable, Codable {
        public var from: String
        public var to: String

        public init(from: String, to: String) {
            self.from = from
            self.to = to
        }
    }

    public var level: Level
    public var projectKey: String?
    /// The project breakdown dimension (activity | model | skill) — part of
    /// the drill position (PR #429 review); the bundle validates the value.
    public var dimension: String?
    public var projectName: String?
    public var pick: String?
    public var pickLabel: String?
    public var sessionKey: String?
    public var sessionTitle: String?
    public var detail: String?
    public var selection: Selection?
    /// Range and provider scope are App state, not route state — but a route
    /// is nothing but keys, and keys name nothing under a different range
    /// (#393's stale-route lesson). So an arriving route carries the filters
    /// it was made under, and the bundle applies them before it lands.
    public var rangeKey: String?
    public var scope: String?

    public init(
        level: Level,
        projectKey: String? = nil,
        dimension: String? = nil,
        projectName: String? = nil,
        pick: String? = nil,
        pickLabel: String? = nil,
        sessionKey: String? = nil,
        sessionTitle: String? = nil,
        detail: String? = nil,
        selection: Selection? = nil,
        rangeKey: String? = nil,
        scope: String? = nil
    ) {
        self.level = level
        self.projectKey = projectKey
        self.dimension = dimension
        self.projectName = projectName
        self.pick = pick
        self.pickLabel = pickLabel
        self.sessionKey = sessionKey
        self.sessionTitle = sessionTitle
        self.detail = detail
        self.selection = selection
        self.rangeKey = rangeKey
        self.scope = scope
    }

    /// The landing. What every jump point falls back to.
    public static let overview = DashboardRoute(level: .overview)

    /// The keys each level's page actually reads. Held here as well as in the
    /// bundle deliberately: both ends reject the same incoherent routes, so a
    /// route this side would refuse to send is also one the bundle would
    /// refuse to land on.
    /// The bundle's PROJECT_DIMENSIONS whitelist, mirrored (PR #429 round 2):
    /// both ends reject the same values, so an invalid dimension can neither
    /// be sent nor restored.
    public static let projectDimensions: Set<String> = ["activity", "model", "skill"]

    public var isCoherent: Bool {
        func present(_ value: String?) -> Bool {
            guard let value else { return false }
            return !value.isEmpty
        }
        if let dimension, !Self.projectDimensions.contains(dimension) { return false }
        switch level {
        case .overview, .detail:
            return true
        case .project:
            return present(projectKey)
        case .activity:
            return present(projectKey) && present(pick)
        case .session:
            return present(projectKey) && present(sessionKey)
        }
    }
}

/// Every place in the app that opens the dashboard window (issue #424).
///
/// Deliberately an enum rather than a route argument at each call site: the
/// acceptance criterion is that every entry lands on the RIGHT position, and
/// that is a decision worth having in one testable place. Today the deck has
/// exactly one such entry — the gear menu's "Usage Analytics…", wired from
/// both the popover and the floating deck (#295). Adding a scoped entry later
/// is a case here plus its landing rule; it is NOT a second navigator.
public enum DashboardJumpPoint: Equatable, Sendable, CaseIterable {
    /// Gear menu → "Usage Analytics…". Carries no scope of its own, so the
    /// honest landing is where the reader last was.
    case usageAnalytics
}

extension DashboardRoute {
    /// Which position a jump point opens on, given the last recorded one.
    ///
    /// An entry with no scope in hand must not invent one — it reopens where
    /// the reader left off, which is also what makes relaunch restore work
    /// through the same single path rather than a parallel one. A stored
    /// route that no longer coheres is not a position, and lands on the
    /// overview.
    public static func landing(
        for jumpPoint: DashboardJumpPoint,
        restored: DashboardRoute
    ) -> DashboardRoute {
        switch jumpPoint {
        case .usageAnalytics:
            return restored.isCoherent ? restored : .overview
        }
    }
}

/// Route ⇄ URL fragment. The single place either direction is spelled.
public enum DashboardRouteCodec {
    /// The fragment parameter name, matched by `ROUTE_PARAM` in
    /// dashboard/src/route.js.
    public static let parameter = "route"

    /// The `WKScriptMessageHandler` name the bundle posts its position to,
    /// matched by `BRIDGE` in dashboard/src/route.js. One-way: the bundle
    /// tells the host where the reader went, the host tells nobody anything.
    public static let bridgeName = "modeldeckRoute"

    /// Only RFC 3986 unreserved characters survive unescaped, so the JSON's
    /// braces, quotes and commas are all percent-encoded — the fragment is
    /// one opaque token to anything that reads a URL.
    private static let unreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Deterministic so the fragment is a testable contract rather than
    /// whatever key order the encoder felt like today.
    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    /// The route as JSON — also the shape the bundle posts back.
    public static func json(_ route: DashboardRoute) -> String? {
        guard let data = try? encoder.encode(route) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func route(fromJSON json: String) -> DashboardRoute? {
        guard let data = json.data(using: .utf8),
              let route = try? JSONDecoder().decode(DashboardRoute.self, from: data),
              route.isCoherent
        else { return nil }
        return route
    }

    /// `route=<percent-encoded JSON>`, or nil for the landing — a deep link
    /// to the overview is just the dashboard, and an empty fragment keeps the
    /// address bar honest.
    public static func fragment(for route: DashboardRoute) -> String? {
        guard route != .overview, route.isCoherent else { return nil }
        guard let json = json(route),
              let encoded = json.addingPercentEncoding(withAllowedCharacters: unreserved)
        else { return nil }
        return "\(parameter)=\(encoded)"
    }

    /// The URL the web view loads: the daemon's own `/dashboard`, with the
    /// route hanging off the fragment. The base is never rewritten — no query
    /// item, no extra path component, and above all no token.
    public static func url(base dashboardURL: URL, route: DashboardRoute) -> URL {
        guard let fragment = fragment(for: route),
              var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false)
        else { return dashboardURL }
        // `fragment` is already percent-encoded; assigning the encoded form
        // stops URLComponents from double-escaping the `%` signs.
        components.percentEncodedFragment = fragment
        return components.url ?? dashboardURL
    }
}

/// Where the window last was, so a relaunch reopens it there (#402(c)).
///
/// Storage is the repo's usual injected `UserDefaults` (the FloatingDeckModel
/// pattern) — a route is a position, not a credential, and nothing in it is
/// secret. A stored value that no longer decodes, or names a level whose keys
/// are missing, is not a position to return to: it reads as the landing.
public final class DashboardRouteStore {
    public static let defaultsKey = "modeldeck.dashboard.route"

    private let defaults: UserDefaults?

    /// `nil` disables persistence outright — the seam tests use so a suite
    /// never writes to a real defaults domain.
    public init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
    }

    /// The route to open on, given nothing else to go on.
    public func restored() -> DashboardRoute {
        guard let json = defaults?.string(forKey: Self.defaultsKey),
              let route = DashboardRouteCodec.route(fromJSON: json)
        else { return .overview }
        return route
    }

    /// Record where the reader now is. The overview clears the key rather
    /// than storing a default, so a fresh install and a reader who navigated
    /// home are the same state.
    public func record(_ route: DashboardRoute) {
        guard let defaults else { return }
        // Identifiers only (PR #429 review, CWE-359): display labels —
        // projectName, pickLabel, sessionTitle — can carry prompt-derived
        // text, and UserDefaults is a plist on disk. The dashboard re-derives
        // every label from its own data; a restore needs only the keys.
        var stored = route
        stored.projectName = nil
        stored.pickLabel = nil
        stored.sessionTitle = nil
        // The LEVEL decides (PR #429 round 2): an overview route carrying a
        // rangeKey or scope is not == .overview, but it is still the landing —
        // persisting it would reopen overview with stale state.
        guard route.level != .overview, stored.isCoherent, let json = DashboardRouteCodec.json(stored) else {
            defaults.removeObject(forKey: Self.defaultsKey)
            return
        }
        defaults.set(json, forKey: Self.defaultsKey)
    }
}

/// Issue #424 (#402(d)) — how the window authenticates to the daemon.
///
/// The daemon's `mutationAllowed` (src/server.mjs) requires the SAME token in
/// two places on every non-GET request: the `x-modeldeck-token` header and the
/// `modeldeck_session` cookie. The app already does exactly this for its own
/// API calls (DaemonClient.authorizedRequest); the window does it too, so
/// there is ONE auth story rather than a window that is special.
///
/// WHY BOTH, FOR A WEB VIEW. WKWebView can only carry custom headers on the
/// top-level navigation request it is handed — subresource loads and the
/// page's own `fetch` calls get none. The cookie is what covers those, and it
/// is a SESSION cookie (no expiry), so WebKit holds it in memory and never
/// writes the token into the on-disk cookie jar.
///
/// WHY NOT THE URL. A token in a query string or fragment would land in the
/// web view's back/forward list, in anything that ever bookmarks or logs the
/// URL, and in the `Referer` of any future off-page request. Nothing here
/// ever puts it there, and `DashboardRouteCodec` has a test saying so.
public enum DashboardWindowAuth {
    /// Matched by `req.headers['x-modeldeck-token']` in src/server.mjs.
    public static let headerField = "x-modeldeck-token"

    /// Matched by `cookies.modeldeck_session` in src/server.mjs.
    public static let cookieName = "modeldeck_session"

    /// The cookie the window presents, described without AppKit so the shape
    /// is testable. The app target turns this into an `HTTPCookie`.
    public struct SessionCookie: Equatable, Sendable {
        public var name: String
        public var value: String
        public var domain: String
        public var path: String
        /// No expiry: memory-only in WebKit, gone when the app quits.
        public var isSessionOnly: Bool
        /// The page is same-origin loopback; a cross-site request has no
        /// business carrying this.
        public var isSameSiteStrict: Bool
        /// The bundle never reads `document.cookie`, and nothing should.
        public var isHTTPOnly: Bool
    }

    /// Percent-encode the way `decodeURIComponent` on the server decodes it —
    /// the same rule DaemonClient.cookieEncoded uses, kept identical on
    /// purpose: two encodings of one cookie is a bug that only shows up on
    /// tokens containing a reserved character.
    public static func cookieEncoded(_ value: String) -> String {
        let unreserved = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    /// The cookie for a token on the daemon `dashboardURL` points at.
    /// Returns nil when the URL has no host to scope the cookie to — a
    /// hostless cookie would be offered to everything.
    public static func sessionCookie(token: String, dashboardURL: URL) -> SessionCookie? {
        guard let host = dashboardURL.host, !token.isEmpty else { return nil }
        return SessionCookie(
            name: cookieName,
            value: cookieEncoded(token),
            domain: host,
            path: "/",
            isSessionOnly: true,
            isSameSiteStrict: true,
            isHTTPOnly: true
        )
    }
}

extension DashboardWindowAuth.SessionCookie {
    /// The `HTTPCookie` property bag WebKit's cookie store takes. Kept beside
    /// the struct so the flags that make this safe — session-only, strict,
    /// HTTP-only — cannot be dropped in the app target without the test here
    /// noticing.
    public var properties: [HTTPCookiePropertyKey: Any] {
        var bag: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
        ]
        // Any expiry at all would put the token in WebKit's on-disk cookie
        // jar; a session cookie lives in memory and dies with the process.
        if !isSessionOnly { bag[.expires] = Date.distantFuture }
        if isSameSiteStrict { bag[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict }
        // Not a documented HTTPCookie key, but WebKit honours it and it is
        // the difference between a token the page's JS can read and one it
        // cannot. Ignored where unsupported — belt, not the only brace.
        if isHTTPOnly { bag[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        return bag
    }
}
