import Foundation

// Issue #445 — Tim's field ruling on the installed 1.0.0 (2026-08-15):
// "I don't want a message they're nagging all the time. I don't want it to
// use a whole row either. […] Even an icon that would make that whole row
// visible wouldn't be okay with me."
//
// The state this describes — something ModelDeck did not start is on the
// proxy port (#400's refusal, and under a recorded `coexist` choice the
// user's own decision) — used to render a full-width caption in the deck's
// header info space. It may no longer cost a deck row at all: no dedicated
// row, no recurring banner, no row-creating icon.
//
// This AMENDS #401's coexistence-visibility surface, not its principle.
// "Never silent coexistence" still holds, through two surfaces that cost
// nothing: Settings → General → Managed proxy carries the full sentence
// (`ManagedProxyOnboardingCopy.settingsSummary`), and the deck's ALREADY
// ALWAYS-RENDERED header chrome carries a subtle glyph whose tooltip states
// the whole thing.
//
// The decision lives here, pure, so the "renders no row" half is a unit test
// rather than a screenshot (house style: StatuslineCaptureControl).

/// Where — if anywhere — the external-proxy coexistence state shows on the
/// deck.
public enum ProxyCoexistNotice {
    public enum Display: Equatable, Sendable {
        /// Nothing on the deck. Either there is no external instance, or a
        /// surface that owns the screen is already telling the story.
        case silent
        /// A glyph in the header's existing control cluster. Costs no row:
        /// the header renders on every deck open regardless.
        case headerGlyph(tooltip: String)
    }

    /// The one glyph. Deliberately the same `info.circle` the retired caption
    /// carried, at header-control size and secondary weight.
    public static let glyphSystemImage = "info.circle"

    public static let glyphAccessibilityLabel = "External proxy, not managed by ModelDeck"

    /// The sentence the retired row used to state, kept verbatim as the
    /// tooltip's first line so nothing was lost in the move.
    public static let headline = "External proxy detected — not managed by ModelDeck"

    /// Where the full story lives now, named in the tooltip so the state is
    /// followable rather than merely visible.
    public static let settingsPointer = "Settings → General → Managed proxy explains what this changes."

    /// The deck's whole external-proxy display decision.
    ///
    /// - `phase`: slice C's lifecycle phase. Only `.externalInstanceDetected`
    ///   is ours; every other phase is either healthy-and-silent or an
    ///   actionable state whose row (Start / Try Again) renders only where
    ///   ModelDeck owns the proxy (#614) — either way, not this notice's.
    /// - `choice`: the recorded onboarding answer. `coexist` means the user
    ///   chose this, so the tooltip states WHY managed-only features are off
    ///   rather than reading as a fault.
    /// - `onboardingCardPresented`: while the #422 first-launch card is up it
    ///   owns the surface and is asking about this exact instance — a glyph
    ///   repeating it would be noise.
    /// `@MainActor` only because the copy it quotes is (`ManagedProxyModel`
    /// is a main-actor model); the decision itself is pure and side-effect
    /// free.
    @MainActor
    public static func display(
        phase: ManagedProxyModel.Phase,
        choice: ManagedProxyOnboardingChoice?,
        onboardingCardPresented: Bool
    ) -> Display {
        guard phase == .externalInstanceDetected, !onboardingCardPresented else { return .silent }
        let reason = choice == .coexist
            ? ManagedProxyOnboardingCopy.coexistUnavailableReason
            : ManagedProxyModel.externalInstanceMessage
        return .headerGlyph(tooltip: "\(headline). \(reason) \(settingsPointer)")
    }
}
