import Foundation

/// Pure checks for uplink in-flight acks and the 10 MB pending+stash+inflight cap.
enum UplinkInflightTests {
    static func run() {
        ackPopsCompleteMessages()
        ackInsideMessageKeepsTheTail()
        resumeRestoresUnconfirmedAheadOfNewFrames()
        resumeZeroAndOverflow()
        flapResumeDoesNotRequeueTwice()
        clearThenResumeAlignsPrefix()
        resumeBehindPrefixRequeuesWithoutConsumed()
        paddingConfirmsOnWireBytes()
        eachRawByteConsumedOnce()
        capDropsOldestFrame()
        capNeverExceedsAndExactFit()
        requeueDropsOldest()
        oversizedFrameDoesNotCrash()
        tryEnqueueRefusesWithoutDropping()
        resumeTimeoutDropsInflight()
        rxAckThroughReceiver()
        print("UplinkInflightTests passed")
    }

    private static func ackPopsCompleteMessages() {
        var u = UplinkInflight()
        u.noteSent(frames: [Data(count: 100)], raw: 100, sent: 100, captureId: "a", sessionId: "s")
        u.noteSent(frames: [Data(count: 200)], raw: 200, sent: 200, captureId: "b", sessionId: "s")
        u.noteSent(frames: [Data(count: 300)], raw: 300, sent: 300, captureId: "c", sessionId: "s")
        let got = u.apply(rx: 300)
        eq(got.count, 2)
        eq(got[0].rawBytes, 100)
        eq(got[1].rawBytes, 200)
        eq(u.messages.count, 1)
        eq(u.rawBytes, 300)
    }

    private static func ackInsideMessageKeepsTheTail() {
        var u = UplinkInflight()
        u.noteSent(frames: [Data(count: 100)], raw: 100, sent: 100, captureId: "a", sessionId: "s")
        u.noteSent(frames: [Data(count: 100)], raw: 100, sent: 100, captureId: "b", sessionId: "s")
        let got = u.apply(rx: 150)
        eq(got.count, 1)
        eq(got[0].captureId, "a")
        eq(u.messages.count, 1)
        eq(u.messages[0].captureId, "b")
    }

    private static func resumeRestoresUnconfirmedAheadOfNewFrames() {
        var u = UplinkInflight()
        let second = Data([2])
        let third = Data([3, 3])
        u.noteSent(frames: [Data([1])], raw: 1, sent: 10, captureId: "a", sessionId: "s")
        u.noteSent(frames: [second], raw: 1, sent: 10, captureId: "b", sessionId: "s")
        u.noteSent(frames: [third], raw: 2, sent: 10, captureId: "c", sessionId: "s")
        var pending = [Data([9])]
        let result = u.resume(prevRx: 10)
        eq(result.consumed.count, 1)
        eq(result.consumed[0].rawBytes, 1)
        pending.insert(contentsOf: result.frames, at: 0)
        eq(pending, [second, third, Data([9])])
        eq(u.isEmpty, true)
        eq(u.testingPrefixWire, 10)
    }

    private static func resumeZeroAndOverflow() {
        var none = UplinkInflight()
        none.noteSent(frames: [Data([1]), Data([2])], raw: 2, sent: 50, captureId: "a", sessionId: "s")
        none.noteSent(frames: [Data([3])], raw: 1, sent: 50, captureId: "b", sessionId: "s")
        let zero = none.resume(prevRx: 0)
        eq(zero.consumed.count, 0)
        eq(zero.frames, [Data([1]), Data([2]), Data([3])])

        var all = UplinkInflight()
        all.noteSent(frames: [Data([1])], raw: 1, sent: 50, captureId: "a", sessionId: "s")
        all.noteSent(frames: [Data([2])], raw: 1, sent: 50, captureId: "b", sessionId: "s")
        let over = all.resume(prevRx: 10_000)
        eq(over.consumed.count, 2)
        eq(over.frames.count, 0)
        eq(all.isEmpty, true)
        eq(all.testingPrefixWire, 10_000)
    }

    /// Conn 2 resumes A+B and parks C. Conn 3 sees the same prev_rx and must not touch C again.
    private static func flapResumeDoesNotRequeueTwice() {
        var u = UplinkInflight()
        let a = Data([1])
        let b = Data([2])
        let c = Data([3])
        u.noteSent(frames: [a], raw: 1, sent: 10, captureId: "a", sessionId: "s")
        u.noteSent(frames: [b], raw: 1, sent: 20, captureId: "b", sessionId: "s")
        u.noteSent(frames: [c], raw: 1, sent: 30, captureId: "c", sessionId: "s")
        var pending: [Data] = []
        let second = u.resume(prevRx: 30)
        eq(second.consumed.count, 2)
        eq(second.consumed[0].rawBytes, 1)
        eq(second.consumed[1].rawBytes, 1)
        pending.insert(contentsOf: second.frames, at: 0)
        eq(pending, [c])
        eq(u.testingPrefixWire, 30)
        let third = u.resume(prevRx: 30)
        eq(third.consumed.count, 0)
        eq(third.frames.count, 0)
        pending.insert(contentsOf: third.frames, at: 0)
        eq(pending, [c])
        eq(u.testingPrefixWire, 30)
    }

    /// stop() clears prefixWire. The next uplink_resume realigns, then rx_ack pops only the new frame.
    private static func clearThenResumeAlignsPrefix() {
        var u = UplinkInflight()
        u.noteSent(frames: [Data([1])], raw: 1, sent: 10, captureId: "old", sessionId: "s")
        u.clear()
        eq(u.testingPrefixWire, 0)
        let t = 5000
        let aligned = u.resume(prevRx: t)
        eq(aligned.consumed.count, 0)
        eq(aligned.frames.count, 0)
        eq(u.testingPrefixWire, t)
        let d = Data([4])
        u.noteSent(frames: [d], raw: 4, sent: 40, captureId: "d", sessionId: "s")
        let got = u.apply(rx: t + 40)
        eq(got.count, 1)
        eq(got[0].rawBytes, 4)
        eq(u.isEmpty, true)
        eq(u.testingPrefixWire, t + 40)
    }

    /// prev_rx behind prefixWire requeues every in-flight frame and confirms nothing.
    private static func resumeBehindPrefixRequeuesWithoutConsumed() {
        var u = UplinkInflight()
        u.noteSent(frames: [Data([0])], raw: 1, sent: 1000, captureId: "pre", sessionId: "s")
        eq(u.apply(rx: 1000).count, 1)
        eq(u.testingPrefixWire, 1000)
        let a = Data([1])
        let b = Data([2])
        u.noteSent(frames: [a], raw: 1, sent: 100, captureId: "a", sessionId: "s")
        u.noteSent(frames: [b], raw: 1, sent: 100, captureId: "b", sessionId: "s")
        let result = u.resume(prevRx: 400)
        eq(result.consumed.count, 0)
        eq(result.frames, [a, b])
        eq(u.isEmpty, true)
        eq(u.testingPrefixWire, 400)
    }

    private static func paddingConfirmsOnWireBytes() {
        var u = UplinkInflight()
        u.noteSent(frames: [Data(count: 100)], raw: 100, sent: 1600, captureId: "a", sessionId: "s")
        eq(u.apply(rx: 1599).count, 0)
        eq(u.messages.count, 1)
        let got = u.apply(rx: 1600)
        eq(got.count, 1)
        eq(got[0].rawBytes, 100)
    }

    private static func eachRawByteConsumedOnce() {
        var u = UplinkInflight()
        u.noteSent(frames: [Data(count: 10)], raw: 10, sent: 1600, captureId: "a", sessionId: "s")
        u.noteSent(frames: [Data(count: 20)], raw: 20, sent: 1600, captureId: "b", sessionId: "s")
        u.noteSent(frames: [Data(count: 30)], raw: 30, sent: 1600, captureId: "c", sessionId: "s")
        var seen: [String: Int] = [:]
        for item in u.apply(rx: 1600) {
            seen[item.captureId, default: 0] += 1
        }
        let again = u.resume(prevRx: 1600)
        for item in again.consumed {
            seen[item.captureId, default: 0] += 1
        }
        eq(again.frames.count, 2)
        var replay = UplinkInflight()
        replay.noteSent(frames: [again.frames[0]], raw: 20, sent: 1600, captureId: "b", sessionId: "s")
        replay.noteSent(frames: [again.frames[1]], raw: 30, sent: 1600, captureId: "c", sessionId: "s")
        for item in replay.apply(rx: 3200) {
            seen[item.captureId, default: 0] += 1
        }
        eq(seen["a"] ?? -1, 1)
        eq(seen["b"] ?? -1, 1)
        eq(seen["c"] ?? -1, 1)
    }

    private static func capDropsOldestFrame() {
        let uplink = AudioUplink.shared
        uplink.testingResetBuffers()
        let frame = Data(count: 1024)
        let n = UplinkInflight.maxBytes / frame.count
        for _ in 0 ..< n {
            uplink.testingBuffer(frame, dropOldest: true)
        }
        eq(uplink.testingOccupied(), UplinkInflight.maxBytes)
        eq(uplink.testingDropped(), 0)
        uplink.testingBuffer(frame, dropOldest: true)
        eq(uplink.testingDropped(), frame.count)
        eq(uplink.testingOccupied(), UplinkInflight.maxBytes)
    }

    private static func capNeverExceedsAndExactFit() {
        let uplink = AudioUplink.shared
        uplink.testingResetBuffers()
        let frame = Data(count: 4096)
        var bytes = 0
        while bytes + frame.count <= UplinkInflight.maxBytes {
            uplink.testingBuffer(frame, dropOldest: true)
            bytes += frame.count
            check(uplink.testingOccupied() <= UplinkInflight.maxBytes, "occupied \(uplink.testingOccupied()) over cap")
        }
        eq(uplink.testingOccupied(), bytes)
        eq(uplink.testingDropped(), 0)
        let hugeInflight = Data(count: 2048)
        uplink.testingNoteSent(frames: [hugeInflight], raw: hugeInflight.count, sent: hugeInflight.count, captureId: "i", sessionId: "s")
        check(uplink.testingOccupied() <= UplinkInflight.maxBytes + hugeInflight.count, "note")
        uplink.testingBuffer(Data(count: 1), dropOldest: true)
        check(uplink.testingOccupied() <= UplinkInflight.maxBytes, "trim keeps pending+stash+inflight within cap")
    }

    private static func requeueDropsOldest() {
        let uplink = AudioUplink.shared
        uplink.testingResetBuffers()
        let frame = Data(repeating: 0x22, count: 1024)
        let n = UplinkInflight.maxBytes / frame.count
        for _ in 0 ..< n {
            uplink.testingBuffer(frame, dropOldest: true)
        }
        let oldest = Data(repeating: 0x11, count: 1024)
        uplink.testingNoteSent(frames: [oldest], raw: oldest.count, sent: oldest.count, captureId: "old", sessionId: "s")
        let consumed = uplink.testingRequeue(prevRx: 0)
        eq(consumed.count, 0)
        eq(uplink.testingDropped(), oldest.count)
        eq(uplink.testingOccupied(), UplinkInflight.maxBytes)
        eq(uplink.testingInflightRaw(), 0)
        eq(uplink.testingPendingHead() ?? Data(), frame)
    }

    /// A single frame larger than the cap is appended and then trimmed away.
    /// `droppedBytes` grows by that frame's size and the buffer is empty. No crash.
    private static func oversizedFrameDoesNotCrash() {
        let uplink = AudioUplink.shared
        uplink.testingResetBuffers()
        let huge = Data(count: UplinkInflight.maxBytes + 1)
        uplink.testingBuffer(huge, dropOldest: true)
        eq(uplink.testingOccupied(), 0)
        eq(uplink.testingDropped(), huge.count)
        eq(uplink.testingPendingBytes(), 0)
    }

    private static func tryEnqueueRefusesWithoutDropping() {
        let uplink = AudioUplink.shared
        uplink.testingResetBuffers()
        let frame = Data(count: 1024)
        let n = UplinkInflight.maxBytes / frame.count
        for _ in 0 ..< n {
            uplink.testingBuffer(frame, dropOldest: true)
        }
        let dropped = uplink.testingDropped()
        let occupied = uplink.testingOccupied()
        check(uplink.tryEnqueue(Data(count: 1)) == false, "tryEnqueue over cap returns false")
        eq(uplink.testingDropped(), dropped)
        eq(uplink.testingOccupied(), occupied)
        eq(uplink.testingInflightRaw(), 0)
    }

    private static func resumeTimeoutDropsInflight() {
        eq(UplinkInflight.resumeTimeout, 2.0)
        var u = UplinkInflight()
        u.noteSent(frames: [Data(count: 40)], raw: 40, sent: 1600, captureId: "a", sessionId: "s")
        u.noteSent(frames: [Data(count: 60)], raw: 60, sent: 1600, captureId: "b", sessionId: "s")
        let dropped = u.expireUnconfirmed()
        eq(dropped, 100)
        eq(u.rawBytes, 0)
        eq(u.isEmpty, true)
        eq(u.apply(rx: 10_000).count, 0)
    }

    private static func rxAckThroughReceiver() {
        let uplink = AudioUplink.shared
        uplink.testingResetBuffers()
        uplink.testingNoteSent(frames: [Data(count: 100)], raw: 100, sent: 1600, captureId: "pad", sessionId: "s")
        uplink.handleAudioText(#"{"type":"rx_ack","rx":1600}"#)
        eq(uplink.testingInflightRaw(), 0)
        eq(uplink.testingDropped(), 0)
    }
}
