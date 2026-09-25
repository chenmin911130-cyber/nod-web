import Foundation

/// Phone → server send clock. Cumulative mode is never re-anchored on send completion.
struct UplinkPacer {
    enum Mode: String { case cumulative, legacy }
    var mode: Mode = .cumulative
    var catchupRate: Double = 1.0
    var coalesceMax: Int = 1
    let slack: TimeInterval = 0.3
    private(set) var nextSendAt: TimeInterval = 0

    mutating func reset() { nextSendAt = 0 }

    func waitBeforeSend(now: TimeInterval) -> TimeInterval {
        nextSendAt <= 0 ? 0 : max(0, nextSendAt - now)
    }

    func framesForMessage(pendingFrames: Int) -> Int {
        guard pendingFrames > 0 else { return 0 }
        guard mode == .cumulative, pendingFrames >= 2 else { return 1 }
        return min(pendingFrames, max(1, coalesceMax))
    }

    mutating func noteSendStarted(now: TimeInterval, audioSeconds: TimeInterval, pendingFramesBefore: Int) {
        guard mode == .cumulative else { return }
        let base = nextSendAt <= 0 ? now : max(nextSendAt, now - slack)
        let rate = pendingFramesBefore >= 2 ? max(1.0, catchupRate) : 1.0
        nextSendAt = base + audioSeconds / rate
    }

    mutating func noteSendCompleted(now: TimeInterval, audioSeconds: TimeInterval) {
        guard mode == .legacy else { return }
        nextSendAt = now + audioSeconds
    }

    mutating func apply(config obj: [String: Any]) {
        if let p = obj["pace"] as? String, let m = Mode(rawValue: p) { mode = m }
        if let r = (obj["catchup_rate"] as? NSNumber)?.doubleValue { catchupRate = max(1.0, min(2.0, r)) }
        if let c = (obj["coalesce_max"] as? NSNumber)?.intValue { coalesceMax = max(1, min(10, c)) }
    }

    #if PCM_REPLAY_TESTING
    mutating func testingSetNextSendAt(_ t: TimeInterval) { nextSendAt = t }
    #endif
}

extension Notification.Name {
    static let nodUplinkState = Notification.Name("nod.uplink.state")
}

/// Native PCM WebSocket so lock-screen capture does not go through WKWebView JS.
final class AudioUplink: NSObject, URLSessionWebSocketDelegate {
    static let shared = AudioUplink()

    private let queue = DispatchQueue(label: "nod.audio.uplink")
    private let lock = NSLock()
    private let bufLock = NSLock()
    private var _enabled = false
    private var _connected = false

    /// Uplink mode is on (`start` until `stop` / 4404). PCM stays native even while reconnecting.
    var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _enabled
    }

    /// Socket is open. Used only for send vs buffer.
    private var isConnected: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _connected
    }

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var stopped = true
    private var stash = Data()
    private var pending: [Data] = []
    private var pendingBytes = 0
    private var acceptingPcm = true // under bufLock
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var pingTimer: DispatchSourceTimer?
    private var flushWork: DispatchWorkItem?
    private var pumpWork: DispatchWorkItem?
    private var sending = false
    private var pacer = UplinkPacer()
    private var watchObserver: NSObjectProtocol?
    private var startCompletions: [(Error?) -> Void] = []
    private var startTimeoutWork: DispatchWorkItem?

    /// 16 kHz PCM16 mono. Must match `server/stt_audio.py`.
    private let sampleBytesPerSec = 16_000 * 2
    private let minChunkBytes = 1600 // 50 ms — AssemblyAI 3007 floor
    private let frameBytes = 3200 // 100 ms
    private let maxPendingBytes = 2 * 1024 * 1024
    private var enqueuedBytes = 0
    private var sentBytes = 0
    private var droppedBytes = 0
    private var pcmEndId = ""
    private var pcmEndOffset = 0
    private var pcmEndCapture = ""
    private var streamCaptureId = ""
    private var streamSessionId = ""

    private override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        _ = WatchPcmIngest.shared
        watchObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm"),
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let data = note.userInfo?["data"] as? Data, !data.isEmpty else { return }
            self?.enqueue(data)
        }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm.bind"),
            object: nil,
            queue: nil
        ) { [weak self] note in
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let session = note.userInfo?["sessionId"] as? String ?? ""
            self?.queue.async {
                if !capture.isEmpty, capture != self?.streamCaptureId {
                    self?.pcmEndId = ""
                    self?.pcmEndCapture = ""
                    self?.pcmEndOffset = 0
                }
                if !capture.isEmpty { self?.streamCaptureId = capture }
                if !session.isEmpty { self?.streamSessionId = session }
            }
        }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm.reset"),
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.queue.async {
                self?.streamCaptureId = ""
                self?.streamSessionId = ""
                self?.pcmEndId = ""
                self?.pcmEndCapture = ""
                self?.pcmEndOffset = 0
            }
        }
    }

    func start(url: URL, completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            if self.url == url, self.isEnabled, !self.stopped {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            if self.url == url, !self.stopped, !self.startCompletions.isEmpty {
                self.startCompletions.append(completion)
                return
            }
            if !self.startCompletions.isEmpty {
                self.finishStart(
                    NSError(
                        domain: "NodMic",
                        code: 4,
                        userInfo: [NSLocalizedDescriptionKey: "Audio uplink restarted"]
                    )
                )
            }
            self.url = url
            self.bufLock.lock()
            self.acceptingPcm = true
            self.resetByteCountersLocked()
            self.bufLock.unlock()
            self.stopped = false
            self.reconnectAttempt = 0
            self.startCompletions = [completion]
            self.open()
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.startCompletions.isEmpty else { return }
                self.failInitialConnect()
                self.finishStart(
                    NSError(
                        domain: "NodMic",
                        code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "Audio uplink did not connect"]
                    )
                )
            }
            self.startTimeoutWork = work
            self.queue.asyncAfter(deadline: .now() + 8, execute: work)
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            if !self.startCompletions.isEmpty {
                self.finishStart(
                    NSError(
                        domain: "NodMic",
                        code: 5,
                        userInfo: [NSLocalizedDescriptionKey: "Audio uplink stopped"]
                    )
                )
            }
            self.stopped = true
            self.reconnectWork?.cancel()
            self.reconnectWork = nil
            self.flushWork?.cancel()
            self.flushWork = nil
            self.pumpWork?.cancel()
            self.pumpWork = nil
            self.sending = false
            self.pacer = UplinkPacer()
            self.stopPing()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setConnected(false)
            self.setEnabled(false)
            self.bufLock.lock()
            self.stash.removeAll(keepingCapacity: false)
            self.pending.removeAll(keepingCapacity: false)
            self.pendingBytes = 0
            self.resetByteCountersLocked()
            self.bufLock.unlock()
            self.pcmEndId = ""
            self.pcmEndCapture = ""
            self.pcmEndOffset = 0
        }
    }

    func enqueue(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [weak self] in
            guard let self else { return }
            self.bufLock.lock()
            guard self.acceptingPcm else { self.bufLock.unlock(); return }
            self.append(data, dropOldest: true)
            self.bufLock.unlock()
            self.pump()
        }
    }

    /// Watch replay: refuse the chunk instead of dropping older frames.
    /// Uses bufLock only — must not wait on the uplink serial queue (ingest holds its own).
    func tryEnqueue(_ data: Data) -> Bool {
        guard !data.isEmpty else { return true }
        bufLock.lock()
        let ok = acceptingPcm && pendingBytes + stash.count + data.count <= maxPendingBytes
        if ok {
            append(data, dropOldest: false)
        }
        bufLock.unlock()
        if ok {
            queue.async { [weak self] in self?.pump() }
        }
        return ok
    }

    func queuedBytes() -> Int {
        bufLock.lock()
        let n = pendingBytes + stash.count
        bufLock.unlock()
        return n
    }

    func flushTail() {
        queue.async { [weak self] in
            self?.flushTailLocked()
            self?.pump()
        }
    }

    func requestPcmEnd(sessionId: String, byteOffset: Int, captureId: String) {
        queue.async { [weak self] in
            guard let self else { return }
            self.pcmEndId = sessionId
            self.pcmEndCapture = captureId
            self.pcmEndOffset = byteOffset
            if !captureId.isEmpty { self.streamCaptureId = captureId }
            if !sessionId.isEmpty { self.streamSessionId = sessionId }
            self.flushTailLocked()
            self.pump()
        }
    }

    private func flushTailLocked() {
        bufLock.lock()
        if !stash.isEmpty {
            let frame = stash
            stash = Data()
            pending.append(frame)
            pendingBytes += frame.count
        }
        bufLock.unlock()
    }

    private func finishStart(_ error: Error?) {
        startTimeoutWork?.cancel()
        startTimeoutWork = nil
        let cbs = startCompletions
        startCompletions = []
        guard !cbs.isEmpty else { return }
        DispatchQueue.main.async {
            for cb in cbs { cb(error) }
        }
    }

    private func failInitialConnect() {
        stopped = true
        reconnectWork?.cancel()
        reconnectWork = nil
        flushWork?.cancel()
        flushWork = nil
        pumpWork?.cancel()
        pumpWork = nil
        sending = false
        pacer.reset()
        stopPing()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        setConnected(false)
        setEnabled(false)
        bufLock.lock()
        stash.removeAll(keepingCapacity: false)
        pending.removeAll(keepingCapacity: false)
        pendingBytes = 0
        resetByteCountersLocked()
        bufLock.unlock()
        pcmEndId = ""
        pcmEndCapture = ""
        pcmEndOffset = 0
    }

    private func setEnabled(_ on: Bool) {
        lock.lock()
        let changed = _enabled != on
        _enabled = on
        lock.unlock()
        guard changed else { return }
        NotificationCenter.default.post(
            name: .nodUplinkState,
            object: nil,
            userInfo: ["enabled": on, "active": on]
        )
    }

    private func setConnected(_ on: Bool) {
        lock.lock()
        _connected = on
        lock.unlock()
    }

    private func open() {
        pacer.reset()
        reconnectWork?.cancel()
        reconnectWork = nil
        stopPing()
        task?.cancel(with: .goingAway, reason: nil)
        guard let url, !stopped else { return }
        let next = session.webSocketTask(with: url)
        task = next
        next.resume()
        listen(next)
    }

    private func append(_ data: Data, dropOldest: Bool) {
        enqueuedBytes += data.count
        stash.append(data)
        while stash.count >= frameBytes {
            let frame = Data(stash.prefix(frameBytes))
            stash.removeSubrange(0 ..< frameBytes)
            buffer(frame, dropOldest: dropOldest)
        }
        scheduleFlush()
    }

    private func scheduleFlush() {
        flushWork?.cancel()
        guard stash.count >= minChunkBytes else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.bufLock.lock()
            guard self.stash.count >= self.minChunkBytes else {
                self.bufLock.unlock()
                return
            }
            let frame = self.stash
            self.stash = Data()
            self.buffer(frame, dropOldest: true)
            self.bufLock.unlock()
            self.pump()
        }
        flushWork = work
        queue.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private func buffer(_ frame: Data, dropOldest: Bool) {
        if !dropOldest, pendingBytes + frame.count > maxPendingBytes {
            return
        }
        pending.append(frame)
        pendingBytes += frame.count
        if dropOldest {
            while pendingBytes > maxPendingBytes, let oldest = pending.first {
                pending.removeFirst()
                pendingBytes -= oldest.count
                droppedBytes += oldest.count
            }
        }
    }

    private func audioSeconds(_ data: Data) -> TimeInterval {
        TimeInterval(data.count) / TimeInterval(sampleBytesPerSec)
    }

    private func sendableFrame(_ frame: Data) -> Data {
        guard frame.count < minChunkBytes else { return frame }
        var padded = frame
        padded.append(Data(count: minChunkBytes - frame.count))
        return padded
    }

    private func pump() {
        guard !sending, pumpWork == nil, isConnected, !stopped else { return }
        bufLock.lock()
        let hasPending = !pending.isEmpty
        bufLock.unlock()
        if !hasPending {
            sendPcmEndIfIdle()
            return
        }
        let wait = pacer.waitBeforeSend(now: uptime())
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pumpWork = nil
            self.sendHead()
        }
        pumpWork = work
        queue.asyncAfter(deadline: .now() + wait, execute: work)
    }

    private func sendPcmEndIfIdle() {
        guard !pcmEndId.isEmpty, !pcmEndCapture.isEmpty, isConnected, let task, !stopped, !sending else { return }
        bufLock.lock()
        let idle = pending.isEmpty && stash.isEmpty
        bufLock.unlock()
        guard idle else { return }
        let payload: [String: Any] = [
            "type": "pcm_end",
            "id": pcmEndId,
            "capture_id": pcmEndCapture,
            "byte_offset": pcmEndOffset,
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8)
        else { return }
        sending = true
        task.send(.string(text)) { [weak self] error in
            guard let self else { return }
            self.queue.async {
                if error == nil {
                    self.pcmEndId = ""
                    self.pcmEndCapture = ""
                    self.pcmEndOffset = 0
                }
                self.sending = false
                if error != nil {
                    self.sendPcmEndIfIdle()
                }
            }
        }
    }

    private func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func resetByteCountersLocked() {
        enqueuedBytes = 0
        sentBytes = 0
        droppedBytes = 0
    }

    private func sendHead() {
        guard !sending else { return }
        guard isConnected, let task, !stopped else { return }
        bufLock.lock()
        let before = pending.count
        let n = pacer.framesForMessage(pendingFrames: before)
        if n == 0 {
            bufLock.unlock()
            sendPcmEndIfIdle()
            return
        }
        let batch = Array(pending.prefix(n))
        bufLock.unlock()
        var joined = Data()
        for piece in batch { joined.append(piece) }
        let frame = sendableFrame(joined)
        let consumeCapture = streamCaptureId
        let consumeSession = streamSessionId
        let batchBytes = batch.reduce(0) { $0 + $1.count }
        pacer.noteSendStarted(now: uptime(), audioSeconds: audioSeconds(frame), pendingFramesBefore: before)
        sending = true
        task.send(.data(frame)) { [weak self] error in
            guard let self else { return }
            self.queue.async {
                self.sending = false
                if error != nil {
                    self.handleDrop()
                    return
                }
                self.bufLock.lock()
                for piece in batch {
                    if self.pending.first == piece {
                        self.pending.removeFirst()
                        self.pendingBytes -= piece.count
                    }
                }
                self.sentBytes += batchBytes
                self.bufLock.unlock()
                self.pacer.noteSendCompleted(now: self.uptime(), audioSeconds: self.audioSeconds(frame))
                NotificationCenter.default.post(
                    name: Notification.Name("nod.uplink.consumed"),
                    object: nil,
                    userInfo: [
                        "bytes": batchBytes,
                        "captureId": consumeCapture,
                        "sessionId": consumeSession,
                    ]
                )
                self.pump()
            }
        }
    }

    #if PCM_REPLAY_TESTING
    var pacerForTesting: UplinkPacer { pacer }
    #endif

    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.task === task, !self.stopped else { return }
                switch result {
                case .failure:
                    self.handleDrop()
                case .success(let message):
                    if case .string(let text) = message {
                        self.handleAudioText(text)
                    }
                    self.listen(task)
                }
            }
        }
    }

    func handleAudioText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        switch obj["type"] as? String {
        case "pcm_drained":
            let id = obj["id"] as? String ?? ""
            let capture = obj["capture_id"] as? String ?? obj["captureId"] as? String ?? ""
            let offset: Int
            if let n = obj["byte_offset"] as? Int {
                offset = n
            } else if let n = obj["byte_offset"] as? Double {
                offset = Int(n)
            } else {
                offset = Int(obj["byte_offset"] as? String ?? "") ?? 0
            }
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.serverDrained"),
                object: nil,
                userInfo: ["sessionId": id, "captureId": capture, "byteOffset": offset]
            )
        case "pcm_stall":
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.serverStalled"),
                object: nil,
                userInfo: [
                    "sessionId": obj["id"] as? String ?? "",
                    "text": obj["text"] as? String ?? "",
                ]
            )
        case "pcm_rejected":
            let sid = obj["id"] as? String ?? ""
            let wireCapture = obj["capture_id"] as? String ?? obj["captureId"] as? String ?? ""
            guard !sid.isEmpty, sid == streamSessionId, !streamCaptureId.isEmpty,
                  wireCapture.isEmpty || wireCapture == streamCaptureId else { return }
            // Raw PCM has no capture header. A session-wide rejection on this
            // bound socket applies to its current capture; never relabel a
            // rejection that already carries a different capture.
            let capture = wireCapture.isEmpty ? streamCaptureId : wireCapture
            stopped = true
            reconnectWork?.cancel()
            flushWork?.cancel()
            pumpWork?.cancel()
            stopPing()
            bufLock.lock()
            acceptingPcm = false
            pending.removeAll()
            pendingBytes = 0
            stash.removeAll()
            bufLock.unlock()
            WatchPcmIngest.shared.reject(sessionId: sid, captureId: capture)
            // Keep enabled=true: a dead native rail must not fall back to JS.
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.serverRejected"),
                object: nil,
                userInfo: ["sessionId": sid, "captureId": capture,
                           "reason": obj["reason"] as? String ?? "session_ended",
                           "text": obj["text"] as? String ?? ""]
            )
        case "watch_copy":
            NotificationCenter.default.post(
                name: Notification.Name("nod.uplink.watchCopy"),
                object: nil,
                userInfo: obj
            )
        case "uplink_config":
            pacer.apply(config: obj)
        case "qa_copy":
            // Live Q&A has its own server message type but the SAME Watch copy lane:
            // the bridge keeps one current copy (question -> original, answer ->
            // translation), so a locked phone keeps streaming answers without a
            // second, competing copy state on the Watch.
            NotificationCenter.default.post(
                name: Notification.Name("nod.uplink.qaCopy"),
                object: nil,
                userInfo: obj
            )
        default:
            break
        }
    }

    private func handleDrop() {
        guard !stopped else { return }
        pacer.reset()
        sending = false
        pumpWork?.cancel()
        pumpWork = nil
        setConnected(false)
        stopPing()
        if task != nil {
            task?.cancel(with: .goingAway, reason: nil)
            task = nil
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !stopped, url != nil else { return }
        reconnectWork?.cancel()
        let delay = min(30.0, pow(2.0, Double(reconnectAttempt)))
        reconnectAttempt = min(reconnectAttempt + 1, 5)
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped else { return }
            self.open()
        }
        reconnectWork = work
        queue.asyncAfter(deadline: .now() + max(1.0, delay), execute: work)
    }

    private func startPing() {
        stopPing()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 20, repeating: 20)
        timer.setEventHandler { [weak self] in
            guard let self, let task = self.task, self.isConnected, !self.stopped else { return }
            self.bufLock.lock()
            let pendingMs = (self.pendingBytes + self.stash.count) / 32
            let enqueuedMs = self.enqueuedBytes / 32
            let sentMs = self.sentBytes / 32
            let droppedMs = self.droppedBytes / 32
            self.bufLock.unlock()
            let payload: [String: Any] = [
                "type": "ping",
                "pending_ms": pendingMs,
                "enqueued_ms": enqueuedMs,
                "sent_ms": sentMs,
                "dropped_ms": droppedMs,
            ]
            guard JSONSerialization.isValidJSONObject(payload),
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let text = String(data: data, encoding: .utf8)
            else { return }
            task.send(.string(text)) { _ in }
        }
        pingTimer = timer
        timer.resume()
    }

    private func stopPing() {
        pingTimer?.cancel()
        pingTimer = nil
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        queue.async { [weak self] in
            guard let self, webSocketTask === self.task else { return }
            self.reconnectAttempt = 0
            self.setConnected(true)
            self.setEnabled(true)
            self.startPing()
            self.pump()
            if !self.startCompletions.isEmpty {
                self.finishStart(nil)
            }
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        queue.async { [weak self] in
            guard let self, webSocketTask === self.task else { return }
            if closeCode.rawValue == 4404 {
                self.pacer.reset()
                self.stopped = true
                self.reconnectWork?.cancel()
                self.reconnectWork = nil
                self.pumpWork?.cancel()
                self.pumpWork = nil
                self.sending = false
                self.stopPing()
                self.task = nil
                self.setConnected(false)
                self.setEnabled(false)
                if !self.startCompletions.isEmpty {
                    self.finishStart(
                        NSError(
                            domain: "NodMic",
                            code: 6,
                            userInfo: [NSLocalizedDescriptionKey: "Listen session ended"]
                        )
                    )
                }
                return
            }
            self.handleDrop()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let http = task.response as? HTTPURLResponse {
            queue.async { [weak self] in
                guard let self, task === self.task else { return }
                if Self.shouldStopOnHandshake(http.statusCode) {
                    self.failHandshake(http.statusCode)
                    return
                }
                if error != nil { self.handleDrop() }
            }
            return
        }
        guard error != nil else { return }
        queue.async { [weak self] in
            guard let self, task === self.task else { return }
            self.handleDrop()
        }
    }

    /// HTTP 4xx on the audio websocket upgrade is a handshake reject, not a
    /// listen-session expiry (that is close code 4404). 403 must not rewind or
    /// relabel the local capture as ended.
    static func shouldStopOnHandshake(_ status: Int) -> Bool {
        status >= 400 && status < 500 && status != 4404
    }

    static func handshakeMeansSessionExpired(_ status: Int) -> Bool {
        false
    }

    func handleHandshakeStatus(_ status: Int) {
        queue.async { [weak self] in
            self?.failHandshake(status)
        }
    }

    private func failHandshake(_ status: Int) {
        pacer.reset()
        stopped = true
        reconnectWork?.cancel()
        reconnectWork = nil
        pumpWork?.cancel()
        pumpWork = nil
        sending = false
        stopPing()
        task = nil
        setConnected(false)
        NotificationCenter.default.post(
            name: Notification.Name("nod.uplink.handshakeFailed"),
            object: nil,
            userInfo: ["status": status]
        )
        if !startCompletions.isEmpty {
            finishStart(
                NSError(
                    domain: "NodMic",
                    code: 7,
                    userInfo: [NSLocalizedDescriptionKey: "Audio uplink handshake failed (\(status))"]
                )
            )
        }
    }
}
