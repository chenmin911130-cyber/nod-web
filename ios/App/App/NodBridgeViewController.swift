import Capacitor
import WebKit

/// Installs the UI-locale user script on the WebView configuration before the
/// first document load. AppDelegate's async hook runs too late for module init.
final class NodBridgeViewController: CAPBridgeViewController {
    override public func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        NodUiLocale.install(on: configuration.userContentController)
        return configuration
    }
}

enum NodUiLocale {
    static func preferredTag() -> String {
        (Locale.preferredLanguages.first ?? Locale.current.identifier)
    }

    static func install(on controller: WKUserContentController) {
        let escaped = preferredTag()
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let source = "window.__NOD_UI_LOCALE__='\(escaped)';"
        let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        controller.addUserScript(script)
    }
}
