import Foundation

extension Notification.Name {
    static let nodWatchPcmBind = Notification.Name("nod.watch.pcm.bind")
    static let nodWatchPcmReset = Notification.Name("nod.watch.pcm.reset")
    static let nodWatchPcmLive = Notification.Name("nod.watch.pcm.live")
    static let nodWatchPcmFile = Notification.Name("nod.watch.pcm.file")
    static let nodWatchPcmAck = Notification.Name("nod.watch.pcm.ack")
}

/// Phone ingest of Watch PCM. Persist first, then stream into AudioUplink with backpressure.
final class WatchPcmIngest {
    static let shared = WatchPcmIngest()

    static let frameBytes = 3200

    private let queue = DispatchQueue(label: "nod.watch.ingest")
    private let fm = FileManager.default
    private var nextByte = 0
    private var captureId = ""
    private var sessionId = ""
    private(set) var ackByte = 0
    private var parked: [(offset: Int, url: URL, key: String)] = []
    private var pumping = false
    private var drainLastByte = -1
    private var drainCapture = ""
    private var drainSession = ""
    private var pcmEndSent = false
    private var observers: [NSObjectProtocol] = []

    private var inboundRoot: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base.appendingPathComponent("nod-watch-in", isDirectory: true)
    }

    private init() {
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
            let seq = (note.userInfo?["seq"] as? Int) ?? Int(note.userInfo?["seq"] as? String ?? "") ?? 0
            let offset = (note.userInfo?["byteOffset"] as? Int)
                ?? Int(note.userInfo?["byteOffset"] as? String ?? "") ?? 0
            let ok = self.ingestFile(src: url, captureId: capture, sessionId: session, seq: seq, offset: offset)
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
                var ack = 0
                var capture = ""
                var session = ""
                self?.queue.sync {
                    ack = self?.ackByte ?? 0
                    capture = self?.captureId ?? ""
                    session = self?.sessionId ?? ""
                }
                reply["ackByte"] = ack
                reply["captureId"] = capture
                reply["sessionId"] = session
            }
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
                self?.markSentLocked(n, captureId: capture, sessionId: session)
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
                self.nextByte = 0
                self.parked.removeAll()
                self.ackByte = 0
                self.drainLastByte = -1
                self.drainCapture = ""
                self.drainSession = ""
                self.pcmEndSent = false
            }
            if !captureId.isEmpty { self.captureId = captureId }
            if !sessionId.isEmpty { self.sessionId = sessionId }
            self.maybeRequestPcmEndLocked()
        }
    }

    func reset() {
        queue.sync { [weak self] in
            guard let self else { return }
            self.nextByte = 0
            self.captureId = ""
            self.sessionId = ""
            self.ackByte = 0
            self.parked.removeAll()
            self.drainLastByte = -1
            self.drainCapture = ""
            self.drainSession = ""
            self.pcmEndSent = false
        }
    }

    func currentAck() -> Int {
        var n = 0
        queue.sync { n = self.ackByte }
        return n
    }

    private func fillAck(_ reply: NSMutableDictionary) {
        var ack = 0
        var capture = ""
        var session = ""
        queue.sync {
            ack = self.ackByte
            capture = self.captureId
            session = self.sessionId
        }
        reply["ackByte"] = ack
        reply["captureId"] = capture
        reply["sessionId"] = session
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
        return result
    }

    @discardableResult
    func ingestFile(src: URL, captureId: String, sessionId: String, seq: Int, offset: Int) -> Bool {
        guard !captureId.isEmpty else { return false }
        try? fm.createDirectory(at: inboundRoot, withIntermediateDirectories: true)
        let dest = inboundRoot.appendingPathComponent("\(captureId)-\(seq)-\(UUID().uuidString).pcm")
        do {
            if fm.fileExists(atPath: dest.path) {
                try fm.removeItem(at: dest)
            }
            try fm.copyItem(at: src, to: dest)
        } catch {
            return false
        }
        var ok = true
        queue.sync {
            let size = (try? self.fm.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0
            let decision = Self.decision(
                liveCapture: self.captureId,
                liveSession: self.sessionId,
                incomingCapture: captureId,
                incomingSession: sessionId,
                nextByte: self.nextByte,
                offset: offset,
                bytes: size
            )
            if decision == "stale-capture" || decision == "stale-session" || decision == "duplicate" {
                try? self.fm.removeItem(at: dest)
                ok = true
                return
            }
            if self.captureId.isEmpty {
                try? self.fm.removeItem(at: dest)
                ok = false
                return
            }
            self.parked.append((offset: offset, url: dest, key: "\(captureId):\(offset)"))
            self.parked.sort { $0.offset < $1.offset }
            self.pumpLocked()
        }
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
        if captureId.isEmpty { return "stale-capture" }
        let decision = Self.decision(
            liveCapture: self.captureId,
            liveSession: self.sessionId,
            incomingCapture: captureId,
            incomingSession: sessionId,
            nextByte: nextByte,
            offset: offset,
            bytes: data.count
        )
        if decision == "stale-capture" || decision == "stale-session" || decision == "duplicate" {
            return decision
        }
        if self.captureId.isEmpty { self.captureId = captureId }
        if self.sessionId.isEmpty, !sessionId.isEmpty { self.sessionId = sessionId }
        if decision == "future" { return decision }
        let slice: Data
        if offset < nextByte {
            let skip = min(data.count, nextByte - offset)
            slice = data.subdata(in: skip ..< data.count)
        } else {
            slice = data
        }
        feed(slice)
        return decision
    }

    private func feed(_ data: Data) {
        var offset = 0
        while offset < data.count {
            let end = min(offset + Self.frameBytes, data.count)
            let frame = data.subdata(in: offset ..< end)
            if !AudioUplink.shared.tryEnqueue(frame) {
                return
            }
            nextByte += frame.count
            offset = end
        }
    }

    private func markSentLocked(_ n: Int, captureId: String, sessionId: String) {
        guard n > 0 else { return }
        if !captureId.isEmpty, !self.captureId.isEmpty, captureId != self.captureId { return }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return }
        ackByte = min(nextByte, ackByte + n)
    }

    private func beginDrainLocked(lastByte: Int, captureId: String, sessionId: String) {
        if !self.captureId.isEmpty, !captureId.isEmpty, captureId != self.captureId { return }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return }
        drainLastByte = lastByte
        drainCapture = captureId.isEmpty ? self.captureId : captureId
        drainSession = sessionId.isEmpty ? self.sessionId : sessionId
        pcmEndSent = false
        AudioUplink.shared.flushTail()
        pumpLocked()
        maybeRequestPcmEndLocked()
    }

    private func maybeRequestPcmEndLocked() {
        guard !pcmEndSent, drainLastByte >= 0, !drainSession.isEmpty, !drainCapture.isEmpty else { return }
        if !drainCapture.isEmpty, drainCapture != captureId { return }
        guard nextByte >= drainLastByte else { return }
        pcmEndSent = true
        AudioUplink.shared.requestPcmEnd(sessionId: drainSession, byteOffset: drainLastByte, captureId: drainCapture)
    }

    private func pumpLocked() {
        guard !pumping else { return }
        pumping = true
        defer { pumping = false }
        while let head = parked.first {
            if AudioUplink.shared.queuedBytes() >= 2 * 1024 * 1024 { break }
            if head.offset > nextByte { break }
            parked.removeFirst()
            if head.offset + fileSize(head.url) <= nextByte {
                try? fm.removeItem(at: head.url)
                continue
            }
            if !streamFile(head.url, fileOffset: head.offset) {
                break
            }
        }
        maybeRequestPcmEndLocked()
    }

    /// Returns false when the uplink is full so the caller must leave the pump.
    private func streamFile(_ url: URL, fileOffset: Int) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return true }
        defer { try? handle.close() }
        let skip = max(0, nextByte - fileOffset)
        do { try handle.seek(toOffset: UInt64(skip)) } catch { return true }
        while true {
            let chunk: Data
            do {
                chunk = try handle.read(upToCount: Self.frameBytes) ?? Data()
            } catch {
                return true
            }
            if chunk.isEmpty {
                try? fm.removeItem(at: url)
                return true
            }
            if !AudioUplink.shared.tryEnqueue(chunk) {
                parked.append((offset: fileOffset, url: url, key: url.lastPathComponent))
                parked.sort { $0.offset < $1.offset }
                return false
            }
            nextByte += chunk.count
        }
    }

    private func fileSize(_ url: URL) -> Int {
        (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
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
