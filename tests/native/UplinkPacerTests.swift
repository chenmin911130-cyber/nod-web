import Foundation

/// Pure clock tests for `UplinkPacer`. Time is simulated; nothing sleeps.
enum UplinkPacerTests {
    static func run() {
        legacyReproducesDrift()
        legacyMatchesBaselineFormula()
        cumulativeNoDrift()
        catchupDrainsBacklogBounded()
        noCatchupWhenRateOne()
        slackBoundsBurst()
        framesForMessageCases()
        applyConfigClamps()
        uplinkConfigThroughReceiver()
        print("UplinkPacerTests passed")
    }

    /// Pre-B cadence: each send waits, then pays 3 ms of leeway and 6.4 ms to completion.
    private static func legacyReproducesDrift() {
        var pacer = UplinkPacer()
        pacer.mode = .legacy
        var now: TimeInterval = 0
        var first: TimeInterval = 0
        var last: TimeInterval = 0
        for i in 0 ..< 600 {
            let start = now + pacer.waitBeforeSend(now: now) + 0.003
            if i == 0 { first = start }
            if i == 599 { last = start }
            let complete = start + 0.0064
            pacer.noteSendCompleted(now: complete, audioSeconds: 0.1)
            now = complete
        }
        let elapsed = last - first
        print(String(format: "legacy 600 sends: %.4f s", elapsed))
        check(elapsed >= 63.5, "legacy 600 sends drifted \(elapsed) s, want >= 63.5")
    }

    /// `waitBeforeSend` equals the formula that used to live in `AudioUplink.pump`.
    private static func legacyMatchesBaselineFormula() {
        let triples: [(TimeInterval, TimeInterval, TimeInterval)] = [
            (0, 0.1, 0.04),
            (1.0, 0.1, 1.05),
            (2.5, 0.1, 2.7),
            (10, 0.2, 10.05),
            (10, 0.2, 10.25),
            (3, 0.05, 3.0),
            (4, 0.1, 3.9),
            (8, 0.15, 8.2),
            (0, 0, 1),
            (5, 0.1, 5.1),
            (6.4, 0.1, 6.403),
            (7, 0.32, 7.1),
            (9, 0.1, 9.099),
            (12, 0.05, 12.04),
            (15, 0.1, 14.95),
            (20, 0.2, 20.3),
            (30, 0.1, 30.0064),
            (40, 0.003, 40.002),
            (50, 0.1, 50.103),
            (100, 0.1, 99.5),
        ]
        check(triples.count == 20, "baseline formula covers 20 triples")
        for (lastSendAt, lastAudio, now) in triples {
            var pacer = UplinkPacer()
            pacer.mode = .legacy
            pacer.noteSendCompleted(now: lastSendAt, audioSeconds: lastAudio)
            let got = pacer.waitBeforeSend(now: now)
            let want = max(0, lastAudio - (now - lastSendAt))
            check(abs(got - want) < 1e-9, "legacy wait \(got) != baseline \(want)")
        }
    }

    private static func cumulativeNoDrift() {
        var pacer = UplinkPacer()
        var now: TimeInterval = 0
        var first: TimeInterval = 0
        var last: TimeInterval = 0
        for i in 0 ..< 600 {
            let start = now + pacer.waitBeforeSend(now: now) + 0.003
            if i == 0 { first = start }
            if i == 599 { last = start }
            pacer.noteSendStarted(now: start, audioSeconds: 0.1, pendingFramesBefore: 1)
            let complete = start + 0.0064
            pacer.noteSendCompleted(now: complete, audioSeconds: 0.1)
            now = complete
        }
        let elapsed = last - first
        print(String(format: "cumulative 600 sends: %.4f s", elapsed))
        check(abs(elapsed - 59.9) <= 0.05, "cumulative 600 sends \(elapsed) s, want 59.9 ± 0.05")
    }

    private static func catchupDrainsBacklogBounded() {
        var pacer = UplinkPacer()
        pacer.catchupRate = 1.5
        pacer.coalesceMax = 3
        var pending = 50
        var t: TimeInterval = 0
        var nextArrival: TimeInterval = 0.1
        var starts: [(TimeInterval, Int, TimeInterval)] = []
        while t < 30, pending > 1 {
            let target = t + pacer.waitBeforeSend(now: t)
            while nextArrival <= target + 1e-12 {
                pending += 1
                nextArrival += 0.1
            }
            t = target
            if pending <= 1 { break }
            let n = pacer.framesForMessage(pendingFrames: pending)
            let audio = TimeInterval(n) * 0.1
            pacer.noteSendStarted(now: t, audioSeconds: audio, pendingFramesBefore: pending)
            pending -= n
            starts.append((t, n, audio))
            if pending <= 1 { break }
        }
        check(t <= 11.0, "catch-up drain t=\(t) s, want <= 11")
        check(starts.allSatisfy { $0.1 <= 3 }, "a catch-up message exceeded 3 frames")
        var worstMessages = 0
        var worstAudio: TimeInterval = 0
        for (start, _, _) in starts {
            var messages = 0
            var audio: TimeInterval = 0
            for (other, _, seconds) in starts where other >= start && other < start + 1 {
                messages += 1
                audio += seconds
            }
            worstMessages = max(worstMessages, messages)
            worstAudio = max(worstAudio, audio)
        }
        check(worstMessages <= 10, "catch-up sent \(worstMessages) msgs in 1 s")
        check(worstAudio <= 2.1, "catch-up sent \(worstAudio) s of audio in 1 s")
        print(String(format: "catch-up drain: %.3f s, worst %d msgs/s, %.3f audio-s/s", t, worstMessages, worstAudio))
    }

    /// Drift fix without catch-up. Coalesce stays 1 so one in-flight frame leaves 49 of 50.
    private static func noCatchupWhenRateOne() {
        var pacer = UplinkPacer()
        pacer.catchupRate = 1.0
        pacer.coalesceMax = 1
        var pending = 50
        var t: TimeInterval = 0
        var nextArrival: TimeInterval = 0.1
        var minPending = pending
        while t < 10 {
            let target = t + pacer.waitBeforeSend(now: t)
            while nextArrival <= min(target, 10) + 1e-12 {
                pending += 1
                nextArrival += 0.1
                minPending = min(minPending, pending)
            }
            if target > 10 { break }
            t = target
            let n = pacer.framesForMessage(pendingFrames: pending)
            pacer.noteSendStarted(now: t, audioSeconds: TimeInterval(n) * 0.1, pendingFramesBefore: pending)
            pending -= n
            minPending = min(minPending, pending)
        }
        check(minPending >= 49, "rate 1.0 backlog fell to \(minPending), want >= 49")
    }

    private static func slackBoundsBurst() {
        var pacer = UplinkPacer()
        pacer.catchupRate = 1.5
        pacer.coalesceMax = 3
        pacer.testingSetNextSendAt(10)
        var now: TimeInterval = 20
        var pending = 30
        var zeroRun = 0
        var maxZero = 0
        var steps = 0
        while pending > 1, steps < 40 {
            let wait = pacer.waitBeforeSend(now: now)
            if wait == 0 {
                zeroRun += 1
                maxZero = max(maxZero, zeroRun)
            } else {
                zeroRun = 0
            }
            now += wait
            let n = pacer.framesForMessage(pendingFrames: pending)
            pacer.noteSendStarted(now: now, audioSeconds: TimeInterval(n) * 0.1, pendingFramesBefore: pending)
            pending -= n
            steps += 1
        }
        check(maxZero >= 1 && maxZero <= 3, "slack allowed \(maxZero) consecutive zero waits, want 1...3")
    }

    private static func framesForMessageCases() {
        var legacy = UplinkPacer()
        legacy.mode = .legacy
        legacy.coalesceMax = 3
        eq(legacy.framesForMessage(pendingFrames: 0), 0)
        eq(legacy.framesForMessage(pendingFrames: 1), 1)
        eq(legacy.framesForMessage(pendingFrames: 5), 1)

        var cumulative = UplinkPacer()
        cumulative.coalesceMax = 3
        eq(cumulative.framesForMessage(pendingFrames: 0), 0)
        eq(cumulative.framesForMessage(pendingFrames: 1), 1)
        eq(cumulative.framesForMessage(pendingFrames: 2), 2)
        eq(cumulative.framesForMessage(pendingFrames: 5), 3)
        cumulative.coalesceMax = 1
        eq(cumulative.framesForMessage(pendingFrames: 5), 1)
    }

    private static func applyConfigClamps() {
        var pacer = UplinkPacer()
        pacer.catchupRate = 1.25
        pacer.coalesceMax = 4
        pacer.apply(config: ["catchup_rate": NSNumber(value: 9.0)])
        eq(pacer.catchupRate, 2.0)
        pacer.apply(config: ["catchup_rate": NSNumber(value: 0.5)])
        eq(pacer.catchupRate, 1.0)
        pacer.apply(config: ["coalesce_max": NSNumber(value: 0)])
        eq(pacer.coalesceMax, 1)
        pacer.apply(config: ["coalesce_max": NSNumber(value: 50)])
        eq(pacer.coalesceMax, 10)
        pacer.apply(config: ["pace": "legacy"])
        eq(pacer.mode, UplinkPacer.Mode.legacy)
        pacer.apply(config: ["pace": "cumulative"])
        eq(pacer.mode, UplinkPacer.Mode.cumulative)
        pacer.apply(config: ["pace": "bogus"])
        eq(pacer.mode, UplinkPacer.Mode.cumulative)
        pacer.catchupRate = 1.7
        pacer.coalesceMax = 4
        pacer.apply(config: [:])
        eq(pacer.catchupRate, 1.7)
        eq(pacer.coalesceMax, 4)
        eq(pacer.mode, UplinkPacer.Mode.cumulative)
    }

    private static func uplinkConfigThroughReceiver() {
        let text = #"{"type":"uplink_config","v":1,"pace":"cumulative","catchup_rate":1.5,"coalesce_max":3}"#
        AudioUplink.shared.handleAudioText(text)
        let pacer = AudioUplink.shared.pacerForTesting
        eq(pacer.catchupRate, 1.5)
        eq(pacer.coalesceMax, 3)
        eq(pacer.mode, UplinkPacer.Mode.cumulative)
    }
}
