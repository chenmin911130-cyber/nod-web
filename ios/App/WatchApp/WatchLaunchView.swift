import SwiftUI

// MARK: - Design constants

/// The launch composition's constants, all in the confirmed design frame
/// (851 x 1847 — `docs/design/brand/launch-screen.md`, the single geometry
/// source of truth).
///
/// The phone keeps the same numbers in `App/LaunchBrand.swift`. The Watch holds
/// its own copy under a watch-local name because the two targets share no file
/// and, more importantly, because the Watch does **not** use the phone's
/// `scaleAspectFit`: it fits one uniform scale into the dial (see
/// `WatchBrandLayout`). Values come from the design doc, never from eyeballing a
/// screenshot; they were checked one by one against `BrandLaunch` (mark ink,
/// wordmark ink box, gap, bar width/pitch/radius/half-heights, colours, breathing
/// loop) and agree.
enum WatchBrandGeometry {
    /// `web/public/logo.svg` ink box, brought to the design's 160-unit ink height
    /// (design x 178..309.28). The mark's shapes are never redrawn or stretched.
    static let markInkSize = CGSize(width: 131.282, height: 160)
    /// The wordmark's asset box in the design frame (x 355..676, y 762..838). The
    /// glyph ink sits at x 356..673.5 inside it, so the drawn ink is 317.5 wide and
    /// starts one unit in -- the same inset the phone's `BrandWordmark.pdf` carries.
    static let wordmarkInkSize = CGSize(width: 321, height: 76)
    /// Ink extents inside that box, matching the design raster and the phone asset.
    static let wordmarkInkInset: CGFloat = 1
    static let wordmarkInkWidth: CGFloat = 317.5
    /// The gap the design leaves between the mark's ink and the wordmark's ink.
    /// Together with the two ink boxes this is the composition's horizontal
    /// proportion: 45.72 : 131.282 + 45.72 + 321 = 45.72 : 497.98.
    static let gap: CGFloat = 45.72
    /// Waveform: 5 bars, 13 wide, 19 pitch, 6.5 corner radius, half-heights
    /// 11/17/27/17/11 (design y centre 1541.5).
    static let barWidth: CGFloat = 13
    static let barPitch: CGFloat = 19
    static let barRadius: CGFloat = 6.5
    static let barHalfHeights: [CGFloat] = [11, 17, 27, 17, 11]
    /// The design places the waveform's centre 0.62 x the mark's ink height below
    /// the mark's ink box (`launch-screen.md`, watch section).
    static let waveformGapRatio: CGFloat = 0.62
    /// The design frame centres the mark+wordmark row at 43.27% of its height
    /// (`cy = 799.5`); the Watch keeps that row centre and only shortens the
    /// waveform gap, because a dial has no room for the full 851x1847 rhythm.
    static let rowCentreRatio: CGFloat = 0.4327
    /// No bar may come within this distance of the dial's bottom edge: on a
    /// rounded dial that is where a bar would start to look clipped.
    static let bottomSafety: CGFloat = 12
    /// Side margin as a fraction of the dial's width. The dial's rounded corners
    /// eat into the extreme edges and the row is the widest thing on the page, so
    /// the row is inset instead of being scaled edge to edge.
    static let sideMarginRatio: CGFloat = 0.08
    static let topMarginRatio: CGFloat = 0.04

    /// The composition's full ink width in design units.
    static var rowWidth: CGFloat { markInkSize.width + gap + wordmarkInkSize.width }

    /// The tallest bar's half-height, in design units.
    static var maxBarHalfHeight: CGFloat { barHalfHeights.max() ?? 0 }

    /// The composition's full ink height in design units, at the design's own
    /// waveform gap. Used only as the vertical fit budget.
    static var compositionHeight: CGFloat {
        markInkSize.height + waveformGapRatio * markInkSize.height + maxBarHalfHeight
    }

    /// Breathing period and amplitude, seconds / fraction of each bar's
    /// half-height. These mirror `App/LaunchBrand.swift`'s loop (0.14 at 1.2 s)
    /// so the phone's and the Watch's launch pages breathe the same way, and stay
    /// under the issue's 0.18 ceiling. Deliberately small: brand motion, not a
    /// meter.
    static let waveformPeriod: Double = 1.2
    static let waveformAmplitude: Double = 0.14
    /// Per-bar stagger, seconds, applied outwards from the centre bar: enough that
    /// the row does not read as one block, and the same 0.12 s the phone uses.
    static let waveformStagger: Double = 0.12

    /// The animation angle for a wall-clock time. Kept here so the phase and the
    /// period stay next to each other.
    static func waveformPhase(at time: TimeInterval) -> Double {
        2 * .pi * time / waveformPeriod
    }

    /// One bar's half-height multiplier for `index` at `phase` (radians).
    ///
    /// A silent sine breathing around the design's own heights, staggered outwards
    /// from the centre bar. It carries no audio level and implies no recording;
    /// nothing here reads a microphone.
    static func waveformBreath(index: Int, phase: Double) -> CGFloat {
        let staggerAngle = 2 * Double.pi * waveformStagger / waveformPeriod
        let stepsFromCentre = abs(Double(index) - Double(barHalfHeights.count - 1) / 2)
        return 1 + waveformAmplitude * sin(phase - staggerAngle * stepsFromCentre)
    }
}

// MARK: - Layout

/// Where the mark, the wordmark and the five bars land on one dial size.
///
/// Everything is derived from a single uniform `scale`, so the composition can
/// never crop, wrap or distort; `size` is the whole usable dial because the
/// caller lets the page ignore the safe area.
struct WatchBrandLayout {
    let mark: CGRect
    let wordmark: CGRect
    /// Design units -> points, the same for both axes.
    let scale: CGFloat
    /// The waveform's centre line.
    let waveformCentre: CGPoint

    /// The bars in their still, design shape.
    var bars: [CGRect] { bars(phase: nil) }

    /// The five bars for one frame: `phase` is the animation angle in radians,
    /// `nil` is the design's own still shape.
    func bars(phase: Double?) -> [CGRect] {
        let g = WatchBrandGeometry.self
        return (0..<g.barHalfHeights.count).map { index in
            let breath = phase.map { g.waveformBreath(index: index, phase: $0) } ?? 1
            let half = g.barHalfHeights[index] * scale * breath
            let x = waveformCentre.x
                + (CGFloat(index) - CGFloat(g.barHalfHeights.count - 1) / 2) * g.barPitch * scale
                - g.barWidth * scale / 2
            return CGRect(x: x, y: waveformCentre.y - half, width: g.barWidth * scale, height: half * 2)
        }
    }

    /// The one place the composition's sizes are decided.
    ///
    /// A dial is round-cornered and much taller than it is wide, so the *width*
    /// is what binds on every shipping size; the height budget (which already
    /// includes the design's waveform gap) is the guard for a dial whose height
    /// would run out first. Either way there is a single uniform scale, so the
    /// mark keeps its aspect and the wordmark never wraps.
    static func layout(in size: CGSize) -> WatchBrandLayout {
        let g = WatchBrandGeometry.self
        let side = size.width * g.sideMarginRatio
        let top = size.height * g.topMarginRatio
        let available = CGSize(
            width: max(1, size.width - 2 * side),
            height: max(1, size.height - top - g.bottomSafety)
        )
        let scale = min(
            available.width / g.rowWidth,
            available.height / g.compositionHeight
        )

        let rowTop = size.height * g.rowCentreRatio - g.markInkSize.height * scale / 2
        let rowLeft = (size.width - g.rowWidth * scale) / 2
        let mark = CGRect(
            x: rowLeft,
            y: rowTop,
            width: g.markInkSize.width * scale,
            height: g.markInkSize.height * scale
        )
        // The design centres the wordmark's ink on the mark's ink (y 762..838
        // around the mark's 719.5..879.5).
        let wordmark = CGRect(
            x: rowLeft + (g.markInkSize.width + g.gap) * scale,
            y: rowTop + (g.markInkSize.height - g.wordmarkInkSize.height) / 2 * scale,
            width: g.wordmarkInkSize.width * scale,
            height: g.wordmarkInkSize.height * scale
        )

        // The waveform gap is the design's 0.62 x mark height, scaled with the
        // composition, then clamped to the two limits that matter on a dial:
        // it may not close up into the wordmark (floor: half the tallest bar),
        // and it may not open up until the lowest bar reaches the bottom safety
        // line (ceiling: whatever height is left under the row). On the 41 mm and
        // 45 mm dials the width drives the scale and there is ample height, so
        // neither clamp binds — the bars sit on the design's own gap — but the
        // guards keep a short dial from breaking the composition.
        let proportionalGap = g.waveformGapRatio * g.markInkSize.height * scale
        let floor = g.maxBarHalfHeight * scale * 0.5
        let ceiling = max(
            floor,
            size.height - g.bottomSafety
                - (rowTop + g.markInkSize.height * scale)
                - g.maxBarHalfHeight * scale
        )
        let gap = min(max(proportionalGap, floor), ceiling)

        let centre = CGPoint(
            x: rowLeft + g.rowWidth * scale / 2,
            y: rowTop + g.markInkSize.height * scale + gap
        )
        return WatchBrandLayout(mark: mark, wordmark: wordmark, scale: scale, waveformCentre: centre)
    }
}

// MARK: - The mark

/// `web/public/logo.svg`: two stroked paths plus a cyan dot, in the logo's own
/// 100x100 viewBox space. The geometry is reused verbatim — only a uniform
/// scale/translate is applied — so the Watch mark cannot drift from the web one.
enum WatchBrandMark {
    /// Stroke width of both paths in viewBox units.
    private static let strokeWidth: CGFloat = 9
    /// Ink box of the two strokes plus the dot, derived from the paths below:
    /// x 26-4.5 .. 81+4.5, y (32-13)-4.5 .. 88+4.5. The design doc's 21.24/14.24
    /// is the same box rounded by the tracker that measured it; the difference is
    /// 0.26 viewBox units (0.15 pt on a 41 mm dial).
    static let inkBox = CGRect(x: 21.5, y: 14.5, width: 64, height: 78)

    /// `M26 88 V32 A13 13 0 0 1 52 32 L78 58` and `M58 38 Q66 29 81 34 V60`,
    /// expanded to their stroked outlines.
    static func inkOutline() -> Path {
        var centreline = Path()
        centreline.move(to: CGPoint(x: 26, y: 88))
        centreline.addLine(to: CGPoint(x: 26, y: 32))
        // The shoulder: a 13-radius semicircle over the top, centred at (39, 32),
        // exactly as the SVG's arc draws it.
        centreline.addRelativeArc(
            center: CGPoint(x: 39, y: 32),
            radius: 13,
            startAngle: .degrees(180),
            delta: .degrees(180)
        )
        centreline.addLine(to: CGPoint(x: 78, y: 58))
        centreline.move(to: CGPoint(x: 58, y: 38))
        centreline.addQuadCurve(to: CGPoint(x: 81, y: 34), control: CGPoint(x: 66, y: 29))
        centreline.addLine(to: CGPoint(x: 81, y: 60))
        return centreline.strokedPath(
            StrokeStyle(lineWidth: strokeWidth, lineCap: .round, lineJoin: .round)
        )
    }

    /// `<circle cx="81" cy="70" r="4.5">` — the one cyan element of the mark.
    static func dot() -> Path {
        Path(ellipseIn: CGRect(x: 81 - 4.5, y: 70 - 4.5, width: 9, height: 9))
    }
}

// MARK: - The wordmark

/// The wordmark, transcribed from `tools/brand/compose.mjs` — the same glyph table
/// the phone draws from: rounded stems and true circle bowls, not a system font, so
/// the Watch renders the same letterforms as the phone at any size.
///
/// Local space (as built in `shapes()`): x 0..317.5, y 0..76 — the glyph ink box in
/// the design frame (design x 356..673.5, y 762..838), shifted right by one unit at
/// the end so it sits in the 321-wide asset box (design x 355..676). Vertically
/// 0 = ascender (762), 16 = x-height (778), 60 = baseline (822), 76 = the descender
/// of "p" (838).
///
/// The glyphs sit at the design's own x positions, so the inter-glyph gaps are the
/// design's measured 8/7/10/8/11/8/12 rather than one shared advance: a uniform gap
/// made the letters wider and the gaps tighter than the design. The counters are the
/// design's r 12 (r 12.5 in "p") — 24 units against a 44-unit x-height; an earlier
/// revision drew r 5.75 slivers, which made the bowls read as solid blobs.
enum WatchBrandWordmark {
    /// The design's two stem weights and its round dot.
    private static let thinStem: CGFloat = 9.5 // n, d, p
    private static let fullStem: CGFloat = 10 // i, l, t
    private static let dotRadius: CGFloat = 5.5
    /// The design's wordmark metrics in local units, shared with the layout audit.
    /// 0 is the ascender (design 762), `xHeightTop` the x-height (778), `baseline`
    /// the baseline (822) and `descender` the foot of "p" (838).
    static let xHeightTop: CGFloat = 16
    static let baseline: CGFloat = 60
    static let descender: CGFloat = 76
    private static let bowlCentreY: CGFloat = 38.25

    /// The wordmark's solid ink and its rings. Rings must be filled even-odd (the
    /// counter of each bowl is a second subpath) and solids must be filled
    /// normally, so the two never share a fill call: a bowl and a stem overlap
    /// ("d", "p") and even-odd would punch the overlap out.
    static func shapes() -> (ink: Path, rings: Path) {
        var ink = Path()
        var rings = Path()
        ink.addPath(n()) // n      ink x   0..39
        rings.addPath(bowl(centreX: 68.5, outer: 22, inner: 12)) // o      x  46.5..90.5
        ink.addPath(stem(x: 132, y: 0, height: baseline, width: thinStem)) // d stem
        rings.addPath(bowl(centreX: 119.5, outer: 22, inner: 12)) // d      x  97.5..141.5
        rings.addPath(bowl(centreX: 173, outer: 21.5, inner: 12.5)) // p bowl
        ink.addPath(stem(
            x: 152,
            y: bowlCentreY - 21.5,
            height: descender - (bowlCentreY - 21.5),
            width: thinStem
        )) // p      x 151.5..194.5
        ink.addPath(i()) // i      x 203..213
        ink.addPath(stem(x: 224, y: 0, height: baseline, width: fullStem)) // l      x 224..234
        rings.addPath(bowl(centreX: 263.5, outer: 22, inner: 12)) // o (2)  x 241.5..285.5
        ink.addPath(t()) // t      x 290..317.5
        // The asset box is one unit wider than the ink on the left, exactly as the
        // phone's asset is, so the finished ink carries the same inset.
        let inset = CGAffineTransform(translationX: WatchBrandGeometry.wordmarkInkInset, y: 0)
        return (ink.applying(inset), rings.applying(inset))
    }

    /// "n": a 9.5-wide stroke whose arch has the design's outer radius 19.5, so the
    /// apex lands exactly on the x-height (778) instead of towering over it.
    private static func n() -> Path {
        let outer: CGFloat = 19.5
        let r = outer - thinStem / 2 // 14.75: the arch's centreline
        let centreY = xHeightTop + outer // 35.5
        var centreline = Path()
        centreline.move(to: CGPoint(x: thinStem / 2, y: baseline))
        centreline.addLine(to: CGPoint(x: thinStem / 2, y: centreY))
        centreline.addRelativeArc(
            center: CGPoint(x: thinStem / 2 + r, y: centreY),
            radius: r,
            startAngle: .degrees(180),
            delta: .degrees(180)
        )
        centreline.addLine(to: CGPoint(x: thinStem / 2 + 2 * r, y: baseline))
        return centreline.strokedPath(
            StrokeStyle(lineWidth: thinStem, lineCap: .butt, lineJoin: .round)
        )
    }

    /// A bowl and its counter, as two subpaths for an even-odd fill. The counter is
    /// the design's r 12 (r 12.5 in "p"), i.e. a ~10-unit stroke, not the sliver an
    /// earlier revision drew.
    private static func bowl(centreX: CGFloat, outer: CGFloat, inner: CGFloat) -> Path {
        var path = Path()
        path.addEllipse(in: CGRect(
            x: centreX - outer,
            y: bowlCentreY - outer,
            width: outer * 2,
            height: outer * 2
        ))
        path.addEllipse(in: CGRect(
            x: centreX - inner,
            y: bowlCentreY - inner,
            width: inner * 2,
            height: inner * 2
        ))
        return path
    }

    private static func stem(x: CGFloat, y: CGFloat, height: CGFloat, width: CGFloat) -> Path {
        var path = Path()
        path.addRect(CGRect(x: x, y: y, width: width, height: height))
        return path
    }

    /// "i": the stem plus the design's round dot, centred on the stem.
    private static func i() -> Path {
        var path = stem(x: 203, y: xHeightTop, height: baseline - xHeightTop, width: fullStem)
        path.addEllipse(in: CGRect(
            x: 208 - dotRadius,
            y: 6 - dotRadius,
            width: dotRadius * 2,
            height: dotRadius * 2
        ))
        return path
    }

    /// "t": a 10-wide stem to the baseline and a stroke-weight exit to the ink's
    /// right edge (r 4). The bar — not a centred crossbar — is what makes the t as
    /// wide as the design; an r 9 bottom-left round used to read as a thick shoe.
    private static func t() -> Path {
        let stemLeft: CGFloat = 298
        let stemRight: CGFloat = 308
        let bend: CGFloat = 50
        // The bar ends exactly at the ink box's right edge, so the t defines the
        // wordmark's horizontal extent.
        let right = WatchBrandGeometry.wordmarkInkWidth
        let crossbarLeft: CGFloat = 290
        var path = Path()
        path.move(to: CGPoint(x: stemLeft, y: 4))
        path.addLine(to: CGPoint(x: stemRight, y: 4))
        path.addLine(to: CGPoint(x: stemRight, y: bend))
        path.addLine(to: CGPoint(x: right - 4, y: bend))
        path.addRelativeArc(
            center: CGPoint(x: right - 4, y: bend + 4),
            radius: 4,
            startAngle: .degrees(270),
            delta: .degrees(90)
        )
        path.addLine(to: CGPoint(x: right, y: baseline - 4))
        path.addRelativeArc(
            center: CGPoint(x: right - 4, y: baseline - 4),
            radius: 4,
            startAngle: .degrees(0),
            delta: .degrees(90)
        )
        path.addLine(to: CGPoint(x: stemLeft, y: baseline))
        path.closeSubpath()
        path.addRect(CGRect(
            x: crossbarLeft,
            y: xHeightTop,
            width: right - crossbarLeft,
            height: 9.5
        ))
        return path
    }
}

// MARK: - The gate

/// The rules that decide when the brand page may cover the app, and when its
/// waveform may move. Pure, so they can be reviewed without a Watch.
enum WatchLaunchGate {
    /// Should a launch show the brand page at all?
    ///
    /// A launch that already had a session on the wrist — recording or paused,
    /// which is exactly what the glance store the complication reads records —
    /// must go straight to the content. Restored sessions are otherwise only
    /// observable after `WCSession` activates, which is too late to keep the
    /// overlay from briefly covering a running session.
    static func overlayShows(startedAt: Date?, pausedElapsed: TimeInterval?) -> Bool {
        startedAt == nil && pausedElapsed == nil
    }

    /// May the overlay hand the screen back?
    ///
    /// Yes when a session is already live (the phone's application context or the
    /// Watch's own recorder filled the page in) or when `WCSession` finished
    /// activating. Activation is the app's only asynchronous cold-start step and
    /// it is local — it does not wait for the phone to answer, which is why the
    /// exit condition is not `reachable` and not a network round trip.
    static func contentReady(sessionLive: Bool, linkActivated: Bool) -> Bool {
        sessionLive || linkActivated
    }

    /// Always On and Reduce Motion both hold the waveform still. The launch page
    /// must never be the reason a dimmed screen keeps refreshing.
    static func waveformAnimates(dimmed: Bool, reduceMotion: Bool) -> Bool {
        !dimmed && !reduceMotion
    }

    /// Bounded safety exit, seconds.
    ///
    /// 8 s is not a taste call: `WatchPhoneSession.armStartWait` and
    /// `startOutcome` already treat 8000 ms as "the phone link is not coming", so
    /// a Watch that never finishes the launch handshake is bounded by the number
    /// this app already uses for that condition. After it, the overlay leaves and
    /// the existing Ready page (which works offline) is what the user sees.
    static let deadlineSeconds: TimeInterval = 8

    /// How often the launch handshake is re-checked while the overlay is up.
    static let pollNanoseconds: UInt64 = 50_000_000
}

// MARK: - The page

/// The brand launch page: the mark, the "nodpilot" wordmark and the waveform, on
/// pure black, drawn as real vectors (no rasterised asset, so it stays sharp at
/// every dial size).
///
/// It is shown only by `WatchRootView`, only on a genuine cold start, and only
/// until the page behind it can hold its own state.
struct WatchLaunchView: View {
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Force the still waveform. `\.accessibilityReduceMotion` is read-only, so a
    /// preview (or a layout/test harness) cannot inject it the way it can inject
    /// `\.isLuminanceReduced`; this is the seam for the Reduce Motion preview.
    /// The shipped page always reads the real environment values.
    var forcesStillWaveform = false

    private let ink = Color(red: 244 / 255, green: 248 / 255, blue: 252 / 255)
    private let cyan = Color(red: 0, green: 210 / 255, blue: 1)

    var body: some View {
        Group {
            if !forcesStillWaveform,
               WatchLaunchGate.waveformAnimates(dimmed: dimmed, reduceMotion: reduceMotion) {
                // Only the animated branch keeps a timeline alive: Always On and
                // Reduce Motion draw one still canvas.
                TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: false)) { timeline in
                    canvas(phase: WatchBrandGeometry.waveformPhase(
                        at: timeline.date.timeIntervalSinceReferenceDate
                    ))
                }
            } else {
                canvas(phase: nil)
            }
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Nodpilot")
    }

    private func canvas(phase: Double?) -> some View {
        Canvas { context, size in
            let layout = WatchBrandLayout.layout(in: size)
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
            drawMark(in: &context, layout: layout)
            drawWordmark(in: &context, layout: layout)
            drawWaveform(in: &context, layout: layout, phase: phase)
        }
    }

    private func drawMark(in context: inout GraphicsContext, layout: WatchBrandLayout) {
        let scale = layout.mark.width / WatchBrandMark.inkBox.width
        let transform = CGAffineTransform(translationX: layout.mark.minX, y: layout.mark.minY)
            .scaledBy(x: scale, y: scale)
            .translatedBy(x: -WatchBrandMark.inkBox.minX, y: -WatchBrandMark.inkBox.minY)
        context.fill(WatchBrandMark.inkOutline().applying(transform), with: .color(ink))
        context.fill(WatchBrandMark.dot().applying(transform), with: .color(cyan))
    }

    private func drawWordmark(in context: inout GraphicsContext, layout: WatchBrandLayout) {
        let scale = layout.wordmark.width / WatchBrandGeometry.wordmarkInkSize.width
        let transform = CGAffineTransform(translationX: layout.wordmark.minX, y: layout.wordmark.minY)
            .scaledBy(x: scale, y: scale)
        let shapes = WatchBrandWordmark.shapes()
        context.fill(shapes.ink.applying(transform), with: .color(ink))
        context.fill(
            shapes.rings.applying(transform),
            with: .color(ink),
            style: FillStyle(eoFill: true)
        )
    }

    private func drawWaveform(in context: inout GraphicsContext, layout: WatchBrandLayout, phase: Double?) {
        let radius = WatchBrandGeometry.barRadius * layout.scale
        for bar in layout.bars(phase: phase) {
            context.fill(Path(roundedRect: bar, cornerRadius: radius), with: .color(cyan))
        }
    }
}

// MARK: - Layout evidence

#if DEBUG
extension WatchBrandLayout {
    /// The numbers a reviewer needs to check the two shipping dials without a
    /// Watch: the rects for the mark, the wordmark and every bar, the wordmark's
    /// rendered x-height and the clearance under the lowest bar.
    static func audit(_ size: CGSize) -> String {
        let layout = layout(in: size)
        let bars = layout.bars
        let bottom = bars.map(\.maxY).max() ?? 0
        let clearance = size.height - bottom
        func rect(_ value: CGRect) -> String {
            String(
                format: "x %7.2f  y %7.2f  w %7.2f  h %7.2f",
                value.minX, value.minY, value.width, value.height
            )
        }
        var lines = [
            String(format: "dial %.0fx%.0f  scale %.4f", size.width, size.height, layout.scale),
            "  mark        \(rect(layout.mark))",
            "  wordmark    \(rect(layout.wordmark))",
        ]
        for (index, bar) in bars.enumerated() {
            lines.append("  bar \(index)      \(rect(bar))")
        }
        // The wordmark's local units are the design frame's units, so `scale`
        // converts its metrics to points directly.
        lines.append(String(
            format: "  wordmark x-height %.2f pt, ascender %.2f pt, ink height %.2f pt",
            (WatchBrandWordmark.baseline - WatchBrandWordmark.xHeightTop) * layout.scale,
            WatchBrandWordmark.baseline * layout.scale,
            WatchBrandWordmark.descender * layout.scale
        ))
        lines.append(String(
            format: "  lowest bar bottom %.2f pt, clearance %.2f pt — 12 pt rule %@",
            bottom, clearance, clearance >= WatchBrandGeometry.bottomSafety ? "met" : "VIOLATED"
        ))
        let waveTop = bars.map(\.minY).min() ?? 0
        lines.append(String(
            format: "  wordmark ink bottom %.2f pt, air under the mark/wordmark %.2f pt",
            layout.wordmark.maxY, waveTop - layout.wordmark.maxY
        ))
        return lines.joined(separator: "\n")
    }
}

struct WatchLaunchView_Previews: PreviewProvider {
    static var previews: some View {
        WatchLaunchView()
            .previewDevice("Apple Watch Series 9 (41mm)")
        WatchLaunchView()
            .previewDevice("Apple Watch Series 9 (45mm)")
        // Always On: the waveform must hold still.
        WatchLaunchView()
            .previewDevice("Apple Watch Series 9 (45mm)")
            .environment(\.isLuminanceReduced, true)
        // Reduce Motion: same rule, user-chosen. The value cannot be injected, so
        // the preview uses the view's own still-frame seam.
        WatchLaunchView(forcesStillWaveform: true)
            .previewDevice("Apple Watch Series 9 (41mm)")
            .onAppear {
                // Printed sizes are the two dial point sizes the acceptance calls
                // out; the preview devices above resolve to their own dial and are
                // here for the small/large visual check.
                print("-- 40 mm (162 x 197)")
                print(WatchBrandLayout.audit(CGSize(width: 162, height: 197)))
                print("-- 45 mm (198 x 242)")
                print(WatchBrandLayout.audit(CGSize(width: 198, height: 242)))
            }
    }
}
#endif
