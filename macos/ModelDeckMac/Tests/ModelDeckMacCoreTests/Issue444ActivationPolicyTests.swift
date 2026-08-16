import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #444 — TRIPWIRE dashboard-activation-policy-flip.
//
// The hybrid: ModelDeck stays a menu-bar agent (.accessory) until the
// dashboard window opens, runs .regular while it is open (Dock icon,
// standard app menu, Cmd-Tab), and returns to .accessory when the last one
// closes. Two ways this regresses, and the tripwire catches both:
//
//   - ALWAYS-ACCESSORY — the flip is dropped or never reaches the window's
//     lifecycle, and the full-size window has no app menu again (the 1.0
//     field report).
//   - STUCK-REGULAR — the down-flip is lost, and ModelDeck keeps a Dock icon
//     and a Cmd-Tab slot with no window open, which is the agent design
//     repealed by accident.
//
// Two halves, because either alone is escapable: the BEHAVIOURAL half drives
// the pure control through both directions; the STATIC half asserts the
// dashboard window's lifecycle still calls both of them, so a future edit
// that deletes the wiring trips even though the pure type is untouched.

/// Stand-ins for the AppKit windows the app registers by identity. Nothing
/// here touches NSWindow: the control only ever sees an ObjectIdentifier.
private final class StandInWindow {}

@Suite("Issue #444 — TRIPWIRE dashboard-activation-policy-flip")
struct Issue444ActivationPolicyTests {

    // MARK: - Behavioural half

    @Test("window open flips to regular; last close flips back to accessory")
    func flipsBothDirections() {
        var control = AppActivationPolicyControl()
        // Launch state is the bundle's LSUIElement posture.
        #expect(control.policy == .accessory)

        let window = StandInWindow()
        let opened = control.windowOpened(ObjectIdentifier(window))
        #expect(
            opened == .regular,
            """
            TRIPWIRE dashboard-activation-policy-flip: opening the dashboard window no \
            longer asks for .regular — the window is back to having no app menu.
            """
        )
        #expect(control.policy == .regular)

        let closed = control.windowClosed(ObjectIdentifier(window))
        #expect(
            closed == .accessory,
            """
            TRIPWIRE dashboard-activation-policy-flip: closing the last window no longer \
            asks for .accessory — ModelDeck would keep a Dock icon with no window open.
            """
        )
        #expect(control.policy == .accessory)
        #expect(control.openWindowCount == 0)
    }

    @Test("re-fronting the same window issues no second flip")
    func reopeningTheSameWindowIsNoChange() {
        var control = AppActivationPolicyControl()
        let window = StandInWindow()
        #expect(control.windowOpened(ObjectIdentifier(window)) == .regular)
        // The one-window rule fronts the existing window; re-issuing
        // setActivationPolicy there would churn activation for nothing.
        #expect(control.windowOpened(ObjectIdentifier(window)) == nil)
        #expect(control.policy == .regular)
        #expect(control.openWindowCount == 1)
    }

    @Test("only the LAST window's close drops back to accessory")
    func earlierClosesHoldRegular() {
        var control = AppActivationPolicyControl()
        let first = StandInWindow()
        let second = StandInWindow()
        #expect(control.windowOpened(ObjectIdentifier(first)) == .regular)
        #expect(control.windowOpened(ObjectIdentifier(second)) == nil)
        #expect(control.windowClosed(ObjectIdentifier(first)) == nil)
        #expect(control.policy == .regular)
        #expect(control.windowClosed(ObjectIdentifier(second)) == .accessory)
        #expect(control.policy == .accessory)
    }

    @Test("a close nobody registered changes nothing")
    func unregisteredCloseIsIgnored() {
        var control = AppActivationPolicyControl()
        let window = StandInWindow()
        let stranger = StandInWindow()
        #expect(control.windowOpened(ObjectIdentifier(window)) == .regular)
        // The deck popover, the floating deck and Settings are deliberately
        // unregistered — their closes must never drop the policy.
        #expect(control.windowClosed(ObjectIdentifier(stranger)) == nil)
        #expect(control.policy == .regular)
        // A second close of an already-closed window is equally inert.
        #expect(control.windowClosed(ObjectIdentifier(window)) == .accessory)
        #expect(control.windowClosed(ObjectIdentifier(window)) == nil)
        #expect(control.policy == .accessory)
    }

    // MARK: - Static half

    @Test("the dashboard window's lifecycle still drives both directions")
    func dashboardWindowWiresBothDirections() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // .../Tests/ModelDeckMacCoreTests
            .deletingLastPathComponent()   // .../Tests
            .deletingLastPathComponent()   // .../ModelDeckMac (package root)
            .appendingPathComponent("Sources/ModelDeckMac/DashboardWindow.swift")
        let text = try String(contentsOf: source, encoding: .utf8)

        #expect(
            text.contains("activationPolicy.windowOpened("),
            """
            TRIPWIRE dashboard-activation-policy-flip: DashboardWindow.swift no longer \
            registers the window on open. The control can be perfect and the app still \
            never flips to .regular.
            """
        )
        #expect(
            text.contains("activationPolicy.windowClosed("),
            """
            TRIPWIRE dashboard-activation-policy-flip: DashboardWindow.swift no longer \
            unregisters the window on close. The app would stay .regular — Dock icon and \
            Cmd-Tab slot with no window open.
            """
        )
        for policy in ["NSApp.setActivationPolicy(.regular)", "NSApp.setActivationPolicy(.accessory)"] {
            #expect(
                text.contains(policy),
                """
                TRIPWIRE dashboard-activation-policy-flip: DashboardWindow.swift no longer \
                applies \(policy), so the control's decision reaches nothing.
                """
            )
        }
    }
}
