import Foundation

/// Watch-side PCM shards. Memory is a working buffer; disk is the source of truth.
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

    private var current = Data()
    private let lock = NSLock()
    private let fm = FileManager.default
    private var root: URL {
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
        defer { lock.unlock() }
        captureId = UUID().uuidString
        sessionId = ""
        nextSeq = 1
        byteOffset = 0
        lastByte = 0
        frozen = false
        diskFull = false
        ackedByte = 0
        current = Data()
        try? fm.createDirectory(at: captureDir(), withIntermediateDirectories: true)
    }

    func bindSession(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !id.isEmpty else { return }
        sessionId = id
    }

    func discardCapture() {
        lock.lock()
        let id = captureId
        captureId = ""
        sessionId = ""
        nextSeq = 1
        byteOffset = 0
        lastByte = 0
        frozen = false
        current = Data()
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
        let offset = byteOffset
        let seq = nextSeq
        current.append(data)
        byteOffset += data.count
        lastByte = byteOffset
        usedBytes += data.count
        if current.count >= Self.shardBytes {
            closeShardLocked()
        }
        return (offset, seq)
    }

    func closeShard() {
        lock.lock()
        closeShardLocked()
        lock.unlock()
    }

    func freeze() {
        lock.lock()
        closeShardLocked()
        frozen = true
        lastByte = byteOffset
        lock.unlock()
    }

    func ack(_ byte: Int) {
        lock.lock()
        if byte > ackedByte { ackedByte = byte }
        let id = captureId
        let ack = ackedByte
        lock.unlock()
        deleteAckedShards(captureId: id, through: ack)
        refreshUsed()
    }

    func unackedShards() -> [Shard] {
        lock.lock()
        let id = captureId
        let session = sessionId
        let ack = ackedByte
        lock.unlock()
        guard !id.isEmpty else { return [] }
        return shardsOnDisk(captureId: id, sessionId: session).filter { $0.byteOffset + $0.bytes > ack }
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

    private func closeShardLocked() {
        guard !current.isEmpty, !captureId.isEmpty else { return }
        let seq = nextSeq
        let start = byteOffset - current.count
        let url = captureDir().appendingPathComponent("\(seq)_\(start).pcm")
        do {
            try current.write(to: url, options: .atomic)
            nextSeq = seq + 1
            current = Data()
            writeManifest(seq: nextSeq, start: start)
        } catch {
            diskFull = true
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
        for shard in shardsOnDisk(captureId: captureId, sessionId: "") {
            if shard.byteOffset + shard.bytes <= ack {
                try? fm.removeItem(at: shard.url)
            }
        }
    }

    private func refreshUsed() {
        lock.lock()
        var total = current.count
        let rootPath = root
        lock.unlock()
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
        lock.lock()
        usedBytes = total
        lock.unlock()
    }
}
