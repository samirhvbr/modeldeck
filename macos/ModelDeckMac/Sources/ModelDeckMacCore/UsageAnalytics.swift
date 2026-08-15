import Foundation

/// Issue #343: the usage-analytics dashboard entry point. The daemon serves
/// the page at `/dashboard` behind the `usageAnalyticsEnabled` kill switch;
/// the app's whole job is one flag-gated menu item that opens it. Strings
/// and URL derivation live here (in Core) so they are unit-testable and the
/// VoiceOver label is an explicit contract, not an accident of the title.
///
/// Issue #423 (charter d2, #402(a)(c)) retargeted the destination: the item
/// now opens ModelDeck's OWN window, whose WKWebView loads this same
/// loopback URL from the same daemon route — never a second serving
/// mechanism, and never the browser. The kill switch is unchanged: flag off,
/// no menu item, and the daemon still 404s the route.
public enum UsageAnalytics {
    /// Gear-menu item title (ellipsis: it opens a separate window).
    public static let menuItemTitle = "Usage Analytics…"

    /// Explicit VoiceOver label — names the destination and the side effect
    /// (a separate ModelDeck window), which the title alone doesn't carry.
    public static let menuItemAccessibilityLabel =
        "Open the usage analytics dashboard in a ModelDeck window"

    /// The dashboard URL on the daemon that `base` points at (loopback
    /// only — the daemon serves nothing off-machine).
    public static func dashboardURL(base: URL) -> URL {
        base.appendingPathComponent("dashboard")
    }
}
