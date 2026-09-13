import os
import UIKit
import WebKit

/// What the brand mask should do once it has to decide whether the web layer is merely
/// slow or actually dead (issue #227: "实际不可恢复初始化失败需有限时失败出口和可操作重试").
///
/// A plain value type with no UIKit or WebKit in it, so the rule itself can be checked
/// without a device or a web view.
enum StartupRecoveryDecision: Equatable {
    /// The `NodSplash` handshake arrived: the first real web page is on screen. Reveal.
    case ready
    /// The document finished loading **and** the probe found the web app's root painted:
    /// the web layer is alive, only slower than the mask's patience. Reveal and let the web
    /// view's own offline / signed-out / retry state show — never the recovery page.
    case slowButAlive
    /// The document never loaded, or it loaded and the JavaScript never ran. An
    /// unrecoverable initialisation failure: show the recovery page instead of uncovering a
    /// blank web view.
    case dead
}

/// The rule that separates "slow" from "dead", plus the probe that feeds it.
enum StartupRecovery {

    /// Cheap, non-throwing liveness probe. `#root` is the element the app mounts into
    /// (`web/app.html`: `<div id="root"></div>`); a document that is no longer `loading`
    /// whose root still has no children means the bundle's JavaScript never ran — a dead
    /// start, not a slow one. Nothing here talks to the network, so it cannot itself hang.
    static let probeScript = "(function(){try{var r=document.getElementById('root');return !!(document.readyState!=='loading' && r && r.childElementCount>0)}catch(e){return false}})()"

    /// The decision. "Alive" is deliberately narrow and is exactly what the issue asks
    /// for: **the web view finished a navigation in this process** (so the bundle and its
    /// assets resolved and the document is real) **and** the probe found the app's root
    /// painted (so the JavaScript actually booted). Anything else is an unrecoverable
    /// initialisation failure: no navigation ever committed, a navigation that failed, or a
    /// document whose root never filled.
    ///
    /// This is not "the API was slow". A slow request happens *after* the shell has loaded
    /// and painted, so the shell's own offline / signed-out / retry state owns that case and
    /// the mask must yield to it. Neither is it "the network is slow": the native bundle
    /// (`capacitor://localhost`, no `server.url`) is entirely local, so a document that has
    /// not finished loading after ten seconds is a broken bundle or a WebKit failure, not
    /// latency.
    ///
    /// `didFinishNavigation` is monotonic within one attempt — one successful navigation is
    /// evidence the bundle resolves — because the entry document redirects to `app.html`
    /// with `location.replace` (`scripts/prepare-ios-web.mjs`), so a cancelled first
    /// navigation must not erase the second one's success. A retry clears it again.
    static func decision(isReady: Bool, didFinishNavigation: Bool, hasPaintedRoot: Bool) -> StartupRecoveryDecision {
        if isReady { return .ready }
        if didFinishNavigation && hasPaintedRoot { return .slowButAlive }
        return .dead
    }

    /// A navigation WebKit cancelled, or one a policy turned into something else, is not a
    /// failure. This matters on every healthy cold start: the bundled entry document
    /// redirects itself to `app.html` with `location.replace`, so the first navigation is
    /// cancelled by the second (and CAP's URL policy cancels outbound links the same way).
    /// Treating those as failures would put the recovery page on screen on every launch.
    static func isBenignNavigationInterruption(_ error: NSError) -> Bool {
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return true }
        // WebKitErrorDomain 102: frame load interrupted by policy change.
        if error.domain == "WebKitErrorDomain" && error.code == 102 { return true }
        return false
    }

    /// Whether a failed navigation is the unrecoverable case the recovery page exists for —
    /// the *first* page never loading. Once a document has loaded, a later failed navigation
    /// belongs to the live web layer (a deep link, a route it moved to), and the mask must
    /// not drop a recovery page over a page that is alive; the ready handshake or the timeout
    /// probe decides that instead.
    static func isUnrecoverableNavigationFailure(didFinishNavigation: Bool) -> Bool {
        !didFinishNavigation
    }
}

/// Stands in for the bridge's own `WKNavigationDelegate` so the mask can see the first
/// navigation finish or fail.
///
/// Capacitor installs one `WebViewDelegationHandler` as the web view's navigation delegate
/// and uses it for far more than navigation (URL policy, the JS message bridge, zooming),
/// so replacing it outright — or subclassing it, which cannot reach its internal `bridge` —
/// would break the bridge. Instead every call this class does not consume is forwarded
/// straight to the delegate it replaced, through `responds(to:)` +
/// `forwardingTarget(for:)`, and `LaunchOverlay` hands that delegate back once the mask is
/// gone. `decidePolicyFor` in particular is never consumed here, so the bridge keeps its
/// decision handler exactly as it is.
final class StartupNavigationObserver: NSObject, WKNavigationDelegate {

    /// The delegate that was in place when the mask took over. Weak, because the bridge
    /// owns it and the mask must not extend its life.
    private(set) weak var forwardTarget: WKNavigationDelegate?

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

    // MARK: - The two events the mask consumes, forwarded to the bridge as well

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
/// It draws the same composition as the launch image — `BrandLaunch`'s design frame, the
/// same aspect-fill mapping — so the only thing that changes when it appears is that the
/// waveform starts breathing. Nothing here reads audio, asks for a permission or opens an
/// audio session: the loop is pure ambience for the moment the app is initialising, and it
/// must never look like a meter.
///
/// The mask is also the app's bounded exit from a cold start that never completes: if the
/// web layer is alive it comes down as it always has, and if it is dead the mask shows
/// `StartupRecoveryView` with a working 重试 instead of uncovering a blank page.
final class LaunchOverlay: UIView {

    /// Posted by the `NodSplash` plugin once the first real page is on screen. The plugin
    /// lives in its own pod and cannot see this target's symbols, so the literal is
    /// duplicated in `NodSplashPlugin.swift` and in `BrandLaunch.readyNotificationName`.
    static let readyNotification = Notification.Name(BrandLaunch.readyNotificationName)

    /// Once the mask has come down in this process, no later activation may put it back.
    /// A cold launch is the only thing that shows the brand.
    private(set) static var hasRevealedInThisProcess = false

    /// Bounded wait for the readiness signal. A healthy cold start reports in well under a
    /// second, so ten seconds never preempts a slow-but-progressing load; if the bridge or
    /// the network is broken the mask probes the web layer and either hands over to the web
    /// view's own offline / sign-in / retry state or shows the recovery page.
    private static let safetyTimeout: TimeInterval = 10
    private static let fadeDuration: TimeInterval = 0.2

    private static let log = OSLog(subsystem: "com.nodpilot.app", category: "LaunchOverlay")

    private let markView = UIImageView()
    private let wordmarkView = UIImageView()
    private var bars: [CALayer] = []

    private var mapping: BrandLaunch.Mapping?
    private var displayLink: CADisplayLink?
    private var loopStart: CFTimeInterval = 0
    private var timeoutWork: DispatchWorkItem?
    private var readyObserver: NSObjectProtocol?

    private var isReady = false
    private var didTimeOut = false
    private var isRevealing = false
    private var revealPending = false
    private var isActive = true

    /// The web layer's view, handed over by `AppDelegate`. Weak: the bridge owns it.
    private weak var webView: WKWebView?
    private var navigationObserver: StartupNavigationObserver?
    /// Set by a finished navigation; cleared only when a retry starts a fresh attempt.
    private var didFinishNavigation = false
    /// The last URL a navigation attempted, so a retry can reload a page that failed
    /// *provisionally* and therefore never became `webView.url`.
    private var lastAttemptURL: URL?
    private let recoveryView = StartupRecoveryView()
    private var isRecovering = false

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
        if !UIAccessibility.isReduceMotionEnabled { startBreathing() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("LaunchOverlay is code-only")
    }

    deinit {
        displayLink?.invalidate()
        timeoutWork?.cancel()
        if let readyObserver { NotificationCenter.default.removeObserver(readyObserver) }
        stopObservingNavigation()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        let scale = window?.screen.scale ?? UIScreen.main.scale
        for bar in bars { bar.contentsScale = scale }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let mapping = BrandLaunch.mapping(in: bounds)
        self.mapping = mapping
        markView.frame = mapping.rect(BrandLaunch.markRect)
        wordmarkView.frame = mapping.rect(BrandLaunch.wordmarkRect)
        for (index, bar) in bars.enumerated() {
            bar.bounds = CGRect(
                x: 0,
                y: 0,
                width: mapping.length(BrandLaunch.barWidth),
                height: 2 * mapping.length(BrandLaunch.barHalfHeight(index))
            )
            // Position is the design centre, so `transform` can only breathe the bar
            // around the same y the launch image drew it at.
            bar.position = mapping.point(x: BrandLaunch.barCentreX(index), y: BrandLaunch.waveformCentreY)
            bar.cornerRadius = mapping.length(BrandLaunch.barCornerRadius)
        }
    }

    private func buildContent() {
        // Asset images: the PDFs stay vector, so the mark and the wordmark are crisp at
        // whatever the aspect-fill mapping scales them to.
        markView.image = UIImage(named: "BrandMark")
        markView.contentMode = .scaleToFill
        wordmarkView.image = UIImage(named: "BrandWordmark")
        wordmarkView.contentMode = .scaleToFill
        addSubview(markView)
        addSubview(wordmarkView)
        for _ in 0..<BrandLaunch.barCount {
            let bar = CALayer()
            bar.backgroundColor = BrandLaunch.accentColor.cgColor
            bar.actions = ["transform": NSNull(), "position": NSNull(), "bounds": NSNull()]
            layer.addSublayer(bar)
            bars.append(bar)
        }
    }

    /// Built once, on top of the brand artwork and hidden until the mask decides the web
    /// layer is dead. Opaque black, so it also hides the mark and the breathing bars.
    private func buildRecoveryPage() {
        recoveryView.frame = bounds
        recoveryView.isHidden = true
        recoveryView.onRetry = { [weak self] in self?.retry() }
        addSubview(recoveryView)
    }

    // MARK: - Breathing loop

    private func startBreathing() {
        guard displayLink == nil, !isRecovering else { return }
        loopStart = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(step))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopBreathing() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func step() {
        let time = CACurrentMediaTime() - loopStart
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, bar) in bars.enumerated() {
            bar.transform = CATransform3DMakeScale(1, BrandLaunch.breathScale(index, at: time), 1)
        }
        CATransaction.commit()
    }

    // MARK: - Readiness, timeout, reveal

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

    private func webLayerIsReady() {
        guard !isReady else { return }
        isReady = true
        note("ready — the splash handshake arrived, revealing the web layer")
        requestReveal()
    }

    private func safetyTimeoutFired() {
        guard !isReady, !didTimeOut, !isRecovering, !Self.hasRevealedInThisProcess else { return }
        didTimeOut = true
        note("safety timeout (\(Int(Self.safetyTimeout))s) — probing the web layer before deciding")
        probeWebLayer { [weak self] painted in
            guard let self else { return }
            switch StartupRecovery.decision(
                isReady: self.isReady,
                didFinishNavigation: self.didFinishNavigation,
                hasPaintedRoot: painted
            ) {
            case .ready:
                self.note("ready -> reveal (the handshake landed while the probe was in flight)")
                self.requestReveal()
            case .slowButAlive:
                self.note("slow-but-alive -> reveal (navigation finished: \(self.didFinishNavigation), painted root: \(painted))")
                self.requestReveal()
            case .dead:
                self.note("dead -> recovery (navigation finished: \(self.didFinishNavigation), painted root: \(painted))")
                self.showRecovery()
            }
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
        guard (isReady || didTimeOut), !isRevealing else { return }
        // A timeout alone is never grounds to uncover the page once the mask has decided the
        // web layer is dead: only the ready handshake may lift the recovery page.
        guard isReady || !isRecovering else { return }
        guard isActive else {
            revealPending = true
            return
        }
        revealPending = false
        isRevealing = true
        Self.hasRevealedInThisProcess = true
        stopBreathing()
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
        guard !isRecovering, !isRevealing, !Self.hasRevealedInThisProcess else { return }
        isRecovering = true
        // The breathing waveform would be invisible under an opaque page; stop burning a
        // display link while the user decides.
        stopBreathing()
        bringSubviewToFront(recoveryView)
        recoveryView.isHidden = false
        // The mask itself must not swallow touches, but this one page must take them.
        isUserInteractionEnabled = true
    }

    private func hideRecovery() {
        guard isRecovering else { return }
        isRecovering = false
        recoveryView.isHidden = true
        isUserInteractionEnabled = false
    }

    /// 重试: one bounded attempt, back on the brand mask. The mask never reloads from the
    /// web layer's own state — it only ever retries the page it was waiting for.
    private func retry() {
        guard isRecovering, !isRevealing else { return }
        guard let webView else {
            note("retry(reload-failed): no web view attached — recovery stays up")
            return
        }

        let reload: () -> Void
        if let url = webView.url {
            note("retry: reload \(url.absoluteString)")
            reload = { webView.reload() }
        } else if let url = lastAttemptURL {
            // A provisional failure never commits a URL, so `reload()` would be a no-op on a
            // web view that has never loaded: reload the exact page that failed instead.
            note("retry: no committed url — loading the failed url \(url.absoluteString)")
            reload = { webView.load(URLRequest(url: url)) }
        } else {
            note("retry(reload-failed): no committed or attempted url to reload — recovery stays up")
            return
        }

        // Back to the mask for another bounded attempt. Clearing `isReady` is what lets the
        // NodSplash handshake complete a second time; clearing `didFinishNavigation` makes
        // the probe judge this attempt's navigation, not the dead one's.
        isReady = false
        didTimeOut = false
        didFinishNavigation = false
        hideRecovery()
        alpha = 1
        if !UIAccessibility.isReduceMotionEnabled { startBreathing() }
        armSafetyTimeout()
        reload()
    }

    // MARK: - Web view handover

    /// Hand the mask the web view it has to judge. Called by `AppDelegate`; idempotent, and
    /// a no-op once the mask has come down so a hot resume can never reinstall it.
    func attach(webView: WKWebView) {
        guard navigationObserver == nil, !Self.hasRevealedInThisProcess else { return }
        self.webView = webView
        let observer = StartupNavigationObserver(forwardingTo: webView.navigationDelegate)
        observer.onFinish = { [weak self] in self?.navigationDidFinish() }
        observer.onFail = { [weak self] error in self?.navigationDidFail(error) }
        webView.navigationDelegate = observer
        navigationObserver = observer
        // The bridge may already have committed the entry document before the mask attached.
        // Seed the flag so the timeout does not read that as a dead start; the probe still
        // has to find a painted root, so this can never call a dead page alive.
        didFinishNavigation = webView.url != nil && !webView.isLoading
        lastAttemptURL = webView.url
        note("attached to the web view (url: \(webView.url?.absoluteString ?? "none"), loading: \(webView.isLoading))")
    }

    /// Give the bridge back the delegate the mask borrowed.
    private func stopObservingNavigation() {
        guard let observer = navigationObserver else { return }
        navigationObserver = nil
        guard let webView, webView.navigationDelegate === observer else { return }
        webView.navigationDelegate = observer.forwardTarget
    }

    /// A document loaded. Deliberately does **not** reveal: a loaded document is not a
    /// painted page, and the mask still waits for the `NodSplash` handshake or the timeout
    /// (which is what `didFinishNavigation` feeds).
    private func navigationDidFinish() {
        guard !Self.hasRevealedInThisProcess else { return }
        didFinishNavigation = true
        if let url = webView?.url { lastAttemptURL = url }
        note("navigation finished (url: \(webView?.url?.absoluteString ?? "none"))")
    }

    /// A failed navigation is the unrecoverable case — a missing bundle, an asset that will
    /// not load, the entry document never arriving — so the recovery page goes up
    /// immediately instead of waiting out the full timeout.
    private func navigationDidFail(_ error: NSError) {
        guard !isReady, !isRevealing, !Self.hasRevealedInThisProcess else { return }
        if StartupRecovery.isBenignNavigationInterruption(error) {
            note("navigation interruption ignored (\(error.domain) \(error.code)) — not a failure")
            return
        }
        // Only a first page that never loaded is the initialisation failure this page exists
        // for. Once *a* document has loaded, a later failed navigation belongs to the live web
        // layer (a deep link, a route it moved to), and dropping the recovery page over a
        // working page would be worse than letting the ready handshake or the timeout decide.
        guard StartupRecovery.isUnrecoverableNavigationFailure(didFinishNavigation: didFinishNavigation) else {
            note("navigation failed after a document had loaded (\(error.domain) \(error.code)) — leaving it to the web layer")
            return
        }
        if let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL { lastAttemptURL = url }
        note("dead -> recovery (first navigation failed: \(error.domain) \(error.code))")
        showRecovery()
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
        if !UIAccessibility.isReduceMotionEnabled, !isRevealing, !isRecovering { startBreathing() }
        if revealPending { requestReveal() }
    }

    func applicationWillResignActive() {
        isActive = false
        stopBreathing()
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
