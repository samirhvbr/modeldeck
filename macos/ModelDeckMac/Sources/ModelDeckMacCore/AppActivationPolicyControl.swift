import Foundation

// Issue #444 — the hybrid activation policy. ModelDeck is a menu-bar agent
// by recorded design (LSUIElement; design/mac-app-spec.md): no Dock icon, no
// app menu, the status item is the app's home. That is right for the deck
// popover and wrong for the full-size dashboard window (#423) — Tim's field
// report on 1.0: clicking that window leaves the top-left menu belonging to
// whatever app was frontmost, which reads as broken for a real window.
//
// The hybrid, NOT a repeal of the agent design: while a policy-holding
// window is open the app runs `.regular` (Dock icon, standard app menu,
// Cmd-Tab entry); when the last one closes it drops straight back to
// `.accessory` and the app is a menu-bar agent again. Nothing here touches
// the deck popover or the floating deck — those surfaces are unregistered
// and keep working identically under either policy.
//
// The decision lives here, pure, so BOTH directions are unit-tested
// (TRIPWIRE dashboard-activation-policy-flip): the app target only applies
// what this returns to `NSApp.setActivationPolicy`.

/// The two activation policies ModelDeck ever runs under.
public enum AppActivationPolicy: Equatable, Sendable {
    /// Menu-bar agent: no Dock icon, no app menu. The resting state.
    case accessory
    /// Ordinary app: Dock icon, app menu, Cmd-Tab. Held only while a
    /// registered window is open.
    case regular
}

/// Which policy the app should be in, given the windows that claim one.
///
/// Windows are identified by `ObjectIdentifier`, so registration is the
/// window's own identity — no counter to get out of step with reality.
/// Every mutation returns the policy to APPLY, or `nil` when nothing
/// changed: re-opening an already-registered window (fronting the one
/// dashboard window) must not re-issue `setActivationPolicy`, which churns
/// activation for no reason.
public struct AppActivationPolicyControl: Equatable, Sendable {
    /// The policy the app is in as far as this control is concerned. Starts
    /// `.accessory` — the bundle's LSUIElement launch state.
    public private(set) var policy: AppActivationPolicy = .accessory

    private var openWindows: Set<ObjectIdentifier> = []

    public init() {}

    /// How many registered windows are open.
    public var openWindowCount: Int { openWindows.count }

    /// A window that holds the regular policy appeared. The FIRST one flips
    /// to `.regular`; later ones (and re-registrations of the same window)
    /// change nothing.
    public mutating func windowOpened(_ window: ObjectIdentifier) -> AppActivationPolicy? {
        guard openWindows.insert(window).inserted else { return nil }
        return updatedPolicy()
    }

    /// A registered window closed. Only the LAST one drops back to
    /// `.accessory`; a window that was never registered (or already
    /// recorded closed) changes nothing.
    public mutating func windowClosed(_ window: ObjectIdentifier) -> AppActivationPolicy? {
        guard openWindows.remove(window) != nil else { return nil }
        return updatedPolicy()
    }

    private mutating func updatedPolicy() -> AppActivationPolicy? {
        let wanted: AppActivationPolicy = openWindows.isEmpty ? .accessory : .regular
        guard wanted != policy else { return nil }
        policy = wanted
        return wanted
    }
}
