import SwiftUI
import ModelDeckMacCore

/// Provider identification on deck cards, column headers, and the Settings
/// accounts roster: the official desktop-app icons — Claude.app's icon for
/// Claude, ChatGPT.app's icon for Codex (issue #103, Tim directive
/// 2026-07-21; spec "Provider marks" row, amended same day), and the
/// official Grok mark on its brand-black tile for Grok.
///
/// The bundled artwork carries the macOS squircle-on-transparent-margin
/// shape (the apps' own `.icns` renders for Claude/Codex; a matching
/// generated tile for Grok) — rendered as-is, no chip backing or extra
/// masking, in the same layout slots the previous vector marks used.
struct ProviderMarkView: View {
    let provider: DeckProvider
    var size: CGFloat = 20

    var body: some View {
        Group {
            if let icon = ProviderIcons.image(for: provider) {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                // A built app somehow missing the resource: the slot keeps
                // its size and carries the provider's initial, so the header
                // reads as a provider mark rather than a gap.
                RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                    .fill(Color(nsColor: .quaternarySystemFill))
                    .overlay(
                        Text(provider.displayName.prefix(1))
                            .font(.system(size: size * 0.56, weight: .semibold))
                            .foregroundStyle(.secondary)
                    )
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(provider.displayName)
    }
}
