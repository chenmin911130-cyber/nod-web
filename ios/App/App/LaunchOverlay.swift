import os
import UIKit
import WebKit

/// Stands in for the bridge's own `WKNavigationDelegate` so the mask can see the first
/// navigation start, finish or fail.
///
/// Capacitor installs one `WebViewDelegationHandler` as the web view's navigation delegate
/// and uses it for far more than navigation (URL policy, the JS message bridge, zooming),
/// so replacing it outright — or subclassing it, which cannot reach its internal `bridge` —
/// would break the bridge. Instead every call this class consumes is forwarded straight on
/// to the delegate it replaced, and every call it does not consume is forwarded through
/// `responds(to:)` + `forwardingTarget(for:)`. `LaunchOverlay` hands that delegate back once
/// the mask is gone.
final class StartupNavigationObserver: NSObject, WKNavigationDelegate {

    /// The delegate that was in place when the mask took over. Weak, because the bridge
    /// owns it and the mask must not extend its life.
    private(set) weak var forwardTarget: WKNavigationDelegate?

    /// A main-frame navigation is about to be attempted; the URL matters because a
    /// *provisional* failure never becomes `webView.url` and a retry still has to have
    /// something to load (issue #227, "可操作重试").
    var onAttempt: ((URL?) -> Void)?
    /// A navigation loaded its document.
    var onFinish: (() -> Void)?
    /// A navigation failed — provisionally or after committing.
    var onFail: ((NSError) -> Void)?

    init(forwardingTo target: WKNavigationDelegate?) {
        forwardTarget = target
        super.init()
    }

    // MARK: - Transparent forwarding

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return forwardTarget?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if super.responds(to: aSelector) { return nil }
        return forwardTarget
    }

    // MARK: - The events the mask consumes, all forwarded to the bridge as well

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.targetFrame?.isMainFrame ?? true {
            onAttempt?(navigationAction.request.url)
        }
        // The bridge's decision is the one that counts — its own navigation policy is not
        // ours to change. If it has somehow gone, allowing the navigation is the neutral
        // answer and keeps the decision handler balanced (WebKit traps if it is not called).
        let selector = NSSelectorFromString("webView:decidePolicyForNavigationAction:decisionHandler:")
        if let target = forwardTarget, target.responds(to: selector) {
            target.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        forwardTarget?.webView?(webView, didFinish: navigation)
        onFinish?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        forwardTarget?.webView?(webView, didFail: navigation, withError: error)
        onFail?(error as NSError)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        forwardTarget?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        onFail?(error as NSError)
    }
}

/// The brand mask that covers the window between the static launch screen and the first
/// page the web layer has actually painted.
///
/// It shows the same `LaunchBrand` image as `LaunchScreen.storyboard` (`scaleAspectFit`
/// on black) so the letterforms stay the confirmed design raster. Reconstructed PDF
/// mark/wordmark and extra waveform bars would fight that image.
///
/// The mask is also the app's bounded exit from a cold start that never completes: if the
/// web layer is alive it comes down as it always has, and if it is dead the mask shows
/// `StartupRecoveryView` with a working 重试 instead of uncovering a blank page. Every
/// decision it makes is a `StartupRecoveryGate` transition (see `StartupRecoveryGate.swift`)
/// — this class owns the web view, the clock and the views, not the policy.
final class LaunchOverlay: UIView {

    /// Posted by the `NodSplash` plugin once the first real page is on screen. The plugin
    /// lives in its own pod and cannot see this target's symbols, so the literal is
    /// duplicated in `NodSplashPlugin.swift` and in `BrandLaunch.readyNotificationName`.
    static let readyNotification = Notification.Name(BrandLaunch.readyNotificationName)

    /// Once the mask has come down in this process, no later activation may put it back.
    /// A cold launch is the only thing that shows the brand.
    private(set) static var hasRevealedInThisProcess = false

    /// Bounded wait for the readiness signal. Native boot no longer waits for
    /// `/api/me`, so a healthy cold start reports in well under a second. Ten
    /// seconds never preempts a slow-but-progressing load; if the bridge is broken
    /// the mask probes the web layer and either hands over to the web view's own
    /// offline / sign-in / retry state or shows the recovery page.
    private static let safetyTimeout: TimeInterval = 10
    private static let fadeDuration: TimeInterval = 0.2

    private static let log = OSLog(subsystem: "com.nodpilot.app", category: "LaunchOverlay")

    private let brandView = UIImageView()

    private var timeoutWork: DispatchWorkItem?
    private var readyObserver: NSObjectProtocol?

    /// Everything the mask knows about the cold start, and every decision it makes.
    private var gate = StartupRecoveryGate()
    private var isRevealing = false
    private var revealPending = false
    private var isActive = true

    /// The web layer's view, handed over by `AppDelegate`. Weak: the bridge owns it.
    private weak var webView: WKWebView?
    private var navigationObserver: StartupNavigationObserver?
    /// The last URL a navigation attempted, so a retry can reload a page that failed
    /// *provisionally* and therefore never became `webView.url`.
    private var lastAttemptURL: URL?
    /// The app's own entry URL, resolved by `AppDelegate` from Capacitor's configuration.
    /// The last-resort retry target: it is what the bridge itself loads at launch, so a
    /// retry can start a load even when nothing has committed and nothing was reported.
    private var entryURL: URL?
    private let recoveryView = StartupRecoveryView()

    // MARK: - Life cycle

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = BrandLaunch.backgroundColor
        isOpaque = true
        // Never swallow a touch: the mask is decoration over a web view that may already
        // be interactive underneath. `showRecovery()` flips this back on, because the
        // recovery page's 重试 has to be reachable.
        isUserInteractionEnabled = false
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        buildContent()
        buildRecoveryPage()
        observeReadiness()
        armSafetyTimeout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("LaunchOverlay is code-only")
    }

    deinit {
        timeoutWork?.cancel()
        if let readyObserver { NotificationCenter.default.removeObserver(readyObserver) }
        stopObservingNavigation()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        brandView.frame = bounds
        recoveryView.frame = bounds
    }

    private func buildContent() {
        brandView.image = UIImage(named: "LaunchBrand")
        brandView.contentMode = .scaleAspectFit
        brandView.backgroundColor = BrandLaunch.backgroundColor
        addSubview(brandView)
    }

    /// Built once, on top of the brand artwork and hidden until the mask decides the web
    /// layer is dead. Opaque black, so it also hides the launch image.
    private func buildRecoveryPage() {
        recoveryView.frame = bounds
        recoveryView.isHidden = true
        recoveryView.onRetry = { [weak self] in self?.retry() }
        addSubview(recoveryView)
    }

    // MARK: - Gate driving

    private func observeReadiness() {
        readyObserver = NotificationCenter.default.addObserver(
            forName: Self.readyNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.webLayerIsReady()
        }
    }

    private func armSafetyTimeout() {
        // A retry may run while the previous attempt's timeout is still pending.
        timeoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.safetyTimeoutFired() }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.safetyTimeout, execute: work)
    }

    /// Run one gate action. The gate decides, this performs.
    private func perform(_ action: StartupRecoveryGate.Action) {
        switch action {
        case .none:
            break
        case .reveal:
            requestReveal()
        case .recover:
            showRecovery()
        case .retry(let url):
            startRetry(to: url)
        case .retryUnavailable:
            recoveryView.showRetryUnavailable()
        }
    }

    private func webLayerIsReady() {
        guard !gate.isReady else { return }
        let wasRecovering = gate.isRecovering
        note(wasRecovering
            ? "ready — the splash handshake arrived while the recovery page was up; hiding it and revealing"
            : "ready — the splash handshake arrived, revealing the web layer")
        perform(gate.splashReady())
    }

    private func safetyTimeoutFired() {
        guard gate.safetyTimeoutFired() else { return }
        note("safety timeout (\(Int(Self.safetyTimeout))s) — probing the web layer before deciding")
        probeWebLayer { [weak self] painted in
            guard let self else { return }
            let action = self.gate.probeReturned(painted ? .alive : .dead)
            if self.gate.isReady {
                self.note("ready -> reveal (the handshake landed while the probe was in flight)")
            } else if action == .reveal {
                self.note("slow-but-alive -> reveal (navigation finished: \(self.gate.didFinishNavigation), painted root: \(painted))")
            } else if action == .recover {
                self.note("dead -> recovery (navigation finished: \(self.gate.didFinishNavigation), painted root: \(painted))")
            }
            self.perform(action)
        }
    }

    /// Ask the web layer whether it is alive. Main-thread and cheap; an error (no document,
    /// a torn-down web view) is itself the "dead" answer, never a crash and never a throw.
    private func probeWebLayer(_ completion: @escaping (Bool) -> Void) {
        guard let webView else {
            note("probe: no web view attached — treating the web layer as dead")
            completion(false)
            return
        }
        webView.evaluateJavaScript(StartupRecovery.probeScript) { [weak self] result, error in
            if let error {
                self?.note("probe: evaluateJavaScript failed (\(error.localizedDescription)) — treating the web layer as dead")
                completion(false)
                return
            }
            // WKWebView hands back an NSNumber for a JavaScript boolean.
            let painted = (result as? NSNumber)?.boolValue ?? (result as? Bool) ?? false
            completion(painted)
        }
    }

    /// Reveal as soon as the web layer says it is ready — no minimum display time and no
    /// artificial delay. While the app is not active the mask stays up and the reveal is
    /// deferred to the next `applicationDidBecomeActive`, so a page can never be uncovered
    /// behind a permission alert or while the app is in the background.
    private func requestReveal() {
        guard !isRevealing else { return }
        guard isActive else {
            revealPending = true
            return
        }
        revealPending = false
        isRevealing = true
        Self.hasRevealedInThisProcess = true
        // The mask is done: step out from in front of the bridge's own navigation delegate
        // so nothing about deep links or in-page navigation is ever routed through us again.
        stopObservingNavigation()
        hideRecovery()
        UIView.animate(
            withDuration: Self.fadeDuration,
            delay: 0,
            options: [.curveEaseOut, .beginFromCurrentState]
        ) {
            self.alpha = 0
        } completion: { finished in
            guard finished else {
                // Interrupted by a resign; stay opaque and try again when we are active.
                self.alpha = 1
                self.isRevealing = false
                self.revealPending = true
                return
            }
            // Out of the hierarchy, so it can neither intercept touches nor cover anything.
            self.removeFromSuperview()
        }
    }

    // MARK: - Recovery page (issue #227)

    /// Show the bounded failure exit instead of uncovering a blank web view. Safe to call
    /// from the safety timeout or straight from a navigation failure; the mask may still
    /// come down afterwards if the web layer's own retry eventually reports ready.
    private func showRecovery() {
        guard !isRevealing else { return }
        // A page that once had to say "can't retry" must not stay disabled if it is shown
        // again for a later failure.
        recoveryView.reset()
        bringSubviewToFront(recoveryView)
        recoveryView.isHidden = false
        // The mask itself must not swallow touches, but this one page must take them.
        isUserInteractionEnabled = true
    }

    private func hideRecovery() {
        recoveryView.isHidden = true
        isUserInteractionEnabled = false
    }

    /// 重试 tapped. The gate picks the URL (committed → attempted → the app's own entry
    /// URL); this either starts that load or tells the page it cannot, but it never leaves
    /// an enabled button that does nothing.
    private func retry() {
        guard !isRevealing else { return }
        guard let webView else {
            note("retry(reload-failed): no web view attached — the page says so")
            recoveryView.showRetryUnavailable()
            return
        }
        let action = gate.retry(committed: webView.url, attempted: lastAttemptURL, entry: entryURL)
        if action == .retryUnavailable {
            note("retry(reload-failed): no committed url, no attempted url and no entry url — the page says so")
        }
        perform(action)
    }

    /// Start one bounded attempt, back on the brand mask. `armSafetyTimeout()` is what
    /// makes the exit bounded again: ready, or the timeout judges this attempt too.
    private func startRetry(to url: URL) {
        guard let webView else { return }
        let reload = webView.url == url
        note("retry: \(reload ? "reload" : "load") \(url.absoluteString)")
        hideRecovery()
        alpha = 1
        armSafetyTimeout()
        if reload {
            webView.reload()
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - Web view handover

    /// Hand the mask the web view it has to judge, plus the app's own entry URL. Called by
    /// `AppDelegate`; idempotent, and a no-op once the mask has come down so a hot resume can
    /// never reinstall it. The entry URL is refreshed on every call, because it may only be
    /// resolvable once the bridge has finished loading.
    func attach(webView: WKWebView, entryURL: URL?) {
        if let entryURL { self.entryURL = entryURL }
        guard navigationObserver == nil, !Self.hasRevealedInThisProcess else { return }
        self.webView = webView
        let observer = StartupNavigationObserver(forwardingTo: webView.navigationDelegate)
        observer.onAttempt = { [weak self] url in self?.navigationDidAttempt(url) }
        observer.onFinish = { [weak self] in self?.navigationDidFinish() }
        observer.onFail = { [weak self] error in self?.navigationDidFail(error) }
        webView.navigationDelegate = observer
        navigationObserver = observer
        // The bridge may already have committed the entry document before the mask attached.
        gate.attached(alreadyFinishedNavigation: webView.url != nil && !webView.isLoading)
        lastAttemptURL = webView.url
        note("attached to the web view (url: \(webView.url?.absoluteString ?? "none"), entry: \(self.entryURL?.absoluteString ?? "none"), loading: \(webView.isLoading))")
    }

    /// Give the bridge back the delegate the mask borrowed.
    private func stopObservingNavigation() {
        guard let observer = navigationObserver else { return }
        navigationObserver = nil
        guard let webView, webView.navigationDelegate === observer else { return }
        webView.navigationDelegate = observer.forwardTarget
    }

    /// A main-frame navigation is starting. Recorded as early as possible so `retry()` has
    /// something to load even when the navigation never commits and never reports a URL.
    private func navigationDidAttempt(_ url: URL?) {
        guard !Self.hasRevealedInThisProcess, let url else { return }
        lastAttemptURL = url
    }

    /// A document loaded. Deliberately does **not** reveal: a loaded document is not a
    /// painted page, and the mask still waits for the `NodSplash` handshake or the timeout
    /// (which is what the gate's navigation evidence feeds).
    private func navigationDidFinish() {
        if let url = webView?.url { lastAttemptURL = url }
        note("navigation finished (url: \(webView?.url?.absoluteString ?? "none"))")
        perform(gate.navigationFinished())
    }

    /// A failed navigation is the unrecoverable case — a missing bundle, an asset that will
    /// not load, the entry document never arriving — so the recovery page goes up
    /// immediately instead of waiting out the full timeout.
    private func navigationDidFail(_ error: NSError) {
        if StartupRecovery.isBenignNavigationInterruption(error) {
            perform(gate.navigationFailed(isBenign: true))
            note("navigation interruption ignored (\(error.domain) \(error.code)) — not a failure")
            return
        }
        if let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL { lastAttemptURL = url }
        let action = gate.navigationFailed(isBenign: false)
        if action == .recover {
            note("dead -> recovery (first navigation failed: \(error.domain) \(error.code))")
        } else {
            note("navigation failed while the web layer owned the screen (\(error.domain) \(error.code)) — leaving it to the web layer")
        }
        perform(action)
    }

    // MARK: - Diagnostics

    /// One line per decision point, on the same log as before, so a device console can tell
    /// `ready`, `slow-but-alive`, `dead`, `retry` and `reload-failed` apart. Public because
    /// this is a diagnostic, not user data.
    private func note(_ message: String) {
        os_log("%{public}@", log: Self.log, type: .default, message)
    }

    // MARK: - App lifecycle (driven by AppDelegate; only a cold launch installs the mask)

    func applicationDidBecomeActive() {
        isActive = true
        if revealPending { requestReveal() }
    }

    func applicationWillResignActive() {
        isActive = false
        guard isRevealing else { return }
        // An inactive app must not uncover its page — a permission alert or the app
        // switcher may be in front of it. Hold the mask opaque and reveal on the next
        // activation instead.
        layer.removeAllAnimations()
        alpha = 1
        isRevealing = false
        revealPending = true
    }
}
