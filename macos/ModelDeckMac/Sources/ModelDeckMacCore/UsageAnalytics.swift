import Foundation

/// Issue #343: the usage-analytics dashboard entry point. The daemon serves
/// the page at `/dashboard` behind the `usageAnalyticsEnabled` kill switch;
/// the app's whole job is one flag-gated menu item that opens the
/// URL in the default browser. Strings and URL derivation live here (in
/// Core) so they are unit-testable and the VoiceOver label is an explicit
/// contract, not an accident of the title.
public enum UsageAnalytics {
    /// Gear-menu item title (ellipsis: it leaves the popover for a browser).
    public static let menuItemTitle = "Usage Analytics…"

    /// Explicit VoiceOver label — names the destination and the side effect
    /// (opens the default browser), which the title alone doesn't carry.
    public static let menuItemAccessibilityLabel =
        "Open the usage analytics dashboard in your web browser"

    /// The dashboard URL on the daemon that `base` points at (loopback
    /// only — the daemon serves nothing off-machine).
    public static func dashboardURL(base: URL) -> URL {
        base.appendingPathComponent("dashboard")
    }
}
