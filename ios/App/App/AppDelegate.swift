import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// The brand mask for this cold launch; nil once it has faded out (or if it was never
    /// installed). A hot resume must never build another one.
    private var launchOverlay: LaunchOverlay?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        DispatchQueue.main.async {
            self.makeWebViewFeelNative()
            self.installLaunchOverlay()
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
        launchOverlay?.applicationWillResignActive()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        makeWebViewFeelNative()
        launchOverlay?.applicationDidBecomeActive()
    }

    /// Cold launch only. The mask covers the gap between the static launch screen and the
    /// first page the web layer has painted; `hasRevealedInThisProcess` keeps a scene
    /// restoration or a background relaunch from replaying the brand over live content,
    /// and `applicationDidBecomeActive` never installs one.
    private func installLaunchOverlay() {
        guard launchOverlay == nil, !LaunchOverlay.hasRevealedInThisProcess else { return }
        guard let window = window else { return }
        let overlay = LaunchOverlay(frame: window.bounds)
        // Hand the mask the bridge's web view so, at its safety timeout, it can tell a
        // slow-but-alive start from a dead one instead of uncovering a blank page (#227),
        // plus the URL Capacitor itself boots from — the last-resort target a retry falls
        // back to when no navigation ever committed a URL.
        if let controller = window.rootViewController as? CAPBridgeViewController,
           let webView = controller.webView {
            overlay.attach(webView: webView, entryURL: controller.bridge?.config.appStartServerURL)
        }
        // Above the bridge's view, but still inside the app's own window, so a system
        // permission alert still comes up over it.
        window.addSubview(overlay)
        launchOverlay = overlay
    }

    private func makeWebViewFeelNative() {
        guard let controller = window?.rootViewController as? CAPBridgeViewController,
              let webView = controller.webView else { return }
        // If the bridge's view had not loaded yet when the mask was installed, this is the
        // first moment its web view — and its entry URL — exist. `attach` is idempotent and a
        // no-op once the mask is gone.
        launchOverlay?.attach(webView: webView, entryURL: controller.bridge?.config.appStartServerURL)
        webView.allowsLinkPreview = false
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 5 / 255, green: 7 / 255, blue: 10 / 255, alpha: 1)
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
