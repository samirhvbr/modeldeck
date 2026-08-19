import Foundation

// Issue #524 — build item 7 of the keys-with-riders design: the surface for
// the consented config write (#521) and the per-profile helper wiring (#522).
//
// House style is `ProxyCoexistNotice`: the whole presentation DECISION lives
// here, pure and unit-tested, and the SwiftUI views render it without deciding
// anything. Three rules are structural rather than stylistic, and each has a
// tripwire:
//
//  1. **Copy is quoted, never re-worded.** Every sentence this surface shows is
//     a `ConsentedConfigWriteCopy` string or the wiring's own
//     `partialStateDescription`, verbatim. #521 pinned those sentences with a
//     tripwire precisely so the immediacy and enforcement-flip disclosures
//     could not drift — a paraphrase in a view routes around that tripwire
//     while looking like ordinary UI polish.
//  2. **Evidence is never reachable only through a control.** `evidenceLines`
//     and `controls` are separate, so nothing load-bearing hides in a tooltip,
//     a hover, or behind a press (deck-row presentation class, #65/#113/#272).
//  3. **A control that cannot act explains itself in place** (PR #435). A
//     disabled control carries its reason as text ON the surface — not as a
//     `.help` tooltip, which VoiceOver never speaks — and a control that has no
//     model method behind it is not rendered at all rather than rendered dead.

/// One actionable thing on this surface. Every case maps to a real method on
/// `ConsentedConfigWriteModel`; there is deliberately no "Done"/"Dismiss"
/// action, because that model has no way back to `.hidden` and a button that
/// did nothing would be exactly the dead control PR #435 forbids.
public struct ClientKeySurfaceControl: Equatable, Sendable, Identifiable {
    public enum Action: String, Equatable, Sendable {
        /// `ConsentedConfigWriteModel.confirm()`
        case confirm
        /// `ConsentedConfigWriteModel.decline()`
        case decline
        /// `ConsentedConfigWriteModel.deleteOfferedBackups()`
        case deleteBackups
    }

    public var action: Action
    public var title: String
    public var isEnabled: Bool
    /// Non-nil exactly when `isEnabled` is false — the in-place reason, in the
    /// model's own words. The tripwire asserts the biconditional.
    public var unavailableExplanation: String?
    public var accessibilityLabel: String
    /// Spoken after the label. Carries the honest cost of the action (what
    /// declining gives up) or the reason it is unavailable.
    public var accessibilityHint: String?

    public var id: Action { action }

    public init(
        action: Action,
        title: String,
        isEnabled: Bool = true,
        unavailableExplanation: String? = nil,
        accessibilityLabel: String? = nil,
        accessibilityHint: String? = nil
    ) {
        self.action = action
        self.title = title
        self.isEnabled = isEnabled
        self.unavailableExplanation = unavailableExplanation
        self.accessibilityLabel = accessibilityLabel ?? title
        self.accessibilityHint = accessibilityHint
    }
}

/// One rendered block: a headline, the sentences under it, and the controls
/// beside them — in that order, and never mixed.
public struct ClientKeySurfaceSection: Equatable, Sendable {
    public var headline: String
    /// Read-only sentences. Every one of them is visible without interacting.
    public var evidenceLines: [String]
    public var controls: [ClientKeySurfaceControl]
    /// True only while the model is doing something; renders a progress
    /// indicator next to the headline.
    public var isBusy: Bool
    /// What VoiceOver announces for the block itself. The evidence lines are
    /// separate elements and are read in order after it.
    public var accessibilityLabel: String

    public init(
        headline: String,
        evidenceLines: [String] = [],
        controls: [ClientKeySurfaceControl] = [],
        isBusy: Bool = false,
        accessibilityLabel: String? = nil
    ) {
        self.headline = headline
        self.evidenceLines = evidenceLines
        self.controls = controls
        self.isBusy = isBusy
        self.accessibilityLabel = accessibilityLabel ?? headline
    }
}

/// Whether this surface shows anything at all. `silent` is a real answer, not
/// an empty one: #445 ruled that a state ModelDeck cannot act on may not cost a
/// row, and a section explaining a feature the user has not enabled and cannot
/// yet reach is the nagging Tim rejected.
public enum ClientKeySurfaceDisplay: Equatable, Sendable {
    case silent
    case section(ClientKeySurfaceSection)

    public var section: ClientKeySurfaceSection? {
        if case .section(let section) = self { return section }
        return nil
    }
}

/// Strings this surface adds. Everything the consented write already says lives
/// in `ConsentedConfigWriteCopy` and is quoted from there; these are only the
/// sentences that had no home, and they are pinned by tests the same way.
public enum ClientKeySurfaceCopy {
    public static let deleteBackupsButtonTitle = "Delete the saved copy"

    // Attribution state (design §2.6: declining leaves attribution unavailable
    // "with the stated reason — honest-coexist, not nagging").
    public static let attributionOnHeadline = "Receipts name the profile that spent it"
    public static let attributionUnfinishedHeadline = "Receipts can't name the profile yet"
    public static let attributionOffHeadline = "Receipts don't name the profile that spent it"

    public static let attributionOffLine = "This Mac's proxy accepts one shared key for every profile, so a receipt can show what was spent but not who spent it. Turning on per-profile keys is what changes that, and nothing here does it behind your back."

    public static func attributionOnLine(service: String) -> String {
        "Requests from this profile carry its own key (Keychain item \(service)), and their receipts name it."
    }

    /// The honest coexistence cost of the live-session continuity rule
    /// (design §2.5, blocker 2): the shared key stays admitted, so the requests
    /// it pays for resolve to NULL and read as unattributed.
    public static let legacyStillAdmittedLine = "\(ConsentedConfigWriteCopy.legacyEntryName.prefix(1).uppercased())\(ConsentedConfigWriteCopy.legacyEntryName.dropFirst()) is still accepted, so shells that started before the change keep working. ModelDeck can't tell which profile those requests came from, so their receipts say unattributed rather than guessing."
}

/// The consented write's phases, as something a view can render.
public enum ClientKeyConsentSurface {
    public static func display(phase: ConsentedConfigWriteModel.Phase) -> ClientKeySurfaceDisplay {
        switch phase {
        case .hidden:
            return .silent

        case .working(let message):
            // `preparingLine` and `applyingLine` are different states and say
            // so themselves; the view never substitutes a generic "Working…".
            return .section(headline: message, isBusy: true)

        case .consent(let prompt, let canConfirm):
            return .section(consent(prompt, canConfirm: canConfirm))

        case .record(let record):
            return .section(self.record(record))
        }
    }

    private static func consent(
        _ prompt: ConsentedConfigConsentPrompt,
        canConfirm: Bool
    ) -> ClientKeySurfaceSection {
        // The decline's consequence is EVIDENCE, not a tooltip. #521 states it
        // as the honest cost of saying no, and a cost the user can only
        // discover by hovering is a cost that was not disclosed.
        let evidence = prompt.operations
            + prompt.effects
            + [prompt.coverageLine, prompt.backupLine, prompt.undoLine, prompt.declineConsequence]
        return ClientKeySurfaceSection(
            headline: prompt.title,
            evidenceLines: evidence,
            controls: [
                // Disabled rather than hidden, exactly as #521's model
                // documents: the user is told who would break, not left
                // wondering where the button went. The reason is the coverage
                // line, which is already on the surface above — the control
                // repeats it so the explanation is in place at the control too.
                ClientKeySurfaceControl(
                    action: .confirm,
                    title: prompt.confirmButtonTitle,
                    isEnabled: canConfirm,
                    unavailableExplanation: canConfirm ? nil : prompt.coverageLine,
                    accessibilityLabel: canConfirm
                        ? prompt.confirmButtonTitle
                        : "\(prompt.confirmButtonTitle), unavailable",
                    accessibilityHint: canConfirm ? prompt.effects.first : prompt.coverageLine
                ),
                ClientKeySurfaceControl(
                    action: .decline,
                    title: prompt.declineButtonTitle,
                    accessibilityHint: prompt.declineConsequence
                ),
            ]
        )
    }

    private static func record(_ record: ConsentedConfigRecord) -> ClientKeySurfaceSection {
        var lines = record.lines
        // The model appends `takingEffectNowLine` whenever activation is not
        // live — including when it was SUPERSEDED, where that sentence
        // ("ModelDeck is confirming the change stuck") outruns what ModelDeck
        // knows. `supersededLine` is #521's own copy for that case; this picks
        // the right one of the two rather than writing a third.
        if case .superseded(let reason) = record.activation {
            lines = lines.filter { $0 != ConsentedConfigWriteCopy.takingEffectNowLine }
            lines.append(ConsentedConfigWriteCopy.supersededLine(reason))
        }
        var controls: [ClientKeySurfaceControl] = []
        if record.offersBackupDeletion {
            controls.append(ClientKeySurfaceControl(
                action: .deleteBackups,
                title: ClientKeySurfaceCopy.deleteBackupsButtonTitle,
                accessibilityHint: ConsentedConfigWriteCopy.backupDeletionOffer
            ))
        }
        return ClientKeySurfaceSection(
            headline: record.headline,
            evidenceLines: lines,
            controls: controls
        )
    }
}

/// Whether receipts can name the profile that spent a request, from the #522
/// wiring report alone.
public enum ClientKeyAttributionSurface {
    /// - Parameter wiring: the daemon's report for the profile in question.
    ///   `nil` means it has not answered — which is not the same as "off", and
    ///   renders nothing rather than a guess.
    public static func display(wiring: ClientKeyHelperWiring?) -> ClientKeySurfaceDisplay {
        guard let wiring else { return .silent }

        // A migration that stopped between its two files. The wiring type owns
        // this sentence — including which half is missing — so it is quoted
        // whole. No control: this surface has no migration to re-run, and the
        // sentence already names the remedy.
        if let partial = wiring.partialStateDescription {
            return .section(ClientKeySurfaceSection(
                headline: ClientKeySurfaceCopy.attributionUnfinishedHeadline,
                evidenceLines: [partial]
            ))
        }

        guard wiring.isPerProfile, wiring.isFullyWired else {
            return .section(ClientKeySurfaceSection(
                headline: ClientKeySurfaceCopy.attributionOffHeadline,
                evidenceLines: [ClientKeySurfaceCopy.attributionOffLine]
            ))
        }

        var lines = [ClientKeySurfaceCopy.attributionOnLine(service: wiring.service)]
        if wiring.legacySharedKeyStillAdmitted {
            lines.append(ClientKeySurfaceCopy.legacyStillAdmittedLine)
        }
        return .section(ClientKeySurfaceSection(
            headline: ClientKeySurfaceCopy.attributionOnHeadline,
            evidenceLines: lines
        ))
    }
}

private extension ClientKeySurfaceDisplay {
    static func section(
        headline: String,
        evidenceLines: [String] = [],
        controls: [ClientKeySurfaceControl] = [],
        isBusy: Bool = false
    ) -> ClientKeySurfaceDisplay {
        .section(ClientKeySurfaceSection(
            headline: headline, evidenceLines: evidenceLines, controls: controls, isBusy: isBusy
        ))
    }
}
