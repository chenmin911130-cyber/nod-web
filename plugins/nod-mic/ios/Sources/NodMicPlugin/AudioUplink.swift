import Foundation

extension Notification.Name {
    static let nodUplinkState = Notification.Name("nod.uplink.state")
}

/// Native PCM WebSocket so lock-screen capture does not go through WKWebView JS.
final class AudioUplink: NSObject, URLSessionWebSocketDelegate {
    static let shared = AudioUplink()

    private let queue = DispatchQueue(label: "nod.audio.uplink")
    private let lock = NSLock()
    private var _active = false
    var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _active
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
    private var watchObserver: NSObjectProtocol?

    private let frameBytes = 3200
    private let maxPendingBytes = 2 * 1024 * 1024

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

    func start(url: URL) {
        queue.async { [weak self] in
            guard let self else { return }
            if self.url == url, self.task != nil, !self.stopped {
                return
            }
            self.url = url
            self.stopped = false
            self.reconnectAttempt = 0
            self.open()
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.reconnectWork?.cancel()
            self.reconnectWork = nil
            self.flushWork?.cancel()
            self.flushWork = nil
            self.stopPing()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setActive(false)
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

    private func setActive(_ on: Bool) {
        lock.lock()
        let changed = _active != on
        _active = on
        lock.unlock()
        guard changed else { return }
        NotificationCenter.default.post(name: .nodUplinkState, object: nil, userInfo: ["active": on])
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
        guard !stash.isEmpty else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stash.isEmpty else { return }
            let frame = self.stash
            self.stash = Data()
            self.sendOrBuffer(frame)
        }
        flushWork = work
        queue.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private func sendOrBuffer(_ frame: Data) {
        guard !frame.isEmpty else { return }
        if let task, isActive {
            task.send(.data(frame)) { [weak self] error in
                guard let self, error != nil else { return }
                self.queue.async {
                    self.buffer(frame)
                    self.handleDrop()
                }
            }
            return
        }
        buffer(frame)
    }

    private func buffer(_ frame: Data) {
        pending.append(frame)
        pendingBytes += frame.count
        while pendingBytes > maxPendingBytes, let oldest = pending.first {
            pending.removeFirst()
            pendingBytes -= oldest.count
        }
    }

    private func flushPending() {
        guard let task, isActive else { return }
        let frames = pending
        pending.removeAll(keepingCapacity: false)
        pendingBytes = 0
        for frame in frames {
            task.send(.data(frame)) { _ in }
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
        setActive(false)
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
            guard let self, let task = self.task, !self.stopped else { return }
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
            self.setActive(true)
            self.startPing()
            self.flushPending()
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
                self.stopPing()
                self.task = nil
                self.setActive(false)
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
