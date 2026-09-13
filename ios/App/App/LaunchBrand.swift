import CoreGraphics
import Foundation

/// Geometry for the Nod brand launch composition — the single source of truth for the
/// static launch image, the in-app mask that follows it, and the watch app.
///
/// Everything is authored in the confirmed design frame (851 x 1847,
/// `docs/design/brand/launch-screen.md`). A screen maps that frame with aspect-fill +
/// centring (`mapping(in:)`), exactly like the launch storyboard's `scaleAspectFill`,
/// so the pieces register on top of the composition bitmap.
///
/// Deliberately free of UIKit so it also compiles for watchOS; the handful of drawing
/// helpers that do need UIKit live in the guarded extension at the bottom.
enum BrandLaunch {

    // MARK: - Design frame

    static let frameWidth: CGFloat = 851
    static let frameHeight: CGFloat = 1847

    /// Vertical centre of the mark + wordmark block.
    static let compositionCentreY: CGFloat = 799.5

    // MARK: - Mark

    /// The mark's ink box in `web/public/logo.svg` units: the two strokes are 9 wide
    /// with round caps, so the round cap at (26, 88) and the arc apex at (39, 19)
    /// bound the ink.
    static let logoInk = CGRect(x: 21.5, y: 14.5, width: 64, height: 78)

    /// Ink height and width from the design spec. The logo's own aspect ratio
    /// (64:78 = 0.820513) follows from the height, so the mark is never stretched;
    /// the scale below is derived from the width so the asset's box is exactly
    /// 131.282 x 160 and the cut lands exactly on the logo's ink.
    static let markHeight: CGFloat = 160
    static let markWidth: CGFloat = 131.282

    /// Exactly `markWidth / logoInk.width` = 2.05128125. The composition SVG rounds this
    /// to 2.051, which shaves ~0.5 pt off the far side of the mark.
    static let logoScale: CGFloat = markWidth / logoInk.width

    /// Mark ink box, straight from the design note. The confirmed design raster
    /// (`launch-851x1847.png`) measures 178.0 x 720.0 for its top-left corner, so this
    /// box registers with it to within half a point.
    static let markRect = CGRect(x: 178, y: 719.5, width: markWidth, height: markHeight)

    // MARK: - Wordmark

    /// The crop box the `BrandWordmark` asset was authored in — the design note's
    /// ink box, and the `viewBox` of `docs/design/brand/wordmark.svg`. The eight glyphs
    /// measure x 356.0 .. 673.5, y 762 .. 838, so they sit inside it untouched.
    static let wordmarkRect = CGRect(x: 355, y: 762, width: 321, height: 76)

    /// Baseline and x-height of the wordmark, for anyone drawing it from primitives.
    static let wordmarkBaseline: CGFloat = 822
    static let wordmarkXHeight: CGFloat = 778

    /// The mark + wordmark block the watch lays out (`docs/design/brand/launch-screen.md`
    /// quotes it as roughly 497 x 160).
    static let compositionRect = markRect.union(wordmarkRect)

    // MARK: - Waveform

    static let waveformCentreY: CGFloat = 1541.5
    static let barCount = 5
    static let barWidth: CGFloat = 13
    static let barPitch: CGFloat = 19
    static let barCornerRadius: CGFloat = 6.5
    static let firstBarX: CGFloat = 381
    static let barHalfHeights: [CGFloat] = [11, 17, 27, 17, 11]

    /// Centre of bar `index` inside the design frame; the bars sit in 19 pt slots.
    static func barCentreX(_ index: Int) -> CGFloat {
        firstBarX + CGFloat(index) * barPitch + barWidth / 2
    }

    static func barHalfHeight(_ index: Int) -> CGFloat {
        guard barHalfHeights.indices.contains(index) else { return 0 }
        return barHalfHeights[index]
    }

    static func barRect(_ index: Int) -> CGRect {
        CGRect(
            x: firstBarX + CGFloat(index) * barPitch,
            y: waveformCentreY - barHalfHeight(index),
            width: barWidth,
            height: 2 * barHalfHeight(index)
        )
    }

    // MARK: - Breathing loop

    /// Ambience, not a meter: this animates while the app is merely initialising, so it
    /// must never look like it is reading audio. Small amplitude, slow period, and the
    /// bars stagger outwards from the centre so the loop reads as a breath.
    static let breathAmplitude: CGFloat = 0.14
    static let breathPeriod: TimeInterval = 1.2
    static let barStagger: TimeInterval = 0.12

    /// Vertical scale for bar `index` at `time` seconds into the loop. The bar's centre
    /// stays on `waveformCentreY` because the scale is applied about the layer's centre.
    static func breathScale(_ index: Int, at time: TimeInterval) -> CGFloat {
        let omega = 2 * Double.pi / breathPeriod
        let stepsFromCentre = abs(Double(index) - Double(barCount - 1) / 2)
        let phase = omega * stepsFromCentre * barStagger
        return 1 + breathAmplitude * CGFloat(sin(omega * time - phase))
    }

    // MARK: - Design -> screen mapping

    /// Aspect-fill + centre, matching the launch storyboard's `scaleAspectFill`.
    struct Mapping: Equatable {
        let scale: CGFloat
        let offsetX: CGFloat
        let offsetY: CGFloat

        func length(_ value: CGFloat) -> CGFloat { value * scale }

        func point(x: CGFloat, y: CGFloat) -> CGPoint {
            CGPoint(x: x * scale + offsetX, y: y * scale + offsetY)
        }

        func point(_ design: CGPoint) -> CGPoint { point(x: design.x, y: design.y) }

        func rect(_ design: CGRect) -> CGRect {
            CGRect(
                x: design.origin.x * scale + offsetX,
                y: design.origin.y * scale + offsetY,
                width: design.width * scale,
                height: design.height * scale
            )
        }

        /// Inverse of `point(x:y:)`, for hit-testing and for verification output.
        func designPoint(_ screen: CGPoint) -> CGPoint {
            CGPoint(x: (screen.x - offsetX) / scale, y: (screen.y - offsetY) / scale)
        }
    }

    /// `scale = min(w / 851, h / 1847)`, then centre the scaled frame in `bounds`.
    ///
    /// Fit rather than fill: on a screen narrower than the design's 851:1847 the frame
    /// scales to the width and leaves black above and below, so the composition keeps
    /// the design's own proportions -- the mark at 8.66% of the visible height and the
    /// waveform centre at 83.4% -- on every phone. Filling instead would crop the sides
    /// on 19.5:9 and scale everything up ~22% on a 16:9 screen, which pushes the
    /// waveform to 90.8% of the height. The letterbox is invisible: both the launch
    /// image's frame and the mask behind it are pure black.
    static func mapping(in bounds: CGRect) -> Mapping {
        let scale = min(bounds.width / frameWidth, bounds.height / frameHeight)
        return Mapping(
            scale: scale,
            offsetX: bounds.minX + (bounds.width - frameWidth * scale) / 2,
            offsetY: bounds.minY + (bounds.height - frameHeight * scale) / 2
        )
    }

    // MARK: - Readiness handshake

    /// Name of the notification the `NodSplash` Capacitor plugin posts once the first real
    /// web page is on screen; the phone mask listens for it. The plugin ships in its own
    /// pod and cannot import this target, so the same literal appears in
    /// `NodSplashPlugin.swift` — keep the two in step.
    static let readyNotificationName = "NodSplashReady"

    // MARK: - Colours (components, so watchOS can use them without UIKit)

    /// `#000000`
    static let backgroundRGB: (red: CGFloat, green: CGFloat, blue: CGFloat) = (0, 0, 0)
    /// `#f4f8fc` — mark and wordmark.
    static let inkRGB: (red: CGFloat, green: CGFloat, blue: CGFloat) = (244.0 / 255, 248.0 / 255, 252.0 / 255)
    /// `#00d2ff` — the mark's dot and the waveform.
    static let accentRGB: (red: CGFloat, green: CGFloat, blue: CGFloat) = (0, 210.0 / 255, 1)

    // MARK: - Vector paths (design frame)

    /// Places the logo's own ink box on `markRect`: a uniform scale (never stretched),
    /// then the offset that puts the ink's top-left corner exactly on the box.
    private static let logoToDesign = CGAffineTransform(scaleX: logoScale, y: logoScale)
        .concatenating(CGAffineTransform(
            translationX: markRect.minX - logoInk.minX * logoScale,
            y: markRect.minY - logoInk.minY * logoScale
        ))

    /// The mark's ink outline: `logo.svg`'s two strokes, stroked 9 units wide with round
    /// caps and joins and placed in the design frame.
    static let markPath: CGPath = {
        let stroke = CGMutablePath()
        stroke.move(to: CGPoint(x: 26, y: 88))
        stroke.addLine(to: CGPoint(x: 26, y: 32))
        // The arch over the stem: centre (39, 32), sweeping through the apex (39, 19).
        stroke.addArc(center: CGPoint(x: 39, y: 32), radius: 13, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
        stroke.addLine(to: CGPoint(x: 78, y: 58))
        stroke.move(to: CGPoint(x: 58, y: 38))
        stroke.addQuadCurve(to: CGPoint(x: 81, y: 34), control: CGPoint(x: 66, y: 29))
        stroke.addLine(to: CGPoint(x: 81, y: 60))
        return stroke.copy(strokingWithWidth: 9, lineCap: .round, lineJoin: .round, miterLimit: 10, transform: logoToDesign)
    }()

    /// The accent dot under the mark.
    static let markDotPath: CGPath = {
        var transform = logoToDesign
        return CGPath(
            ellipseIn: CGRect(x: 81 - 4.5, y: 70 - 4.5, width: 9, height: 9),
            transform: &transform
        )
    }()

    /// The `nodpilot` wordmark's solid glyphs — `n d p i l t` — transcribed from the
    /// eight glyphs of `docs/design/brand/wordmark.svg` (the design raster
    /// `launch-851x1847.png` measures them at x 356…673.5, y 762…838). Fill with the
    /// **non-zero** rule: a `d`/`p` stem sits inside its bowl, and even-odd would punch
    /// the overlap out.
    static let wordmarkSolidsPath: CGPath = {
        let p = CGMutablePath()

        // n — a 10 pt stem pair joined by one 19.5 pt arch whose apex is the x-height.
        // The SVG's own inner counter arc is under-sized for its chord, so renderers
        // scale it up and the arch grows past the ascender line; this is the exact
        // inward offset of the outer arch instead (outer r 19.5 / inner r 9.5 about
        // (375.5, 797.5)), which also matches the design raster's 39 pt-wide "n".
        p.move(to: CGPoint(x: 356, y: 822))
        p.addLine(to: CGPoint(x: 356, y: 797.5))
        p.addArc(center: CGPoint(x: 375.5, y: 797.5), radius: 19.5, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
        p.addLine(to: CGPoint(x: 395, y: 822))
        p.addLine(to: CGPoint(x: 385, y: 822))
        p.addLine(to: CGPoint(x: 385, y: 797.5))
        p.addArc(center: CGPoint(x: 375.5, y: 797.5), radius: 9.5, startAngle: 0, endAngle: -.pi, clockwise: true)
        p.addLine(to: CGPoint(x: 366, y: 822))
        p.closeSubpath()

        // d stem
        p.addRect(CGRect(x: 488, y: 762, width: 9.5, height: 60))
        // p stem (the descender reaches 838)
        p.addRect(CGRect(x: 508, y: 778, width: 9.5, height: 60))
        // i and its dot
        p.addRect(CGRect(x: 559, y: 778, width: 10, height: 43))
        p.addEllipse(in: CGRect(x: 564 - 5.5, y: 768 - 5.5, width: 11, height: 11))
        // l
        p.addRect(CGRect(x: 580, y: 762, width: 10, height: 59))
        // t — stem to the baseline, stroke-weight exit to x 673.5 (r 4). The old
        // r 9 bottom-left round stopped the stem at the bar and read as a shoe.
        p.move(to: CGPoint(x: 654, y: 766))
        p.addLine(to: CGPoint(x: 664, y: 766))
        p.addLine(to: CGPoint(x: 664, y: 812))
        p.addLine(to: CGPoint(x: 669.5, y: 812))
        appendArc(p, to: CGPoint(x: 673.5, y: 816), radius: 4, largeArc: false, sweep: false)
        p.addLine(to: CGPoint(x: 673.5, y: 818))
        appendArc(p, to: CGPoint(x: 669.5, y: 822), radius: 4, largeArc: false, sweep: false)
        p.addLine(to: CGPoint(x: 654, y: 822))
        p.closeSubpath()
        p.addRect(CGRect(x: 646, y: 778, width: 27.5, height: 9.5))

        return p
    }()

    /// The wordmark's ring glyphs — `o`, the `d` bowl, the `p` bowl, and the second `o`.
    /// Each ring is two concentric circles, so this one needs the **even-odd** rule.
    static let wordmarkRingsPath: CGPath = {
        let p = CGMutablePath()
        addRing(to: p, centerX: 424.5, centerY: 800.25, outer: 22, inner: 12)
        addRing(to: p, centerX: 475.5, centerY: 800.25, outer: 22, inner: 12)
        addRing(to: p, centerX: 529, centerY: 800.25, outer: 21.5, inner: 12.5)
        addRing(to: p, centerX: 619.5, centerY: 800.25, outer: 22, inner: 12)
        return p
    }()

    private static func addRing(to path: CGMutablePath, centerX: CGFloat, centerY: CGFloat, outer: CGFloat, inner: CGFloat) {
        path.addEllipse(in: CGRect(x: centerX - outer, y: centerY - outer, width: 2 * outer, height: 2 * outer))
        path.addEllipse(in: CGRect(x: centerX - inner, y: centerY - inner, width: 2 * inner, height: 2 * inner))
    }

    /// Appends one SVG elliptical arc (`A rx ry rot largeArc sweep x y`, with `rot = 0`)
    /// from the path's current point, following the spec's endpoint-to-centre conversion —
    /// including the rule that a radius too small for the chord is scaled up until it fits.
    /// Transcribing the wordmark this way keeps the code reading like the SVG source.
    private static func appendArc(_ path: CGMutablePath, to end: CGPoint, radius: CGFloat, largeArc: Bool, sweep: Bool) {
        let start = path.currentPoint
        guard start != end else { return }
        let half = CGPoint(x: (start.x - end.x) / 2, y: (start.y - end.y) / 2)
        let distance = half.x * half.x + half.y * half.y
        var r = radius
        if distance > r * r { r = distance.squareRoot() }
        let numerator = max(0, r * r - distance)
        let k = distance > 0 ? (numerator / distance).squareRoot() : 0
        let sign: CGFloat = largeArc != sweep ? 1 : -1
        let center = CGPoint(
            x: sign * k * half.y + (start.x + end.x) / 2,
            y: -sign * k * half.x + (start.y + end.y) / 2
        )
        let startAngle = atan2(start.y - center.y, start.x - center.x)
        let endAngle = atan2(end.y - center.y, end.x - center.x)
        var delta = endAngle - startAngle
        if sweep && delta < 0 { delta += 2 * .pi }
        if !sweep && delta > 0 { delta -= 2 * .pi }
        path.addArc(center: center, radius: r, startAngle: startAngle, endAngle: startAngle + delta, clockwise: delta < 0)
    }
}

#if canImport(UIKit) && !os(watchOS)
import UIKit

extension BrandLaunch {

    static var backgroundColor: UIColor {
        UIColor(red: backgroundRGB.red, green: backgroundRGB.green, blue: backgroundRGB.blue, alpha: 1)
    }

    static var inkColor: UIColor {
        UIColor(red: inkRGB.red, green: inkRGB.green, blue: inkRGB.blue, alpha: 1)
    }

    static var accentColor: UIColor {
        UIColor(red: accentRGB.red, green: accentRGB.green, blue: accentRGB.blue, alpha: 1)
    }

    /// One waveform bar layer, positioned at its design slot and ready to breathe.
    /// Only `transform` ever changes, so the bar's centre stays put for the whole loop.
    static func barLayer(index: Int, mapping: Mapping) -> CALayer {
        let layer = CALayer()
        layer.backgroundColor = accentColor.cgColor
        layer.bounds = CGRect(
            x: 0,
            y: 0,
            width: mapping.length(barWidth),
            height: 2 * mapping.length(barHalfHeight(index))
        )
        layer.position = mapping.point(x: barCentreX(index), y: waveformCentreY)
        layer.cornerRadius = mapping.length(barCornerRadius)
        // The loop drives `transform` at display-link rate; implicit animations would
        // lag a quarter second behind every frame.
        layer.actions = ["transform": NSNull(), "position": NSNull(), "bounds": NSNull()]
        return layer
    }
}
#endif
