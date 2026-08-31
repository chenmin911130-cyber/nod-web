import AVFoundation
import Combine
import Foundation
import WatchConnectivity

final class WatchPhoneSession: NSObject, ObservableObject, WCSessionDelegate {
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

    private var speechPlayer: AVAudioPlayer?

    struct WatchHistItem: Identifiable, Equatable {
        let id: String
        let title: String
        let text: String
    }

    private var pendingPcm = Data()
    private var liveStreamed = false
    private let maxPending = 8 * 1024 * 1024

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
        pendingPcm.removeAll(keepingCapacity: true)
        liveStreamed = false
        elapsedMs = 0
        send(action: "record")
        setSpeechLive(true)
        beginMic(hint: "Recording · Pause anytime, Done for report")
    }

    func pause() {
        guard WatchRecorder.shared.isRunning || listening else { return }
        if let startedAt {
            elapsedMs = Date().timeIntervalSince(startedAt)
        }
        WatchRecorder.shared.stop()
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
        setSpeechLive(true)
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
        listening = false
        startedAt = nil
        elapsedMs = 0
        WatchGlanceStore.clear()
        hint = "Ready"
        send(action: "stop")
        flushUnsent()
        pendingPcm.removeAll()
        liveStreamed = false
    }

    private func startRecording() {
        pendingPcm.removeAll(keepingCapacity: true)
        liveStreamed = false
        elapsedMs = 0
        send(action: "start")
        setSpeechLive(true)
        beginMic(hint: reachable ? "Watch mic" : "Recording on Watch")
    }

    private func beginMic(hint: String, resetClock: Bool = true) {
        WatchRecorder.shared.start { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
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
            }
        }
    }

    private func forwardPcm(_ data: Data) {
        if pendingPcm.count < maxPending {
            pendingPcm.append(data)
        }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        liveStreamed = true
        session.sendMessage(["pcm": data.base64EncodedString()], replyHandler: nil, errorHandler: nil)
    }

    private func flushUnsent() {
        guard !liveStreamed, !pendingPcm.isEmpty else { return }
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("nod-watch.pcm")
        do {
            try pendingPcm.write(to: url, options: .atomic)
            WCSession.default.transferFile(url, metadata: ["kind": "pcm16", "sr": "16000"])
        } catch {
            WCSession.default.transferUserInfo(["pcm": pendingPcm.base64EncodedString()])
        }
    }

    func send(action: String) {
        let payload = ["action": action]
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.isReachable {
            session.sendMessage(payload, replyHandler: { [weak self] reply in
                DispatchQueue.main.async { self?.apply(reply) }
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

    private func apply(_ payload: [String: Any]) {
        if let hint = payload["hint"] as? String, !hint.isEmpty, !paused {
            self.hint = hint
        }
        if let original = payload["original"] as? String {
            self.original = original
        }
        if let translation = payload["translation"] as? String {
            self.translation = translation
        }
        if let speech = payload["speech"] as? String, let data = Data(base64Encoded: speech), !data.isEmpty {
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
            if self.listening {
                self.hint = session.isReachable ? "Watch mic" : "Recording on Watch"
            } else if self.paused {
                self.hint = "Paused"
            }
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async { self.apply(message) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.apply(applicationContext) }
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let data = try? Data(contentsOf: file.fileURL), !data.isEmpty else { return }
        let kind = (file.metadata?["kind"] as? String) ?? ""
        DispatchQueue.main.async {
            if kind == "speech" {
                self.playSpeech(data)
            }
        }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
}
