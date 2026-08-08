import Foundation

// Issue #328 — the provider status icons (▲/●) beside the Claude and Codex
// column headers reveal their #281 health detail on HOVER, not click-only.
// Tim, on 0.4.3: "nothing happens when you hover over them … users wouldn't
// even know to click." Hover intent is a small state machine, kept here in
// Core so the debounce/grace logic is testable without a pointer:
//
//   idle ──icon enter──▶ armed ──delay elapses──▶ hoverPresented
//   armed ──icon exit──▶ idle (cancel; no flash on a drive-by pointer)
//   hoverPresented ──exit icon AND popover──▶ dismissGrace ──grace──▶ idle
//   dismissGrace ──re-enter icon or popover──▶ hoverPresented (no flicker
//     while the pointer crosses the gap between icon and popover)
//   any presented state ──click──▶ clickPresented (pinned: exactly today's
//     click-opened popover, which outlives the pointer) ──click──▶ idle
//
// The machine only DECIDES; it never presents. Effects are applied by the
// view against `DeckPopoverModel`'s one-at-a-time presented-warning slot
// (#113), so hover and click can never race into a double-present — there
// is one popover binding and one slot, and `present` on an already
// presented popover is a slot no-op. Stale timers are killed by
// generation: every scheduled timer carries the generation minted for it,
// and a firing timer whose generation is no longer current is dropped.
public struct HealthHoverMachine: Equatable, Sendable {
    /// Hover-intent delay before presenting: long enough that sweeping the
    /// pointer across the header doesn't flash popovers, short enough to
    /// read as "hover shows it" (judgment call, flagged on the PR; macOS
    /// tooltips sit near 1s and feel sluggish for a primary affordance).
    public static let presentDelay: TimeInterval = 0.45

    /// Grace after the pointer leaves both the icon and the popover before
    /// a hover-opened popover dismisses. Covers the travel across the
    /// popover's arrow/gap so icon → popover never flickers.
    public static let dismissGrace: TimeInterval = 0.25

    public enum State: Equatable, Sendable {
        /// No hover interest; popover not hover-owned.
        case idle
        /// Pointer on the icon; present timer running.
        case armed
        /// Popover up, hover-owned: leaving both regions starts the grace.
        case hoverPresented
        /// Hover-owned popover up, pointer outside both regions, dismiss
        /// timer running.
        case dismissGrace
        /// Popover up, click-owned (today's behavior): pointer exit does
        /// NOT dismiss; a second click, Escape, or an outside click does.
        case clickPresented
    }

    /// What the view must do after an event. Timers are scheduled by the
    /// view (Task.sleep) and report back via `timerFired(generation:)`.
    public enum Effect: Equatable, Sendable {
        case scheduleTimer(after: TimeInterval, generation: Int)
        case cancelTimer
        /// Claim the model's presented-warning slot for this chip.
        case present
        /// Release the slot (only ever emitted for a hover-owned popover
        /// or a click-toggle-off — never for someone else's presentation).
        case dismiss
    }

    public private(set) var state: State = .idle
    /// Monotonic token minted per scheduled timer; a firing timer with a
    /// stale generation is ignored (the cancel may have raced the sleep).
    public private(set) var generation = 0

    public init() {}

    private mutating func mintGeneration() -> Int {
        generation += 1
        return generation
    }

    /// Pointer entered/left the status icon.
    public mutating func iconHoverChanged(_ inside: Bool) -> [Effect] {
        switch (state, inside) {
        case (.idle, true):
            state = .armed
            return [.scheduleTimer(after: Self.presentDelay, generation: mintGeneration())]
        case (.armed, false):
            state = .idle
            return [.cancelTimer]
        case (.hoverPresented, false):
            state = .dismissGrace
            return [.scheduleTimer(after: Self.dismissGrace, generation: mintGeneration())]
        case (.dismissGrace, true):
            state = .hoverPresented
            return [.cancelTimer]
        default:
            // armed+enter and hoverPresented+enter are repeats; exits while
            // idle/clickPresented change nothing (a pinned popover outlives
            // the pointer, exactly like today's click-opened one).
            return []
        }
    }

    /// Pointer entered/left the presented popover's content.
    public mutating func popoverHoverChanged(_ inside: Bool) -> [Effect] {
        switch (state, inside) {
        case (.dismissGrace, true):
            state = .hoverPresented
            return [.cancelTimer]
        case (.hoverPresented, false):
            state = .dismissGrace
            return [.scheduleTimer(after: Self.dismissGrace, generation: mintGeneration())]
        default:
            return []
        }
    }

    /// A scheduled timer fired. Stale generations (a newer schedule or a
    /// cancel superseded this timer) are dropped on the floor.
    public mutating func timerFired(generation: Int) -> [Effect] {
        guard generation == self.generation else { return [] }
        switch state {
        case .armed:
            state = .hoverPresented
            return [.present]
        case .dismissGrace:
            state = .idle
            return [.dismiss]
        case .idle, .hoverPresented, .clickPresented:
            return []
        }
    }

    /// The icon was clicked. From closed, today's toggle-open; from a
    /// hover-opened popover, the click PINS it (converts hover-owned to
    /// click-owned) instead of the literal toggle-dismiss — dismissing the
    /// popover the user is deliberately reaching for, with the pointer
    /// still on the icon to instantly re-arm hover, would loop open/shut.
    /// From click-owned, today's toggle-dismiss.
    public mutating func clicked() -> [Effect] {
        switch state {
        case .idle:
            state = .clickPresented
            return [.present]
        case .armed:
            // Click beat the hover delay: present now, kill the timer.
            state = .clickPresented
            return [.cancelTimer, .present]
        case .hoverPresented:
            state = .clickPresented
            return []
        case .dismissGrace:
            state = .clickPresented
            return [.cancelTimer]
        case .clickPresented:
            state = .idle
            return [.dismiss]
        }
    }

    /// This chip's popover stopped being the presented one for reasons
    /// outside the machine — Escape, an outside click, another affordance
    /// stealing the one-at-a-time slot, or the #113 reconcile. Resets so a
    /// later hover starts clean; never emits `dismiss` (the slot is
    /// already someone else's or empty).
    public mutating func presentationLost() -> [Effect] {
        let hadTimer = state == .armed || state == .dismissGrace
        state = .idle
        return hadTimer ? [.cancelTimer] : []
    }

    /// The model's one-at-a-time slot changed to something that is not this
    /// chip (`toPresented` = whether ANOTHER warning is now presented, vs
    /// the slot clearing to nil). While `armed` this chip's popover was
    /// never up, so a slot merely CLEARING (someone else's popover closed)
    /// must not kill the in-flight hover intent — the pointer is still
    /// parked on the icon waiting for its present. A steal by another
    /// warning does reset (the user is interacting elsewhere; presenting
    /// over them half a second later would be a fight for the slot). Every
    /// presented state keeps `presentationLost()` semantics unchanged.
    public mutating func slotChanged(toPresented other: Bool) -> [Effect] {
        if state == .armed && !other { return [] }
        return presentationLost()
    }

    /// The chip appeared with its popover ALREADY presented: the slot
    /// survives a deck close/reopen (#113 behavior), but this machine is
    /// view `@State` and rebuilds as idle — leaving it idle would make the
    /// FIRST click emit a `present` the slot no-ops, a visibly swallowed
    /// click. Adopt the presentation as click-owned (a reopened popover
    /// behaves like a click-pinned one: outlives the pointer, next click
    /// dismisses).
    public mutating func adoptPresentedSlot() -> [Effect] {
        guard state == .idle else { return [] }
        state = .clickPresented
        return []
    }
}
