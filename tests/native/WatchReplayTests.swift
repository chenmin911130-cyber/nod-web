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
    deliver(endWatch, ["save": "local", "sessionId": "live-end"])
    check(!endWatch.pendingSync && !endWatch.offeringSave && endWatch.hint == WatchCopy.ready, "Done ignores a late local")
    deliver(endWatch, ["save": "failed", "sessionId": "live-end"])
    check(!endWatch.saveFailed && !endWatch.offeringSave, "Done ignores a late failed")
    deliver(endWatch, ["save": "saved", "sessionId": "live-end"])
    check(endWatch.savedAck && !endWatch.offeringSave, "matching history_kept is Saved to History")
    deliver(endWatch, ["save": "local", "sessionId": "live-end"])
    check(!endWatch.pendingSync, "late local must not roll back Saved to History")
    deliver(endWatch, ["save": "failed", "sessionId": "live-end"])
    check(endWatch.savedAck, "late failed must not roll back Saved to History")
    endWatch.savedAck = false
    endWatch.hint = WatchCopy.ready
    deliver(endWatch, ["save": "failed", "sessionId": "live-end"])
    check(!endWatch.saveFailed && !endWatch.offeringSave, "Saved stays after the 2s Ready flash")

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

    // #196: the capture must carry the mode it was recorded in, so a phone-held
    // Translate capture can never be listed as a Meeting one.
    ingest.reset()
    func bindModeCapture(_ id: String, session: String, mode: String?) {
        var info: [String: Any] = ["sessionId": session, "captureId": id]
        if let mode { info["mode"] = mode }
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.bind"),
            object: nil,
            userInfo: info
        )
        waitSend()
    }
    bindModeCapture("cap-tr", session: "tr-session", mode: "translate")
    check(
        ingest.listCaptures().first { $0.captureId == "cap-tr" }?.mode == "translate",
        "a Translate capture records its mode"
    )
    bindModeCapture("cap-tr", session: "tr-session", mode: nil)
    check(
        ingest.listCaptures().first { $0.captureId == "cap-tr" }?.mode == "translate",
        "a later bind without a mode must not wipe the recorded one"
    )
    bindModeCapture("cap-m", session: "m-session", mode: "meeting")
    check(
        ingest.listCaptures().first { $0.captureId == "cap-m" }?.mode == "meeting",
        "a Meeting capture records meeting"
    )
    bindModeCapture("cap-legacy", session: "legacy-session", mode: nil)
    check(
        ingest.listCaptures().first { $0.captureId == "cap-legacy" }?.mode == "",
        "a capture bound without a mode stays unknown, never meeting"
    )
    func postSave(_ sessionId: String, captureId: String = "") -> [String: Any] {
        var out: [String: Any] = [:]
        var msg: [String: Any] = ["action": "save", "sessionId": sessionId]
        if !captureId.isEmpty { msg["captureId"] = captureId }
        bridge.session(WCSession.default, didReceiveMessage: msg) { out = $0 }
        waitSend()
        return out
    }

    ingest.reset()
    bindCapture("cap-http-ok", session: "http-ok")
    WatchBridge.testingKeep = { sid in (200, keepBody(sid)) }
    let httpOk = postSave("http-ok")
    eq(httpOk["save"] as? String ?? "", "saved")
    check((httpOk["sessionId"] as? String) == "http-ok", "HTTP 200 ok+id replies History saved for that session")

    bindCapture("cap-http-noid", session: "http-noid")
    WatchBridge.testingKeep = { _ in (200, try! JSONSerialization.data(withJSONObject: ["ok": true])) }
    eq(postSave("http-noid")["save"] as? String ?? "", "failed")

    bindCapture("cap-http-emptyid", session: "http-emptyid")
    WatchBridge.testingKeep = { sid in (200, keepBody(sid, id: "")) }
    eq(postSave("http-emptyid")["save"] as? String ?? "", "failed")

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

    ingest.reset()
    bridge.testingResetJobs()
    bindCapture("cap-delay-a", session: "sess-delay-a")
    eq(ingest.ingestLive(data: Data(repeating: 1, count: 1600), captureId: "cap-delay-a", sessionId: "sess-delay-a", offset: 0), "accept")
    bindCapture("cap-delay-b", session: "sess-delay-b")
    eq(ingest.ingestLive(data: Data(repeating: 2, count: 1600), captureId: "cap-delay-b", sessionId: "sess-delay-b", offset: 0), "accept")
    WatchBridge.testingKeep = { sid in (200, keepBody(sid)) }
    eq(postSave("sess-delay-a")["save"] as? String ?? "", "saved")
    check(ingest.listCaptures().contains(where: { $0.captureId == "cap-delay-a" && $0.intent == "keep" }), "delayed Save of A marks A after B started")
    check(!ingest.listCaptures().contains(where: { $0.captureId == "cap-delay-b" && $0.intent == "keep" }), "delayed Save of A must not mark live B keep")

    ingest.reset()
    bridge.testingResetJobs()
    bindCapture("cap-mis-a", session: "sess-mis-a")
    bindCapture("cap-mis-b", session: "sess-mis-b")
    eq(postSave("sess-mis-a", captureId: "cap-mis-b")["save"] as? String ?? "", "failed")
    check(!ingest.listCaptures().contains(where: { $0.captureId == "cap-mis-b" && $0.intent == "keep" }), "session A + capture B is a failed pair")

    let missingIdBody = try JSONSerialization.data(withJSONObject: ["ok": true])
    check(WatchBridge.keepHttpFace(code: 200, body: missingIdBody, sessionId: "x").save == "failed", "native keepHttpFace rejects missing id")
    check(WatchBridge.keepShouldRetry(save: "saved", error: "", attempts: 0, now: 10, nextAttemptAt: 0) == false, "saved is not retried")
    check(WatchBridge.keepShouldRetry(save: "failed", error: "auth", attempts: 1, now: 10, nextAttemptAt: 0) == false, "401 is not retried")
    check(WatchBridge.keepShouldRetry(save: "local", error: "retryable", attempts: 1, now: 10, nextAttemptAt: 5) == true, "retryable keep retries after backoff")
    check(WatchBridge.keepShouldRetry(save: "local", error: "retryable", attempts: 1, now: 3, nextAttemptAt: 5) == false, "retryable keep waits for nextAttemptAt")

    ingest.reset()
    bridge.testingResetJobs()
    WatchBridge.testingKeep = nil
    var holdCalls = 0
    var held: ((Int, Data?) -> Void)?
    WatchBridge.testingKeepAsync = { sid, done in
      if sid == "sess-hold" {
        holdCalls += 1
        held = done
        return
      }
      done(401, nil)
    }
    bindCapture("cap-hold", session: "sess-hold")
    eq(postSave("sess-hold")["save"] as? String ?? "", "local")
    eq(holdCalls, 1)
    bridge.resumeKeeps()
    eq(holdCalls, 1)
    held?(200, keepBody("sess-hold"))
    waitSend()
    check(bridge.listSaves().contains(where: { $0["sessionId"] == "sess-hold" && $0["save"] == "saved" }), "in-flight keep completes once")
    WatchBridge.testingKeepAsync = nil

    ingest.reset()
    bridge.testingResetJobs()
    bindCapture("cap-restart", session: "sess-restart")
    var posted: [String] = []
    WatchBridge.testingKeep = { sid in
      posted.append(sid)
      if sid == "sess-restart" { return (200, keepBody(sid)) }
      return (401, nil)
    }
    eq(postSave("sess-restart")["save"] as? String ?? "", "saved")
    posted.removeAll()
    bridge.testingUnloadJobs()
    check(bridge.listSaves().contains(where: { $0["sessionId"] == "sess-restart" && $0["save"] == "saved" }), "restart reloads saved keep jobs")
    bridge.resumeKeeps()
    check(!posted.contains("sess-restart"), "restart does not POST a saved keep again")
    WatchBridge.testingKeep = nil

    ingest.reset()
    bridge.testingResetJobs()
    bindCapture("cap-500", session: "sess-500")
    var n500 = 0
    WatchBridge.testingKeep = { sid in
      if sid == "sess-500" {
        n500 += 1
        return (500, nil)
      }
      return (401, nil)
    }
    eq(postSave("sess-500")["save"] as? String ?? "", "local")
    eq(n500, 1)
    bridge.resumeKeeps()
    eq(n500, 1)
    WatchBridge.testingNow = { Date().timeIntervalSince1970 + 120 }
    bridge.resumeKeeps()
    eq(n500, 2)
    WatchBridge.testingNow = nil
    WatchBridge.testingKeep = nil

    let savedUi = WatchPhoneSession.WatchSaveUi(terminal: "saved", dismissed: false, pendingSync: false, offeringSave: false, saveFailed: false, savedAck: false, saving: false, hint: WatchCopy.ready)
    check(WatchPhoneSession.reduceSaveStatus(savedUi, save: "local").pendingSync == false, "reduce: saved ignores late local")
    check(WatchPhoneSession.reduceSaveStatus(savedUi, save: "failed").saveFailed == false, "reduce: saved ignores late failed")
    let doneUi = WatchPhoneSession.WatchSaveUi(terminal: "local", dismissed: true, pendingSync: false, offeringSave: false, saveFailed: false, savedAck: false, saving: false, hint: WatchCopy.ready)
    check(WatchPhoneSession.reduceSaveStatus(doneUi, save: "local").pendingSync == false, "reduce: Done ignores late local")
    check(WatchPhoneSession.reduceSaveStatus(doneUi, save: "failed").saveFailed == false, "reduce: Done ignores late failed")

    // #219: the live copy is paged end to end — the bridge fans the pages out
    // (application context + transferUserInfo) and the Watch joins them, so a long
    // original/translation is fully readable instead of clipped.
    let longPage = String(repeating: "甲", count: 12000)
    let tailPage = "收尾一句。"
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening",
        hint: "",
        original: "Original page 0",
        translation: longPage,
        copyId: "page-1",
        originalSegments: ["Original page 0", "Original page 1"],
        translationSegments: [longPage, tailPage]
    )
    eq(WCSession.default.receivedApplicationContext["copySegIndex"] as? Int ?? -1, 0)
    eq(WCSession.default.receivedApplicationContext["copySegTotal"] as? Int ?? -1, 2)
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", longPage)
    let fanned = WCSession.default.messages.filter { ($0["copySegIndex"] as? Int) == 1 }
    check(!fanned.isEmpty, "page 1 must be queued (transferUserInfo) so the context can hold page 0")
    eq(fanned.last?["translation"] as? String ?? "", tailPage)
    eq(fanned.last?["original"] as? String ?? "", "Original page 1")
    check(fanned.last?["history"] == nil, "queued pages leave the history preview to page 0")
    check(!WCSession.default.messages.isEmpty, "page 0 is also sent live when the Watch is reachable")

    // A status push that only changes save/hint carries the same copy: the tail
    // pages are not re-queued (the userInfo queue would grow without bound). A
    // changed page is, and the Watch-ready re-push always re-queues.
    func queuedPages() -> Int {
        WCSession.default.messages.filter { ($0["copySegIndex"] as? Int) == 1 }.count
    }
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "save state", original: "Original page 0", translation: longPage,
        copyId: "page-1", originalSegments: ["Original page 0", "Original page 1"],
        translationSegments: [longPage, tailPage]
    )
    check(queuedPages() == 0, "an unchanged copy must not re-queue its pages")
    bridge.pushStatus(
        capture: "listening", hint: "save state again", original: "Original page 0", translation: longPage,
        copyId: "page-1", originalSegments: ["Original page 0", "Original page 1"],
        translationSegments: [longPage, "收尾一句，更长。"]
    )
    check(queuedPages() == 1, "a changed page is queued")
    bridge.pushStatus(
        capture: "listening", hint: "save state again", original: "Original page 0", translation: longPage,
        copyId: "page-1", originalSegments: ["Original page 0", "Original page 1"],
        translationSegments: [longPage, "收尾一句，更长。"]
    )
    check(queuedPages() == 1, "the same page set is not queued twice")
    bridge.markJsReady()
    check(queuedPages() == 2, "the Watch-ready re-push re-queues every page")

    // #219 P1: a queued tail page carries ONLY the copy. A queued transfer can be
    // delivered long after it was created, so replaying sessionId/save/pcm/hint
    // from that moment would rebind the current recording to an old session.
    let tailKeys: Set<String> = ["copyId", "copySegIndex", "copySegTotal", "copyVersion", "copySeq", "original", "translation"]
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "hint-old", original: "Lead", translation: longPage,
        previous: "prev-old", copyId: "keys-1",
        history: [["id": "h", "title": "t", "text": "x"]],
        mode: "translate", langPair: "en→zh", save: "local", sessionId: "sess-old",
        originalSegments: ["Lead", "Lead tail"], translationSegments: [longPage, tailPage]
    )
    let tailRows = WCSession.default.messages.filter { ($0["copySegIndex"] as? Int) == 1 }
    check(!tailRows.isEmpty, "the tail page is queued")
    for row in tailRows {
        check(Set(row.keys) == tailKeys, "a queued tail page carries only the copy, got \(Set(row.keys).sorted())")
        check(row["sessionId"] == nil && row["save"] == nil && row["hint"] == nil && row["history"] == nil,
              "a queued tail page must not carry status/save/pcm fields")
    }
    // The server copy version rides the context and every queued page, so the
    // Watch can order two different copies (the per-run counter cannot).
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Lead", translation: longPage,
        copyId: "seq-1", originalSegments: ["Lead", "Lead tail"], translationSegments: [longPage, tailPage],
        copySeq: 4242
    )
    eq(WCSession.default.receivedApplicationContext["copySeq"] as? Int ?? -1, 4242)
    let seqTails = WCSession.default.messages.filter { ($0["copySegIndex"] as? Int) == 1 }
    check(!seqTails.isEmpty, "the tail page is queued")
    check(seqTails.allSatisfy { ($0["copySeq"] as? Int) == 4242 }, "every queued page carries the server copy version")

    // The application context (page 0) still carries the live status.
    eq(WCSession.default.receivedApplicationContext["sessionId"] as? String ?? "", "sess-old")
    eq(WCSession.default.receivedApplicationContext["save"] as? String ?? "", "local")
    check(WCSession.default.receivedApplicationContext["history"] != nil, "page 0 keeps the history preview")

    // #219 P2: the page set carries a content version. An unchanged set keeps the
    // same version and is not re-queued; a changed page bumps it and is re-queued
    // alone; a Watch-ready re-push re-queues everything at the same version.
    func queuedSegIndexes() -> [Int] {
        // The live sendMessage carries page 0 too; only pages after it are queued.
        WCSession.default.messages.compactMap { $0["copySegIndex"] as? Int }.filter { $0 > 0 }
    }
    func queuedVersions() -> [Int] {
        WCSession.default.messages.compactMap { row -> Int? in
            guard let index = row["copySegIndex"] as? Int, index > 0 else { return nil }
            return row["copyVersion"] as? Int
        }
    }
    func contextVersion() -> Int {
        WCSession.default.receivedApplicationContext["copyVersion"] as? Int ?? -1
    }
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "v0", translation: "V0",
        copyId: "ver-1", originalSegments: ["v0", "v1"], translationSegments: ["V0", "V1"]
    )
    let firstVersion = contextVersion()
    check(firstVersion > 0, "the first paged push carries a content version")
    eq(queuedSegIndexes(), [1])
    eq(queuedVersions(), [firstVersion])

    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "save state", original: "v0", translation: "V0",
        copyId: "ver-1", originalSegments: ["v0", "v1"], translationSegments: ["V0", "V1"]
    )
    eq(contextVersion(), firstVersion)
    check(queuedSegIndexes().isEmpty, "an unchanged page set is not re-queued")

    // Three pages, only the last changes: one version bump, one queued page.
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "w0", translation: "W0",
        copyId: "ver-2", originalSegments: ["w0", "w1", "w2"], translationSegments: ["W0", "W1", "W2"]
    )
    let threePageVersion = contextVersion()
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "", original: "w0", translation: "W0",
        copyId: "ver-2", originalSegments: ["w0", "w1", "w2"], translationSegments: ["W0", "W1", "W2 changed"]
    )
    let changedVersion = contextVersion()
    eq(changedVersion, threePageVersion + 1)
    eq(queuedSegIndexes(), [2])
    eq(WCSession.default.messages.last?["copyVersion"] as? Int ?? -1, changedVersion)
    eq(WCSession.default.messages.last?["copySegTotal"] as? Int ?? -1, 3)

    // A changed head starts a new generation on the Watch, which resets every
    // slot: all pages are re-queued for it even when a tail text is unchanged.
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "", original: "w0 new", translation: "W0 new",
        copyId: "ver-2", originalSegments: ["w0 new", "w1", "w2"], translationSegments: ["W0 new", "W1", "W2 changed"]
    )
    eq(contextVersion(), changedVersion + 1)
    eq(queuedSegIndexes(), [1, 2])

    WCSession.default.messages.removeAll()
    bridge.markJsReady()
    eq(contextVersion(), changedVersion + 1)
    eq(queuedSegIndexes(), [1, 2])

    // One page behaves exactly as before: no page fields at all.
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Solo", translation: "独段", copyId: "solo",
        originalSegments: ["Solo"], translationSegments: ["独段"]
    )
    check(WCSession.default.receivedApplicationContext["copySegIndex"] == nil, "single page keeps the unpaged payload")
    check(WCSession.default.receivedApplicationContext["copySegTotal"] == nil, "single page has no page total")
    check(WCSession.default.messages.allSatisfy { $0["copySegIndex"] == nil }, "single page fans out no queued page")

    let watch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("paged")),
        connect: false
    )
    // A copy starts at page 0: a page of an unknown copy is dropped, so a late page
    // of a superseded copy can never put the old translation back.
    deliver(watch, ["copyId": "c1", "copySegIndex": 1, "copySegTotal": 2, "original": "org-1", "translation": "page-1"])
    eq(watch.translation, "")
    eq(watch.original, "")
    eq(watch.copyId, "")
    deliver(watch, ["copyId": "c1", "copySegIndex": 0, "copySegTotal": 2, "original": "org-0", "translation": "page-0"])
    eq(watch.translation, "page-0")
    eq(watch.copyId, "c1")
    // The phone re-pushes every page; page 1 then fills the rest.
    deliver(watch, ["copyId": "c1", "copySegIndex": 1, "copySegTotal": 2, "original": "org-1", "translation": "page-1"])
    eq(watch.translation, "page-0page-1")
    eq(watch.original, "org-0org-1")
    // A re-sent page is idempotent.
    deliver(watch, ["copyId": "c1", "copySegIndex": 0, "copySegTotal": 2, "original": "org-0", "translation": "page-0"])
    eq(watch.translation, "page-0page-1")
    // A missing middle page keeps the prefix (no gap gluing).
    deliver(watch, ["copyId": "c4", "copySegIndex": 0, "copySegTotal": 3, "original": "g-0", "translation": "g-0"])
    eq(watch.translation, "g-0")
    deliver(watch, ["copyId": "c4", "copySegIndex": 2, "copySegTotal": 3, "original": "g-2", "translation": "g-2"])
    eq(watch.translation, "g-0")
    deliver(watch, ["copyId": "c4", "copySegIndex": 1, "copySegTotal": 3, "original": "g-1", "translation": "g-1"])
    eq(watch.translation, "g-0g-1g-2")
    // A new copy id starts a new copy on its page 0.
    deliver(watch, ["copyId": "c5", "copySegIndex": 1, "copySegTotal": 2, "original": "n-1", "translation": "n-1"])
    eq(watch.translation, "g-0g-1g-2")
    deliver(watch, ["copyId": "c5", "copySegIndex": 0, "copySegTotal": 2, "original": "n-0", "translation": "n-0"])
    eq(watch.translation, "n-0")
    eq(watch.original, "n-0")
    deliver(watch, ["copyId": "c5", "copySegIndex": 1, "copySegTotal": 2, "original": "n-1", "translation": "n-1"])
    eq(watch.translation, "n-0n-1")
    // Page 0 re-delivered for the same copy (Watch relaunch) must NOT drop pages 1..n.
    deliver(watch, ["copyId": "c5", "copySegIndex": 0, "copySegTotal": 2, "original": "n-0", "translation": "n-0"])
    eq(watch.translation, "n-0n-1")
    // Clearing the published copy id (New / Stop, which also blanks original and
    // translation) drops the pages too, and a queued page of the superseded copy
    // cannot put the old translation back.
    watch.copyId = ""
    watch.original = ""
    watch.translation = ""
    deliver(watch, ["copyId": "c5", "copySegIndex": 1, "copySegTotal": 2, "original": "n-1", "translation": "n-1"])
    eq(watch.translation, "")
    eq(watch.original, "")
    eq(watch.copyId, "")
    deliver(watch, ["copyId": "c6", "copySegIndex": 0, "copySegTotal": 2, "original": "z-0", "translation": "z-0"])
    eq(watch.translation, "z-0")
    // An old phone build sends the whole copy in one payload: whole-string replace.
    deliver(watch, ["copyId": "c7", "original": "one shot", "translation": "整段替换"])
    eq(watch.translation, "整段替换")
    eq(watch.original, "one shot")
    eq(watch.copyId, "c7")

    // #219 P2: pages carry a content version, so a straggler from an older stream
    // edit / Retry cannot overwrite a newer slot or glue mixed text onto a new head.
    let versioned = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("versioned")),
        connect: false
    )
    deliver(versioned, ["copyId": "v1", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "o0", "translation": "t0"])
    deliver(versioned, ["copyId": "v1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 1, "original": "o1", "translation": "t1"])
    eq(versioned.translation, "t0t1")
    // A later version of the same copy updates the tail.
    deliver(versioned, ["copyId": "v1", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 2, "original": "o0", "translation": "t0"])
    deliver(versioned, ["copyId": "v1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 2, "original": "o1", "translation": "t1-new"])
    eq(versioned.translation, "t0t1-new")
    // A late page of the OLDER version must not overwrite the newer slot.
    deliver(versioned, ["copyId": "v1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 1, "original": "o1", "translation": "t1-stale"])
    eq(versioned.translation, "t0t1-new")
    // Same version re-delivered is idempotent.
    deliver(versioned, ["copyId": "v1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 2, "original": "o1", "translation": "t1-new"])
    eq(versioned.translation, "t0t1-new")
    // A late OLDER page 0 must not become the current content again.
    deliver(versioned, ["copyId": "v1", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "o0-stale", "translation": "t0-stale"])
    eq(versioned.translation, "t0t1-new")
    eq(versioned.original, "o0o1")
    // Retry / stream edit: the head text changes at a newer version. The slots
    // reset, so a straggler of the previous generation is dropped instead of being
    // glued onto the new head; the re-queued page of this generation then applies.
    deliver(versioned, ["copyId": "v1", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 5, "original": "r0", "translation": "r0"])
    eq(versioned.translation, "r0")
    deliver(versioned, ["copyId": "v1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 2, "original": "o1", "translation": "t1-stale"])
    eq(versioned.translation, "r0")
    deliver(versioned, ["copyId": "v1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 5, "original": "r1", "translation": "r1"])
    eq(versioned.translation, "r0r1")
    // A new copy id starts its own version stream (the phone's counter is per run).
    deliver(versioned, ["copyId": "v2", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "n0", "translation": "n0"])
    eq(versioned.translation, "n0")
    deliver(versioned, ["copyId": "v2", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 1, "original": "n1", "translation": "n1"])
    eq(versioned.translation, "n0n1")
    // A payload with no version (an older phone) keeps the previous behaviour.
    deliver(versioned, ["copyId": "v3", "copySegIndex": 0, "copySegTotal": 2, "original": "L0", "translation": "L0"])
    deliver(versioned, ["copyId": "v3", "copySegIndex": 1, "copySegTotal": 2, "original": "L1", "translation": "L1"])
    eq(versioned.translation, "L0L1")
    deliver(versioned, ["copyId": "v3", "copySegIndex": 1, "copySegTotal": 2, "original": "L1", "translation": "L1-b"])
    eq(versioned.translation, "L0L1-b")

    // #219 review: the paging version guard had two holes. (a) multi -> single:
    // the unpaged payload replaced the paged copy and cleared every version, so a
    // late tail of the old multi-page copy was accepted and wiped the text.
    let holes = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("holes")),
        connect: false
    )
    deliver(holes, ["copyId": "h1", "copySeq": 10, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 3, "original": "h0", "translation": "H0"])
    deliver(holes, ["copyId": "h1", "copySeq": 10, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 3, "original": "h1", "translation": "H1"])
    eq(holes.translation, "H0H1")
    // The copy shrinks to a single page: an unpaged payload at a newer version.
    deliver(holes, ["copyId": "h1", "copySeq": 11, "copyVersion": 4, "original": "whole", "translation": "整段"])
    eq(holes.translation, "整段")
    // A late tail of the old generation must not clear or overwrite the text.
    deliver(holes, ["copyId": "h1", "copySeq": 11, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 3, "original": "h1", "translation": "H1-old"])
    eq(holes.translation, "整段")
    eq(holes.original, "whole")
    // Even a tail claiming the floor version may not switch the copy back to paged
    // on its own: only page 0 leaves the unpaged representation.
    deliver(holes, ["copyId": "h1", "copySeq": 11, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 4, "original": "h2", "translation": "H2-floor"])
    eq(holes.translation, "整段")
    eq(holes.original, "whole")
    // A legitimate page 0 of a newer version leaves the unpaged copy normally.
    deliver(holes, ["copyId": "h1", "copySeq": 12, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 5, "original": "n0", "translation": "N0"])
    eq(holes.translation, "N0")
    deliver(holes, ["copyId": "h1", "copySeq": 12, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 5, "original": "n1", "translation": "N1"])
    eq(holes.translation, "N0N1")
    // A tail that arrives BEFORE its page 0 is buffered and then joins it.
    deliver(holes, ["copyId": "h2", "copySeq": 20, "copyVersion": 1, "original": "single", "translation": "单段"])
    eq(holes.translation, "单段")
    deliver(holes, ["copyId": "h2", "copySeq": 21, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 2, "original": "tail", "translation": "尾页"])
    eq(holes.translation, "单段")
    deliver(holes, ["copyId": "h2", "copySeq": 21, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 2, "original": "head", "translation": "头页"])
    eq(holes.translation, "头页尾页")
    eq(holes.original, "headtail")

    // (b) an older copy's page 0 must not become current again. The per-run
    // `copyVersion` cannot see this; the server copy version can.
    deliver(holes, ["copyId": "h3", "copySeq": 40, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "new0", "translation": "新0"])
    eq(holes.translation, "新0")
    deliver(holes, ["copyId": "h9-old", "copySeq": 39, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 9, "original": "old0", "translation": "旧0"])
    eq(holes.translation, "新0")
    eq(holes.copyId, "h3")
    // ... including an older UNPAGED frame.
    deliver(holes, ["copyId": "h9-old", "copySeq": 39, "copyVersion": 9, "original": "old-whole", "translation": "旧整段"])
    eq(holes.translation, "新0")
    eq(holes.copyId, "h3")
    // The same server version is idempotent, and a newer one applies.
    deliver(holes, ["copyId": "h3", "copySeq": 40, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "new0", "translation": "新0"])
    eq(holes.translation, "新0")
    deliver(holes, ["copyId": "h4", "copySeq": 41, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "z0", "translation": "零1"])
    eq(holes.translation, "零1")
    // A missing / zero server version carries no ordering information (an older
    // phone, or the server has not stamped one yet): still accepted.
    deliver(holes, ["copyId": "z1", "copySeq": 0, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "a0", "translation": "零版本"])
    eq(holes.translation, "零版本")
    deliver(holes, ["copyId": "z2", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "a1", "translation": "无序号"])
    eq(holes.translation, "无序号")

    check(WatchPhoneSession.copySeqApplies(incoming: 5, high: 4), "a newer server copy version applies")
    check(WatchPhoneSession.copySeqApplies(incoming: 4, high: 4), "the same server copy version is idempotent")
    check(!WatchPhoneSession.copySeqApplies(incoming: 3, high: 4), "an older server copy version is dropped")
    check(WatchPhoneSession.copySeqApplies(incoming: 0, high: 4), "a zero server version carries no ordering")
    check(WatchPhoneSession.copySeqApplies(incoming: nil, high: 4), "an absent server version carries no ordering")
    check(WatchPhoneSession.copySeqApplies(incoming: 3, high: 0), "the first server version is accepted")

    // A queued tail page carries no session/capture/save fields, so receiving one
    // cannot rebind the recording to the session it was created in.
    let boundBuffer = WatchSendBuffer()
    boundBuffer.bindSession("sess-live")
    let boundWatch = WatchPhoneSession(
        sendBuffer: boundBuffer,
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("bound")),
        connect: false
    )
    deliver(boundWatch, ["copyId": "b1", "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "B0", "translation": "B0"])
    deliver(boundWatch, ["copyId": "b1", "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 1, "original": "B1", "translation": "B1"])
    eq(boundWatch.translation, "B0B1")
    eq(boundBuffer.sessionId, "sess-live")

    func versionApplies(
        incoming: Int?,
        pageIndex: Int,
        sameCopyId: Bool = true,
        slotVersion: Int? = nil,
        page0Version: Int = 0,
        generationVersion: Int = 0
    ) -> Bool {
        WatchPhoneSession.copyPageVersionApplies(
            incoming: incoming,
            pageIndex: pageIndex,
            sameCopyId: sameCopyId,
            slotVersion: slotVersion,
            page0Version: page0Version,
            generationVersion: generationVersion
        )
    }
    check(versionApplies(incoming: nil, pageIndex: 1, slotVersion: 9, page0Version: 9, generationVersion: 9),
          "no version keeps the legacy apply")
    check(!versionApplies(incoming: 3, pageIndex: 1, slotVersion: 4, generationVersion: 2),
          "an older tail loses to its slot")
    check(versionApplies(incoming: 4, pageIndex: 1, slotVersion: 4, generationVersion: 2),
          "the same tail version is idempotent")
    check(!versionApplies(incoming: 1, pageIndex: 1, generationVersion: 5),
          "a tail older than the copy generation is dropped")
    check(versionApplies(incoming: 5, pageIndex: 1, generationVersion: 5),
          "a tail of the current generation applies")
    check(!versionApplies(incoming: 4, pageIndex: 0, page0Version: 5),
          "an older page 0 never becomes current")
    check(versionApplies(incoming: 5, pageIndex: 0, page0Version: 5),
          "the same page 0 version is idempotent")
    check(versionApplies(incoming: 9, pageIndex: 0, page0Version: 5),
          "a newer page 0 applies")
    check(versionApplies(incoming: 1, pageIndex: 0, sameCopyId: false, page0Version: 9),
          "a new copy id starts its own version stream")
    check(versionApplies(incoming: 1, pageIndex: 1, sameCopyId: false, slotVersion: 9, generationVersion: 9),
          "a new copy's tail is not compared across copies")

    func restart(id: String, index: Int, text: String, stored: String?) -> Bool {
        WatchPhoneSession.copyPageStartsNewCopy(
            incomingId: id,
            currentId: "c",
            pageIndex: index,
            incomingOriginal: text,
            incomingTranslation: text,
            storedOriginal: stored,
            storedTranslation: stored
        )
    }
    check(restart(id: "other", index: 1, text: "x", stored: "x"), "a new copy id restarts")
    check(!restart(id: "c", index: 1, text: "later", stored: "first"), "a later page never restarts the copy")
    check(!restart(id: "c", index: 0, text: "same", stored: "same"), "a re-delivered page 0 keeps the pages")
    check(!restart(id: "c", index: 0, text: "first", stored: nil), "page 0 before its pages is still the same copy")
    check(restart(id: "c", index: 0, text: "grown", stored: "old"), "a page 0 with new text starts over")
    check(WatchPhoneSession.copyPageApplies(incomingId: "c", currentId: "c", pageIndex: 5), "pages of the current copy apply")
    check(WatchPhoneSession.copyPageApplies(incomingId: "new", currentId: "c", pageIndex: 0), "page 0 starts another copy")
    check(!WatchPhoneSession.copyPageApplies(incomingId: "new", currentId: "c", pageIndex: 1), "a later page of another copy is dropped")

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
