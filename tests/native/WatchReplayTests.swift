import Foundation

func check(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func deliver(_ session: WatchPhoneSession, _ message: [String: Any]) {
    session.session(WCSession.default, didReceiveMessage: message)
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
}
@main struct WatchReplayTests {
 static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = WatchPcmStore(rootURL: root)
    store.beginCapture(); store.bindSession("live")
    let session = WatchPhoneSession(pcmStore: store, connect: false)
    deliver(session, ["sessionId": "live"])
    session.draining = true
    deliver(session, ["sessionId": "old", "pcmRejected": "true", "pcmRejectSessionId": "old", "pcmRejectCaptureId": "old-capture"])
    check(!session.pcmRejected && session.draining, "old rejection must not terminate a new capture")
    check(store.sessionId == "live", "old payload must not overwrite recording identity")
    deliver(session, ["pcmRejected": "true", "pcmRejectSessionId": "live", "pcmRejectCaptureId": "old-capture"])
    check(!session.pcmRejected, "same-session old capture rejection ignored")
    deliver(session, ["pcmRejected": "true", "pcmRejectSessionId": "live", "pcmRejectCaptureId": store.captureId])
    check(session.pcmRejected && session.drainFailed && !session.draining, "matching rejection ends drain")
    // A system-held old capture must not be deleted even after local state resets.
    // Matching rejection already froze this capture, so use a fresh old recording.
    store.beginCapture(); store.bindSession("old-storage")
    _ = store.append(Data(repeating: 2, count: 3200)); store.closeShard()
    let storedId = store.captureId
    let shard = store.unackedShards()[0]
    _ = WCSession.default.transferFile(shard.url, metadata: store.metadata(for: shard))
    store.beginCapture()
    check(session.deleteUnfinishedCapture(storedId) == 0, "in-flight source file must not be removed")
    check(FileManager.default.fileExists(atPath: shard.url.path), "in-flight original preserved")
    // End after terminal failure cannot re-arm upload. Leaving keeps files.
    session.finish()
    check(!session.draining && session.drainFailed, "terminal End must not retry")
    session.leaveIncomplete()
    check(!session.draining && !session.drainFailed, "failure page has a usable exit")
    check(FileManager.default.fileExists(atPath: shard.url.path), "leaving preserves original")

    // The file has now completed: only its matching record may be released.
    let transfer = WCSession.default.outstandingFileTransfers.removeFirst()
    session.session(WCSession.default, didFinish: transfer, error: nil)
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    check(session.deleteUnfinishedCapture(storedId) == 3200, "completed old capture can be deleted")

    // Real filesystem budget across captures; external PCM arrives through the
    // same recorder callback used on device, not a model of storage failure.
    let diskRoot = root.appendingPathComponent("budget")
    let old = diskRoot.appendingPathComponent("old")
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    let file = old.appendingPathComponent("1.pcm")
    FileManager.default.createFile(atPath: file.path, contents: nil)
    let fh = try FileHandle(forWritingTo: file)
    try fh.truncate(atOffset: UInt64(WatchPcmStore.diskLimit - 64)); try fh.close()
    let fullStore = WatchPcmStore(rootURL: diskRoot)
    fullStore.beginCapture()
    check(fullStore.usedBytes == WatchPcmStore.diskLimit - 64, "new capture counts old disk bytes")
    let fullSession = WatchPhoneSession(pcmStore: fullStore, connect: false)
    fullSession.listening = true
    WatchRecorder.shared.isRunning = true
    WatchRecorder.shared.onPcm?(Data(repeating: 3, count: 1600))
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    check(fullSession.storageFailed && fullSession.drainFailed, "disk full becomes visible failure state")
    check(!fullSession.listening && !WatchRecorder.shared.isRunning, "disk full stops both capture and recording state")
    fullSession.leaveIncomplete()
    check(!fullSession.drainFailed && !fullSession.unfinishedCaptureList.isEmpty, "storage remains accessible after failure")
    check(fullSession.deleteUnfinishedCapture("old") > 0, "explicit old capture cleanup frees space")
    fullSession.startSession()
    check(!fullSession.storageFailed && !fullSession.pcmRejected, "fresh capture resets failure only after explicit Start")
    let lateStore = WatchPcmStore(rootURL: root.appendingPathComponent("late"))
    lateStore.beginCapture()
    let lateWatch = WatchPhoneSession(pcmStore: lateStore, connect: false)
    lateWatch.listening = true
    WatchRecorder.shared.onPcm?(Data(repeating: 6, count: 640))
    lateWatch.finish()
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    check(!lateWatch.storageFailed, "normal End with a late recorder callback must not report disk full")

    let nativeStore = WatchPcmStore(rootURL: root.appendingPathComponent("native"))
    nativeStore.beginCapture(); nativeStore.bindSession("native-session")
    let nativeWatch = WatchPhoneSession(pcmStore: nativeStore, connect: false)
    let uplink = AudioUplink.shared
    let ingest = WatchPcmIngest.shared
    let bridge = WatchBridge.shared
    WCSession.default.messages.removeAll()
    NotificationCenter.default.post(name: Notification.Name("nod.watch.pcm.bind"), object: nil,
        userInfo: ["sessionId": "native-session", "captureId": nativeStore.captureId])
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    _ = ingest.ingestLive(data: Data(repeating: 4, count: 32000), captureId: nativeStore.captureId, sessionId: "native-session", offset: 0)
    for _ in 0..<10 {
        NotificationCenter.default.post(name: Notification.Name("nod.uplink.consumed"), object: nil,
            userInfo: ["sessionId": "native-session", "captureId": nativeStore.captureId, "bytes": 3200])
    }
    RunLoop.main.run(until: Date().addingTimeInterval(1.15))
    let acks = WCSession.default.messages.filter { $0["pcmAckByte"] != nil }
    check(acks.count == 1 && acks[0]["pcmAckByte"] as? String == "32000", "coalesced ack includes final byte without next frame")
    bridge.pushStatus(capture: "listening", hint: "", sessionId: "native-session")
    let wire: [String: Any] = ["type": "pcm_rejected", "id": "native-session", "capture_id": nativeStore.captureId, "reason": "session_ended"]
    let wireText = String(data: try JSONSerialization.data(withJSONObject: wire), encoding: .utf8)!
    uplink.handleAudioText(wireText)
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    check(!uplink.tryEnqueue(Data(repeating: 5, count: 1600)), "terminal socket cannot queue more PCM")
    check(uplink.queuedBytes() == 0, "terminal socket clears undeliverable working queue")
    check(ingest.ingestLive(data: Data(repeating: 5, count: 1600), captureId: nativeStore.captureId, sessionId: "native-session", offset: 32000) == "session-ended", "ingest does not feed terminated session")
    let rejected = WCSession.default.messages.last { $0["pcmRejected"] as? String == "true" }
    check(rejected != nil, "AudioUplink rejection reaches WatchBridge status immediately")
    nativeWatch.draining = true
    deliver(nativeWatch, rejected!)
    check(nativeWatch.pcmRejected && !nativeWatch.draining, "native socket to actual Watch consumer ends drain")
    print("Watch replay: sender relay, ack tail, identity, terminal exit, in-flight deletion and disk-full tests passed")
 }
}
