import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    /// The brand mask for this cold launch; nil once it has faded out (or if it was never
    /// installed). A hot resume must never build another one.
    private var launchOverlay: LaunchOverlay?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        if let activity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                continue: activity,
                restorationHandler: { _ in }
            )
        }
        DispatchQueue.main.async {
            self.makeWebViewFeelNative()
            self.installLaunchOverlay()
        }
    }

    func sceneWillResignActive(_ scene: UIScene) {
        launchOverlay?.applicationWillResignActive()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        makeWebViewFeelNative()
        launchOverlay?.applicationDidBecomeActive()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
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
}
