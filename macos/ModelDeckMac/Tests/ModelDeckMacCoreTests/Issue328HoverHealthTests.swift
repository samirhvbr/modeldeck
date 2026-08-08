import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #328 — the provider status icons reveal their health detail on
// hover, not click-only. The hover-intent debounce, the icon↔popover
// crossing grace, and the hover/click ownership reconciliation all live in
// Core's `HealthHoverMachine`; this suite drives it event by event. The
// hover FEEL (delay length, tracking inside the MenuBarExtra window,
// popover geometry) stays hand-test.

@Suite("Hover intent presents the health detail (issue #328)")
struct HoverIntentPresentTests {
    @Test func hoverPresentsOnlyAfterTheDelayElapses() {
        var machine = HealthHoverMachine()
        let effects = machine.iconHoverChanged(true)
        // Entering arms a timer; nothing presents yet.
        #expect(effects == [.scheduleTimer(
            after: HealthHoverMachine.presentDelay, generation: 1
        )])
        #expect(machine.state == .armed)
        // The timer firing is what presents.
        #expect(machine.timerFired(generation: 1) == [.present])
        #expect(machine.state == .hoverPresented)
    }

    @Test func driveByPointerNeverPresents() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        // Pointer sweeps off before the delay: timer cancelled, no flash.
        #expect(machine.iconHoverChanged(false) == [.cancelTimer])
        #expect(machine.state == .idle)
        // A racing timer that fires anyway (cancel lost the race) is stale
        // by generation and does nothing.
        #expect(machine.timerFired(generation: 1) == [])
        #expect(machine.state == .idle)
    }

    @Test func reEnteringMintsAFreshGenerationSoTheOldTimerIsDead() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        _ = machine.iconHoverChanged(false)
        let effects = machine.iconHoverChanged(true)
        #expect(effects == [.scheduleTimer(
            after: HealthHoverMachine.presentDelay, generation: 2
        )])
        // First hover's timer: stale. Second: presents.
        #expect(machine.timerFired(generation: 1) == [])
        #expect(machine.timerFired(generation: 2) == [.present])
    }

    @Test func repeatedEnterEventsWhileArmedAreNoOps() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        // AppKit tracking can re-report entry; the armed timer must not
        // restart (that would push the present ever further away).
        #expect(machine.iconHoverChanged(true) == [])
        #expect(machine.generation == 1)
    }
}

@Suite("Leaving dismisses, crossing the gap does not (issue #328)")
struct HoverDismissGraceTests {
    private func hoverPresented() -> HealthHoverMachine {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        _ = machine.timerFired(generation: machine.generation)
        return machine
    }

    @Test func leavingBothRegionsDismissesAfterTheGrace() {
        var machine = hoverPresented()
        let effects = machine.iconHoverChanged(false)
        #expect(effects == [.scheduleTimer(
            after: HealthHoverMachine.dismissGrace, generation: machine.generation
        )])
        #expect(machine.state == .dismissGrace)
        #expect(machine.timerFired(generation: machine.generation) == [.dismiss])
        #expect(machine.state == .idle)
    }

    @Test func crossingFromIconIntoThePopoverKeepsItUp() {
        var machine = hoverPresented()
        // Icon exit starts the grace; popover entry cancels it — the
        // pointer crossing the arrow gap must never flicker the popover.
        _ = machine.iconHoverChanged(false)
        #expect(machine.popoverHoverChanged(true) == [.cancelTimer])
        #expect(machine.state == .hoverPresented)
        // The abandoned grace timer is stale if its cancel raced.
        #expect(machine.timerFired(generation: machine.generation) == [])
        #expect(machine.state == .hoverPresented)
    }

    @Test func crossingBackFromPopoverToIconAlsoKeepsItUp() {
        var machine = hoverPresented()
        _ = machine.iconHoverChanged(false)
        _ = machine.popoverHoverChanged(true)
        // Popover exit starts a grace; icon re-entry cancels it.
        _ = machine.popoverHoverChanged(false)
        #expect(machine.state == .dismissGrace)
        #expect(machine.iconHoverChanged(true) == [.cancelTimer])
        #expect(machine.state == .hoverPresented)
    }

    @Test func leavingThePopoverOutwardDismissesAfterTheGrace() {
        var machine = hoverPresented()
        _ = machine.iconHoverChanged(false)
        _ = machine.popoverHoverChanged(true)
        _ = machine.popoverHoverChanged(false)
        #expect(machine.timerFired(generation: machine.generation) == [.dismiss])
        #expect(machine.state == .idle)
    }
}

@Suite("Click and hover share one presentation (issue #328)")
struct HoverClickReconciliationTests {
    @Test func plainClickStillTogglesExactlyLikeToday() {
        var machine = HealthHoverMachine()
        #expect(machine.clicked() == [.present])
        #expect(machine.state == .clickPresented)
        #expect(machine.clicked() == [.dismiss])
        #expect(machine.state == .idle)
    }

    @Test func clickOwnedPopoverIgnoresPointerExit() {
        var machine = HealthHoverMachine()
        _ = machine.clicked()
        // Today's lifecycle: a click-opened popover outlives the pointer.
        #expect(machine.iconHoverChanged(false) == [])
        #expect(machine.popoverHoverChanged(false) == [])
        #expect(machine.state == .clickPresented)
    }

    @Test func clickDuringTheHoverDelayPresentsImmediately() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        // The user beat the debounce: present now, and exactly once — the
        // pending hover timer is cancelled, and even a raced firing is
        // dropped in the clickPresented state, so the model slot is
        // claimed a single time (the double-present guard).
        #expect(machine.clicked() == [.cancelTimer, .present])
        #expect(machine.state == .clickPresented)
        #expect(machine.timerFired(generation: machine.generation) == [])
    }

    @Test func clickOnAHoverOpenedPopoverPinsItWithoutRePresenting() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        _ = machine.timerFired(generation: machine.generation)
        // Already presented: the click must NOT emit a second present (one
        // popover instance) and must NOT toggle-dismiss the popover the
        // user is deliberately reaching for — it converts to click-owned.
        #expect(machine.clicked() == [])
        #expect(machine.state == .clickPresented)
        // Now hover-exit no longer dismisses…
        #expect(machine.iconHoverChanged(false) == [])
        // …and a second click dismisses, exactly like today.
        var second = machine
        #expect(second.clicked() == [.dismiss])
    }

    @Test func clickDuringTheDismissGraceKeepsThePopoverAndPinsIt() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        _ = machine.timerFired(generation: machine.generation)
        _ = machine.iconHoverChanged(false)
        // Still presented during the grace: pin without re-presenting.
        #expect(machine.clicked() == [.cancelTimer])
        #expect(machine.state == .clickPresented)
        #expect(machine.timerFired(generation: machine.generation) == [])
    }
}

@Suite("External dismissal resets the machine (issue #328)")
struct HoverPresentationLostTests {
    @Test func slotStealWhilePresentedResetsWithoutDismissEffect() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        _ = machine.timerFired(generation: machine.generation)
        // Escape / outside click / another affordance took the slot: the
        // machine resets, and must NOT emit `.dismiss` — the slot already
        // belongs to someone else (or is empty), and the model's guarded
        // setter is not a license to tear down a successor.
        #expect(machine.presentationLost() == [])
        #expect(machine.state == .idle)
    }

    @Test func lostWhileArmedCancelsThePendingPresent() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        #expect(machine.presentationLost() == [.cancelTimer])
        #expect(machine.state == .idle)
        #expect(machine.timerFired(generation: machine.generation) == [])
    }

    @Test func lostWhileInGraceCancelsThePendingDismiss() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        _ = machine.timerFired(generation: machine.generation)
        _ = machine.iconHoverChanged(false)
        #expect(machine.presentationLost() == [.cancelTimer])
        #expect(machine.state == .idle)
    }

    @Test func lostWhileIdleIsANoOp() {
        var machine = HealthHoverMachine()
        #expect(machine.presentationLost() == [])
        #expect(machine.state == .idle)
    }

    @Test func lostWhileClickPresentedResetsWithoutDismissEffect() {
        var machine = HealthHoverMachine()
        _ = machine.clicked()
        // Escape or an outside click closed a click-pinned popover: reset
        // (no timer to cancel, no dismiss into a slot already cleared).
        #expect(machine.presentationLost() == [])
        #expect(machine.state == .idle)
    }
}

@Suite("Slot changes vs in-flight hover intent (issue #328 review)")
struct HoverSlotChangeTests {
    @Test func anotherPopoverClosingDoesNotKillAnArmedHover() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        // Some OTHER warning's popover was up and just cleared (slot →
        // nil). The pointer is still parked on this icon waiting for its
        // present — the armed intent must survive, timer intact.
        #expect(machine.slotChanged(toPresented: false) == [])
        #expect(machine.state == .armed)
        #expect(machine.timerFired(generation: machine.generation) == [.present])
    }

    @Test func aStealByAnotherWarningResetsAnArmedHover() {
        var machine = HealthHoverMachine()
        _ = machine.iconHoverChanged(true)
        // Another warning just PRESENTED: the user is interacting
        // elsewhere; presenting ours half a second later would fight for
        // the slot. Reset, kill the pending timer.
        #expect(machine.slotChanged(toPresented: true) == [.cancelTimer])
        #expect(machine.state == .idle)
        #expect(machine.timerFired(generation: machine.generation) == [])
    }

    @Test func slotChangesInPresentedStatesKeepPresentationLostSemantics() {
        // hoverPresented: slot cleared (Escape) or stolen — both reset.
        for toPresented in [false, true] {
            var machine = HealthHoverMachine()
            _ = machine.iconHoverChanged(true)
            _ = machine.timerFired(generation: machine.generation)
            #expect(machine.slotChanged(toPresented: toPresented) == [])
            #expect(machine.state == .idle)
        }
        // dismissGrace: the pending dismiss timer is cancelled either way.
        var grace = HealthHoverMachine()
        _ = grace.iconHoverChanged(true)
        _ = grace.timerFired(generation: grace.generation)
        _ = grace.iconHoverChanged(false)
        #expect(grace.slotChanged(toPresented: false) == [.cancelTimer])
        #expect(grace.state == .idle)
        // clickPresented: reset without effects.
        var pinned = HealthHoverMachine()
        _ = pinned.clicked()
        #expect(pinned.slotChanged(toPresented: true) == [])
        #expect(pinned.state == .idle)
    }
}

@Suite("Reopened deck adopts a surviving popover (issue #328 review)")
struct HoverAdoptPresentedSlotTests {
    @Test func firstClickAfterReopenDismissesInsteadOfNoOp() {
        // Repro: presentedWarning survives deck close/reopen (#113), the
        // chip's @State machine rebuilds as idle. Without adoption, the
        // first click emits `.present` — a slot no-op over the already
        // presented popover, i.e. a click that visibly does nothing.
        var stale = HealthHoverMachine()
        #expect(stale.clicked() == [.present]) // the swallowed-click shape
        // With adoption the reopened popover is click-pinned…
        var machine = HealthHoverMachine()
        #expect(machine.adoptPresentedSlot() == [])
        #expect(machine.state == .clickPresented)
        // …so the first click acts: it dismisses, exactly like a pinned
        // popover's second click.
        #expect(machine.clicked() == [.dismiss])
        #expect(machine.state == .idle)
    }

    @Test func adoptedPopoverOutlivesThePointerLikeAnyClickPinnedOne() {
        var machine = HealthHoverMachine()
        _ = machine.adoptPresentedSlot()
        #expect(machine.iconHoverChanged(false) == [])
        #expect(machine.popoverHoverChanged(false) == [])
        #expect(machine.state == .clickPresented)
    }

    @Test func adoptionOnlyAppliesFromIdle() {
        // A guard against a misplaced onAppear: adoption must never yank
        // an in-flight hover or an already reconciled state.
        var armed = HealthHoverMachine()
        _ = armed.iconHoverChanged(true)
        #expect(armed.adoptPresentedSlot() == [])
        #expect(armed.state == .armed)
        var pinned = HealthHoverMachine()
        _ = pinned.clicked()
        #expect(pinned.adoptPresentedSlot() == [])
        #expect(pinned.state == .clickPresented)
    }
}

@Suite("Hover timing constants (issue #328)")
struct HoverTimingTests {
    @Test func delayAndGraceSitInTheAgreedBands() {
        // The spec's band: present after a short intent delay (~0.4–0.6s),
        // dismiss after a grace long enough to cross the popover gap but
        // short enough to feel like "moving away closes it".
        #expect(HealthHoverMachine.presentDelay >= 0.4)
        #expect(HealthHoverMachine.presentDelay <= 0.6)
        #expect(HealthHoverMachine.dismissGrace > 0)
        #expect(HealthHoverMachine.dismissGrace <= 0.35)
        // Grace strictly shorter than the intent delay: closing must feel
        // snappier than opening.
        #expect(HealthHoverMachine.dismissGrace < HealthHoverMachine.presentDelay)
    }
}
