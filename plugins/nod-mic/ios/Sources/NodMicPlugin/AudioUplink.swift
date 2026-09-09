import Foundation

extension Notification.Name {
    static let nodUplinkState = Notification.Name("nod.uplink.state")
}

/// Native PCM WebSocket so lock-screen capture does not go through WKWebView JS.
final class AudioUplink: NSObject, URLSessionWebSocketDelegate {
    static let shared = AudioUplink()

    private let queue = DispatchQueue(label: "nod.audio.uplink")
    private let lock = NSLock()
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
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var pingTimer: DispatchSourceTimer?
    private var flushWork: DispatchWorkItem?
    private var pumpWork: DispatchWorkItem?
    private var sending = false
    private var lastSendAt: TimeInterval = 0
    private var watchObserver: NSObjectProtocol?
    private var startCompletions: [(Error?) -> Void] = []
    private var startTimeoutWork: DispatchWorkItem?

    /// 16 kHz PCM16 mono. Must match `server/stt_audio.py`.
    private let sampleBytesPerSec = 16_000 * 2
    private let minChunkBytes = 1600 // 50 ms — AssemblyAI 3007 floor
    private let frameBytes = 3200 // 100 ms
    private let maxPendingBytes = 2 * 1024 * 1024
    private var lastSentAudioSeconds: TimeInterval = 0

    private override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        watchObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm"),
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let data = note.userInfo?["data"] as? Data, !data.isEmpty else { return }
            self?.enqueue(data)
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
            self.lastSendAt = 0
            self.lastSentAudioSeconds = 0
            self.stopPing()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setConnected(false)
            self.setEnabled(false)
            self.stash.removeAll(keepingCapacity: false)
            self.pending.removeAll(keepingCapacity: false)
            self.pendingBytes = 0
        }
    }

    func enqueue(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [weak self] in
            self?.append(data)
        }
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
        lastSendAt = 0
        lastSentAudioSeconds = 0
        stopPing()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        setConnected(false)
        setEnabled(false)
        stash.removeAll(keepingCapacity: false)
        pending.removeAll(keepingCapacity: false)
        pendingBytes = 0
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

    private func append(_ data: Data) {
        stash.append(data)
        while stash.count >= frameBytes {
            let frame = Data(stash.prefix(frameBytes))
            stash.removeSubrange(0 ..< frameBytes)
            sendOrBuffer(frame)
        }
        scheduleFlush()
    }

    private func scheduleFlush() {
        flushWork?.cancel()
        // Hold tails shorter than 50 ms. Sending them is AssemblyAI 3007.
        guard stash.count >= minChunkBytes else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.stash.count >= self.minChunkBytes else { return }
            let frame = self.stash
            self.stash = Data()
            self.sendOrBuffer(frame)
        }
        flushWork = work
        queue.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private func sendOrBuffer(_ frame: Data) {
        guard !frame.isEmpty else { return }
        buffer(frame)
        pump()
    }

    private func buffer(_ frame: Data) {
        pending.append(frame)
        pendingBytes += frame.count
        while pendingBytes > maxPendingBytes, let oldest = pending.first {
            pending.removeFirst()
            pendingBytes -= oldest.count
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
        guard !sending, pumpWork == nil else { return }
        guard isConnected, !pending.isEmpty, !stopped else { return }
        let elapsed = Date.timeIntervalSinceReferenceDate - lastSendAt
        let wait = lastSendAt == 0 ? 0 : max(0, lastSentAudioSeconds - elapsed)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pumpWork = nil
            self.sendHead()
        }
        pumpWork = work
        queue.asyncAfter(deadline: .now() + wait, execute: work)
    }

    private func sendHead() {
        guard !sending else { return }
        guard isConnected, let task, let queued = pending.first, !stopped else { return }
        let frame = sendableFrame(queued)
        sending = true
        task.send(.data(frame)) { [weak self] error in
            guard let self else { return }
            self.queue.async {
                self.sending = false
                if error != nil {
                    self.handleDrop()
                    return
                }
                if self.pending.first == queued {
                    self.pending.removeFirst()
                    self.pendingBytes -= queued.count
                }
                self.lastSendAt = Date.timeIntervalSinceReferenceDate
                self.lastSentAudioSeconds = self.audioSeconds(frame)
                self.pump()
            }
        }
    }

    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.task === task, !self.stopped else { return }
                switch result {
                case .failure:
                    self.handleDrop()
                case .success:
                    self.listen(task)
                }
            }
        }
    }

    private func handleDrop() {
        guard !stopped else { return }
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
            task.send(.string("{\"type\":\"ping\"}")) { _ in }
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
        guard error != nil else { return }
        queue.async { [weak self] in
            guard let self, task === self.task else { return }
            self.handleDrop()
        }
    }
}
