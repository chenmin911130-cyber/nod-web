import Foundation
import JavaScriptCore

// Startup-gate tests for issue #227 (执行单 verification item 5): success, failure, repeated
// callbacks and recovery. They drive the production decision code in
// ios/App/App/StartupRecoveryGate.swift — the same file the App target compiles — through
// scripts/test-watch-replay.sh, the repo's native-test entry point. Nothing is re-implemented
// here: the probe script, the slow-vs-dead rule, the benign-cancel classifier, the retry plan
// and the recovery/retry state machine are all the shipping implementations.

func check(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}
func eq<T: Equatable>(_ got: T, _ want: T, _ message: String, file: String = #file, line: Int = #line) {
    if got != want {
        fputs("FAIL: \(file):\(line) \(message) — got \(got) want \(want)\n", stderr)
        exit(1)
    }
}

@main struct StartupRecoveryTests {
    static func main() throws {
        let committed = URL(string: "capacitor://localhost/index.html")!
        let attempted = URL(string: "capacitor://localhost/app.html")!
        let entry = URL(string: "capacitor://localhost")!

        // MARK: The liveness probe, executed for real against a fake document
        //
        // The probe is what separates "slow" from "dead", so it is worth running the exact
        // shipping script (not a copy) through JavaScriptCore. `#root` is the element
        // web/app.html mounts into; a document that is no longer loading whose root is still
        // empty means the bundle's JS never ran.
        func probe(_ document: String) -> Bool {
            guard let context = JSContext() else { return false }
            context.evaluateScript("var document = \(document);")
            return context.evaluateScript(StartupRecovery.probeScript)?.toBool() ?? false
        }

        check(probe("({readyState: 'interactive', getElementById: function(){ return {childElementCount: 3}; }})"),
              "a document that finished loading with a painted #root is alive")
        check(!probe("({readyState: 'complete', getElementById: function(){ return {childElementCount: 0}; }})"),
              "a document whose #root never filled never ran the app's JS: dead")
        check(!probe("({readyState: 'loading', getElementById: function(){ return {childElementCount: 1}; }})"),
              "a document still loading is not alive yet")
        check(!probe("({readyState: 'complete', getElementById: function(){ return null; }})"),
              "no #root at all (the entry redirect document) is dead")
        check(!probe("({readyState: 'complete', getElementById: function(){ throw new Error('boom'); }})"),
              "the probe swallows a JS exception and answers dead instead of throwing")

        // MARK: The slow-vs-dead rule
        eq(StartupRecovery.decision(isReady: true, didFinishNavigation: true, hasPaintedRoot: true),
           .ready, "the handshake is ready")
        eq(StartupRecovery.decision(isReady: true, didFinishNavigation: false, hasPaintedRoot: false),
           .ready, "ready outranks a dead probe: the handshake is the web layer's own word")
        eq(StartupRecovery.decision(isReady: false, didFinishNavigation: true, hasPaintedRoot: true),
           .slowButAlive, "loaded and painted is slow-but-alive, never the recovery page")
        eq(StartupRecovery.decision(isReady: false, didFinishNavigation: true, hasPaintedRoot: false),
           .dead, "navigation finished but the root was never painted is dead")
        eq(StartupRecovery.decision(isReady: false, didFinishNavigation: false, hasPaintedRoot: true),
           .dead, "no navigation finished is dead")
        eq(StartupRecovery.decision(isReady: false, didFinishNavigation: false, hasPaintedRoot: false),
           .dead, "nothing at all is dead")

        // MARK: Cancelled navigations and where a real failure belongs
        check(StartupRecovery.isBenignNavigationInterruption(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)),
              "-999 (the entry document's location.replace cancelling the first navigation) is not a failure")
        check(StartupRecovery.isBenignNavigationInterruption(NSError(domain: "WebKitErrorDomain", code: 102)),
              "WebKit 102 (frame load interrupted by policy) is not a failure")
        check(!StartupRecovery.isBenignNavigationInterruption(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)),
              "a missing bundle file is a real failure")
        check(!StartupRecovery.isBenignNavigationInterruption(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost)),
              "an unreachable host is a real failure")
        check(StartupRecovery.isUnrecoverableNavigationFailure(didFinishNavigation: false),
              "a failed first navigation is the unrecoverable case")
        check(!StartupRecovery.isUnrecoverableNavigationFailure(didFinishNavigation: true),
              "a failure after a document loaded is left to the live web layer")

        // MARK: The retry plan (blocker 1: the button must never be a silent no-op)
        eq(StartupRecovery.retryPlan(committed: committed, attempted: attempted, entry: entry),
           .load(committed), "a committed URL is simply reloaded")
        eq(StartupRecovery.retryPlan(committed: nil, attempted: attempted, entry: entry),
           .load(attempted), "a provisional failure never commits, so the attempted URL is next")
        eq(StartupRecovery.retryPlan(committed: nil, attempted: nil, entry: entry),
           .load(entry), "with nothing committed and nothing attempted the app's own entry URL still loads")
        eq(StartupRecovery.retryPlan(committed: nil, attempted: nil, entry: nil),
           .unavailable, "with nothing at all the page must say so rather than pretend")

        // MARK: Gate — success and repeated callbacks
        var revealed = StartupRecoveryGate()
        eq(revealed.splashReady(), .reveal, "the handshake reveals")
        check(revealed.isReady && revealed.hasRevealed, "and the gate knows it is done")
        eq(revealed.splashReady(), .none, "a repeated handshake is a no-op")
        check(!revealed.safetyTimeoutFired(), "a stale timeout after the reveal does not probe")
        eq(revealed.probeReturned(.dead), .none, "a probe after the reveal cannot bring the page back")

        var slow = StartupRecoveryGate()
        eq(slow.navigationFinished(), .none, "a loaded document does not reveal on its own")
        check(slow.safetyTimeoutFired(), "the first timeout probes")
        eq(slow.probeReturned(.alive), .reveal, "loaded and painted reveals at the timeout")
        check(!slow.isRecovering, "a slow-but-alive start never shows the recovery page")

        var seeded = StartupRecoveryGate()
        seeded.attached(alreadyFinishedNavigation: true)
        check(seeded.didFinishNavigation, "attaching after the entry document committed seeds the navigation evidence")
        check(seeded.safetyTimeoutFired(), "the timeout still probes a seeded attach")
        eq(seeded.probeReturned(.dead), .recover, "seeded evidence is not enough: an unpainted root is still dead")

        // MARK: Gate — failure
        var cancelled = StartupRecoveryGate()
        eq(cancelled.navigationFailed(isBenign: true), .none, "a cancelled navigation is not a failure")
        check(!cancelled.isRecovering, "and never shows the recovery page")

        var firstFailure = StartupRecoveryGate()
        eq(firstFailure.navigationFailed(isBenign: false), .recover, "a failed first navigation shows the page immediately")

        var afterLoad = StartupRecoveryGate()
        _ = afterLoad.navigationFinished()
        eq(afterLoad.navigationFailed(isBenign: false), .none, "a failure after a document loaded is left to the web layer")
        check(!afterLoad.isRecovering, "so no recovery page over a page that is alive")

        // MARK: Gate — timeout -> recovery
        var dead = StartupRecoveryGate()
        check(dead.safetyTimeoutFired(), "the safety timeout fires once")
        eq(dead.probeReturned(.dead), .recover, "no navigation and no painted root shows the bounded exit")
        check(dead.isRecovering, "the recovery page is up")
        eq(dead.probeReturned(.dead), .none, "a repeated probe does not re-present the page")
        check(!dead.safetyTimeoutFired(), "the timeout stays spent until a retry re-arms it")
        eq(dead.retry(committed: committed, attempted: nil, entry: entry), .retry(committed),
           "a retry from the recovery page starts a load")

        // MARK: Gate — retry clears the attempt, re-arms, and a repeat failure returns
        var loop = StartupRecoveryGate()
        _ = loop.navigationFinished()
        _ = loop.safetyTimeoutFired()
        eq(loop.probeReturned(.dead), .recover, "the first attempt failed")
        check(loop.didFinishNavigation, "with the dead attempt's navigation evidence recorded")
        eq(loop.retry(committed: nil, attempted: nil, entry: entry), .retry(entry),
           "a retry with nothing committed and nothing attempted takes the entry-URL fallback")
        check(!loop.isRecovering, "the page goes away for the new attempt")
        check(!loop.didFinishNavigation, "the new attempt starts with no navigation evidence")
        check(!loop.isReady, "readiness is cleared so the handshake can complete a second time")
        check(loop.safetyTimeoutFired(), "the timeout is re-armed for the new attempt")
        eq(loop.probeReturned(.dead), .recover, "a second failure returns to the recovery page")
        eq(loop.retry(committed: nil, attempted: nil, entry: entry), .retry(entry),
           "and the page stays actionable however many times it fails")
        check(loop.safetyTimeoutFired(), "each attempt is bounded again")

        // MARK: Gate — a handshake that lands while the recovery page is up wins
        var late = StartupRecoveryGate()
        _ = late.safetyTimeoutFired()
        eq(late.probeReturned(.dead), .recover, "the page is up after a dead probe")
        eq(late.splashReady(), .reveal, "a handshake that lands while the page is up reveals")
        check(!late.isRecovering, "and hides the recovery page")
        check(late.hasRevealed, "the mask is done")

        // MARK: Gate — a tap with nothing to load must be visibly unavailable
        var nothing = StartupRecoveryGate()
        _ = nothing.safetyTimeoutFired()
        eq(nothing.probeReturned(.dead), .recover, "the page is up after a dead probe")
        eq(nothing.retry(committed: nil, attempted: nil, entry: nil), .retryUnavailable,
           "a tap with no web view, no committed URL, no attempted URL and no entry URL says so")
        check(nothing.isRecovering, "the page stays up: the user is never left with nothing")

        var masking = StartupRecoveryGate()
        eq(masking.retry(committed: committed, attempted: nil, entry: nil), .none,
           "a retry before the recovery page is up is ignored")

        print("Startup recovery: probe anchor, slow-vs-dead rule, cancellation handling, retry plan and the recovery/retry transitions passed")
    }
}
