import Foundation

/// What the brand mask should do once it has to decide whether the web layer is merely
/// slow or actually dead (issue #227: "实际不可恢复初始化失败需有限时失败出口和可操作重试").
///
/// This file is deliberately Foundation-only — no UIKit, no WebKit, no clock, no web view —
/// so the whole startup gate can be compiled and exercised on the host by
/// `tests/native/StartupRecoveryTests.swift` (run through `scripts/test-watch-replay.sh`,
/// the repo's native-test entry point). `LaunchOverlay` owns the web view, the timeout and
/// the views; everything the mask *decides* lives here.
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

    /// What a 重试 tap must load. The page must never leave an enabled button that does
    /// nothing (issue #227, "可操作重试").
    enum RetryPlan: Equatable {
        case load(URL)
        case unavailable
    }

    /// First usable URL wins: the committed one (a plain reload), then the one the last
    /// navigation attempted — WebKit reports the URL of a failed *provisional* navigation,
    /// so that case never becomes `webView.url` — and finally the app's own entry URL.
    ///
    /// The entry URL is what Capacitor itself loads at launch
    /// (`CAPBridgeViewController.loadWebView()` → `config.appStartServerURL`: the local
    /// `capacitor://` bundle), passed down by `AppDelegate`. It is the reason a retry can
    /// still start a load even when the bridge has never committed and never reported a
    /// URL, which is exactly the state the 10 s timeout can reach.
    static func retryPlan(committed: URL?, attempted: URL?, entry: URL?) -> RetryPlan {
        if let committed { return .load(committed) }
        if let attempted { return .load(attempted) }
        if let entry { return .load(entry) }
        return .unavailable
    }
}

/// The cold-start gate: what the mask knows, and what it must do next.
///
/// Pure value type (see the file comment). `LaunchOverlay` drives it — one call per event,
/// one `Action` back — and the tests drive the same transitions directly.
struct StartupRecoveryGate: Equatable {

    /// What the liveness probe found at the safety timeout.
    enum Probe: Equatable {
        /// The document finished loading and the app's `#root` is painted.
        case alive
        /// Nothing usable: no navigation, or a root that never filled.
        case dead
    }

    /// What the mask must do next.
    enum Action: Equatable {
        case none
        /// The web layer owns the screen: fade the mask out, recovery page included.
        case reveal
        /// Show the bounded failure exit.
        case recover
        /// 重试: start this load and re-arm the safety timeout.
        case retry(URL)
        /// There is nothing to load and no entry URL either, so the page must stop
        /// pretending the button works: disable it and say so.
        case retryUnavailable
    }

    private(set) var isReady = false
    private(set) var didTimeOut = false
    private(set) var didFinishNavigation = false
    private(set) var isRecovering = false
    private(set) var hasRevealed = false

    // MARK: - Transitions

    /// The `NodSplash` handshake. A repeat is a no-op, but a handshake that lands while the
    /// recovery page is up wins: the page goes away and the mask reveals.
    mutating func splashReady() -> Action {
        guard !hasRevealed, !isReady else { return .none }
        isReady = true
        return reveal()
    }

    /// The safety timeout fired. `false` means this timeout is stale — the mask is already
    /// ready, already timed out, already recovering or already gone — and the caller must
    /// not even probe. A retry clears `didTimeOut`, which is what re-arms it.
    mutating func safetyTimeoutFired() -> Bool {
        guard !isReady, !didTimeOut, !isRecovering, !hasRevealed else { return false }
        didTimeOut = true
        return true
    }

    /// The probe's answer, after `safetyTimeoutFired()` returned `true`.
    mutating func probeReturned(_ probe: Probe) -> Action {
        switch StartupRecovery.decision(
            isReady: isReady,
            didFinishNavigation: didFinishNavigation,
            hasPaintedRoot: probe == .alive
        ) {
        case .ready, .slowButAlive: return reveal()
        case .dead: return recover()
        }
    }

    /// A document loaded. Evidence for the probe, never a reason to reveal on its own: a
    /// loaded document is not a painted page.
    mutating func navigationFinished() -> Action {
        guard !hasRevealed else { return .none }
        didFinishNavigation = true
        return .none
    }

    /// A navigation failed. A benign cancellation is not a failure, and a failure after a
    /// document has loaded belongs to the live web layer rather than to this gate.
    mutating func navigationFailed(isBenign: Bool) -> Action {
        guard !isReady, !hasRevealed, !isBenign else { return .none }
        guard StartupRecovery.isUnrecoverableNavigationFailure(didFinishNavigation: didFinishNavigation) else { return .none }
        return recover()
    }

    /// 重试 tapped. `committed` is `webView.url`, `attempted` the last URL a navigation
    /// tried, `entry` the app's own entry URL; see `StartupRecovery.retryPlan`.
    mutating func retry(committed: URL?, attempted: URL?, entry: URL?) -> Action {
        guard isRecovering, !hasRevealed else { return .none }
        switch StartupRecovery.retryPlan(committed: committed, attempted: attempted, entry: entry) {
        case .load(let url):
            // A fresh bounded attempt: clearing readiness lets the handshake complete a
            // second time, clearing the timeout re-arms it, and clearing the navigation
            // evidence makes the probe judge *this* attempt instead of the dead one.
            isReady = false
            didTimeOut = false
            didFinishNavigation = false
            isRecovering = false
            return .retry(url)
        case .unavailable:
            return .retryUnavailable
        }
    }

    /// The bridge may already have committed the entry document before the mask attached.
    /// Seeding the flag keeps the timeout from reading that as a dead start; the probe still
    /// has to find a painted root, so this can never call a dead page alive.
    mutating func attached(alreadyFinishedNavigation: Bool) {
        guard !hasRevealed else { return }
        didFinishNavigation = didFinishNavigation || alreadyFinishedNavigation
    }

    // MARK: - Private

    private mutating func reveal() -> Action {
        guard !hasRevealed else { return .none }
        hasRevealed = true
        isRecovering = false
        return .reveal
    }

    private mutating func recover() -> Action {
        guard !isRecovering, !hasRevealed else { return .none }
        isRecovering = true
        return .recover
    }
}
