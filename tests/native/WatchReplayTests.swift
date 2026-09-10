import Foundation

func check(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func deliver(_ session: WatchPhoneSession, _ message: [String: Any]) {
    session.session(WCSession.default, didReceiveMessage: message)
    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
}
func waitSend() {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}

@main struct WatchReplayTests {
 static func main() throws {
    check(!AudioUplink.handshakeMeansSessionExpired(403), "HTTP 403 is not a listen-session expiry")
    check(AudioUplink.shouldStopOnHandshake(403), "HTTP 403 stops reconnect without pretending the capture ended")
    check(!AudioUplink.shouldStopOnHandshake(4404), "websocket 4404 is not classified as HTTP handshake")

    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    PhonePcmStore.testingRoot = root.appendingPathComponent("shared-phone")

    let phone = PhonePcmStore(rootURL: root.appendingPathComponent("phone"))
    check(phone.begin(captureId: "cap-a"), "phone persist file is created before Recording")
    check(phone.isReady(captureId: "cap-a"), "persist-ready is the phone file, not a socket")
    phone.bindSession("live")
    eq(phone.persist(data: Data(repeating: 1, count: 1600), captureId: "cap-a", sessionId: "live", offset: 0), "accept")
    check(phone.currentHeldByte() == 1600, "in-order live bytes become the ack prefix")
    eq(phone.persist(data: Data(repeating: 1, count: 1600), captureId: "cap-a", sessionId: "live", offset: 0), "duplicate")
    check(phone.currentHeldByte() == 1600, "duplicate does not rewrite")
    eq(phone.persist(data: Data(repeating: 2, count: 1600), captureId: "cap-a", sessionId: "live", offset: 3200), "future")
    check(phone.currentHeldByte() == 1600, "future bytes park without advancing ack")
    eq(phone.persist(data: Data(repeating: 3, count: 1600), captureId: "cap-a", sessionId: "live", offset: 1600), "accept")
    check(phone.currentHeldByte() == 4800, "filling the gap appends the parked tail")
    eq(phone.persist(data: Data(repeating: 9, count: 100), captureId: "old", sessionId: "live", offset: 4800), "stale-capture")
    check(phone.seal(lastByte: 4800, captureId: "cap-a", sessionId: "live"), "seal succeeds when the prefix is complete")
    check(phone.read(from: 0, maxBytes: 4800)?.count == 4800, "upload reads from the file, not an in-memory copy of the whole capture")

    let restarted = PhonePcmStore(rootURL: root.appendingPathComponent("phone"))
    check(restarted.currentCaptureId() == "cap-a", "restart finds the persisted capture")
    check(restarted.currentHeldByte() == 4800, "restart restores the held prefix from disk")
    check(restarted.isSealed(), "restart restores the save intent / sealed flag")

    PhonePcmStore.testingDiskLimit = 2000
    defer { PhonePcmStore.testingDiskLimit = nil }
    let tight = PhonePcmStore(rootURL: root.appendingPathComponent("tight"))
    check(tight.begin(captureId: "cap-full"), "tiny-cap persist still opens a file")
    eq(tight.persist(data: Data(repeating: 1, count: 1600), captureId: "cap-full", sessionId: "live", offset: 0), "accept")
    eq(tight.persist(data: Data(repeating: 1, count: 1600), captureId: "cap-full", sessionId: "live", offset: 1600), "persist-failed")
    check(tight.currentHeldByte() == 1600, "disk-full persist keeps the unique phone original")
    PhonePcmStore.testingDiskLimit = nil

    let leftover = WatchPcmStore(rootURL: root.appendingPathComponent("legacy"))
    leftover.beginCapture()
    leftover.bindSession("old-storage")
    _ = leftover.append(Data(repeating: 2, count: 3200)); leftover.closeShard()
    let storedId = leftover.captureId
    let shard = leftover.unackedShards()[0]
    _ = WCSession.default.transferFile(shard.url, metadata: leftover.metadata(for: shard))
    leftover.beginCapture()
    let leftoverSession = WatchPhoneSession(pcmStore: leftover, connect: false)
    check(leftoverSession.deleteUnfinishedCapture(storedId) == 0, "in-flight leftover source file must not be removed")
    check(FileManager.default.fileExists(atPath: shard.url.path), "upgrade keeps leftover Watch originals")
    let transfer = WCSession.default.outstandingFileTransfers.removeFirst()
    leftoverSession.session(WCSession.default, didFinish: transfer, error: nil)
    waitSend()
    check(leftoverSession.deleteUnfinishedCapture(storedId) == 3200, "user can delete a leftover Watch file after it is idle")

    let buf = WatchSendBuffer()
    buf.beginCapture()
    buf.bindSession("live")
    let liveStore = WatchPcmStore(rootURL: root.appendingPathComponent("watch-live"))
    let session = WatchPhoneSession(sendBuffer: buf, pcmStore: liveStore, connect: false)
    deliver(session, ["sessionId": "live", "pcmReady": "true"])
    session.draining = true
    deliver(session, ["sessionId": "old", "pcmRejected": "true", "pcmRejectSessionId": "old", "pcmRejectCaptureId": "old-capture"])
    check(!session.pcmRejected && session.draining, "old rejection must not terminate a new capture")
    deliver(session, ["pcmRejected": "true", "pcmRejectSessionId": "live", "pcmRejectCaptureId": "old-capture"])
    check(!session.pcmRejected, "same-session old capture rejection ignored")
    deliver(session, ["pcmRejected": "true", "pcmRejectSessionId": "live", "pcmRejectCaptureId": buf.captureId])
    check(session.pcmRejected && session.drainFailed && !session.draining, "matching rejection ends drain")
    session.finish()
    waitSend()
    check(!session.draining && session.drainFailed, "terminal End must not retry")
    session.leaveIncomplete()
    check(!session.draining && !session.drainFailed, "failure page has a usable exit")

    let send = WatchSendBuffer()
    send.beginCapture()
    let fullSession = WatchPhoneSession(sendBuffer: send, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("buf")), connect: false)
    fullSession.listening = true
    WatchRecorder.shared.isRunning = true
    WCSession.default.isReachable = true
    let chunk = Data(repeating: 3, count: WatchSendBuffer.limitBytes)
    WatchRecorder.shared.onPcm?(chunk)
    waitSend()
    WatchRecorder.shared.onPcm?(Data(repeating: 3, count: 1600))
    waitSend()
    check(fullSession.paused && !fullSession.listening, "buffer full pauses instead of drop-oldest")
    check(fullSession.hint == WatchCopy.linkLost, "buffer full is a visible connection failure")
    check(WatchRecorder.shared.isRunning == false, "buffer full stops Watch capture")

    let discBuf = WatchSendBuffer()
    discBuf.beginCapture()
    let disc = WatchPhoneSession(sendBuffer: discBuf, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("disc")), connect: false)
    disc.listening = true
    WatchRecorder.shared.isRunning = true
    WCSession.default.isReachable = false
    disc.sessionReachabilityDidChange(WCSession.default)
    waitSend()
    check(disc.paused && !disc.listening, "Watch-phone drop pauses instead of fake Recording")
    check(disc.hint == WatchCopy.linkLost, "disconnect copy is Connection lost")
    WCSession.default.isReachable = true

    let endBuf = WatchSendBuffer()
    endBuf.beginCapture()
    let endWatch = WatchPhoneSession(sendBuffer: endBuf, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("end")), connect: false)
    endWatch.listening = true
    WatchRecorder.shared.isRunning = true
    WatchRecorder.shared.onPcm?(Data(repeating: 6, count: 640))
    waitSend()
    endWatch.finish()
    waitSend()
    check(endWatch.draining, "End waits for the phone persist prefix")
    check(endWatch.hint == WatchCopy.sendingLast, "End copy is the last-bit send, not whole-session catch-up")
    deliver(endWatch, [
        "pcmAckByte": String(endBuf.lastByte),
        "pcmAckCaptureId": endBuf.captureId,
        "pcmSealed": "true",
        "pcmReady": "true",
    ])
    check(!endWatch.draining && endWatch.offeringSave, "persist ack completes End and offers Save even without transcript text")
    check(endWatch.hint == WatchCopy.savedLocal, "End shows phone-local save, not History")
    deliver(endWatch, ["save": "saved", "sessionId": "other"])
    check(endWatch.offeringSave, "wrong-session History ack does not claim Saved to History")
    deliver(endWatch, ["sessionId": "live-end"])
    endWatch.confirmSave()
    check(endWatch.saving, "Save waits for a matching phone ack")
    deliver(endWatch, ["ok": true, "save": "local", "sessionId": "live-end"])
    check(!endWatch.saving && endWatch.pendingSync && !endWatch.offeringSave, "local persist ack leaves Save/Don't save")
    check(endWatch.hint == WatchCopy.pendingSync, "local persist is waiting to sync, not History")
    endWatch.finishPendingSave()
    check(!endWatch.pendingSync && endWatch.hint == WatchCopy.ready, "Done leaves waiting-to-sync without discard")
    deliver(endWatch, ["save": "saved", "sessionId": "live-end"])
    check(endWatch.savedAck && !endWatch.offeringSave, "matching history_kept is Saved to History")
    deliver(endWatch, ["save": "failed", "sessionId": "live-end"])
    check(endWatch.savedAck, "late failed must not roll back Saved to History")

    let ingest = WatchPcmIngest.shared
    let uplink = AudioUplink.shared
    let bridge = WatchBridge.shared
    WCSession.default.messages.removeAll()
    ingest.reset()
    let cap = "cap-native"
    NotificationCenter.default.post(name: Notification.Name("nod.watch.pcm.bind"), object: nil,
        userInfo: ["sessionId": "native-session", "captureId": cap])
    waitSend()
    check(ingest.isReady(captureId: cap), "start bind creates the phone file before Recording")
    var saveReply: [String: Any] = [:]
    bridge.session(WCSession.default, didReceiveMessage: ["action": "save", "sessionId": "native-session"]) { saveReply = $0 }
    waitSend()
    check((saveReply["save"] as? String) == "local", "Save without WKWebView replies local, not History")
    check(ingest.listCaptures().contains(where: { $0.captureId == cap && $0.intent == "keep" }), "native Save marks phone keep intent")
    var emptySave: [String: Any] = [:]
    bridge.session(WCSession.default, didReceiveMessage: ["action": "save"]) { emptySave = $0 }
    waitSend()
    check((emptySave["save"] as? String) == "failed", "Save with empty sessionId is failed, not the current phone session")
    eq(ingest.ingestLive(data: Data(repeating: 4, count: 32000), captureId: cap, sessionId: "native-session", offset: 0), "accept")
    check(ingest.currentAck() == 32000, "Watch ack is persist held, not uplink consume")
    RunLoop.main.run(until: Date().addingTimeInterval(1.15))
    let acks = WCSession.default.messages.filter { $0["pcmAckByte"] != nil }
    check(!acks.isEmpty, "persist held still coalesces a Watch ack")
    check((acks.last?["pcmAckByte"] as? String) == "32000" || (acks.last?["pcmAckByte"] as? Int) == 32000, "coalesced persist ack includes the final byte")
    let wire: [String: Any] = ["type": "pcm_rejected", "id": "native-session", "capture_id": cap, "reason": "session_ended"]
    let wireText = String(data: try JSONSerialization.data(withJSONObject: wire), encoding: .utf8)!
    uplink.handleAudioText(wireText)
    waitSend()
    check(!uplink.tryEnqueue(Data(repeating: 5, count: 1600)), "terminal socket cannot queue more PCM")
    eq(ingest.ingestLive(data: Data(repeating: 5, count: 1600), captureId: cap, sessionId: "native-session", offset: 32000), "session-ended")
    let listed = ingest.listCaptures()
    check(listed.contains(where: { $0.captureId == cap && $0.bytes >= 32000 }), "rejected cloud session keeps the phone original")
    check(ingest.deleteCapture(cap) == 0, "live unsealed capture is not silently deleted")

    func keepBody(_ sid: String, ok: Bool = true, id: String? = nil) -> Data {
        try! JSONSerialization.data(withJSONObject: ["ok": ok, "id": id ?? sid])
    }
    func bindCapture(_ id: String, session: String) {
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.bind"),
            object: nil,
            userInfo: ["sessionId": session, "captureId": id]
        )
        waitSend()
    }
    func postSave(_ sessionId: String) -> [String: Any] {
        var out: [String: Any] = [:]
        bridge.session(WCSession.default, didReceiveMessage: ["action": "save", "sessionId": sessionId]) { out = $0 }
        waitSend()
        return out
    }

    ingest.reset()
    bindCapture("cap-http-ok", session: "http-ok")
    WatchBridge.testingKeep = { sid in (200, keepBody(sid)) }
    let httpOk = postSave("http-ok")
    eq(httpOk["save"] as? String ?? "", "saved")
    check((httpOk["sessionId"] as? String) == "http-ok", "HTTP 200 ok+id replies History saved for that session")

    bindCapture("cap-http-405", session: "http-405")
    WatchBridge.testingKeep = { _ in (405, nil) }
    eq(postSave("http-405")["save"] as? String ?? "", "failed")

    bindCapture("cap-http-401", session: "http-401")
    WatchBridge.testingKeep = { _ in (401, nil) }
    eq(postSave("http-401")["save"] as? String ?? "", "failed")

    bindCapture("cap-http-badid", session: "http-badid")
    WatchBridge.testingKeep = { sid in (200, keepBody(sid, id: "other")) }
    eq(postSave("http-badid")["save"] as? String ?? "", "failed")

    WatchBridge.testingKeep = nil
    bindCapture("cap-ended", session: "ended-1")
    eq(ingest.ingestLive(data: Data(repeating: 7, count: 1600), captureId: "cap-ended", sessionId: "ended-1", offset: 0), "accept")
    bridge.session(WCSession.default, didReceiveMessage: ["action": "stop"]) { _ in }
    waitSend()
    let afterStop = postSave("ended-1")
    eq(afterStop["save"] as? String ?? "", "local")
    check(ingest.listCaptures().contains(where: { $0.captureId == "cap-ended" && $0.intent == "keep" }), "Save after End/reset still marks keep on the ended capture")

    eq(postSave("ghost-missing")["save"] as? String ?? "", "failed")
    check(!ingest.listCaptures().contains(where: { $0.sessionId == "ghost-missing" && $0.intent == "keep" }), "missing capture does not fake a keep intent")

    WatchBridge.testingKeep = { sid in
        if sid == "sess-a" { return (200, keepBody(sid)) }
        return (401, nil)
    }
    bindCapture("cap-iso-a", session: "sess-a")
    eq(postSave("sess-a")["save"] as? String ?? "", "saved")
    bindCapture("cap-iso-b", session: "sess-b")
    eq(postSave("sess-b")["save"] as? String ?? "", "failed")
    let jobs = bridge.listSaves()
    check(jobs.contains(where: { $0["sessionId"] == "sess-a" && $0["save"] == "saved" }), "session A History success is stored")
    check(jobs.contains(where: { $0["sessionId"] == "sess-b" && $0["save"] == "failed" }), "session B failure is stored separately")
    WatchBridge.testingKeep = { _ in (500, nil) }
    eq(postSave("sess-a")["save"] as? String ?? "", "saved")
    check(bridge.listSaves().contains(where: { $0["sessionId"] == "sess-a" && $0["save"] == "saved" }), "late 500 does not roll back A")
    WatchBridge.testingKeep = nil

    _ = bridge
    print("Watch replay: persist-ack, buffer pause, disconnect pause, leftover files, identity, handshake and Save tests passed")
 }
}

func eq<T: Equatable>(_ got: T, _ want: T, file: String = #file, line: Int = #line) {
    if got != want {
        fputs("FAIL: \(file):\(line) got \(got) want \(want)\n", stderr)
        exit(1)
    }
}
