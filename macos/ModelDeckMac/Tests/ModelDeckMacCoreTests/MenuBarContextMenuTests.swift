import Testing
@testable import ModelDeckMacCore

// Issue #59 — the menu bar icon's right-click context menu (standard
// menu-bar-agent affordance): Check for App Updates… + Quit ModelDeck.

@Suite("Menu bar context menu (issue #59)")
struct MenuBarContextMenuTests {
    // TRIPWIRE about-entry-point (issue #425): About ModelDeck is the ONLY
    // route to the standard About panel — and therefore to the bundled
    // Credits.rtf third-party notices — in an app with no app menu. If the
    // item disappears, the shipped MIT attributions become unreachable.
    @Test func menuCarriesAboutThenUpdateCheckThenQuit() {
        let items = MenuBarContextMenu.items(isCheckingForUpdates: false)
        #expect(items.map(\.action) == [.about, .checkForAppUpdates, .quit])
        // Update wording matches the gear menu exactly — same model behind both.
        #expect(items.map(\.title) == ["About ModelDeck", "Check for App Updates…", "Quit ModelDeck"])
        #expect(items.allSatisfy { $0.isEnabled })
    }

    @Test func updateItemDisablesWhileACheckIsInFlight() {
        let items = MenuBarContextMenu.items(isCheckingForUpdates: true)
        #expect(items.first { $0.action == .checkForAppUpdates }?.isEnabled == false)
        // Quit and About must never be gated on anything.
        #expect(items.first { $0.action == .quit }?.isEnabled == true)
        #expect(items.first { $0.action == .about }?.isEnabled == true)
    }

    @Test func rightClickAndCtrlClickTriggerTheMenu() {
        #expect(MenuBarContextMenu.isContextMenuTrigger(isRightClick: true, isControlDown: false))
        #expect(MenuBarContextMenu.isContextMenuTrigger(isRightClick: false, isControlDown: true))
        #expect(MenuBarContextMenu.isContextMenuTrigger(isRightClick: true, isControlDown: true))
    }

    @Test func plainLeftClickStaysThePopoverToggle() {
        #expect(!MenuBarContextMenu.isContextMenuTrigger(isRightClick: false, isControlDown: false))
    }
}
