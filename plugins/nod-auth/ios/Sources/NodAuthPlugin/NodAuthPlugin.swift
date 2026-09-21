import AuthenticationServices
import Capacitor
import CryptoKit
import UIKit
import WebKit

@objc(NodAuthPlugin)
public class NodAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NodAuthPlugin"
    public let jsName = "NodAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "google", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apple", returnType: CAPPluginReturnPromise),
    ]

    private var appleBridge: AppleAuthBridge?

    @objc func apple(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("Missing nonce")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("Could not start Apple sign-in")
                return
            }
            let bridge = AppleAuthBridge(host: host, nonce: nonce) { [weak self] result in
                self?.appleBridge = nil
                switch result {
                case .success(let payload):
                    call.resolve(payload)
                case .canceled:
                    call.reject("canceled")
                case .failed(let message):
                    call.reject(message)
                }
            }
            self.appleBridge = bridge
            bridge.start()
        }
    }

    @objc func google(_ call: CAPPluginCall) {
        let raw = call.getString("url") ?? "https://nodpilot.com/login?native_return=1"
        guard let url = URL(string: raw) else {
            call.reject("Invalid URL")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("Could not start Google sign-in")
                return
            }
            let sheet = NodAuthSheetController(startURL: url) { result in
                switch result {
                case .canceled:
                    call.reject("canceled")
                case .failed(let message):
                    call.reject(message)
                case .token(let token):
                    var comps = URLComponents()
                    comps.scheme = "nodpilot"
                    comps.host = "auth"
                    comps.queryItems = [URLQueryItem(name: "token", value: token)]
                    call.resolve([
                        "url": comps.url?.absoluteString ?? "",
                        "token": token,
                    ])
                }
            }
            sheet.modalPresentationStyle = .fullScreen
            host.present(sheet, animated: true)
        }
    }
}

private enum NodAuthResult {
    case token(String)
    case canceled
    case failed(String)
}

private enum AppleAuthOutcome {
    case success([String: Any])
    case canceled
    case failed(String)
}

private final class AppleAuthBridge: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private weak var host: UIViewController?
    private let rawNonce: String
    private let finish: (AppleAuthOutcome) -> Void

    init(host: UIViewController, nonce: String, finish: @escaping (AppleAuthOutcome) -> Void) {
        self.host = host
        self.rawNonce = nonce
        self.finish = finish
        super.init()
    }

    func start() {
        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(rawNonce)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        host?.view.window ?? UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            finish(.failed("Apple sign-in failed"))
            return
        }
        guard let tokenData = credential.identityToken, let identityToken = String(data: tokenData, encoding: .utf8), !identityToken.isEmpty else {
            finish(.failed("Apple sign-in failed"))
            return
        }
        var payload: [String: Any] = [
            "identityToken": identityToken,
            "user": credential.user,
        ]
        if let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8), !code.isEmpty {
            payload["authorizationCode"] = code
        }
        if let email = credential.email, !email.isEmpty {
            payload["email"] = email
        }
        if let given = credential.fullName?.givenName, !given.isEmpty {
            payload["givenName"] = given
        }
        if let family = credential.fullName?.familyName, !family.isEmpty {
            payload["familyName"] = family
        }
        finish(.success(payload))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let ns = error as NSError
        if ns.domain == ASAuthorizationError.errorDomain, ns.code == ASAuthorizationError.canceled.rawValue {
            finish(.canceled)
            return
        }
        finish(.failed(error.localizedDescription))
    }

    private static func sha256(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler? = nil) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

private final class NodAuthSheetController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private let startURL: URL
    private let finish: (NodAuthResult) -> Void
    private var webView: WKWebView?
    private var settled = false
    private var pageReady = false
    private let scriptHandler = WeakScriptHandler()

    init(startURL: URL, finish: @escaping (NodAuthResult) -> Void) {
        self.startURL = startURL
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
        scriptHandler.target = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 5 / 255, green: 7 / 255, blue: 10 / 255, alpha: 1)

        let bar = UINavigationBar()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.barStyle = .black
        bar.isTranslucent = false
        bar.barTintColor = view.backgroundColor
        bar.titleTextAttributes = [.foregroundColor: UIColor.white]
        let item = UINavigationItem(title: "Sign in")
        item.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(cancelTapped))
        bar.setItems([item], animated: false)

        let content = WKUserContentController()
        content.add(scriptHandler, name: "nodAuth")
        content.addUserScript(WKUserScript(source: Self.watchScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController = content
        config.defaultWebpagePreferences.preferredContentMode = .mobile

        let web = WKWebView(frame: .zero, configuration: config)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.isOpaque = true
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.customUserAgent = Self.safariUserAgent
        webView = web

        view.addSubview(bar)
        view.addSubview(web)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.topAnchor.constraint(equalTo: bar.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        web.load(URLRequest(url: startURL))
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nodAuth")
    }

    @objc private func cancelTapped() {
        settle(.canceled)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nodAuth" else { return }
        if let token = (message.body as? [String: Any])?["token"] as? String, !token.isEmpty {
            settle(.token(token))
            return
        }
        if let token = message.body as? String, !token.isEmpty {
            settle(.token(token))
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "nodpilot" {
            decisionHandler(.cancel)
            if let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty {
                settle(.token(token))
            }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        if pageReady || code == NSURLErrorCancelled || code == NSURLErrorUnsupportedURL { return }
        settle(.failed(error.localizedDescription))
    }

    private func settle(_ result: NodAuthResult) {
        guard !settled else { return }
        settled = true
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nodAuth")
        dismiss(animated: true) { self.finish(result) }
    }

    private static var safariUserAgent: String {
        let version = UIDevice.current.systemVersion
        let os = version.replacingOccurrences(of: ".", with: "_")
        return "Mozilla/5.0 (iPhone; CPU iPhone OS \(os) like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(version) Mobile/15E148 Safari/604.1"
    }

    private static let watchScript = """
    (function () {
      if (window.__nodAuthWatch) return;
      window.__nodAuthWatch = true;
      try { sessionStorage.setItem('nod_native_return', '1'); } catch (e) {}
      try { localStorage.removeItem('nod_token'); } catch (e) {}
      function send(token) {
        if (!token) return;
        try { window.webkit.messageHandlers.nodAuth.postMessage({ token: String(token) }); } catch (e) {}
      }
      function read() {
        try { return localStorage.getItem('nod_token') || ''; } catch (e) { return ''; }
      }
      var seen = '';
      setInterval(function () {
        var token = read();
        if (token && token !== seen) { seen = token; send(token); }
      }, 350);
    })();
    """
}
