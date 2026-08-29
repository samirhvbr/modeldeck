// generate-grok-provider-icon.swift — the Grok deck-column provider icon.
//
// Claude's and Codex's provider icons (issue #103) are the installed desktop
// apps' own .icns renders. Grok has no such app to extract from, so its icon
// is rendered here instead: the official Grok mark (path data from
// @lobehub/icons-static-svg grok.svg, viewBox 24, the same vector xAI ships
// in its own products) drawn white on the Grok-brand black rounded square,
// on Apple's icon grid — the same squircle-on-transparent-margin shape the
// extracted icons carry, so all three read as one family in the deck.
//
// Deterministically renders provider-grok-{32,64,128}.png into
// macos/ModelDeckMac/Sources/ModelDeckMacCore/Resources/. The PNGs are
// committed and digest-pinned in ProviderIconTests; rerun this and update
// the digests whenever the mark changes. Run from the repo root:
//
//   swiftc -o /tmp/generate-grok-provider-icon \
//     macos/ModelDeckMac/Sources/ModelDeckMacCore/SVGPath.swift \
//     scripts/generate-grok-provider-icon.swift \
//     && /tmp/generate-grok-provider-icon
//
// It compiles against the package's own SVGPath parser, so the committed
// asset is provably a render of the committed path data. Each size is drawn
// vectorially at its own pixel size — no downscaled master.

import AppKit

// Official Grok mark (lobehub icons-static-svg, viewBox 24), with the two
// arc-flag clusters expanded since SVGPath doesn't lex run-together forms
// like "00-1.829".
let grokPathData = "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 0 0-1.829-1A8.975 8.975 0 0 0 5.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"

@main
struct GenerateGrokProviderIcon {
    static func main() {
        guard let mark = SVGPath.cgPath(grokPathData) else {
            fputs("generate-grok-provider-icon: SVGPath rejected the mark's path data\n", stderr)
            exit(1)
        }

        let outputDir = URL(fileURLWithPath: "macos/ModelDeckMac/Sources/ModelDeckMacCore/Resources")
        guard FileManager.default.fileExists(atPath: outputDir.path) else {
            fputs("generate-grok-provider-icon: run from the repo root (missing \(outputDir.path))\n", stderr)
            exit(1)
        }

        for pixels in [32, 64, 128] {
            let data = renderIcon(mark: mark, pixels: pixels)
            let url = outputDir.appendingPathComponent("provider-grok-\(pixels).png")
            do {
                try data.write(to: url)
                print("wrote \(url.path)")
            } catch {
                fputs("generate-grok-provider-icon: \(error)\n", stderr)
                exit(1)
            }
        }
    }

    static func renderIcon(mark: CGPath, pixels: Int) -> Data {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels,
            pixelsHigh: pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .calibratedRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            fputs("generate-grok-provider-icon: could not create bitmap rep (\(pixels)px)\n", stderr)
            exit(1)
        }

        NSGraphicsContext.saveGraphicsState()
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            fputs("generate-grok-provider-icon: could not create graphics context (\(pixels)px)\n", stderr)
            exit(1)
        }
        NSGraphicsContext.current = context

        let size = CGFloat(pixels)
        // Apple icon grid, same as scripts/generate-app-icon.swift: the tile
        // spans 824/1024 of the canvas with radius 185.4/1024, leaving the
        // transparent margin ProviderIconTests requires.
        let tileSide = size * 824 / 1024
        let cornerRadius = size * 185.4 / 1024
        let tileOrigin = (size - tileSide) / 2
        let tileRect = NSRect(x: tileOrigin, y: tileOrigin, width: tileSide, height: tileSide)
        NSColor.black.setFill()
        NSBezierPath(roundedRect: tileRect, xRadius: cornerRadius, yRadius: cornerRadius).fill()

        // White mark centered on the tile, sized to ~62% of the tile so it
        // sits with the same visual weight as the extracted icons' glyphs.
        let cg = context.cgContext
        let bounds = mark.boundingBoxOfPath
        let scale = tileSide * 0.62 / max(bounds.width, bounds.height)
        cg.saveGState()
        // SVG y grows downward; the bitmap context grows upward — flip.
        cg.translateBy(
            x: tileRect.midX - bounds.midX * scale,
            y: tileRect.midY + bounds.midY * scale
        )
        cg.scaleBy(x: scale, y: -scale)
        cg.addPath(mark)
        cg.setFillColor(.white)
        cg.fillPath()
        cg.restoreGState()

        NSGraphicsContext.current?.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()

        guard let png = rep.representation(using: .png, properties: [:]) else {
            fputs("generate-grok-provider-icon: PNG encode failed (\(pixels)px)\n", stderr)
            exit(1)
        }
        return png
    }
}
