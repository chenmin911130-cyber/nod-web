import Foundation

/// Watch live PCM is memory-only. 4 seconds of 16 kHz PCM16 (128 KiB) covers a
/// brief WatchConnectivity glitch; it is not an offline archive. Full or
/// unreachable → pause. Never drop-oldest.
final class WatchSendBuffer {
    static let limitBytes = 128_000
    static let limitSeconds = 4
    static let bytesPerSec = 16_000 * 2

    struct Frame {
        let offset: Int
        let data: Data
    }

    private(set) var captureId = ""
    private(set) var sessionId = ""
    private(set) var generation = 0
    private(set) var nextOffset = 0
    private(set) var lastByte = 0
    private(set) var ackedByte = 0
    private(set) var frozen = false
    private var frames: [Frame] = []
    private let lock = NSLock()

    var unackedBytes: Int {
        lock.lock(); defer { lock.unlock() }
        return max(0, lastByte - ackedByte)
    }

    func beginCapture() {
        lock.lock()
        generation += 1
        captureId = UUID().uuidString
        sessionId = ""
        nextOffset = 0
        lastByte = 0
        ackedByte = 0
        frozen = false
        frames.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    func bindSession(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard !id.isEmpty else { return }
        sessionId = id
    }

    func discardCapture() {
        lock.lock()
        generation += 1
        captureId = ""
        sessionId = ""
        nextOffset = 0
        lastByte = 0
        ackedByte = 0
        frozen = false
        frames.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    func freeze() {
        lock.lock()
        frozen = true
        lastByte = nextOffset
        lock.unlock()
    }

    /// Append. Nil means the bound is full or the capture is closed — caller pauses.
    func append(_ data: Data) -> Int? {
        lock.lock(); defer { lock.unlock() }
        guard !data.isEmpty, !frozen, !captureId.isEmpty else { return nil }
        if lastByte - ackedByte + data.count > Self.limitBytes {
            return nil
        }
        let offset = nextOffset
        frames.append(Frame(offset: offset, data: data))
        nextOffset += data.count
        lastByte = nextOffset
        return offset
    }

    func ack(_ byte: Int, captureId: String, sessionId: String) {
        lock.lock(); defer { lock.unlock() }
        if captureId.isEmpty || captureId != self.captureId { return }
        if !sessionId.isEmpty, !self.sessionId.isEmpty, sessionId != self.sessionId { return }
        if byte > ackedByte { ackedByte = byte }
        frames.removeAll { $0.offset + $0.data.count <= ackedByte }
    }

    func unackedFrames() -> [Frame] {
        lock.lock(); defer { lock.unlock() }
        return frames.filter { $0.offset + $0.data.count > ackedByte }
    }

    func snapshot() -> (captureId: String, sessionId: String, lastByte: Int, ackedByte: Int, frozen: Bool, generation: Int) {
        lock.lock(); defer { lock.unlock() }
        return (captureId, sessionId, lastByte, ackedByte, frozen, generation)
    }
}
