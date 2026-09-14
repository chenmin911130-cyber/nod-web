import Capacitor
import Foundation

/// Lifts the brand mask once the web layer has painted its first real page.
///
/// The handshake is a notification rather than a direct call because the plugin ships in
/// its own pod and cannot see the app target's `LaunchOverlay`. Posting it with nothing
/// listening is a no-op, and so is a second `splashReady()` after the mask has gone —
/// which is what makes the web side free to be generous about when it signals.
@objc(NodSplashPlugin)
public class NodSplashPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NodSplashPlugin"
    public let jsName = "NodSplash"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "splashReady", returnType: CAPPluginReturnPromise),
    ]

    /// Kept in step with `BrandLaunch.readyNotificationName` in the App target.
    static let readyNotification = Notification.Name("NodSplashReady")

    @objc func splashReady(_ call: CAPPluginCall) {
        NotificationCenter.default.post(name: Self.readyNotification, object: nil)
        call.resolve()
    }
}
