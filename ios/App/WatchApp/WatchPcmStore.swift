import Foundation

/// Watch-side PCM shards. Every capture frame is appended to disk immediately.
final class WatchPcmStore {
    static let shardBytes = 160_000
    static let diskLimit = 32 * 1024 * 1024
    static let sampleRate = 16_000

    private(set) var captureId = ""
    private(set) var sessionId = ""
    private(set) var nextSeq = 1
    private(set) var byteOffset = 0
    private(set) var lastByte = 0
    private(set) var usedBytes = 0
    private(set) var diskFull = false
    private(set) var frozen = false
    private(set) var ackedByte = 0

    private let lock = NSLock()
    private let fm = FileManager.default
    private let rootOverride: URL?

    init(rootURL: URL? = nil) { self.rootOverride = rootURL }
    private var handle: FileHandle?
    private var shardWritten = 0
    private var currentSeq = 0
    private var root: URL {
        if let rootOverride { return rootOverride }
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base.appendingPathComponent("nod-watch-pcm", isDirectory: true)
    }

    struct Shard {
        let seq: Int
        let byteOffset: Int
        let url: URL
        let bytes: Int
    }

    func beginCapture() {
        lock.lock()
        closeHandleLocked()
        // A fresh capture must NOT reset usedBytes to 0: old originals from a prior
        // capture still consume the 32 MiB budget. Recount every shard under the
        // root first (issue #165 review P2-7), so a new Start cannot write past the
        // cap by pretending old files are gone.
        let existing = usedBytesOnDisk()
        captureId = UUID().uuidString
        sessionId = ""
        nextSeq = 1
        currentSeq = 0
        shardWritten = 0
        byteOffset = 0
        lastByte = 0
        frozen = false
        diskFull = existing >= Self.diskLimit
        ackedByte = 0
        usedBytes = existing
        lock.unlock()
        try? fm.createDirectory(at: captureDir(), withIntermediateDirectories: true)
    }

    /// The total bytes of every .pcm shard across ALL captures on disk.
    private func usedBytesOnDisk() -> Int {
        var total = 0
        let rootPath = root
        if let dirs = try? fm.contentsOfDirectory(at: rootPath, includingPropertiesForKeys: [.fileSizeKey], options: []) {
            for url in dirs {
                if let files = try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.fileSizeKey]) {
                    for f in files {
                        if let n = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                            total += n
                        }
                    }
                }
            }
        }
        return total
    }

    func retireCapture() {
        lock.lock()
        defer { lock.unlock() }
        closeHandleLocked()
        frozen = true
        captureId = ""
        sessionId = ""
    }

    func bindSession(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !id.isEmpty else { return }
        sessionId = id
    }

    func discardCapture() {
        lock.lock()
        closeHandleLocked()
        let id = captureId
        captureId = ""
        sessionId = ""
        nextSeq = 1
        currentSeq = 0
        shardWritten = 0
        byteOffset = 0
        lastByte = 0
        frozen = false
        lock.unlock()
        if !id.isEmpty {
            try? fm.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
        }
        refreshUsed()
    }

    /// Append PCM. Returns nil on disk-full / frozen (caller must stop capture).
    func append(_ data: Data) -> (offset: Int, seq: Int)? {
        lock.lock()
        defer { lock.unlock() }
        guard !data.isEmpty, !frozen, !captureId.isEmpty else { return nil }
        if diskFull || usedBytes + data.count > Self.diskLimit {
            diskFull = true
            return nil
        }
        if handle == nil, !openShardLocked() {
            return nil
        }
        do {
            try handle?.write(contentsOf: data)
            try handle?.synchronize()
        } catch {
            diskFull = true
            return nil
        }
        let offset = byteOffset
        let seq = currentSeq
        byteOffset += data.count
        lastByte = byteOffset
        shardWritten += data.count
        usedBytes += data.count
        if shardWritten >= Self.shardBytes {
            closeHandleLocked()
        }
        return (offset, seq)
    }

    func closeShard() {
        lock.lock()
        closeHandleLocked()
        lock.unlock()
    }

    func freeze() {
        lock.lock()
        closeHandleLocked()
        frozen = true
        lastByte = byteOffset
        lock.unlock()
    }

    /// Advance the live-transfer skip cursor. Does not delete shards; socket
    /// send is not STT drain. Retry must still have the original files.
    func ack(_ byte: Int, captureId: String, sessionId: String) {
        lock.lock()
        defer { lock.unlock() }
        if captureId.isEmpty || captureId != self.captureId { return }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return }
        if byte > ackedByte { ackedByte = byte }
    }

    /// Delete sealed shards only after server pcm_drained for this capture.
    func confirmDrained(captureId: String, sessionId: String, through byte: Int) {
        lock.lock()
        if captureId.isEmpty || captureId != self.captureId {
            lock.unlock()
            return
        }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId {
            lock.unlock()
            return
        }
        if byte > ackedByte { ackedByte = byte }
        let id = self.captureId
        let ack = ackedByte
        lock.unlock()
        deleteAckedShards(captureId: id, through: ack)
        refreshUsed()
    }

    func resetAckForRetry() {
        lock.lock()
        ackedByte = 0
        lock.unlock()
    }

    func unackedShards() -> [Shard] {
        lock.lock()
        let id = captureId
        let session = sessionId
        let ack = ackedByte
        let openSeq = handle != nil ? currentSeq : -1
        lock.unlock()
        guard !id.isEmpty else { return [] }
        return shardsOnDisk(captureId: id, sessionId: session)
            .filter { $0.byteOffset + $0.bytes > ack && $0.seq != openSeq }
            .sorted { $0.seq < $1.seq }
    }

    func metadata(for shard: Shard) -> [String: Any] {
        [
            "kind": "pcm16",
            "sr": "16000",
            "captureId": captureId,
            "sessionId": sessionId,
            "seq": String(shard.seq),
            "byteOffset": String(shard.byteOffset),
            "bytes": String(shard.bytes),
        ]
    }

    private func openShardLocked() -> Bool {
        guard handle == nil, !captureId.isEmpty else { return handle != nil }
        currentSeq = nextSeq
        let start = byteOffset
        let url = captureDir().appendingPathComponent("\(currentSeq)_\(start).pcm")
        if !fm.createFile(atPath: url.path, contents: nil) {
            diskFull = true
            return false
        }
        do {
            handle = try FileHandle(forWritingTo: url)
        } catch {
            diskFull = true
            return false
        }
        shardWritten = 0
        writeManifest(seq: nextSeq, start: start)
        return true
    }

    private func closeHandleLocked() {
        guard handle != nil else { return }
        try? handle?.synchronize()
        try? handle?.close()
        handle = nil
        if shardWritten > 0 {
            nextSeq = currentSeq + 1
            shardWritten = 0
        }
    }

    private func captureDir() -> URL {
        root.appendingPathComponent(captureId, isDirectory: true)
    }

    private func writeManifest(seq: Int, start: Int) {
        let body: [String: Any] = [
            "captureId": captureId,
            "sessionId": sessionId,
            "nextSeq": seq,
            "byteOffset": byteOffset,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        try? data.write(to: captureDir().appendingPathComponent("manifest.json"), options: .atomic)
        _ = start
    }

    private func shardsOnDisk(captureId: String, sessionId: String) -> [Shard] {
        _ = sessionId
        let dir = root.appendingPathComponent(captureId, isDirectory: true)
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.compactMap { name -> Shard? in
            guard name.hasSuffix(".pcm") else { return nil }
            let stem = name.replacingOccurrences(of: ".pcm", with: "")
            let parts = stem.split(separator: "_")
            let seq: Int
            let offset: Int
            if parts.count >= 2, let s = Int(parts[0]), let o = Int(parts[1]) {
                seq = s
                offset = o
            } else if let s = Int(stem) {
                seq = s
                offset = (s - 1) * Self.shardBytes
            } else {
                return nil
            }
            guard seq > 0 else { return nil }
            let url = dir.appendingPathComponent(name)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path),
                  let size = attrs[.size] as? Int, size > 0 else { return nil }
            return Shard(seq: seq, byteOffset: offset, url: url, bytes: size)
        }
    }

    private func deleteAckedShards(captureId: String, through ack: Int) {
        guard !captureId.isEmpty else { return }
        lock.lock()
        let openSeq = handle != nil ? currentSeq : -1
        lock.unlock()
        for shard in shardsOnDisk(captureId: captureId, sessionId: "") {
            if openSeq > 0, shard.seq == openSeq { continue }
            if shard.byteOffset + shard.bytes <= ack {
                try? fm.removeItem(at: shard.url)
            }
        }
    }

    private func refreshUsed() {
        lock.lock()
        defer { lock.unlock() }
        usedBytes = usedBytesOnDisk()
    }

    /// Minimal "unfinished recording" management entry (issue #165 review P2-7).
    /// Lists every capture on disk EXCEPT the current one, with a human-readable
    /// size and a modified timestamp so the user can identify an old, unconfirmed
    /// recording before deleting it. A capture is "unfinished" (has a pending
    /// transfer / unconfirmed drain) once any shard file exists; it is never
    /// auto-deleted by a new Start or time expiry here.
    struct CaptureInfo {
        let captureId: String
        let bytes: Int
        let modifiedAt: Date
        let shardCount: Int
    }

    func unfinishedCaptures() -> [CaptureInfo] {
        lock.lock()
        let current = captureId
        lock.unlock()
        var out: [CaptureInfo] = []
        let rootPath = root
        guard let dirs = try? fm.contentsOfDirectory(
            at: rootPath, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey], options: []
        ) else { return [] }
        for url in dirs {
            let name = url.lastPathComponent
            guard name != current, fm.fileExists(atPath: url.path) else { continue }
            guard let files = try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { continue }
            let shards = files.filter { $0.pathExtension == "pcm" }
            guard !shards.isEmpty else { continue }
            var bytes = 0
            for f in shards {
                if let n = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                    bytes += n
                }
            }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            out.append(CaptureInfo(captureId: name, bytes: bytes, modifiedAt: modified, shardCount: shards.count))
        }
        return out
    }

    /// Delete a previously-listed, non-current capture. Never deletes the current
    /// recording (still in progress or awaiting completion), and never deletes a
    /// capture whose shards are still being transferred — the caller must have
    /// drained its in-flight transfers first (issue #165 review P2-7). Returns the
    /// freed bytes.
    func deleteCapture(_ id: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let current = captureId
        guard !id.isEmpty, id != current else { return 0 }
        let dir = root.appendingPathComponent(id, isDirectory: true)
        guard fm.fileExists(atPath: dir.path) else { return 0 }
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var freed = 0
        for f in files where f.pathExtension == "pcm" {
            if let n = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                freed += n
            }
        }
        // Remove the whole capture dir (shards + manifest). If the removal fails we
        // must not report the space as freed — recount below reflects reality.
        do {
            try fm.removeItem(at: dir)
        } catch {
            return 0
        }
        usedBytes = usedBytesOnDisk()
        return freed
    }
}
