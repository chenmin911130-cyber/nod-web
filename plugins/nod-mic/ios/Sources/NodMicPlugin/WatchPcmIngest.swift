import Foundation

extension Notification.Name {
    static let nodWatchPcmBind = Notification.Name("nod.watch.pcm.bind")
    static let nodWatchPcmReset = Notification.Name("nod.watch.pcm.reset")
    static let nodWatchPcmLive = Notification.Name("nod.watch.pcm.live")
    static let nodWatchPcmFile = Notification.Name("nod.watch.pcm.file")
    static let nodWatchPcmAck = Notification.Name("nod.watch.pcm.ack")
    static let nodWatchPcmDiscard = Notification.Name("nod.watch.pcm.discard")
    static let nodWatchPcmHeld = Notification.Name("nod.watch.pcm.held")
    static let nodWatchPcmIntent = Notification.Name("nod.watch.pcm.intent")
    static let nodWatchPcmPendingKeeps = Notification.Name("nod.watch.pcm.pendingKeeps")
}

/// Phone ingest of Watch PCM. Persist the contiguous prefix first, then stream
/// from that file into AudioUplink. Watch ack is heldByte, never socket send.
final class WatchPcmIngest {
    static let shared = WatchPcmIngest()

    static let frameBytes = 3200

    private let queue = DispatchQueue(label: "nod.watch.ingest")
    private let store: PhonePcmStore
    private var uploadByte = 0
    private(set) var ackByte = 0
    private var captureId = ""
    private var sessionId = ""
    private var pumping = false
    private var drainLastByte = -1
    private var drainCapture = ""
    private var drainSession = ""
    private var pcmEndSent = false
    private var rejected = false
    private var observers: [NSObjectProtocol] = []

    init(store: PhonePcmStore = .shared) {
        self.store = store
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmBind,
            object: nil,
            queue: nil
        ) { [weak self] note in
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            self?.bind(captureId: capture, sessionId: session)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmReset,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.reset()
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmLive,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self, let data = note.userInfo?["data"] as? Data else { return }
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            let offset = (note.userInfo?["byteOffset"] as? Int)
                ?? Int(note.userInfo?["byteOffset"] as? String ?? "") ?? 0
            let decision = self.ingestLive(data: data, captureId: capture, sessionId: session, offset: offset)
            if let reply = note.userInfo?["reply"] as? NSMutableDictionary {
                reply["decision"] = decision
                self.fillAck(reply)
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmFile,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self else { return }
            let url = (note.userInfo?["url"] as? URL) ?? (note.userInfo?["url"] as? String).flatMap(URL.init(fileURLWithPath:))
            guard let url else { return }
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            let offset = (note.userInfo?["byteOffset"] as? Int)
                ?? Int(note.userInfo?["byteOffset"] as? String ?? "") ?? 0
            let ok = self.ingestFile(src: url, captureId: capture, sessionId: session, offset: offset)
            if let reply = note.userInfo?["reply"] as? NSMutableDictionary {
                reply["ok"] = ok
                self.fillAck(reply)
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmAck,
            object: nil,
            queue: nil
        ) { [weak self] note in
            if let reply = note.userInfo?["reply"] as? NSMutableDictionary {
                self?.fillAck(reply)
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmDiscard,
            object: nil,
            queue: nil
        ) { [weak self] note in
            let capture = note.userInfo?["captureId"] as? String ?? ""
            self?.discard(captureId: capture)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmIntent,
            object: nil,
            queue: nil
        ) { [weak self] note in
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            let intent = note.userInfo?["intent"] as? String ?? ""
            let ok = self?.markIntent(intent, captureId: capture, sessionId: session) ?? false
            if let reply = note.userInfo?["reply"] as? NSMutableDictionary {
                reply["ok"] = ok
                if let cap = self?.resolvedCaptureId(captureId: capture, sessionId: session) {
                    reply["captureId"] = cap
                }
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .nodWatchPcmPendingKeeps,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let reply = note.userInfo?["reply"] as? NSMutableDictionary else { return }
            let rows = self?.listCaptures().compactMap { info -> [String: String]? in
                guard info.intent == "keep", !info.sessionId.isEmpty else { return nil }
                return ["sessionId": info.sessionId, "captureId": info.captureId]
            } ?? []
            reply["rows"] = rows
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.uplink.consumed"),
            object: nil,
            queue: nil
        ) { [weak self] note in
            let n = (note.userInfo?["bytes"] as? Int) ?? 0
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            self?.queue.async {
                self?.markUploadedLocked(n, captureId: capture, sessionId: session)
                self?.pumpLocked()
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm.drain"),
            object: nil,
            queue: nil
        ) { [weak self] note in
            let last = (note.userInfo?["lastByte"] as? Int)
                ?? Int(note.userInfo?["lastByte"] as? String ?? "") ?? 0
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            self?.queue.async {
                self?.beginDrainLocked(lastByte: last, captureId: capture, sessionId: session)
            }
        })
    }

    func bind(captureId: String, sessionId: String) {
        queue.sync { [weak self] in
            guard let self else { return }
            if !self.captureId.isEmpty, !captureId.isEmpty, captureId != self.captureId {
                self.rejected = false
                self.uploadByte = 0
                self.ackByte = 0
                self.drainLastByte = -1
                self.drainCapture = ""
                self.drainSession = ""
                self.pcmEndSent = false
            }
            if !captureId.isEmpty {
                if captureId != self.captureId || !self.store.isReady(captureId: captureId) {
                    _ = self.store.begin(captureId: captureId)
                    self.uploadByte = self.store.currentHeldByte()
                    self.ackByte = self.uploadByte
                }
                self.captureId = captureId
            }
            if !sessionId.isEmpty {
                self.sessionId = sessionId
                self.store.bindSession(sessionId)
            }
            self.maybeRequestPcmEndLocked()
        }
    }

    func isReady(captureId: String) -> Bool {
        var ok = false
        queue.sync { ok = self.store.isReady(captureId: captureId) }
        return ok
    }

    func reject(sessionId: String, captureId: String) {
        queue.async {
            guard !sessionId.isEmpty, sessionId == self.sessionId,
                  captureId == self.captureId else { return }
            self.rejected = true
            self.drainLastByte = -1
        }
    }

    func discard(captureId: String) {
        queue.sync {
            guard !captureId.isEmpty else { return }
            _ = self.store.markIntent("discard", captureId: captureId)
            _ = self.store.deleteCapture(captureId)
            if captureId == self.captureId {
                self.rejected = false
                self.uploadByte = 0
                self.ackByte = 0
                self.captureId = ""
                self.sessionId = ""
                self.drainLastByte = -1
                self.drainCapture = ""
                self.drainSession = ""
                self.pcmEndSent = false
            }
        }
    }

    func reset() {
        queue.sync { [weak self] in
            guard let self else { return }
            self.rejected = false
            self.uploadByte = 0
            self.captureId = ""
            self.sessionId = ""
            self.ackByte = 0
            self.drainLastByte = -1
            self.drainCapture = ""
            self.drainSession = ""
            self.pcmEndSent = false
            self.store.resetLive()
        }
    }

    func currentAck() -> Int {
        var n = 0
        queue.sync { n = self.ackByte }
        return n
    }

    func listCaptures() -> [PhonePcmStore.CaptureInfo] {
        var rows: [PhonePcmStore.CaptureInfo] = []
        queue.sync { rows = self.store.listCaptures() }
        return rows
    }

    func deleteCapture(_ id: String) -> Int {
        var n = 0
        queue.sync { n = self.store.deleteCapture(id) }
        return n
    }

    func markIntent(_ intent: String, captureId: String, sessionId: String = "") -> Bool {
        var ok = false
        queue.sync {
            let id = self.resolveCaptureLocked(captureId: captureId, sessionId: sessionId)
            guard !id.isEmpty else { return }
            ok = self.store.markIntent(intent, captureId: id)
        }
        return ok
    }

    func resolvedCaptureId(captureId: String, sessionId: String) -> String {
        var id = ""
        queue.sync {
            id = self.resolveCaptureLocked(captureId: captureId, sessionId: sessionId)
        }
        return id
    }

    /// Save must name a capture or uniquely match a session. Never fall back to the live capture.
    private func resolveCaptureLocked(captureId: String, sessionId: String) -> String {
        let rows = self.store.listCaptures()
        if !captureId.isEmpty {
            guard let found = rows.first(where: { $0.captureId == captureId }) else { return "" }
            if !sessionId.isEmpty, !found.sessionId.isEmpty, found.sessionId != sessionId {
                return ""
            }
            return captureId
        }
        if sessionId.isEmpty { return "" }
        let matches = rows.filter { $0.sessionId == sessionId }
        if matches.count == 1 { return matches[0].captureId }
        return ""
    }

    private func fillAck(_ reply: NSMutableDictionary) {
        var ack = 0
        var capture = ""
        var session = ""
        var ready = false
        var sealed = false
        queue.sync {
            ack = self.ackByte
            capture = self.captureId
            session = self.sessionId
            ready = !capture.isEmpty && self.store.isReady(captureId: capture)
            sealed = self.store.isSealed() && self.drainLastByte >= 0 && self.ackByte >= self.drainLastByte
        }
        reply["ackByte"] = ack
        reply["captureId"] = capture
        reply["sessionId"] = session
        reply["pcmReady"] = ready
        reply["pcmSealed"] = sealed
    }

    @discardableResult
    func ingestLive(data: Data, captureId: String, sessionId: String, offset: Int) -> String {
        var result = "stale-capture"
        queue.sync {
            result = self.ingestLocked(
                data: data,
                captureId: captureId,
                sessionId: sessionId,
                offset: offset
            )
        }
        pump()
        return result
    }

    @discardableResult
    func ingestFile(src: URL, captureId: String, sessionId: String, offset: Int) -> Bool {
        guard !captureId.isEmpty, let data = try? Data(contentsOf: src), !data.isEmpty else { return false }
        var ok = true
        queue.sync {
            let decision = self.ingestLocked(
                data: data,
                captureId: captureId,
                sessionId: sessionId,
                offset: offset
            )
            ok = decision != "stale-capture" && decision != "stale-session" && decision != "persist-failed" && decision != "session-ended"
        }
        pump()
        return ok
    }

    func pump() {
        queue.async { [weak self] in
            self?.pumpLocked()
        }
    }

    private func ingestLocked(
        data: Data,
        captureId: String,
        sessionId: String,
        offset: Int
    ) -> String {
        if rejected { return "session-ended" }
        if captureId.isEmpty { return "stale-capture" }
        let decision = store.persist(
            data: data,
            captureId: captureId,
            sessionId: sessionId,
            offset: offset
        )
        if decision == "persist-failed" {
            return decision
        }
        if decision == "stale-capture" || decision == "stale-session" || decision == "duplicate" {
            ackByte = store.currentHeldByte()
            return decision
        }
        if self.captureId.isEmpty { self.captureId = captureId }
        if self.sessionId.isEmpty, !sessionId.isEmpty { self.sessionId = sessionId }
        ackByte = store.currentHeldByte()
        postHeldLocked()
        maybeSealLocked()
        maybeRequestPcmEndLocked()
        return decision
    }

    private func markUploadedLocked(_ n: Int, captureId: String, sessionId: String) {
        guard n > 0 else { return }
        if !captureId.isEmpty, !self.captureId.isEmpty, captureId != self.captureId { return }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return }
        uploadByte = min(ackByte, uploadByte + n)
    }

    private func beginDrainLocked(lastByte: Int, captureId: String, sessionId: String) {
        guard !rejected else { return }
        if !self.captureId.isEmpty, !captureId.isEmpty, captureId != self.captureId { return }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return }
        drainLastByte = lastByte
        drainCapture = captureId.isEmpty ? self.captureId : captureId
        drainSession = sessionId.isEmpty ? self.sessionId : sessionId
        pcmEndSent = false
        maybeSealLocked()
        AudioUplink.shared.flushTail()
        pumpLocked()
        maybeRequestPcmEndLocked()
        postHeldLocked()
    }

    private func maybeSealLocked() {
        guard drainLastByte >= 0, !drainCapture.isEmpty else { return }
        _ = store.seal(lastByte: drainLastByte, captureId: drainCapture, sessionId: drainSession)
        ackByte = store.currentHeldByte()
    }

    private func maybeRequestPcmEndLocked() {
        guard !rejected, !pcmEndSent, drainLastByte >= 0, !drainSession.isEmpty, !drainCapture.isEmpty else { return }
        if !drainCapture.isEmpty, drainCapture != captureId { return }
        guard ackByte >= drainLastByte else { return }
        pcmEndSent = true
        AudioUplink.shared.requestPcmEnd(sessionId: drainSession, byteOffset: drainLastByte, captureId: drainCapture)
    }

    private func pumpLocked() {
        guard !rejected, !pumping else { return }
        pumping = true
        defer { pumping = false }
        while ackByte > uploadByte {
            if AudioUplink.shared.queuedBytes() >= 2 * 1024 * 1024 { break }
            guard let chunk = store.read(from: uploadByte, maxBytes: Self.frameBytes), !chunk.isEmpty else { break }
            if !AudioUplink.shared.tryEnqueue(chunk) { break }
            uploadByte += chunk.count
        }
        maybeRequestPcmEndLocked()
    }

    private func postHeldLocked() {
        let ack = ackByte
        let capture = captureId
        let session = sessionId
        let sealed = store.isSealed() && drainLastByte >= 0 && ackByte >= drainLastByte
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .nodWatchPcmHeld,
                object: nil,
                userInfo: [
                    "ackByte": ack,
                    "captureId": capture,
                    "sessionId": session,
                    "sealed": sealed,
                ]
            )
        }
    }

    static func decision(
        liveCapture: String,
        liveSession: String,
        incomingCapture: String,
        incomingSession: String,
        nextByte: Int,
        offset: Int,
        bytes: Int
    ) -> String {
        if incomingCapture.isEmpty { return "stale-capture" }
        if !liveCapture.isEmpty, incomingCapture != liveCapture { return "stale-capture" }
        if !incomingSession.isEmpty, !liveSession.isEmpty, incomingSession != liveSession {
            return "stale-session"
        }
        if bytes <= 0 { return "duplicate" }
        let end = offset + bytes
        if end <= nextByte { return "duplicate" }
        if offset > nextByte { return "future" }
        if offset < nextByte { return "overlap" }
        return "accept"
    }
}
