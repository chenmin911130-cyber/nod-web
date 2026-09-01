import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

final class WatchPhoneSession: NSObject, ObservableObject, WCSessionDelegate, WKExtendedRuntimeSessionDelegate {
    static let shared = WatchPhoneSession()

    @Published var listening = false
    @Published var paused = false
    @Published var startedAt: Date?
    @Published var elapsedMs: TimeInterval = 0
    @Published var hint = "Watch mic — tap Listen"
    @Published var original = ""
    @Published var translation = ""
    @Published var history: [WatchHistItem] = []
    @Published var reachable = false
    @Published var speechLive = false
    @Published var speechVoice = "female"
    @Published var mode = WatchPhoneSession.storedMode()

    private var speechPlayer: AVAudioPlayer?

    struct WatchHistItem: Identifiable, Equatable {
        let id: String
        let title: String
        let text: String
    }

    private var pendingPcm = Data()
    private var liveStreamed = false
    private let pcmLock = NSLock()
    private let maxPending = 8 * 1024 * 1024
    private var runtime: WKExtendedRuntimeSession?

    override private init() {
        super.init()
        WatchRecorder.shared.onPcm = { [weak self] data in
            self?.forwardPcm(data)
        }
        listenForHostProbe()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Mac can post Darwin `com.nodpilot.watch.probe` to start Listen without a tap.
    private func listenForHostProbe() {
        let name = "com.nodpilot.watch.probe" as CFString
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                let session = Unmanaged<WatchPhoneSession>.fromOpaque(observer).takeUnretainedValue()
                DispatchQueue.main.async { session.startRecording() }
            },
            name,
            nil,
            .deliverImmediately
        )
    }

    private static let modeKey = "nod.watch.listenMode"

    private static func storedMode() -> String {
        let raw = UserDefaults.standard.string(forKey: modeKey) ?? "meeting"
        return ["meeting", "lecture", "interview", "translate"].contains(raw) ? raw : "meeting"
    }

    static func modeLabel(_ id: String) -> String {
        switch id {
        case "lecture": return "Lecture"
        case "interview": return "Live Q&A"
        case "translate": return "Translate"
        default: return "Meeting"
        }
    }

    func setMode(_ next: String) {
        guard ["meeting", "lecture", "interview", "translate"].contains(next) else { return }
        mode = next
        UserDefaults.standard.set(next, forKey: Self.modeKey)
        if !listening, !paused {
            hint = "\(Self.modeLabel(next)) · tap Listen"
        }
    }

    func toggle() {
        if paused {
            resume()
            return
        }
        if WatchRecorder.shared.isRunning {
            pause()
            return
        }
        startRecording()
    }

    func record() {
        if paused {
            resume()
            return
        }
        if WatchRecorder.shared.isRunning {
            return
        }
        resetPcmBuffer()
        elapsedMs = 0
        send(action: "record")
        beginMic(hint: "Recording · Pause anytime, Done for report")
    }

    func pause() {
        guard WatchRecorder.shared.isRunning || listening else { return }
        if let startedAt {
            elapsedMs = Date().timeIntervalSince(startedAt)
        }
        WatchRecorder.shared.stop()
        stopRuntime()
        listening = false
        paused = true
        WatchGlanceStore.setPaused(elapsed: elapsedMs)
        hint = "Paused"
        send(action: "pause")
    }

    func resume() {
        guard paused else { return }
        paused = false
        startedAt = Date().addingTimeInterval(-elapsedMs)
        send(action: "resume")
        beginMic(hint: reachable ? "Watch mic" : "Recording on Watch", resetClock: false)
    }

    func speakCurrent() {
        send(action: "speak")
    }

    func setSpeechLive(_ on: Bool) {
        speechLive = on
        send(action: on ? "tts_live" : "tts_tap")
    }

    func setSpeechVoice(_ voice: String) {
        speechVoice = voice == "male" ? "male" : "female"
        send(action: speechVoice == "male" ? "tts_male" : "tts_female")
    }

    func playSpeech(_ data: Data) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("nod-play.mp3")
            try data.write(to: url, options: .atomic)
            let player = try AVAudioPlayer(contentsOf: url, fileTypeHint: AVFileType.mp3.rawValue)
            player.volume = 1
            player.prepareToPlay()
            speechPlayer = player
            guard player.play() else {
                hint = "Could not play speech"
                return
            }
        } catch {
            hint = "Could not play speech"
        }
    }

    func finish() {
        paused = false
        WatchRecorder.shared.stop()
        stopRuntime()
        listening = false
        startedAt = nil
        elapsedMs = 0
        WatchGlanceStore.clear()
        hint = "Ready"
        send(action: "stop")
        flushUnsent()
        resetPcmBuffer()
    }

    private func startRecording() {
        resetPcmBuffer()
        elapsedMs = 0
        send(action: "start")
        beginMic(hint: reachable ? "Watch mic" : "Recording on Watch")
    }

    private func beginMic(hint: String, resetClock: Bool = true) {
        WatchRecorder.shared.start { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.stopRuntime()
                    self.listening = false
                    self.paused = false
                    self.startedAt = nil
                    WatchGlanceStore.clear()
                    self.hint = error.localizedDescription
                    return
                }
                self.listening = true
                self.paused = false
                if resetClock || self.startedAt == nil {
                    self.startedAt = Date()
                    self.elapsedMs = 0
                }
                WatchGlanceStore.setStartedAt(self.startedAt)
                self.hint = hint
                self.startRuntime()
            }
        }
    }

    static func pcmShouldBuffer(reachable: Bool) -> Bool {
        !reachable
    }

    static func liveStreamShouldReset(listening: Bool, reachable: Bool) -> Bool {
        listening && !reachable
    }

    static func flushShouldSend(pendingBytes: Int) -> Bool {
        pendingBytes > 0
    }

    private func resetPcmBuffer() {
        pcmLock.lock()
        pendingPcm.removeAll(keepingCapacity: true)
        liveStreamed = false
        pcmLock.unlock()
    }

    private func bufferUnsent(_ data: Data) {
        pcmLock.lock()
        liveStreamed = false
        if pendingPcm.count < maxPending {
            pendingPcm.append(data)
        }
        pcmLock.unlock()
    }

    private func takeUnsentPcm() -> Data {
        pcmLock.lock()
        defer { pcmLock.unlock() }
        guard Self.flushShouldSend(pendingBytes: pendingPcm.count) else { return Data() }
        let data = pendingPcm
        pendingPcm.removeAll()
        liveStreamed = false
        return data
    }

    private func forwardPcm(_ data: Data) {
        guard !data.isEmpty else { return }
        let session = WCSession.default
        let reachable = session.activationState == .activated && session.isReachable
        if Self.pcmShouldBuffer(reachable: reachable) {
            bufferUnsent(data)
            return
        }
        pcmLock.lock()
        liveStreamed = true
        pcmLock.unlock()
        session.sendMessage(["pcm": data.base64EncodedString()], replyHandler: nil, errorHandler: { [weak self] _ in
            self?.bufferUnsent(data)
        })
    }

    private func flushUnsent() {
        let data = takeUnsentPcm()
        guard !data.isEmpty else { return }
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("nod-watch.pcm")
        do {
            try data.write(to: url, options: .atomic)
            WCSession.default.transferFile(url, metadata: ["kind": "pcm16", "sr": "16000"])
        } catch {
            WCSession.default.transferUserInfo(["pcm": data.base64EncodedString()])
        }
    }

    private func startRuntime() {
        runtime?.invalidate()
        let session = WKExtendedRuntimeSession()
        session.delegate = self
        session.start()
        runtime = session
    }

    private func stopRuntime() {
        runtime?.invalidate()
        runtime = nil
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}

    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            guard self.listening else { return }
            self.startRuntime()
        }
    }

    func extendedRuntimeSession(
        _ extendedRuntimeSession: WKExtendedRuntimeSession,
        didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason,
        error: Error?
    ) {
        DispatchQueue.main.async {
            if self.runtime === extendedRuntimeSession {
                self.runtime = nil
            }
            guard self.listening, reason == .expired, self.runtime == nil else { return }
            self.startRuntime()
        }
    }

    func send(action: String) {
        var payload: [String: Any] = ["action": action, "at": Date().timeIntervalSince1970]
        if action == "start" || action == "record" {
            payload["mode"] = mode
        }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.isReachable {
            session.sendMessage(payload, replyHandler: { [weak self] reply in
                DispatchQueue.main.async { self?.apply(reply, live: false) }
            }, errorHandler: { _ in
                session.transferUserInfo(payload)
            })
            return
        }
        session.transferUserInfo(payload)
        DispatchQueue.main.async {
            if self.listening {
                self.hint = "Recording on Watch"
            } else if self.paused {
                self.hint = "Paused"
            } else {
                self.hint = "Waking iPhone…"
            }
        }
    }

    /// Leftover file / application context must not play when the Watch app opens.
    static func speechShouldPlay(live: Bool) -> Bool {
        live
    }

    private func apply(_ payload: [String: Any], live: Bool) {
        if let hint = payload["hint"] as? String, !hint.isEmpty, !paused {
            self.hint = hint
        }
        if let original = payload["original"] as? String {
            self.original = original
        }
        if let translation = payload["translation"] as? String {
            self.translation = translation
        }
        if Self.speechShouldPlay(live: live),
           let speech = payload["speech"] as? String,
           let data = Data(base64Encoded: speech),
           !data.isEmpty {
            playSpeech(data)
        }
        if let rows = payload["history"] as? [Any] {
            self.history = rows.compactMap { row in
                guard let row = row as? [String: Any] else { return nil }
                let id = (row["id"] as? String) ?? ""
                let title = (row["title"] as? String) ?? ""
                let text = (row["text"] as? String) ?? ""
                guard !id.isEmpty, !text.isEmpty || !title.isEmpty else { return nil }
                return WatchHistItem(id: id, title: title, text: text)
            }
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if activationState != .activated {
                self.hint = "Open Nod on iPhone once"
            }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if Self.liveStreamShouldReset(listening: self.listening, reachable: session.isReachable) {
                self.pcmLock.lock()
                self.liveStreamed = false
                self.pcmLock.unlock()
            }
            if self.listening {
                self.hint = session.isReachable ? "Watch mic" : "Recording on Watch"
            } else if self.paused {
                self.hint = "Paused"
            }
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async { self.apply(message, live: true) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.apply(applicationContext, live: false) }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        DispatchQueue.main.async { self.apply(userInfo, live: false) }
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // Leftover speech files are delivered on Watch launch. Never auto-play.
        guard (file.metadata?["kind"] as? String) == "speech" else { return }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
}
