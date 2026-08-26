import AppKit
import SwiftUI
import ModelDeckMacCore

/// Issue #8 — the three-step add-account sheet (spec "Add account",
/// mockups §05). The view is deliberately thin: all decisions live in
/// `AddAccountModel` (ModelDeckMacCore), which is unit tested.
///
/// Issue #560 gives Grok a two-step variant of the same sheet
/// (docs/mockups/grok-add-account.html): no profile home to create and no
/// sign-in to launch, so step 1 points at the grok CLI home that already
/// exists and step 2 shows the billing reading that proves it works.
struct AddAccountSheet: View {
    @ObservedObject var model: AddAccountModel
    @Environment(\.dismiss) private var dismiss

    @State private var provider: DeckProvider = .claude
    @State private var label: String = ""
    @State private var purpose: String = ""
    @State private var color: Color = Color(hexString: "#d97757") ?? .accentColor
    @State private var colorEdited = false
    @State private var confirmingCancel = false
    /// Issue #560: the "What ModelDeck reads" list, collapsed by default —
    /// the promise is the message, the file list is for whoever wants to
    /// check it (Tim's ruling on the #560 design note).
    @State private var showsGrokReadFiles = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            switch model.step {
            case .details: detailsStep
            case .signIn: signInStep
            case .confirm: confirmStep
            }
            if let error = model.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
        .padding(18)
        .frame(width: 420)
        .onAppear {
            model.reset()
            // A reopened sheet remembers the picked provider but not the
            // discovery reset() just cleared, so re-check the folder rather
            // than leaving Connect disabled with nothing on screen.
            if provider == .grok {
                Task { await model.discoverGrokHome() }
            }
        }
        // Closing the sheet mid-connect cancels it, and the cancelled connect
        // rolls its account back: "connected" is only ever said with a real
        // reading on screen (fix round 1).
        .onDisappear { model.cancelPendingConnect() }
        .confirmationDialog(
            "Keep \(model.account?.label ?? "the new subscription")?",
            isPresented: $confirmingCancel,
            titleVisibility: .visible
        ) {
            Button("Keep — sign in later") {
                Task {
                    if await model.cancel(discardAccount: false) { dismiss() }
                }
            }
            Button("Remove it", role: .destructive) {
                Task {
                    // Only dismiss when the reference removal succeeded; on
                    // failure the sheet stays open showing model.lastError.
                    if await model.cancel(discardAccount: true) { dismiss() }
                }
            }
            Button("Continue setup", role: .cancel) {}
        } message: {
            Text("Removing deletes only ModelDeck's reference. Provider credentials are never touched.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.headline)
            Text("Step \(stepNumber) of \(totalSteps)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Step 1 — provider + label + purpose + color

    private var detailsStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                Picker("Provider", selection: $provider) {
                    ForEach(DeckProvider.addableCases, id: \.self) { provider in
                        Text(provider.displayName).tag(provider)
                    }
                }
                .onChange(of: provider) { _, newValue in
                    // A failed Grok discovery has nothing to say about the
                    // form that just replaced it.
                    model.clearLastError()
                    if !colorEdited {
                        color = Color(hexString: newValue == .claude ? "#d97757" : "#48a868") ?? .accentColor
                    }
                    // Grok's folder is discovered, not created, so the sheet
                    // asks the daemon what it finds the moment Grok is picked.
                    if newValue == .grok, model.grokCandidate == nil {
                        Task { await model.discoverGrokHome() }
                    }
                }
                TextField("Label", text: $label, prompt: Text("e.g. Side Project"))
                TextField("Purpose", text: $purpose, prompt: Text("e.g. client work"))
                ColorPicker("Color", selection: $color, supportsOpacity: false)
                    .onChange(of: color) { _, _ in colorEdited = true }
            }
            if provider == .grok {
                grokHomeSection
            } else {
                Text("ModelDeck creates an isolated, owner-only profile home for this subscription. Sign-in happens next, in \(provider.displayName)'s own flow — ModelDeck never sees or stores credentials.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Issue #560 — the grok CLI home this subscription watches

    @ViewBuilder
    private var grokHomeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let candidate = model.grokCandidate {
                HStack(alignment: .top, spacing: 8) {
                    // Decorative: the status line beside it says the same
                    // thing in words, and that line carries the spoken label.
                    Circle()
                        .fill(dotColor(for: candidate))
                        .frame(width: 7, height: 7)
                        .padding(.top, 4)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(candidate.displayPath())
                            .font(.system(size: 11.5, design: .monospaced))
                            .textSelection(.enabled)
                            .help(candidate.path)
                        Text(candidate.statusText())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    // One element for the two lines, with its OWN label —
                    // the "Choose Another Folder" button below stays a
                    // separate element (#65/#113/#272).
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(candidate.accessibilityLabel())
                    Spacer(minLength: 8)
                    Button("Choose Another Folder…") { chooseGrokFolder() }
                        .buttonStyle(.link)
                        .controlSize(.small)
                        .accessibilityLabel("Choose another Grok folder")
                }
                .padding(9)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))

                // The promise IS the ready state's paragraph, so it renders
                // once here and never again inside the disclosure below.
                Text(candidate.canConnect ? GrokHomeCandidate.readOnlyPromise : candidate.explanation)
                    .font(.caption)
                    .foregroundStyle(candidate.canConnect ? Color.secondary : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)

                if let command = candidate.remedyCommand() {
                    remedyCommandRow(command)
                }
                if candidate.canConnect {
                    grokReadFilesDisclosure(candidate)
                }
            } else if model.isBusy {
                Text("Looking for the grok CLI's home…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// A command the person runs themselves. ModelDeck never launches it —
    /// driving grok's own sign-in is the line decision 0035 drew.
    private func remedyCommandRow(_ command: String) -> some View {
        GroupBox {
            HStack(alignment: .top) {
                Text(command)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                }
                .controlSize(.small)
                .accessibilityLabel("Copy the command \(command)")
            }
        }
    }

    private func grokReadFilesDisclosure(_ candidate: GrokHomeCandidate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            DisclosureGroup(isExpanded: $showsGrokReadFiles) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(candidate.readFiles, id: \.self) { file in
                        Text(file)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 3)
            } label: {
                Text("What ModelDeck reads").font(.caption)
            }
        }
    }

    private func dotColor(for candidate: GrokHomeCandidate) -> Color {
        if candidate.canConnect { return .green }
        switch candidate.verdict {
        case .writableByOthers, .notSignedIn: return .orange
        default: return .red
        }
    }

    /// The second grok home case (Tim's ruling: offer it, default to the
    /// discovered `~/.grok`). Picking a folder only re-runs discovery — the
    /// daemon still decides whether it can be connected.
    private func chooseGrokFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.prompt = "Choose"
        panel.message = "Choose the folder the grok CLI uses."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await model.discoverGrokHome(path: url.path) }
    }

    // MARK: Step 2 — the provider's own sign-in

    private var signInStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Terminal is running \(providerDisplayName)'s login for this profile. Complete the sign-in in your browser exactly as normal, then come back here.")
                .fixedSize(horizontal: false, vertical: true)
            if model.didActivateForLogin {
                // Issue #99: current Claude Code stores the credential in
                // whichever profile is active, so the flow flipped
                // activation to the new profile for this sign-in.
                Text("ModelDeck activated this profile so the sign-in lands in the right subscription (required by current \(providerDisplayName) versions). If another profile was active, it's restored after verification.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let command = model.loginCommand {
                GroupBox {
                    HStack(alignment: .top) {
                        Text(command)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(command, forType: .string)
                        }
                        .controlSize(.small)
                    }
                }
            }
            HStack {
                Button("Open Terminal Again") { model.launchLogin() }
                    .controlSize(.small)
            }
            Text("The browser OAuth flow belongs to the provider. ModelDeck only checks the sign-in state afterwards — it never runs a logout on any profile.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Step 3 — verify & land

    @ViewBuilder
    private var confirmStep: some View {
        if isGrokFlow {
            grokConfirmStep
        } else {
            signInConfirmStep
        }
    }

    /// Issue #560: no identity read-back exists for Grok (ModelDeck never
    /// opens its credential), so the reading the deck card uses is the proof
    /// the connection works.
    private var grokConfirmStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ModelDeck asked xAI for this subscription's billing percentage and got an answer, so the card is real, not a placeholder waiting to fill in.")
                .fixedSize(horizontal: false, vertical: true)
            if let window = model.connectedWindow {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(model.account?.label ?? "The subscription")
                            .font(.system(size: 12.5, weight: .semibold))
                        Spacer()
                        if let remaining = window.remainingText {
                            Text(remaining)
                                .font(.system(size: 12, weight: .semibold))
                                .monospacedDigit()
                        }
                    }
                    Text([window.title, window.displayedResetText].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ProgressView(value: window.usedFraction)
                        .progressViewStyle(.linear)
                        .accessibilityHidden(true)
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(model.account?.label ?? "The subscription"). "
                    + [window.remainingText, window.title, window.displayedResetText]
                        .compactMap { $0 }.joined(separator: ". ")
                )
            }
            Text("The grok CLI still owns sign-in, renewal and everything in that folder. Removing this subscription later removes only ModelDeck's reference to it — nothing inside is touched.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var signInConfirmStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text(model.identity.map { "Signed in as \($0)" }
                    ?? "Signed in. (\(providerDisplayName) didn't report an identity.)")
                    .font(.system(size: 13, weight: .semibold))
            }
            Text("\(model.account?.label ?? "The subscription") is in the deck. Its first usage snapshot has been requested; the popover updates as soon as it lands.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let warning = model.completionWarning {
                Text(warning)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var footer: some View {
        HStack {
            if model.isBusy {
                ProgressView().controlSize(.small)
            }
            Spacer()
            switch model.step {
            case .details where provider == .grok:
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                // Reachable in EVERY unusable state, including a discovery
                // that failed outright and left no folder on screen — that
                // was a dead end with no way back (fix round 1).
                if model.offersGrokRetry {
                    Button("Check Again") {
                        Task { await model.discoverGrokHome(path: model.grokRetryPath) }
                    }
                    .disabled(model.isBusy)
                }
                Button("Connect") {
                    Task {
                        await model.connectGrok(
                            label: label,
                            purpose: purpose,
                            colorHex: color.hexString
                        )
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy
                    || model.grokCandidate?.canConnect != true
                    || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            case .details:
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create & Sign In") {
                    Task {
                        await model.begin(
                            provider: provider,
                            label: label,
                            purpose: purpose,
                            colorHex: color.hexString
                        )
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy
                    || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            case .signIn:
                Button("Cancel") { confirmingCancel = true }
                    .keyboardShortcut(.cancelAction)
                Button("I've Signed In — Verify") {
                    Task { await model.confirmSignedIn() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy)
            case .confirm:
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private var providerDisplayName: String {
        model.account.flatMap { DeckProvider.from($0.provider)?.displayName } ?? provider.displayName
    }

    /// Issue #560: the Grok half of the sheet, keyed on the account once one
    /// exists so the confirm step can't be misread as a Claude/Codex landing.
    private var isGrokFlow: Bool {
        (model.account.flatMap { DeckProvider.from($0.provider) } ?? provider) == .grok
    }

    private var title: String {
        switch model.step {
        // Step 1 is the same "add a subscription" for every provider — the
        // Connect verb belongs to the button and to step 2 (Tim's ruling).
        case .details: return "Add Subscription"
        case .signIn: return "Sign in to \(providerDisplayName)"
        case .confirm: return isGrokFlow ? "Grok is connected" : "Subscription added"
        }
    }

    /// Grok has no sign-in step to walk: two steps, not three.
    private var totalSteps: Int { isGrokFlow ? 2 : 3 }

    private var stepNumber: Int {
        switch model.step {
        case .details: return 1
        case .signIn: return 2
        case .confirm: return isGrokFlow ? 2 : 3
        }
    }
}
