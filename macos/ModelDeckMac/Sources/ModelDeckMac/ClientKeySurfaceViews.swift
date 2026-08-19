import SwiftUI
import ModelDeckMacCore

// Issue #524 — the views for build item 7. Deliberately thin, the same way
// ManagedProxyOnboardingViews is: every word and every branch is decided in
// ModelDeckMacCore's `ClientKeySurface`, where it is unit-tested, and nothing
// here chooses a sentence, hides one behind a hover, or renders a control the
// model cannot act on.

/// Renders one decided section. The order is fixed and is the accessibility
/// contract: headline, then every evidence line as its own element, then the
/// controls. A control's unavailability reason is rendered as text beside it —
/// tooltips do not reach VoiceOver (the rule PR #433 set for this codebase).
struct ClientKeySurfaceSectionView: View {
    let section: ClientKeySurfaceSection
    let perform: (ClientKeySurfaceControl.Action) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if section.isBusy { ProgressView().controlSize(.small) }
                Text(section.headline)
                    .font(.system(size: 13, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(section.accessibilityLabel)

            ForEach(Array(section.evidenceLines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Never truncated: a disclosure the reader has to widen a
                    // window to finish is a disclosure that was not made.
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if !section.controls.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        ForEach(section.controls) { control in
                            button(control)
                        }
                    }
                    ForEach(section.controls.filter { !$0.isEnabled }) { control in
                        if let explanation = control.unavailableExplanation {
                            Text(explanation)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func button(_ control: ClientKeySurfaceControl) -> some View {
        let action = Button(control.title) { perform(control.action) }
            .disabled(!control.isEnabled)
            .accessibilityLabel(control.accessibilityLabel)
        if let hint = control.accessibilityHint {
            action.accessibilityHint(hint)
        } else {
            action
        }
    }
}

/// The consented config write, while it is happening. Every phase of #521's
/// model reaches the user through this one view.
struct ClientKeyConsentCard: View {
    @ObservedObject var model: ConsentedConfigWriteModel

    var body: some View {
        if let section = ClientKeyConsentSurface.display(phase: model.phase).section {
            ClientKeySurfaceSectionView(section: section) { action in
                switch action {
                case .confirm: Task { await model.confirm() }
                case .decline: model.decline()
                case .deleteBackups: model.deleteOfferedBackups()
                }
            }
            .padding(12)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Settings → General: whether receipts can name the profile that spent a
/// request, and the consent flow when one is in progress.
///
/// Renders NOTHING until there is something true to say. Per-profile keys
/// cannot be enabled from the app yet, so every install would otherwise carry a
/// permanent row about a feature it cannot reach — the nagging Tim ruled out in
/// #445. `ClientKeyAttributionSurface.display(wiring: nil)` is `.silent`, and
/// that silence is the tested default, not an oversight.
struct ClientKeyAttributionSection: View {
    /// The daemon's wiring report for the profile in view, once an owner
    /// fetches it (`DaemonClient.clientKeyHelperWiring(accountID:)`).
    var wiring: ClientKeyHelperWiring?
    /// The consented write path, once an owner instantiates it.
    var consentModel: ConsentedConfigWriteModel?

    @ViewBuilder
    var body: some View {
        let attribution = ClientKeyAttributionSurface.display(wiring: wiring).section
        if attribution != nil || consentModel != nil {
            Section("Receipt attribution") {
                if let attribution {
                    ClientKeySurfaceSectionView(section: attribution) { _ in }
                }
                if let consentModel {
                    ClientKeyConsentCard(model: consentModel)
                }
            }
        }
    }
}
