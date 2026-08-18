import Foundation

/// Issue #59 — the menu bar icon's right-click (or ctrl-click) context menu:
/// the standard menu-bar-agent affordance for an app with no Dock icon and
/// no app menu. Pure derivation of the menu's contents so the AppKit
/// controller in the app target stays thin and this is unit-testable.
public enum MenuBarContextMenu {
    public enum Action: Equatable, Sendable {
        case about
        case checkForAppUpdates
        case quit
        /// Issue #482: flip a total display mode between its sum ("474%")
        /// and share-of-capacity ("68%") formats — the payload is the full
        /// stored `menuBarAccountId` value to write.
        case setMenuBarSetting(String)
    }

    public struct Item: Equatable, Sendable {
        public var title: String
        public var action: Action
        public var isEnabled: Bool

        public init(title: String, action: Action, isEnabled: Bool = true) {
            self.title = title
            self.action = action
            self.isEnabled = isEnabled
        }
    }

    /// The fixed menu: About ModelDeck (issue #425 — the standard About
    /// panel carries the bundled third-party credits, and a menu-bar-agent
    /// app with no app menu needs an explicit entry point to it), then
    /// Check for App Updates… (issue #59 scope addition — reachable without
    /// digging into the gear menu; disabled while a check is already in
    /// flight) above Quit ModelDeck. Update wording matches the gear menu
    /// exactly — same shared AppUpdateModel behind both.
    /// Issue #482: while a total display mode is active, the menu leads
    /// with the flip Tim asked for — "flip back and forth between 474% and
    /// 68%" — one click on the icon's right-click menu, no Settings trip.
    /// `menuBarSetting` is the stored `menuBarAccountId`; nil or any
    /// non-total value adds nothing.
    public static func items(
        isCheckingForUpdates: Bool,
        menuBarSetting: String? = nil
    ) -> [Item] {
        var items: [Item] = []
        if let stored = menuBarSetting,
           let provider = MenuBarPinResolver.totalProvider(stored) {
            let flipped: MenuBarPinResolver.TotalFormat =
                MenuBarPinResolver.totalFormat(stored) == .share ? .sum : .share
            items.append(Item(
                title: flipped == .share
                    ? "Show \(provider.displayName) Total as Share of Capacity"
                    : "Show \(provider.displayName) Total as Sum",
                action: .setMenuBarSetting(
                    MenuBarPinResolver.totalValue(provider: provider, format: flipped)
                )
            ))
        }
        items.append(contentsOf: [
            Item(title: "About ModelDeck", action: .about),
            Item(
                title: "Check for App Updates…",
                action: .checkForAppUpdates,
                isEnabled: !isCheckingForUpdates
            ),
            Item(title: "Quit ModelDeck", action: .quit),
        ])
        return items
    }

    /// Whether a mouse event on the status item should open the context
    /// menu: right-click, or ctrl-click (the standard secondary-click
    /// equivalent). A plain left click stays the popover toggle.
    public static func isContextMenuTrigger(isRightClick: Bool, isControlDown: Bool) -> Bool {
        isRightClick || isControlDown
    }
}
