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
    func aod(
        draining: Bool = false, drainFailed: Bool = false,
        offeringSave: Bool = false, pendingSync: Bool = false, savedAck: Bool = false,
        listening: Bool = false, paused: Bool = false,
        hasContent: Bool = false, copyFailed: Bool = false
    ) -> WatchAodDisplay {
        WatchAod.display(
            draining: draining, drainFailed: drainFailed,
            offeringSave: offeringSave, pendingSync: pendingSync, savedAck: savedAck,
            listening: listening, paused: paused,
            hasContent: hasContent, copyFailed: copyFailed
        )
    }

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
    deliver(session, ["sessionId": "live", "pcmReady": "true", "pcmAckCaptureId": buf.captureId, "captureId": buf.captureId])
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
    deliver(endWatch, ["sessionId": "live-end", "pcmAckCaptureId": endBuf.captureId, "captureId": endBuf.captureId])
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

    check(
        WatchPhoneSession.endShouldOfferSave(mode: "meeting", watchLastByte: 0, persistAckByte: 0) == false,
        "a true empty Meeting End does not offer Save"
    )
    check(
        WatchPhoneSession.endShouldOfferSave(mode: "meeting", watchLastByte: 0, persistAckByte: 575762),
        "phone persist for this capture is enough to offer Save when Watch lastByte is 0"
    )
    check(
        WatchPhoneSession.endShouldOfferSave(mode: "translate", watchLastByte: 640, persistAckByte: 640) == false,
        "Translate End still has no Save"
    )

    // #232: first End skipped Save/No Save when Watch freeze saw lastByte=0
    // while the phone already held this capture. Late persist ack must offer,
    // not leave Ready; No Save stays dismissed; a new capture ignores the old ack.
    let phoneHeldBuf = WatchSendBuffer()
    phoneHeldBuf.beginCapture()
    let phoneHeld = WatchPhoneSession(sendBuffer: phoneHeldBuf, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("end-phone-held")), connect: false)
    phoneHeld.listening = true
    phoneHeld.finish()
    waitSend()
    check(!phoneHeld.draining && !phoneHeld.offeringSave && phoneHeld.hint == WatchCopy.ready, "Watch-local zero bytes complete End without guessing Save")
    deliver(phoneHeld, [
        "pcmAckByte": "575762",
        "pcmAckCaptureId": phoneHeldBuf.captureId,
        "pcmSealed": "true",
        "pcmReady": "true",
    ])
    check(phoneHeld.offeringSave, "late phone persist for this capture offers Save / No Save")
    check(phoneHeld.hint == WatchCopy.savedLocal, "late persist shows the local save choice, not Ready")
    deliver(phoneHeld, ["capture": "off"])
    check(phoneHeld.offeringSave, "late capture:off must not dismiss an offered Save")

    phoneHeld.declineSave()
    waitSend()
    deliver(phoneHeld, [
        "pcmAckByte": "678074",
        "pcmAckCaptureId": phoneHeldBuf.captureId,
        "pcmSealed": "true",
    ])
    check(!phoneHeld.offeringSave, "No Save stays dismissed when a later persist ack arrives")

    let persistDuringBuf = WatchSendBuffer()
    persistDuringBuf.beginCapture()
    let persistDuring = WatchPhoneSession(sendBuffer: persistDuringBuf, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("end-persist-during")), connect: false)
    persistDuring.listening = true
    deliver(persistDuring, [
        "pcmAckByte": "882698",
        "pcmAckCaptureId": persistDuringBuf.captureId,
        "pcmReady": "true",
    ])
    persistDuring.finish()
    waitSend()
    check(persistDuring.offeringSave, "End offers Save when phone persist for this capture arrived before freeze")

    let staleAckBuf = WatchSendBuffer()
    staleAckBuf.beginCapture()
    let staleAck = WatchPhoneSession(sendBuffer: staleAckBuf, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("end-stale-ack")), connect: false)
    staleAck.listening = true
    staleAck.finish()
    waitSend()
    let oldCap = staleAckBuf.captureId
    staleAck.startSession()
    waitSend()
    deliver(staleAck, [
        "pcmAckByte": "575762",
        "pcmAckCaptureId": oldCap,
        "pcmSealed": "true",
    ])
    check(!staleAck.offeringSave, "persist ack for a previous capture must not offer Save on the new one")

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
    eq(ingest.ingestLive(data: Data(repeating: 3, count: 1600), captureId: "cap-mis-a", sessionId: "sess-mis-a", offset: 0), "accept")
    bindCapture("cap-mis-b", session: "sess-mis-b")
    eq(ingest.ingestLive(data: Data(repeating: 4, count: 1600), captureId: "cap-mis-b", sessionId: "sess-mis-b", offset: 0), "accept")
    var mixedPosted: [String] = []
    WatchBridge.testingKeep = { sid in
        mixedPosted.append(sid)
        if sid == "sess-mis-b" { return (200, keepBody(sid)) }
        return (404, nil)
    }
    let mixed = postSave("sess-mis-a", captureId: "cap-mis-b")
    eq(mixed["save"] as? String ?? "", "saved")
    check((mixed["sessionId"] as? String) == "sess-mis-b", "leftover session A + capture B keeps B's confirmed session")
    check(mixedPosted == ["sess-mis-b"], "mixed pair must POST B, not A, and must not no-op")
    check(ingest.listCaptures().contains(where: { $0.captureId == "cap-mis-b" && $0.intent == "keep" }), "mixed Save marks keep on B")
    check(!ingest.listCaptures().contains(where: { $0.captureId == "cap-mis-a" && $0.intent == "keep" }), "mixed Save must not mark keep on A")
    WatchBridge.testingKeep = nil

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

    check(
        WatchPhoneSession.sessionBindApplies(
            liveCaptureId: "cap-b", liveSessionId: "",
            incomingSessionId: "sess-a", incomingCaptureId: ""
        ) == false,
        "a leftover sessionId cannot self-authenticate onto a new capture"
    )
    check(
        WatchPhoneSession.sessionBindApplies(
            liveCaptureId: "cap-b", liveSessionId: "",
            incomingSessionId: "sess-a", incomingCaptureId: "cap-a"
        ) == false,
        "session A naming capture A must not bind live capture B"
    )
    check(
        WatchPhoneSession.sessionBindApplies(
            liveCaptureId: "cap-b", liveSessionId: "",
            incomingSessionId: "sess-b", incomingCaptureId: "cap-b"
        ) == true,
        "first bind of B requires this capture plus B's session"
    )
    check(
        WatchPhoneSession.sessionBindApplies(
            liveCaptureId: "cap-b", liveSessionId: "sess-b",
            incomingSessionId: "sess-a", incomingCaptureId: "cap-b"
        ) == false,
        "once B is bound, A cannot replace it even if the capture field matches"
    )
    check(WatchPhoneSession.saveShouldSend("") == false, "Save with no confirmed session must not guess an id")
    check(WatchPhoneSession.saveShouldSend("", captureId: "cap-x") == true, "Save still sends when only this capture is known")
    check(WatchPhoneSession.saveWireMessage(sessionId: "", captureId: "") == nil, "empty Save with no capture and no session still fails")
    check(WatchPhoneSession.saveWireMessage(sessionId: "", captureId: "cap-x")?.captureId == "cap-x", "named capture is enough to put Save on the wire")
    check(
        WatchBridge.keepShouldRetry(save: "failed", error: "gone", attempts: 1, now: 10, nextAttemptAt: 0) == false,
        "HTTP 404 gone is not retried"
    )

    // #232: A End+discard, B Start→End→Save. The Start reply / bind of B must not
    // carry A's cached session; keep HTTP must name B; A's late saved cannot ack B.
    ingest.reset()
    bridge.testingResetJobs()
    bindCapture("cap-232-a", session: "sess-232-a")
    eq(ingest.ingestLive(data: Data(repeating: 8, count: 1600), captureId: "cap-232-a", sessionId: "sess-232-a", offset: 0), "accept")
    WatchBridge.testingKeep = { sid in (404, nil) }
    eq(postSave("sess-232-a", captureId: "cap-232-a")["save"] as? String ?? "", "failed")
    var startB: [String: Any] = [:]
    bridge.session(WCSession.default, didReceiveMessage: ["action": "start", "captureId": "cap-232-b"]) { startB = $0 }
    waitSend()
    let startBSession = startB["sessionId"] as? String ?? ""
    let startBAckSession = startB["pcmAckSessionId"] as? String ?? ""
    check(startBSession != "sess-232-a", "Start of B must not echo A's sessionId")
    check(startBAckSession != "sess-232-a", "Start of B must not echo A's pcmAckSessionId")
    check(
        ingest.listCaptures().first { $0.captureId == "cap-232-b" }?.sessionId != "sess-232-a",
        "new capture B must not bind leftover session A"
    )
    WCSession.default.messages.removeAll()
    bridge.pushStatus(capture: "listening", hint: "", sessionId: "sess-232-b")
    waitSend()
    let statusB = WCSession.default.messages.last { ($0["pcmAckCaptureId"] as? String) != nil } ?? [:]
    check((statusB["sessionId"] as? String) == "sess-232-b", "JS bind of B after Start tells Watch top-level sessionId B")
    check((statusB["pcmAckCaptureId"] as? String) == "cap-232-b", "JS bind of B names pcmAckCaptureId B, not A")
    check((statusB["pcmAckSessionId"] as? String ?? "") != "sess-232-a", "JS bind of B must not echo A's pcmAckSessionId")
    eq(ingest.ingestLive(data: Data(repeating: 9, count: 3200), captureId: "cap-232-b", sessionId: "", offset: 0), "accept")
    bindCapture("cap-232-b", session: "sess-232-b")
    var keepPosted: [String] = []
    WatchBridge.testingKeep = { sid in
        keepPosted.append(sid)
        if sid == "sess-232-b" { return (200, keepBody(sid)) }
        return (404, nil)
    }
    eq(postSave("sess-232-b", captureId: "cap-232-b")["save"] as? String ?? "", "saved")
    check(keepPosted == ["sess-232-b"], "B's Save keep HTTP is B, not A")
    check(ingest.listCaptures().contains(where: { $0.captureId == "cap-232-b" && $0.intent == "keep" }), "B Save marks keep on B")
    keepPosted.removeAll()
    WatchBridge.testingKeep = { sid in
        keepPosted.append(sid)
        return (404, nil)
    }
    eq(postSave("sess-232-a", captureId: "cap-232-a")["save"] as? String ?? "", "failed")
    check(keepPosted == ["sess-232-a"], "retry of A still posts A after B started")
    WatchBridge.testingKeep = nil

    ingest.reset()
    bridge.testingResetJobs()
    bindCapture("cap-empty-sid", session: "sess-empty-sid")
    eq(ingest.ingestLive(data: Data(repeating: 2, count: 1600), captureId: "cap-empty-sid", sessionId: "sess-empty-sid", offset: 0), "accept")
    var emptySidPosted: [String] = []
    WatchBridge.testingKeep = { sid in
        emptySidPosted.append(sid)
        if sid == "sess-empty-sid" { return (200, keepBody(sid)) }
        return (404, nil)
    }
    var emptySidSave: [String: Any] = [:]
    bridge.session(WCSession.default, didReceiveMessage: ["action": "save", "captureId": "cap-empty-sid"]) { emptySidSave = $0 }
    waitSend()
    eq(emptySidSave["save"] as? String ?? "", "saved")
    check((emptySidSave["sessionId"] as? String) == "sess-empty-sid", "empty Watch sessionId still keeps the named capture's confirmed session")
    check(emptySidPosted == ["sess-empty-sid"], "empty Watch sessionId must POST keep for the named capture")
    check(ingest.listCaptures().contains(where: { $0.captureId == "cap-empty-sid" && $0.intent == "keep" }), "empty Watch sessionId marks keep on the named capture")
    var emptyBoth: [String: Any] = [:]
    bridge.session(WCSession.default, didReceiveMessage: ["action": "save"]) { emptyBoth = $0 }
    waitSend()
    check((emptyBoth["save"] as? String) == "failed", "Save with no capture and no session still fails")
    check(emptySidPosted == ["sess-empty-sid"], "empty Save must not keep the live session")
    WatchBridge.testingKeep = nil

    ingest.reset()
    bridge.testingResetJobs()
    bridge.testingResetCopyState()
    bindCapture("cap-ack-c", session: "sess-ack-c")
    eq(ingest.ingestLive(data: Data(repeating: 5, count: 1600), captureId: "cap-ack-c", sessionId: "sess-ack-c", offset: 0), "accept")
    WCSession.default.messages.removeAll()
    RunLoop.main.run(until: Date().addingTimeInterval(1.15))
    let persistAck = WCSession.default.messages.last { $0["pcmAckByte"] != nil } ?? [:]
    check((persistAck["sessionId"] as? String) == "sess-ack-c", "persist ack includes top-level sessionId of the confirmed pair")
    check((persistAck["pcmAckSessionId"] as? String) == "sess-ack-c", "persist ack still names pcmAckSessionId")

    let bindB = WatchSendBuffer()
    bindB.beginCapture()
    let watchB = WatchPhoneSession(sendBuffer: bindB, pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("232-b")), connect: false)
    WCSession.default.messages.removeAll()
    deliver(watchB, ["sessionId": "sess-232-a", "pcmReady": "true"])
    check(bindB.sessionId != "sess-232-a", "stale reply/context with only session A must not bind B")
    watchB.confirmSave()
    check(watchB.saving, "Save with this capture enters saving without guessing a session id")
    check(
        WCSession.default.messages.contains(where: {
            ($0["action"] as? String) == "save"
                && ($0["captureId"] as? String) == bindB.captureId
                && ($0["sessionId"] as? String ?? "").isEmpty
        }),
        "Save with a named capture still goes on the wire when sessionId is empty"
    )
    deliver(watchB, ["sessionId": "sess-232-a"])
    check(bindB.sessionId.isEmpty, "session-only leftover A cannot pin B's Save")
    deliver(watchB, ["sessionId": "sess-232-b", "pcmAckCaptureId": bindB.captureId, "captureId": bindB.captureId])
    check(bindB.sessionId == "sess-232-b", "B binds when the payload names this capture and B")
    check(WCSession.default.messages.contains(where: { ($0["action"] as? String) == "save" && ($0["sessionId"] as? String) == "sess-232-b" }), "first confirmed session pins B's Save")
    deliver(watchB, ["save": "saved", "sessionId": "sess-232-a"])
    check(!watchB.savedAck, "A's late History ack cannot mark B saved")
    deliver(watchB, ["ok": true, "save": "saved", "sessionId": "sess-232-b"])
    check(watchB.savedAck, "B's matching History ack is Saved to History")
    ingest.reset()
    bridge.testingResetCopyState()
    WatchBridge.testingKeep = nil

    let savedUi = WatchPhoneSession.WatchSaveUi(terminal: "saved", dismissed: false, pendingSync: false, offeringSave: false, saveFailed: false, savedAck: false, saving: false, hint: WatchCopy.ready)
    check(WatchPhoneSession.reduceSaveStatus(savedUi, save: "local").pendingSync == false, "reduce: saved ignores late local")
    check(WatchPhoneSession.reduceSaveStatus(savedUi, save: "failed").saveFailed == false, "reduce: saved ignores late failed")
    let doneUi = WatchPhoneSession.WatchSaveUi(terminal: "local", dismissed: true, pendingSync: false, offeringSave: false, saveFailed: false, savedAck: false, saving: false, hint: WatchCopy.ready)
    check(WatchPhoneSession.reduceSaveStatus(doneUi, save: "local").pendingSync == false, "reduce: Done ignores late local")
    check(WatchPhoneSession.reduceSaveStatus(doneUi, save: "failed").saveFailed == false, "reduce: Done ignores late failed")

    bridge.testingResetCopyState()
    WCSession.default.messages.removeAll()
    let copyWire: [String: Any] = [
        "type": "watch_copy",
        "id": "pair-lock",
        "original": "Hello there",
        "translation": "你好",
        "seq": 3,
        "session_id": "native-session",
        "done": true,
    ]
    let copyText = String(data: try JSONSerialization.data(withJSONObject: copyWire), encoding: .utf8)!
    uplink.handleAudioText(copyText)
    waitSend()
    let copies = WCSession.default.messages.filter { ($0["translation"] as? String) == "你好" }
    check(!copies.isEmpty, "audio watch_copy reaches Watch without WKWebView JS")
    check((copies.last?["original"] as? String) == "Hello there", "watch_copy keeps the spoken line")

    // #219 P1: one copy version stream, shared by the native rows and the JS face
    // push. The Watch must never roll back to older text, and a new sentence must
    // not be blocked by a longer older one.
    func sendCopy(id: String, original: String, translation: String, seq: Int, session: String, failed: Bool = false) {
        let wire: [String: Any] = [
            "type": "watch_copy",
            "id": id,
            "original": original,
            "translation": translation,
            "seq": seq,
            "session_id": session,
            "done": false,
            "failed": failed,
        ]
        let text = String(data: try! JSONSerialization.data(withJSONObject: wire), encoding: .utf8)!
        uplink.handleAudioText(text)
        waitSend()
    }
    WCSession.default.messages.removeAll()
    sendCopy(id: "pair-a", original: "First", translation: "第一句", seq: 1000, session: "sess-a")
    sendCopy(id: "pair-b", original: "Second", translation: "第二句", seq: 2000, session: "sess-b")
    // A late frame of the previous session must not win on arrival order.
    sendCopy(id: "pair-a2", original: "First again", translation: "还是第一句", seq: 1500, session: "sess-a")
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "第二句")

    // The phone's JS face was suspended while locked: a stale push must not
    // overwrite the newer native copy.
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Second", translation: "第二",
        copyId: "pair-b", copySeq: 1900
    )
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "第二句")
    // Current JS face for the SAME copy, same version, shorter text: keep longer.
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Second", translation: "第二句",
        copyId: "pair-b", copySeq: 2000
    )
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "第二句")
    // Same version but a DIFFERENT copy (New / switch mode / a typed row): the
    // older, longer text must not survive the switch.
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Typed", translation: "手打",
        copyId: "typed-1", copySeq: 2000
    )
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "手打")
    eq(WCSession.default.messages.last?["original"] as? String ?? "", "Typed")

    // #219 P2: the replay to the phone holds the last copies (sentences), not the
    // last streamed updates — one long sentence must not evict several earlier
    // ones, so the phone can catch up on everything it missed while locked.
    sendCopy(id: "pair-r1", original: "One", translation: "第一句", seq: 5000, session: "sess-replay")
    sendCopy(id: "pair-r2", original: "Two", translation: "第二句", seq: 5001, session: "sess-replay")
    sendCopy(id: "pair-r1", original: "One", translation: "第一句还在长", seq: 5002, session: "sess-replay")
    var replay = bridge.testingCopyReplay()
    check(replay.count == 2, "replay keeps one row per copy")
    eq(replay[0]["id"] as? String ?? "", "pair-r1")
    check((replay[0]["translation"] as? String ?? "") == "第一句还在长", "the kept row holds its latest text")
    eq(replay[1]["id"] as? String ?? "", "pair-r2")

    // #219 P2: a failed copy reaches the Watch as a failure, and a later good row
    // clears it instead of leaving a half sentence looking live.
    sendCopy(id: "pair-f", original: "Three", translation: "半句", seq: 5003, session: "sess-replay", failed: true)
    eq(WCSession.default.messages.last?["copyFailed"] as? String ?? "", "true")
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "半句")
    sendCopy(id: "pair-f", original: "Three", translation: "完整三句", seq: 5004, session: "sess-replay")
    eq(WCSession.default.messages.last?["copyFailed"] as? String ?? "", "false")
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "完整三句")
    // The phone's face push carries the same marker (a stale push must not).
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Three", translation: "半句",
        copyId: "pair-f", copySeq: 5004, copyFailed: true
    )
    eq(WCSession.default.messages.last?["copyFailed"] as? String ?? "", "true")
    bridge.pushStatus(
        capture: "listening", hint: "", original: "Three", translation: "完整三句",
        copyId: "pair-f", copySeq: 5004, copyFailed: false
    )
    eq(WCSession.default.messages.last?["copyFailed"] as? String ?? "", "false")
    // A control-only push (no copy state) must not flip the marker.
    bridge.pushStatus(capture: "listening", hint: "Ready", save: "local", sessionId: "sess-replay")
    eq(WCSession.default.messages.last?["copyFailed"] as? String ?? "", "false")

    // A new control session clears the replay: rows from a closed session must not
    // be re-applied to a page the phone already reset.
    sendCopy(id: "pair-z", original: "Zero", translation: "零", seq: 6000, session: "sess-fresh")
    replay = bridge.testingCopyReplay()
    check(replay.count == 1, "a new session starts with an empty replay")
    eq(replay[0]["id"] as? String ?? "", "pair-z")

    // #219: a new copy session (New / clear / switch mode / Start) must not leave
    // the previous session's text on the Watch or in the replay, and the payload
    // must name the copy so the Watch can tell sentences apart.
    sendCopy(id: "old-row", original: "Old", translation: "旧句", seq: 7000, session: "sess-one")
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "旧句")
    sendCopy(id: "", original: "", translation: "", seq: 7001, session: "sess-two")
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "")
    eq(WCSession.default.messages.last?["original"] as? String ?? "", "")
    check(
        !bridge.testingCopyReplay().contains { ($0["translation"] as? String) == "旧句" },
        "a new session clears the previous session's replay"
    )
    sendCopy(id: "new-row", original: "New", translation: "新句", seq: 7002, session: "sess-two")
    eq(WCSession.default.messages.last?["translation"] as? String ?? "", "新句")
    eq(WCSession.default.messages.last?["copyId"] as? String ?? "", "new-row")
    // The server copy version rides the payload: the Watch orders copies with it
    // (monotone across a phone app restart), not with a per-run counter.
    check((WCSession.default.messages.last?["copySeq"] as? Int ?? 0) > 0,
          "the payload carries the server copy version")

    bridge.testingResetCopyState()
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

    // The two live fields can have different page counts (a short original, a long
    // translation). Requiring the slot to exist in BOTH used to re-queue the tail on
    // every push, so the queue grew without bound while a sentence streamed.
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "", original: "One page only", translation: longPage,
        copyId: "uneven-1", originalSegments: ["One page only"], translationSegments: [longPage, tailPage]
    )
    check(queuedPages() == 1, "an uneven pair queues its tail once")
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "save state", original: "One page only", translation: longPage,
        copyId: "uneven-1", originalSegments: ["One page only"], translationSegments: [longPage, tailPage]
    )
    check(queuedPages() == 0, "an unchanged tail is not re-queued when the original has fewer pages")

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
    bridge.testingResetCopyState()
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

    // #219 P2-2: accepting the delayed same-copy tail must not be paid for by
    // re-queuing every page on every push. Only changed pages are queued, and a push
    // that merely raises the server copy version (a `done`) queues nothing.
    func queuedIndexes(_ id: String) -> [Int] {
        WCSession.default.messages
            .filter { ($0["copyId"] as? String) == id }
            .compactMap { $0["copySegIndex"] as? Int }
            .filter { $0 > 0 }
    }
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "q0", translation: "Q0",
        copyId: "q-1", originalSegments: ["qo0", "qo1", "qo2"], translationSegments: ["qp0", "qp1", "qp2"],
        copySeq: 7000
    )
    eq(queuedIndexes("q-1"), [1, 2])
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "", original: "q0", translation: "Q0",
        copyId: "q-1", originalSegments: ["qo0", "qo1", "qo2"], translationSegments: ["qp0", "qp1", "qp2 new"],
        copySeq: 7001
    )
    eq(queuedIndexes("q-1"), [2])
    WCSession.default.messages.removeAll()
    bridge.pushStatus(
        capture: "listening", hint: "", original: "q0", translation: "Q0",
        copyId: "q-1", originalSegments: ["qo0", "qo1", "qo2"], translationSegments: ["qp0", "qp1", "qp2 new"],
        copySeq: 7002
    )
    check(queuedIndexes("q-1").isEmpty, "a copySeq bump alone must not re-queue pages")
    eq(queuedIndexes("q-1").count, 0)

    let watch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("paged")),
        connect: false
    )
    // A copy starts at page 0: a tail that outran its head (the two ride different
    // WCSession channels) is parked, not applied, and not lost — it is spliced in
    // when its head lands.
    deliver(watch, ["copyId": "c1", "copySegIndex": 1, "copySegTotal": 2, "original": "org-1", "translation": "page-1"])
    eq(watch.translation, "")
    eq(watch.original, "")
    eq(watch.copyId, "")
    deliver(watch, ["copyId": "c1", "copySegIndex": 0, "copySegTotal": 2, "original": "org-0", "translation": "page-0"])
    eq(watch.translation, "page-0page-1")
    eq(watch.original, "org-0org-1")
    eq(watch.copyId, "c1")
    // Re-delivering the tail is idempotent.
    deliver(watch, ["copyId": "c1", "copySegIndex": 1, "copySegTotal": 2, "original": "org-1", "translation": "page-1"])
    eq(watch.translation, "page-0page-1")
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
    // A new copy id starts a new copy on its page 0; its earlier tail is parked and
    // joins that head immediately (tail -> head across channels).
    deliver(watch, ["copyId": "c5", "copySegIndex": 1, "copySegTotal": 2, "original": "n-1", "translation": "n-1"])
    eq(watch.translation, "g-0g-1g-2")
    deliver(watch, ["copyId": "c5", "copySegIndex": 0, "copySegTotal": 2, "original": "n-0", "translation": "n-0"])
    eq(watch.translation, "n-0n-1")
    eq(watch.original, "n-0n-1")
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

    check(WatchPhoneSession.copySeqApplies(incoming: 5, high: 4, sameCopyId: false), "a newer server copy version applies")
    check(WatchPhoneSession.copySeqApplies(incoming: 4, high: 4, sameCopyId: false), "the same server copy version is idempotent")
    check(!WatchPhoneSession.copySeqApplies(incoming: 3, high: 4, sameCopyId: false), "an older server copy version is dropped")
    check(WatchPhoneSession.copySeqApplies(incoming: 0, high: 4, sameCopyId: false), "a zero server version carries no ordering")
    check(WatchPhoneSession.copySeqApplies(incoming: nil, high: 4, sameCopyId: false), "an absent server version carries no ordering")
    check(WatchPhoneSession.copySeqApplies(incoming: 3, high: 0, sameCopyId: false), "the first server version is accepted")
    // Inside one sentence an older server version is normal: the phone only re-sends
    // pages whose text changed, so a delayed tail keeps the version it was queued at.
    check(WatchPhoneSession.copySeqApplies(incoming: 3, high: 4, sameCopyId: true),
          "inside one sentence a delayed older server version still applies")

    // #219 P2-2: the server-version gate must not reject a delayed, unchanged tail
    // page of the SAME sentence — nothing would ever re-send it. Head first, page 2
    // next, the delayed page 1 last: the copy must end up complete.
    let interleaved = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("interleaved")),
        connect: false
    )
    deliver(interleaved, ["copyId": "i1", "copySeq": 10, "copySegIndex": 0, "copySegTotal": 3, "copyVersion": 5, "original": "o0", "translation": "p0"])
    eq(interleaved.translation, "p0")
    // A `done` raises the server copy version without changing the head text.
    deliver(interleaved, ["copyId": "i1", "copySeq": 11, "copySegIndex": 0, "copySegTotal": 3, "copyVersion": 5, "original": "o0", "translation": "p0"])
    eq(interleaved.translation, "p0")
    // Page 2 belongs to a NEWER content generation whose head has not landed: it is
    // parked (a new head must not be spliced onto an old tail), so it is neither
    // shown nor lost.
    deliver(interleaved, ["copyId": "i1", "copySeq": 11, "copySegIndex": 2, "copySegTotal": 3, "copyVersion": 6, "original": "o2", "translation": "p2"])
    eq(interleaved.translation, "p0")
    // The delayed page 1 still carries the version/seq it was queued with — the
    // older SERVER version must not gate it inside one sentence.
    deliver(interleaved, ["copyId": "i1", "copySeq": 10, "copySegIndex": 1, "copySegTotal": 3, "copyVersion": 5, "original": "o1", "translation": "p1"])
    eq(interleaved.translation, "p0p1")
    eq(interleaved.original, "o0o1")
    // The newer generation's head lands with the SAME text: the sentence is not a new
    // generation (nothing to reset), and the parked page 2 joins it immediately.
    deliver(interleaved, ["copyId": "i1", "copySeq": 12, "copySegIndex": 0, "copySegTotal": 3, "copyVersion": 6, "original": "o0", "translation": "p0"])
    eq(interleaved.translation, "p0p1p2")
    // Re-delivering the tails at that version is idempotent.
    deliver(interleaved, ["copyId": "i1", "copySeq": 12, "copySegIndex": 1, "copySegTotal": 3, "copyVersion": 6, "original": "o1", "translation": "p1"])
    deliver(interleaved, ["copyId": "i1", "copySeq": 12, "copySegIndex": 2, "copySegTotal": 3, "copyVersion": 6, "original": "o2", "translation": "p2"])
    eq(interleaved.translation, "p0p1p2")
    eq(interleaved.original, "o0o1o2")

    // #219 P2-2: an application context re-delivered by the OS carries the same
    // copy id but an older content version — it must not roll the whole text back.
    let replayed = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("replayed")),
        connect: false
    )
    deliver(replayed, ["copyId": "r1", "copySeq": 30, "copyVersion": 9, "original": "o-new", "translation": "新"])
    eq(replayed.translation, "新")
    deliver(replayed, ["copyId": "r1", "copySeq": 30, "copyVersion": 8, "original": "o-old", "translation": "旧"])
    eq(replayed.translation, "新")
    eq(replayed.original, "o-new")
    // A newer whole text still applies...
    deliver(replayed, ["copyId": "r1", "copySeq": 31, "copyVersion": 10, "original": "o-new2", "translation": "新2"])
    eq(replayed.translation, "新2")
    // ...and a NEW sentence may legitimately carry a lower per-run content version.
    deliver(replayed, ["copyId": "r2", "copySeq": 32, "copyVersion": 2, "original": "o-next", "translation": "下句"])
    eq(replayed.translation, "下句")
    eq(replayed.copyId, "r2")

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

    // A previous test left a pcm rejection in the singleton bridge; the real app
    // clears it on a new capture, so do the same before pushing status again
    // (otherwise the receiver's stale-rejection guard drops the whole payload).
    bridge.session(WCSession.default, didReceiveMessage: [
        "action": "start", "captureId": "copy-status-\(UUID().uuidString)",
        "at": Date().timeIntervalSince1970,
    ]) { _ in }
    waitSend()

    // #219 review P2-2: head and tails ride different WCSession channels (the
    // application context / sendMessage vs the queued userInfo), so a tail can
    // arrive before its head. Neither order may lose a page, and nothing may rely
    // on another ready or on the text happening to change again.
    let outOfOrder = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("out-of-order")),
        connect: false
    )
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "A", translation: "甲",
        copyId: "copy-A", originalSegments: ["A"], translationSegments: ["甲"],
        copySeq: 900001
    )
    deliver(outOfOrder, WCSession.default.receivedApplicationContext)
    eq(outOfOrder.translation, "甲")
    let pageB0 = String(repeating: "乙", count: 12000)
    let pageB1 = "乙尾"
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "B", translation: pageB0 + pageB1,
        copyId: "copy-B", originalSegments: ["B"], translationSegments: [pageB0, pageB1],
        copySeq: 900002
    )
    let bTail = WCSession.default.messages.first { ($0["copySegIndex"] as? Int) == 1 }
    check(bTail != nil, "B's tail is queued")
    let bHead = WCSession.default.receivedApplicationContext
    // The queued tail lands first: it must not switch the sentence, and must not be
    // thrown away either.
    deliver(outOfOrder, bTail!)
    eq(outOfOrder.translation, "甲")
    eq(outOfOrder.copyId, "copy-A")
    deliver(outOfOrder, bHead)
    eq(outOfOrder.copyId, "copy-B")
    eq(outOfOrder.translation, pageB0 + pageB1)

    // The same for a new content generation of ONE sentence: a new-generation tail
    // that outruns its changed head is parked and joins that head (no old tail mixed
    // into the new text, no page lost).
    let generations = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("generations")),
        connect: false
    )
    let g1 = [String(repeating: "一", count: 12000), String(repeating: "二", count: 12000), "一尾"]
    let g2 = [String(repeating: "壹", count: 12000), String(repeating: "贰", count: 12000), "壹尾"]
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "H1", translation: g1.joined(),
        copyId: "gen-1", originalSegments: ["H1"], translationSegments: g1,
        copySeq: 900003
    )
    deliver(generations, WCSession.default.receivedApplicationContext)
    eq(generations.translation, g1[0])
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    bridge.pushStatus(
        capture: "listening", hint: "", original: "H2", translation: g2.joined(),
        copyId: "gen-1", originalSegments: ["H2"], translationSegments: g2,
        copySeq: 900004
    )
    let g2Tails = WCSession.default.messages.filter { (($0["copySegIndex"] as? Int) ?? 0) > 0 }
    let g2Head = WCSession.default.receivedApplicationContext
    check(g2Tails.count >= 2, "a changed head re-queues every tail, got \(g2Tails.count)")
    // A tail of the new generation outruns its head: it is parked, so the old head
    // is never spliced onto the new tail.
    deliver(generations, g2Tails.last!)
    eq(generations.translation, g1[0])
    deliver(generations, g2Head)
    eq(generations.original, "H2")
    // The parked tail joins its head; the rest of the re-queued tails complete the
    // new generation, and none of the old generation's text survives.
    deliver(generations, g2Tails.first!)
    eq(generations.translation, g2.joined())
    check(!generations.translation.contains("一"), "no old-generation text may survive")

    // #219 review P2-3: the phone's page counter restarts with its process. The same
    // sentence comes back with a NEWER server version and a LOWER page counter; the
    // Watch must take it immediately instead of rejecting new content until the
    // counter climbs back — while a pre-restart page cannot roll it back.
    let rebooted = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("rebooted")),
        connect: false
    )
    let oldLong = String(repeating: "旧", count: 12000)
    deliver(rebooted, ["copyId": "A", "copySeq": 100, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 100, "original": "o-old", "translation": oldLong])
    deliver(rebooted, ["copyId": "A", "copySeq": 100, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 100, "original": "o-old2", "translation": "旧尾"])
    eq(rebooted.translation, oldLong + "旧尾")
    // Phone restarted: same sentence, newer server version, counter back to 1.
    deliver(rebooted, ["copyId": "A", "copySeq": 101, "copyVersion": 1, "original": "o-new", "translation": "新"])
    eq(rebooted.translation, "新")
    eq(rebooted.original, "o-new")
    // Its paged form restores immediately too.
    deliver(rebooted, ["copyId": "A", "copySeq": 101, "copySegIndex": 0, "copySegTotal": 2, "copyVersion": 1, "original": "o-new", "translation": "新0"])
    deliver(rebooted, ["copyId": "A", "copySeq": 101, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 1, "original": "o-new1", "translation": "新1"])
    eq(rebooted.translation, "新0新1")
    // A pre-restart page (higher page version, OLDER server version) stays out.
    deliver(rebooted, ["copyId": "A", "copySeq": 100, "copySegIndex": 1, "copySegTotal": 2, "copyVersion": 100, "original": "o-old2", "translation": "旧尾"])
    eq(rebooted.translation, "新0新1")
    eq(rebooted.original, "o-newo-new1")

    // An older copy (smaller server version) can neither take over nor park its way
    // back in.
    deliver(rebooted, ["copyId": "OLD", "copySeq": 50, "copyVersion": 200, "original": "o-oldcopy", "translation": "旧副本"])
    eq(rebooted.translation, "新0新1")
    eq(rebooted.copyId, "A")
    deliver(rebooted, ["copyId": "OLD", "copySeq": 51, "copySegIndex": 0, "copySegTotal": 1, "copyVersion": 201, "original": "o-oldcopy", "translation": "旧副本2"])
    eq(rebooted.translation, "新0新1")
    eq(rebooted.copyId, "A")

    // The parked-tail cache is bounded: many heads' tails cannot grow it forever.
    let bounded = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("bounded")),
        connect: false
    )
    deliver(bounded, ["copyId": "keep", "copySeq": 1, "copyVersion": 1, "original": "keep", "translation": "keep"])
    for i in 0..<20 {
        deliver(bounded, [
            "copyId": "pend-\(i)", "copySeq": 1000 + i, "copySegIndex": 1, "copySegTotal": 2,
            "copyVersion": 1 + i, "original": "o", "translation": "t",
        ])
    }
    check(bounded.testingPendingCopyKeys().count <= 6,
          "the parked-tail cache is bounded, got \(bounded.testingPendingCopyKeys().count)")
    eq(bounded.translation, "keep")
    eq(bounded.copyId, "keep")

    // #219 integration (#221 + #222): the LOCKED phone's native path must be paged
    // too, and the copy version it carries is what lets the Watch reject an older
    // copy's page 0 — while a delayed tail of the SAME sentence (queued before the
    // version advanced) must still join it. Neither PR covers this on its own.
    bridge.testingResetCopyState()
    let lockedPageA = String(repeating: "甲", count: 12000)
    let lockedPageB = "尾页。"
    func lockedRow(seq: Int) -> [String: Any] {
        [
            "type": "watch_copy", "id": "locked-paged", "original": "Locked line",
            "translation": lockedPageA + lockedPageB, "seq": seq, "session_id": "sess-paged",
            "done": true, "failed": false, "order": 3,
            "original_pages": ["Locked line"], "translation_pages": [lockedPageA, lockedPageB],
        ]
    }
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    uplink.handleAudioText(String(data: try JSONSerialization.data(withJSONObject: lockedRow(seq: 960_000)), encoding: .utf8)!)
    waitSend()
    eq(WCSession.default.receivedApplicationContext["copySegTotal"] as? Int ?? -1, 2)
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", lockedPageA)
    eq(WCSession.default.receivedApplicationContext["copySeq"] as? Int ?? -1, 960_000)
    let lockedTail = WCSession.default.messages.filter { ($0["copySegIndex"] as? Int) == 1 }
    check(!lockedTail.isEmpty, "the locked path queues the tail page instead of one oversized frame")
    eq(lockedTail.last?["translation"] as? String ?? "", lockedPageB)
    eq(lockedTail.last?["copyId"] as? String ?? "", "locked-paged")
    eq(lockedTail.last?["copySeq"] as? Int ?? -1, 960_000)

    let lockedWatch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("locked-paged")),
        connect: false
    )
    // Cross-channel inversion: the queued tail rides transferUserInfo while the head
    // rides the application context, so deliver the TAIL first and the head second —
    // using the REAL payloads the bridge produced, keys included.
    let lockedHead = WCSession.default.receivedApplicationContext
    let lockedTailPayload = lockedTail.last ?? [:]
    deliver(lockedWatch, lockedTailPayload)
    eq(lockedWatch.translation, "")
    deliver(lockedWatch, lockedHead)
    eq(lockedWatch.translation, lockedPageA + lockedPageB)
    eq(lockedWatch.original, "Locked line")
    // A done through the native channel raises the copy version with the same text:
    // the unchanged tail is NOT re-queued (the queue must not grow per push) ...
    WCSession.default.messages.removeAll()
    uplink.handleAudioText(String(data: try JSONSerialization.data(withJSONObject: lockedRow(seq: 960_001)), encoding: .utf8)!)
    waitSend()
    eq(WCSession.default.receivedApplicationContext["copySeq"] as? Int ?? -1, 960_001)
    check(
        WCSession.default.messages.allSatisfy { ($0["copySegIndex"] as? Int) != 1 },
        "an unchanged tail page is not re-queued by a done"
    )
    // ... so a tail stamped with the older server version must still join the
    // sentence: within one copyId the server version gates nothing.
    deliver(lockedWatch, [
        "copyId": "locked-paged", "copySegIndex": 1, "copySegTotal": 2,
        "copyVersion": 5, "copySeq": 960_000,
        "original": "Locked tail", "translation": lockedPageB,
    ])
    eq(lockedWatch.translation, lockedPageA + lockedPageB)

    // An older COPY (different id, smaller copySeq) still cannot become current.
    deliver(lockedWatch, [
        "copyId": "stale-copy", "copySegIndex": 0, "copySegTotal": 1,
        "copyVersion": 4, "copySeq": 959_000,
        "original": "Old", "translation": "旧句",
    ])
    eq(lockedWatch.translation, lockedPageA + lockedPageB)
    eq(lockedWatch.copyId, "locked-paged")

    // A short locked copy stays single-frame: no page fields anywhere.
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    let shortWire: [String: Any] = [
        "type": "watch_copy", "id": "locked-short", "original": "Short", "translation": "短句",
        "seq": 960_002, "session_id": "sess-paged", "done": true, "failed": false,
    ]
    uplink.handleAudioText(String(data: try JSONSerialization.data(withJSONObject: shortWire), encoding: .utf8)!)
    waitSend()
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", "短句")
    check(WCSession.default.receivedApplicationContext["copySegIndex"] == nil, "a short locked copy stays unpaged")
    check(WCSession.default.messages.allSatisfy { $0["copySegIndex"] == nil }, "a short locked copy queues nothing")

    // Live Q&A (#219 follow-up): the phone is locked, the webview cannot push a
    // face, so the Q&A answer has to arrive over the native audio socket. The
    // server sends `qa_copy` with the question/answer named as such; the bridge
    // maps it onto the shared copy lane and the Watch renders it as question +
    // answer. Every payload below is produced by the real server shape and fed
    // through the real receiver (`AudioUplink.handleAudioText`).
    bridge.testingResetCopyState()
    let qaWire: (String, String, Int, Bool, Bool) -> [String: Any] = { id, answer, seq, done, failed in
        [
            "type": "qa_copy", "id": id,
            "question": "What is the refund window?", "answer": answer,
            "seq": seq, "session_id": "qa-session-1", "done": done, "failed": failed,
        ]
    }
    func feedAudio(_ obj: [String: Any]) throws {
        uplink.handleAudioText(String(data: try JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!)
        waitSend()
    }
    check(
        WatchBridge.watchCopyRow(fromQa: qaWire("q-1", "It is 30 days.", 970_000, true, false))["original"] as? String
            == "What is the refund window?",
        "the Q&A payload maps question -> original"
    )
    let qaWatch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("qa-locked")),
        connect: false
    )
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    try feedAudio(qaWire("q-1", "", 970_000, false, false))
    eq(WCSession.default.receivedApplicationContext["original"] as? String ?? "", "What is the refund window?")
    deliver(qaWatch, WCSession.default.receivedApplicationContext)
    deliver(qaWatch, ["mode": "interview"])
    eq(qaWatch.original, "What is the refund window?")
    eq(qaWatch.translation, "")
    check(qaWatch.mode == "interview", "the Watch is in Live Q&A for the answer")

    // The answer streams while the phone stays locked: each chunk is the whole
    // answer so far, so the Watch can never show a rolled-back prefix.
    try feedAudio(qaWire("q-1", "It is ", 970_001, false, false))
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", "It is ")
    try feedAudio(qaWire("q-1", "It is 30 days.", 970_002, false, false))
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", "It is 30 days.")
    try feedAudio(qaWire("q-1", "It is 30 days.", 970_003, true, false))
    eq(WCSession.default.receivedApplicationContext["copySeq"] as? Int ?? -1, 970_003)
    deliver(qaWatch, WCSession.default.receivedApplicationContext)
    eq(qaWatch.translation, "It is 30 days.")
    eq(qaWatch.original, "What is the refund window?")

    // A long answer is paged; the tail must join the head instead of replacing the
    // whole answer with one page.
    bridge.testingResetCopyState()
    let qaLongA = String(repeating: "答", count: 12000)
    let qaLongB = "尾页。"
    var qaPaged: [String: Any] = qaWire("q-long", qaLongA + qaLongB, 970_100, true, false)
    qaPaged["question_pages"] = ["What is the refund window?"]
    qaPaged["answer_pages"] = [qaLongA, qaLongB]
    let pagedWatch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("qa-paged")),
        connect: false
    )
    WCSession.default.messages.removeAll()
    WCSession.default.receivedApplicationContext = [:]
    try feedAudio(qaPaged)
    let qaHead = WCSession.default.receivedApplicationContext
    let qaTail = WCSession.default.messages.last { ($0["copySegIndex"] as? Int) == 1 } ?? [:]
    check(!qaTail.isEmpty, "the locked Q&A answer queues its tail page")
    // Tail first, then head: a page that arrives before its head must not become
    // the whole answer, and the joined text must be complete once the head lands.
    deliver(pagedWatch, qaTail)
    eq(pagedWatch.translation, "")
    deliver(pagedWatch, qaHead)
    eq(pagedWatch.translation, qaLongA + qaLongB)
    eq(pagedWatch.original, "What is the refund window?")

    // Retry / regenerate: the same question gets a fresh answer, and the old
    // attempt's frames must not roll it back.
    bridge.testingResetCopyState()
    let retryWatch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("qa-retry")),
        connect: false
    )
    try feedAudio(qaWire("q-retry", "first attempt", 970_200, false, false))
    deliver(retryWatch, WCSession.default.receivedApplicationContext)
    eq(retryWatch.translation, "first attempt")
    try feedAudio(qaWire("q-retry", "", 970_201, false, false))
    try feedAudio(qaWire("q-retry", "second attempt", 970_202, true, false))
    deliver(retryWatch, WCSession.default.receivedApplicationContext)
    eq(retryWatch.translation, "second attempt")
    // A late chunk carrying the superseded version is a stale frame.
    try feedAudio(qaWire("q-retry", "first attempt (late)", 970_200, false, false))
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", "second attempt")

    // A late frame from a previous question cannot overwrite the current one.
    bridge.testingResetCopyState()
    let orderWatch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("qa-order")),
        connect: false
    )
    try feedAudio(qaWire("q-old", "old answer", 970_300, false, false))
    try feedAudio(qaWire("q-new", "new answer", 970_301, false, false))
    deliver(orderWatch, WCSession.default.receivedApplicationContext)
    eq(orderWatch.translation, "new answer")
    try feedAudio(qaWire("q-old", "old answer (late)", 970_299, false, false))
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", "new answer")
    eq(WCSession.default.receivedApplicationContext["copyId"] as? String ?? "", "q-new")

    // A failure names its attempt and the Watch can say so instead of showing a
    // half answer as live.
    bridge.testingResetCopyState()
    try feedAudio(qaWire("q-fail", "", 970_400, false, true))
    eq(WCSession.default.receivedApplicationContext["copyFailed"] as? String ?? "", "true")

    // New / a workspace switch mints a new Q&A stream, so the previous
    // conversation's late frame is rejected by the session guard.
    bridge.testingResetCopyState()
    let switchedWatch = WatchPhoneSession(
        sendBuffer: WatchSendBuffer(),
        pcmStore: WatchPcmStore(rootURL: root.appendingPathComponent("qa-switch")),
        connect: false
    )
    try feedAudio(qaWire("q-switch", "before", 970_500, false, false))
    deliver(switchedWatch, WCSession.default.receivedApplicationContext)
    eq(switchedWatch.translation, "before")
    var qaAfterSwitch: [String: Any] = qaWire("q-after", "after", 970_501, false, false)
    qaAfterSwitch["session_id"] = "qa-session-2"
    try feedAudio(qaAfterSwitch)
    deliver(switchedWatch, WCSession.default.receivedApplicationContext)
    eq(switchedWatch.translation, "after")
    // The previous conversation's late frame must not reopen the copy it belonged
    // to, even though it names a different session and a different turn.
    try feedAudio(qaWire("q-switch", "before (very late)", 970_499, false, false))
    eq(WCSession.default.receivedApplicationContext["copyId"] as? String ?? "", "q-after")
    eq(WCSession.default.receivedApplicationContext["translation"] as? String ?? "", "after")
    eq(switchedWatch.translation, "after")

    // #224: the dimmed (Always On) screen must keep showing the live question and
    // answer, not just a mode name and a timer — and it must not fall back to a
    // black page while a session's copy is still on screen. The decision is pure,
    // so every branch of the display is checked here without a Watch.
    // Live Q&A with an answer on screen: the answer stays readable, and the session
    // still counts as running (mode chip + clock), because generating is not End.
    eq(aod(listening: true, hasContent: true), WatchAodDisplay(kind: .content, active: true, copyFailed: false))
    // A failed copy still shows its text plus the failure note.
    eq(aod(listening: true, hasContent: true, copyFailed: true), WatchAodDisplay(kind: .content, active: true, copyFailed: true))
    // Paused with content: readable, marked paused, and no running clock.
    eq(aod(paused: true, hasContent: true), WatchAodDisplay(kind: .content, active: true, copyFailed: false))
    // The confirmed black-screen bug: session ended (capture off) but its last
    // question/answer is still the content the user wants to read.
    eq(aod(hasContent: true), WatchAodDisplay(kind: .content, active: false, copyFailed: false))
    // Listening but nothing transcribed yet: nothing to read, so stay black rather
    // than claiming content that does not exist.
    eq(aod(listening: true), WatchAodDisplay(kind: .idle, active: false, copyFailed: false))
    // Ready with no session at all.
    eq(aod(), WatchAodDisplay(kind: .idle, active: false, copyFailed: false))
    // The platform's own end-of-session surfaces keep the screen, even with content.
    eq(aod(offeringSave: true, hasContent: true), WatchAodDisplay(kind: .platform, active: false, copyFailed: false))
    eq(aod(pendingSync: true, hasContent: true), WatchAodDisplay(kind: .platform, active: false, copyFailed: false))
    eq(aod(savedAck: true, hasContent: true), WatchAodDisplay(kind: .platform, active: false, copyFailed: false))
    eq(aod(draining: true, listening: true, hasContent: true), WatchAodDisplay(kind: .platform, active: true, copyFailed: false))
    eq(aod(drainFailed: true, hasContent: true), WatchAodDisplay(kind: .platform, active: false, copyFailed: false))

    // #224 confirmed design: the bottom waveform is a status animation, so it may
    // only move while the Watch is actually listening and visible. Paused, Always On
    // and Reduce Motion must all hold it still — the animation is never allowed to
    // be what keeps the screen (or the CPU) awake.
    check(WatchAod.waveformAnimates(listening: true, paused: false, dimmed: false, reduceMotion: false),
          "a listening bright screen animates the waveform")
    check(!WatchAod.waveformAnimates(listening: false, paused: false, dimmed: false, reduceMotion: false),
          "a stopped session must not animate")
    check(!WatchAod.waveformAnimates(listening: true, paused: true, dimmed: false, reduceMotion: false),
          "paused holds the waveform still")
    check(!WatchAod.waveformAnimates(listening: true, paused: false, dimmed: true, reduceMotion: false),
          "Always On holds the waveform still")
    check(!WatchAod.waveformAnimates(listening: true, paused: true, dimmed: true, reduceMotion: false),
          "Always On and paused hold the waveform still")
    check(!WatchAod.waveformAnimates(listening: true, paused: false, dimmed: false, reduceMotion: true),
          "Reduce Motion holds the waveform still")

    // #218 Live Q&A reading rules (compact summary + no jump while reading).
    WatchQASummaryTests.run()

    _ = bridge
    print("Watch replay: persist-ack, buffer pause, disconnect pause, leftover files, identity, handshake, Save, locked Live Q&A, Always-On display and waveform tests passed")
 }
}

func eq<T: Equatable>(_ got: T, _ want: T, file: String = #file, line: Int = #line) {
    if got != want {
        fputs("FAIL: \(file):\(line) got \(got) want \(want)\n", stderr)
        exit(1)
    }
}
