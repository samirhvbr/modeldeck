import AppKit
import ModelDeckMacCore

/// Issue #59 — right-click (or ctrl-click) on the menu bar icon presents a
/// small context menu: Check for App Updates… and Quit ModelDeck. As a
/// menu-bar agent app the icon is ModelDeck's only persistent surface, so
/// it must carry the standard quit affordance.
///
/// `MenuBarExtra` offers no native hook for a secondary click, so a local
/// event monitor watches for right/ctrl-clicks landing in the status item's
/// window (the same StatusBar-window identification the issue #45
/// diagnostics use — those windows live in this process, so the monitor
/// sees the events) and swallows them in favor of an NSMenu. Plain left
/// clicks pass through untouched: the popover toggle is unaffected.
@MainActor
final class MenuBarContextMenuController: NSObject {
    private let appUpdateModel: AppUpdateModel
    /// Issue #121: "Update Now" from the context-menu result alert drives
    /// the same shared install model as the deck dialog and Settings.
    private let installModel: AppUpdateInstallModel
    private var monitor: Any?

    /// Issue #482/#488: the stored `menuBarAccountId` + `poolTotalFormat`
    /// feeding the flip item, and the write path back through the
    /// daemon-backed settings sync — the same shared-format write the
    /// Settings picker and the deck header's click use. All set after
    /// construction (the settings sync outlives this controller), and a nil
    /// either way simply renders no flip item.
    var menuBarSetting: (() -> String?)?
    var poolTotalFormat: (() -> String?)?
    var onSetTotalFormat: ((DeckProvider, MenuBarPinResolver.TotalFormat) -> Void)?

    init(appUpdateModel: AppUpdateModel, installModel: AppUpdateInstallModel) {
        self.appUpdateModel = appUpdateModel
        self.installModel = installModel
    }

    /// Installs the event monitor once; safe to call repeatedly. The
    /// controller lives for the app's lifetime, so the monitor is never
    /// removed.
    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.rightMouseDown, .leftMouseDown]
        ) { [weak self] event in
            // Local event monitors always fire on the main thread; Swift 6
            // treats the closure as nonisolated, so assert the hop. The
            // closure returns Bool because NSEvent is not Sendable.
            let handled = MainActor.assumeIsolated {
                guard let self,
                      Self.isStatusItemEvent(event),
                      MenuBarContextMenu.isContextMenuTrigger(
                          isRightClick: event.type == .rightMouseDown,
                          isControlDown: event.modifierFlags.contains(.control)
                      )
                else { return false }
                self.present(with: event)
                return true
            }
            return handled ? nil : event
        }
    }

    /// Whether the event landed in a status bar item's window.
    private static func isStatusItemEvent(_ event: NSEvent) -> Bool {
        guard let window = event.window else { return false }
        return String(describing: type(of: window)).contains("StatusBar")
    }

    private func present(with event: NSEvent) {
        guard let view = event.window?.contentView else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        let items = MenuBarContextMenu.items(
            isCheckingForUpdates: appUpdateModel.isChecking,
            menuBarSetting: menuBarSetting?(),
            poolTotalFormat: poolTotalFormat?() ?? ""
        )
        for item in items {
            if item.action == .quit, !menu.items.isEmpty {
                menu.addItem(.separator())
            }
            let menuItem = NSMenuItem(title: item.title, action: nil, keyEquivalent: "")
            menuItem.target = self
            menuItem.isEnabled = item.isEnabled
            switch item.action {
            case .about:
                menuItem.action = #selector(showAbout)
            case .checkForAppUpdates:
                menuItem.action = #selector(checkForAppUpdates)
            case .quit:
                menuItem.action = #selector(quit)
            case .setTotalFormat(let provider, let format):
                // Issue #482/#488: the flip carries its provider + target
                // format on the menu item ("claude|share").
                menuItem.action = #selector(setTotalFormat(_:))
                menuItem.representedObject = "\(provider.rawValue)|\(format.rawValue)"
                // A separator between the mode item and the app rows keeps
                // the flip visually tied to the icon it changes.
                menu.addItem(menuItem)
                menu.addItem(.separator())
                continue
            }
            menu.addItem(menuItem)
        }
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }

    /// Same flow as the gear menu's item: run the shared AppUpdateModel and
    /// present the shared update panel. Issue #163: the NSAlert this used
    /// to show closed on Update Now and left zero feedback while Sparkle
    /// worked; the panel transitions in place to the progress surface and
    /// stays up through download → verify → install → relaunch (or lands on
    /// the error, actionable).
    @objc private func checkForAppUpdates() {
        Task { @MainActor [appUpdateModel, installModel] in
            // Issue #170: explicitCheck() never returns nil — every explicit
            // check presents its outcome (the old `guard let resultDialog`
            // silently dropped the click when a check was already in flight).
            let dialog = await appUpdateModel.explicitCheck()
            AppUpdateDialogPanel.present(dialog: dialog, installModel: installModel)
        }
    }

    /// Issue #425 — the standard About panel; AppKit renders the bundled
    /// Credits.rtf (third-party notices) in its credits area automatically.
    /// As an LSUIElement app ModelDeck is never the active app when the
    /// menu opens, so activate first or the panel appears behind others.
    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(nil)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    /// Issue #482/#488: writes the flipped format through the SHARED
    /// pool-total setting (same write as the Settings picker and the deck
    /// header's click); the confirmed document flows back through settings
    /// sync and both surfaces update together.
    @objc private func setTotalFormat(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String else { return }
        let parts = value.split(separator: "|", maxSplits: 1)
        guard parts.count == 2,
              let provider = DeckProvider(rawValue: String(parts[0])),
              let format = MenuBarPinResolver.TotalFormat(rawValue: String(parts[1]))
        else { return }
        onSetTotalFormat?(provider, format)
    }
}
