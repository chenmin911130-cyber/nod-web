import ClockKit
import UIKit

final class ComplicationController: NSObject, CLKComplicationDataSource {
    static let descriptorId = "nod-timer"

    static func reload() {
        let server = CLKComplicationServer.sharedInstance()
        for item in server.activeComplications ?? [] {
            server.reloadTimeline(for: item)
        }
    }

    func getComplicationDescriptors(handler: @escaping ([CLKComplicationDescriptor]) -> Void) {
        handler([
            CLKComplicationDescriptor(
                identifier: Self.descriptorId,
                displayName: "Nodpilot Timer",
                supportedFamilies: [
                    .circularSmall,
                    .modularSmall,
                    .utilitarianSmall,
                    .utilitarianLarge,
                    .graphicCircular,
                    .graphicCorner,
                    .graphicRectangular,
                ]
            ),
        ])
    }

    func handleSharedComplicationDescriptors(_ complicationDescriptors: [CLKComplicationDescriptor]) {}

    func getCurrentTimelineEntry(
        for complication: CLKComplication,
        withHandler handler: @escaping (CLKComplicationTimelineEntry?) -> Void
    ) {
        handler(CLKComplicationTimelineEntry(date: Date(), complicationTemplate: template(for: complication.family)))
    }

    func getTimelineEndDate(for complication: CLKComplication, withHandler handler: @escaping (Date?) -> Void) {
        handler(WatchGlanceStore.startedAt()?.addingTimeInterval(60 * 60 * 3) ?? Date())
    }

    func getPrivacyBehavior(
        for complication: CLKComplication,
        withHandler handler: @escaping (CLKComplicationPrivacyBehavior) -> Void
    ) {
        handler(.showOnLockScreen)
    }

    private func template(for family: CLKComplicationFamily) -> CLKComplicationTemplate {
        let started = WatchGlanceStore.startedAt()
        let paused = WatchGlanceStore.pausedElapsed()
        let text: CLKTextProvider
        if let started {
            text = CLKRelativeDateTextProvider(date: started, style: .timer, units: [.hour, .minute, .second])
        } else if let paused {
            text = CLKSimpleTextProvider(text: clock(paused))
        } else {
            text = CLKSimpleTextProvider(text: "Nodpilot")
        }
        let image = CLKImageProvider(onePieceImage: markImage())
        image.tintColor = UIColor(red: 0, green: 210 / 255, blue: 1, alpha: 1)
        let colorImage = CLKFullColorImageProvider(fullColorImage: markImage())

        switch family {
        case .circularSmall:
            return CLKComplicationTemplateCircularSmallStackImage(line1ImageProvider: image, line2TextProvider: text)
        case .modularSmall:
            return CLKComplicationTemplateModularSmallStackImage(line1ImageProvider: image, line2TextProvider: text)
        case .utilitarianSmall:
            return CLKComplicationTemplateUtilitarianSmallFlat(textProvider: text, imageProvider: image)
        case .utilitarianLarge:
            return CLKComplicationTemplateUtilitarianLargeFlat(textProvider: text, imageProvider: image)
        case .graphicCircular:
            return CLKComplicationTemplateGraphicCircularStackImage(line1ImageProvider: colorImage, line2TextProvider: text)
        case .graphicCorner:
            return CLKComplicationTemplateGraphicCornerCircularImage(imageProvider: colorImage)
        case .graphicRectangular:
            let header = CLKComplicationTemplateGraphicRectangularStandardBody(
                headerTextProvider: CLKSimpleTextProvider(text: paused != nil ? WatchCopy.paused : WatchCopy.listening),
                body1TextProvider: text
            )
            header.headerImageProvider = colorImage
            return header
        default:
            return CLKComplicationTemplateGraphicCircularStackImage(line1ImageProvider: colorImage, line2TextProvider: text)
        }
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let sec = max(0, Int(seconds))
        let h = sec / 3600
        let m = (sec % 3600) / 60
        let s = sec % 60
        if h > 0 {
            return "\(h):\(String(format: "%02d", m)):\(String(format: "%02d", s))"
        }
        return "\(String(format: "%02d", m)):\(String(format: "%02d", s))"
    }

    private func markImage() -> UIImage {
        let config = UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
        return UIImage(systemName: "waveform", withConfiguration: config) ?? UIImage()
    }
}
