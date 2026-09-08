import SwiftUI

/// Five rounded bars: Ready breathe, Watch-mic level, or a static mid height.
struct WaveBars: View {
    enum Mode: Equatable {
        case breathe
        case level(Float)
        case still
    }

    let mode: Mode
    var animating: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    private var frozen: Bool {
        reduceMotion || luminanceReduced || !animating
    }

    var body: some View {
        GeometryReader { geo in
            let maxH = geo.size.height
            let gap = max(1.0, geo.size.width * 0.12)
            let barW = max(2.0, (geo.size.width - gap * 4) / 5)
            if frozen || stillMode {
                bars(Self.stillHeights, barW: barW, maxH: maxH, gap: gap)
            } else if case .level(let level) = mode {
                bars(Self.levelHeights(level), barW: barW, maxH: maxH, gap: gap)
            } else {
                TimelineView(.periodic(from: .now, by: 1.0 / 15.0)) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3.8) / 3.8
                    bars(Self.breatheHeights(phase: phase), barW: barW, maxH: maxH, gap: gap)
                }
            }
        }
    }

    private var stillMode: Bool {
        if case .still = mode { return true }
        return false
    }

    private func bars(_ heights: [CGFloat], barW: CGFloat, maxH: CGFloat, gap: CGFloat) -> some View {
        HStack(alignment: .center, spacing: gap) {
            ForEach(0..<5, id: \.self) { i in
                Capsule()
                    .frame(width: barW, height: max(2, maxH * heights[i]))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    static func breatheHeights(phase: Double) -> [CGFloat] {
        (0..<5).map { i in
            let wave = 0.5 + 0.28 * sin(2 * .pi * (phase + Double(i) * 0.14))
            return CGFloat(wave)
        }
    }

    static let stillHeights: [CGFloat] = [0.42, 0.62, 0.50, 0.68, 0.46]

    static func levelHeights(_ level: Float) -> [CGFloat] {
        let l = CGFloat(max(0, min(1, level)))
        let weights: [CGFloat] = [0.40, 0.72, 1.0, 0.72, 0.40]
        return weights.map { 0.18 + $0 * 0.82 * l }
    }
}
