import Foundation

/// Phone-side durable Watch capture. The contiguous prefix on disk is the only
/// ack the Watch may trust. Cloud upload reads from this file and must not be
/// the delete/ack signal.
final class PhonePcmStore {
    static let shared = PhonePcmStore()
    static let diskLimit = 256 * 1024 * 1024
    #if PCM_REPLAY_TESTING
    static var testingDiskLimit: Int?
    #endif
    static let sampleRate = 16_000
    /// 16 kHz PCM16 mono ≈ 2.2 hours at the cap — phone holds the original so
    /// Watch memory can stay a few seconds of unacked retry, not an archive.
    static let bytesPerSec = 16_000 * 2

    private var diskCap: Int {
        #if PCM_REPLAY_TESTING
        return Self.testingDiskLimit ?? Self.diskLimit
        #else
        return Self.diskLimit
        #endif
    }

    struct CaptureInfo: Equatable {
        let captureId: String
        let sessionId: String
        let bytes: Int
        let sealed: Bool
        let modifiedAt: Date
        let intent: String
        /// #196: the mode this capture was recorded in (may be "" for captures
        /// written before this field existed). An empty mode is NOT "meeting".
        let mode: String
    }

    private let fm = FileManager.default
    private let rootOverride: URL?
    #if PCM_REPLAY_TESTING
    static var testingRoot: URL?
    #endif
    private let lock = NSLock()
    private var captureId = ""
    private var sessionId = ""
    private var heldByte = 0
    private var lastByte = 0
    private var sealed = false
    private var intent = "none"
    /// #196: recorded mode of the LIVE capture, persisted in its manifest so the
    /// History list can tell a Translate capture from a Meeting one.
    private var mode = ""
    private var handle: FileHandle?
    private var diskFull = false

    init(rootURL: URL? = nil) {
        self.rootOverride = rootURL
        recoverLocked()
    }

    private var root: URL {
        if let rootOverride { return rootOverride }
        #if PCM_REPLAY_TESTING
        if let testingRoot = Self.testingRoot { return testingRoot }
        #endif
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base.appendingPathComponent("nod-phone-pcm", isDirectory: true)
    }

    func currentCaptureId() -> String {
        lock.lock(); defer { lock.unlock() }
        return captureId
    }

    func currentSessionId() -> String {
        lock.lock(); defer { lock.unlock() }
        return sessionId
    }

    func currentHeldByte() -> Int {
        lock.lock(); defer { lock.unlock() }
        return heldByte
    }

    func isSealed() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return sealed
    }

    func isDiskFull() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return diskFull
    }

    func isReady(captureId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !captureId.isEmpty, captureId == self.captureId else { return false }
        return fm.fileExists(atPath: pcmURL(captureId).path)
    }

    @discardableResult
    func begin(captureId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        closeHandleLocked()
        if !self.captureId.isEmpty, self.captureId != captureId, !sealed {
            writeManifestLocked()
        }
        return openLocked(captureId: captureId)
    }

    private func openLocked(captureId: String) -> Bool {
        self.captureId = captureId
        sessionId = ""
        heldByte = 0
        lastByte = 0
        sealed = false
        intent = "none"
        mode = ""
        diskFull = usedBytesOnDisk() >= diskCap
        guard !captureId.isEmpty else { return false }
        try? fm.createDirectory(at: captureDir(captureId), withIntermediateDirectories: true)
        let url = pcmURL(captureId)
        if !fm.fileExists(atPath: url.path) {
            guard fm.createFile(atPath: url.path, contents: nil) else {
                diskFull = true
                return false
            }
        }
        do {
            handle = try FileHandle(forWritingTo: url)
            try handle?.seekToEnd()
            heldByte = Int(handle?.offsetInFile ?? 0)
        } catch {
            diskFull = true
            return false
        }
        writeManifestLocked()
        return true
    }

    func bindSession(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard !id.isEmpty else { return }
        sessionId = id
        writeManifestLocked()
    }

    /// #196: record the mode of the live capture. Empty is ignored (unknown stays
    /// unknown), so a later blank status cannot wipe a known mode.
    func bindMode(_ value: String) {
        lock.lock(); defer { lock.unlock() }
        guard !value.isEmpty else { return }
        mode = value
        writeManifestLocked()
    }

    /// Persist in-order bytes. Future chunks are parked as sidecar files.
    /// Duplicate / stale identities do not write. Returns the ingest decision.
    func persist(
        data: Data,
        captureId: String,
        sessionId: String,
        offset: Int
    ) -> String {
        lock.lock(); defer { lock.unlock() }
        if captureId.isEmpty { return "stale-capture" }
        if self.captureId.isEmpty {
            guard openLocked(captureId: captureId) else { return "persist-failed" }
            if !sessionId.isEmpty { self.sessionId = sessionId }
        }
        if captureId != self.captureId { return "stale-capture" }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId {
            return "stale-session"
        }
        if !sessionId.isEmpty, self.sessionId.isEmpty { self.sessionId = sessionId }
        if data.isEmpty { return "duplicate" }
        if diskFull || usedBytesOnDisk() + data.count > diskCap {
            diskFull = true
            return "persist-failed"
        }
        let end = offset + data.count
        if end <= heldByte { return "duplicate" }
        if offset > heldByte {
            guard parkLocked(data: data, offset: offset) else { return "persist-failed" }
            return "future"
        }
        let overlap = offset < heldByte
        let slice: Data
        if overlap {
            let skip = min(data.count, heldByte - offset)
            slice = data.subdata(in: skip ..< data.count)
        } else {
            slice = data
        }
        guard writeLocked(slice) else { return "persist-failed" }
        drainParkedLocked()
        writeManifestLocked()
        return overlap ? "overlap" : "accept"
    }

    func seal(lastByte: Int, captureId: String, sessionId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if captureId.isEmpty || captureId != self.captureId { return false }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return false }
        self.lastByte = lastByte
        drainParkedLocked()
        guard heldByte >= lastByte else {
            writeManifestLocked()
            return false
        }
        sealed = true
        try? handle?.synchronize()
        writeManifestLocked()
        return true
    }

    func markIntent(_ value: String, captureId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let id = captureId
        guard !id.isEmpty else { return false }
        let dir = captureDir(id)
        guard fm.fileExists(atPath: dir.path) else { return false }
        if id == self.captureId {
            intent = value
            return writeManifestLocked()
        }
        var meta = readManifest(id)
        meta["intent"] = value
        if meta["captureId"] == nil { meta["captureId"] = id }
        guard let data = try? JSONSerialization.data(withJSONObject: meta) else { return false }
        do {
            try data.write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    func read(from offset: Int, maxBytes: Int) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard !captureId.isEmpty, maxBytes > 0, offset < heldByte else { return Data() }
        let url = pcmURL(captureId)
        guard let reader = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? reader.close() }
        do {
            try reader.seek(toOffset: UInt64(offset))
            let want = min(maxBytes, heldByte - offset)
            return try reader.read(upToCount: want) ?? Data()
        } catch {
            return nil
        }
    }

    func listCaptures() -> [CaptureInfo] {
        lock.lock()
        let live = captureId
        lock.unlock()
        var out: [CaptureInfo] = []
        guard let dirs = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: []
        ) else { return [] }
        for dir in dirs {
            let id = dir.lastPathComponent
            let pcm = dir.appendingPathComponent("audio.pcm")
            let size = (try? fm.attributesOfItem(atPath: pcm.path)[.size] as? Int) ?? 0
            guard size > 0 || id == live else { continue }
            let meta = readManifest(id)
            let modified = (try? dir.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            out.append(CaptureInfo(
                captureId: id,
                sessionId: meta["sessionId"] as? String ?? "",
                bytes: size,
                sealed: (meta["sealed"] as? Bool) ?? false,
                modifiedAt: modified,
                intent: meta["intent"] as? String ?? "none",
                mode: meta["mode"] as? String ?? ""
            ))
        }
        return out.sorted { $0.modifiedAt > $1.modifiedAt }
    }

    /// Explicit user delete of a finished/abandoned capture. Never deletes the
    /// unique live original while it is still the current unsealed capture.
    func deleteCapture(_ id: String, force: Bool = false) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard !id.isEmpty else { return 0 }
        if id == captureId, !sealed, !force { return 0 }
        let dir = captureDir(id)
        let pcm = pcmURL(id)
        let size = (try? fm.attributesOfItem(atPath: pcm.path)[.size] as? Int) ?? 0
        do {
            try fm.removeItem(at: dir)
        } catch {
            return 0
        }
        if id == captureId {
            closeHandleLocked()
            captureId = ""
            sessionId = ""
            heldByte = 0
            lastByte = 0
            sealed = false
        }
        return size
    }

    func resetLive() {
        lock.lock(); defer { lock.unlock() }
        closeHandleLocked()
        captureId = ""
        sessionId = ""
        heldByte = 0
        lastByte = 0
        sealed = false
        intent = "none"
        diskFull = false
    }

    private func recoverLocked() {
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        guard let dirs = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: []
        ), let newest = dirs.max(by: { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return da < db
        }) else { return }
        let id = newest.lastPathComponent
        let url = pcmURL(id)
        guard fm.fileExists(atPath: url.path) else { return }
        let meta = readManifest(id)
        captureId = id
        sessionId = meta["sessionId"] as? String ?? ""
        sealed = (meta["sealed"] as? Bool) ?? false
        intent = meta["intent"] as? String ?? "none"
        // #196: a restart mid-capture must not lose the recorded mode (legacy
        // manifests have none → "" stays unknown).
        mode = meta["mode"] as? String ?? ""
        lastByte = (meta["lastByte"] as? Int) ?? 0
        do {
            handle = try FileHandle(forWritingTo: url)
            try handle?.seekToEnd()
            heldByte = Int(handle?.offsetInFile ?? 0)
        } catch {
            heldByte = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        }
        if lastByte < heldByte { lastByte = heldByte }
        diskFull = usedBytesOnDisk() >= diskCap
    }

    private func writeLocked(_ data: Data) -> Bool {
        guard !data.isEmpty else { return true }
        if handle == nil {
            guard !captureId.isEmpty else { return false }
            let url = pcmURL(captureId)
            if !fm.fileExists(atPath: url.path) {
                guard fm.createFile(atPath: url.path, contents: nil) else { return false }
            }
            do {
                handle = try FileHandle(forWritingTo: url)
                try handle?.seekToEnd()
            } catch {
                return false
            }
        }
        do {
            try handle?.seek(toOffset: UInt64(heldByte))
            try handle?.write(contentsOf: data)
            try handle?.synchronize()
            heldByte += data.count
            if lastByte < heldByte { lastByte = heldByte }
            return true
        } catch {
            diskFull = true
            return false
        }
    }

    private func parkLocked(data: Data, offset: Int) -> Bool {
        guard !captureId.isEmpty else { return false }
        let url = captureDir(captureId).appendingPathComponent("\(offset).part")
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            diskFull = true
            return false
        }
    }

    private func drainParkedLocked() {
        guard !captureId.isEmpty else { return }
        let dir = captureDir(captureId)
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        let parts: [(Int, URL)] = names.compactMap { name in
            guard name.hasSuffix(".part") else { return nil }
            let stem = name.replacingOccurrences(of: ".part", with: "")
            guard let offset = Int(stem) else { return nil }
            return (offset, dir.appendingPathComponent(name))
        }.sorted { $0.0 < $1.0 }
        for (offset, url) in parts {
            if offset > heldByte { break }
            guard let data = try? Data(contentsOf: url), !data.isEmpty else {
                try? fm.removeItem(at: url)
                continue
            }
            let end = offset + data.count
            if end <= heldByte {
                try? fm.removeItem(at: url)
                continue
            }
            let slice: Data
            if offset < heldByte {
                slice = data.subdata(in: (heldByte - offset) ..< data.count)
            } else {
                slice = data
            }
            if writeLocked(slice) {
                try? fm.removeItem(at: url)
            } else {
                return
            }
        }
    }

    @discardableResult
    private func writeManifestLocked() -> Bool {
        guard !captureId.isEmpty else { return false }
        let body: [String: Any] = [
            "captureId": captureId,
            "sessionId": sessionId,
            "heldByte": heldByte,
            "lastByte": lastByte,
            "sealed": sealed,
            "intent": intent,
            // #196: the mode the capture was recorded in ("" when unknown).
            "mode": mode,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return false }
        do {
            try data.write(to: captureDir(captureId).appendingPathComponent("manifest.json"), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private func readManifest(_ id: String) -> [String: Any] {
        let url = captureDir(id).appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return obj
    }

    private func closeHandleLocked() {
        try? handle?.synchronize()
        try? handle?.close()
        handle = nil
    }

    private func captureDir(_ id: String) -> URL {
        root.appendingPathComponent(id, isDirectory: true)
    }

    private func pcmURL(_ id: String) -> URL {
        captureDir(id).appendingPathComponent("audio.pcm")
    }

    private func usedBytesOnDisk() -> Int {
        var total = 0
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey], options: []) else {
            return 0
        }
        for dir in dirs {
            if let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey]) {
                for f in files {
                    if let n = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                        total += n
                    }
                }
            }
        }
        return total
    }
}
