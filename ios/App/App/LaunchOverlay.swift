import os
import UIKit

/// The brand mask that covers the window between the static launch screen and the first
/// page the web layer has actually painted.
///
/// It draws the same composition as the launch image — `BrandLaunch`'s design frame, the
/// same aspect-fill mapping — so the only thing that changes when it appears is that the
/// waveform starts breathing. Nothing here reads audio, asks for a permission or opens an
/// audio session: the loop is pure ambience for the moment the app is initialising, and it
/// must never look like a meter.
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
    /// the network is broken it still hands over to the web view's own offline / sign-in /
    /// retry state instead of trapping the user on a logo.
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

    // MARK: - Life cycle

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = BrandLaunch.backgroundColor
        isOpaque = true
        // Never swallow a touch: the mask is decoration over a web view that may already
        // be interactive underneath.
        isUserInteractionEnabled = false
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        buildContent()
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

    // MARK: - Breathing loop

    private func startBreathing() {
        guard displayLink == nil else { return }
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
        let work = DispatchWorkItem { [weak self] in self?.safetyTimeoutFired() }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.safetyTimeout, execute: work)
    }

    private func webLayerIsReady() {
        guard !isReady else { return }
        isReady = true
        requestReveal()
    }

    private func safetyTimeoutFired() {
        guard !isReady, !didTimeOut, !Self.hasRevealedInThisProcess else { return }
        didTimeOut = true
        os_log(
            "NodSplash: no readiness signal within the safety timeout — lifting the brand mask so the web view's own state shows",
            log: Self.log,
            type: .default
        )
        requestReveal()
    }

    /// Reveal as soon as the web layer says it is ready — no minimum display time and no
    /// artificial delay. While the app is not active the mask stays up and the reveal is
    /// deferred to the next `applicationDidBecomeActive`, so a page can never be uncovered
    /// behind a permission alert or while the app is in the background.
    private func requestReveal() {
        guard (isReady || didTimeOut), !isRevealing else { return }
        guard isActive else {
            revealPending = true
            return
        }
        revealPending = false
        isRevealing = true
        Self.hasRevealedInThisProcess = true
        stopBreathing()
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

    // MARK: - App lifecycle (driven by AppDelegate; only a cold launch installs the mask)

    func applicationDidBecomeActive() {
        isActive = true
        if !UIAccessibility.isReduceMotionEnabled, !isRevealing { startBreathing() }
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
