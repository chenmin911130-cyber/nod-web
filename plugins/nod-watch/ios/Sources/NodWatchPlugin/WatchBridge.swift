import AVFoundation
import Foundation
import WatchConnectivity

/// Phone-side WatchConnectivity. Watch mic PCM is forwarded to JS; start/stop
/// are queued until the workspace is ready so consent / start_listen stay intact.
public final class WatchBridge: NSObject, WCSessionDelegate, AVAudioPlayerDelegate {
    public static let shared = WatchBridge()

    weak var plugin: NodWatchPlugin?
    private(set) var jsReady = false
    private var pending: [(action: String, at: Double?, live: Bool, mode: String)] = []
    private var pendingPcm: [String] = []
    private var lastCapture = ""
    private var lastHint = "Ready"
    private var lastOriginal = ""
    private var lastTranslation = ""
    private var lastPrevious = ""
    private var lastHistory: [[String: String]] = []
    private var lastMode = ""
    private var lastLangPair = ""
    private var speechPlayer: AVAudioPlayer?
    private var speechFinish: ((Error?) -> Void)?
    private var uplinkActive = false
    private var uplinkObserver: NSObjectProtocol?

    override private init() {
        super.init()
        uplinkObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.uplink.state"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.uplinkActive = (note.userInfo?["enabled"] as? Bool)
                ?? (note.userInfo?["active"] as? Bool)
                ?? false
        }
    }

    public func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate == nil {
            session.delegate = self
        }
        if session.activationState != .activated {
            session.activate()
        }
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory
        )
    }

    func markJsReady() {
        jsReady = true
        let queued = pending
        pending.removeAll()
        let now = Date().timeIntervalSince1970
        for item in queued {
            if Self.shouldRunWatchCommand(item.action, at: item.at, live: item.live, now: now) {
                emit(item.action, mode: item.mode)
            }
        }
        let pcm = pendingPcm
        pendingPcm.removeAll()
        for chunk in pcm {
            plugin?.notifyListeners("pcm", data: ["data": chunk])
        }
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory
        )
    }

    public func pushStatus(
        capture: String,
        hint: String,
        original: String = "",
        translation: String = "",
        previous: String = "",
        history: [[String: String]] = [],
        mode: String = "",
        langPair: String = ""
    ) {
        if !capture.isEmpty {
            lastCapture = capture
        }
        lastHint = hint
        lastOriginal = original
        lastTranslation = translation
        lastPrevious = previous
        lastHistory = history
        if !mode.isEmpty {
            lastMode = mode
        }
        if !langPair.isEmpty {
            lastLangPair = langPair
        }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        var payload: [String: Any] = [
            "capture": lastCapture,
            "hint": hint,
            "original": original,
            "translation": translation,
            "previous": previous,
            "history": history,
        ]
        if !lastMode.isEmpty {
            payload["mode"] = lastMode
        }
        if !lastLangPair.isEmpty {
            payload["langPair"] = lastLangPair
        }
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        do {
            try session.updateApplicationContext(payload)
        } catch {
            /* watch may be locked / unreachable */
        }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        }
    }

    static func watchListenMode(_ raw: String) -> String {
        let value = raw.lowercased()
        return ["meeting", "lecture", "interview", "translate"].contains(value) ? value : ""
    }

    /// Live sendMessage is a Watch tap. Queued leftovers need a fresh `at`.
    static func shouldRunWatchCommand(_ action: String, at: Double?, live: Bool, now: Double) -> Bool {
        let listenCtl = action == "start" || action == "stop" || action == "record" || action == "pause" || action == "resume"
        if !listenCtl { return true }
        if live { return true }
        guard let at else { return false }
        return now - at <= 30
    }

    private func handle(_ message: [String: Any], live: Bool) {
        if let pcm = message["pcm"] as? String, !pcm.isEmpty {
            emitPcm(pcm)
        }
        let raw = (message["action"] as? String ?? "").lowercased()
        let allowed = ["stop", "start", "record", "pause", "resume", "speak", "save", "discard", "tts_live", "tts_tap", "tts_female", "tts_male"]
        let action = allowed.contains(raw) ? raw : ""
        guard !action.isEmpty else { return }
        let mode = Self.watchListenMode(message["mode"] as? String ?? "")
        let at = message["at"] as? Double
        let now = Date().timeIntervalSince1970
        guard Self.shouldRunWatchCommand(action, at: at, live: live, now: now) else { return }
        if jsReady {
            emit(action, mode: mode)
        } else {
            pending.append((action, at, live, mode))
        }
    }

    func stopSpeechPlayback() {
        DispatchQueue.main.async {
            self.speechPlayer?.stop()
            self.speechPlayer = nil
            self.restoreListenSession()
            self.speechFinish?(nil)
            self.speechFinish = nil
        }
    }

    func playSpeech(_ data: Data, dest: String = "phone", finished: ((Error?) -> Void)? = nil) {
        if dest == "watch" {
            sendSpeechToWatch(data)
            DispatchQueue.main.async { finished?(nil) }
            return
        }
        DispatchQueue.main.async {
            self.playLocal(data, finished: finished)
        }
    }

    private func sendSpeechToWatch(_ data: Data) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.isReachable, data.count <= 50_000 {
            session.sendMessage(["speechData": data], replyHandler: nil, errorHandler: { _ in
                Self.transferSpeech(data, session: session)
            })
            return
        }
        Self.transferSpeech(data, session: session)
    }

    private static func transferSpeech(_ data: Data, session: WCSession) {
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nod-watch-speech.mp3")
        do {
            try data.write(to: url, options: .atomic)
            session.transferFile(url, metadata: [
                "kind": "speech",
                "at": String(Date().timeIntervalSince1970),
            ])
        } catch {
            /* Watch play is best-effort; phone still speaks locally. */
        }
    }

    private func playLocal(_ data: Data, finished: ((Error?) -> Void)?) {
        speechFinish?(nil)
        speechFinish = finished
        do {
            try routeSpeechOutput()
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("nod-play.mp3")
            try data.write(to: url, options: .atomic)
            let player = try AVAudioPlayer(contentsOf: url, fileTypeHint: AVFileType.mp3.rawValue)
            player.delegate = self
            player.volume = 1
            player.prepareToPlay()
            guard player.duration > 0.05 else {
                throw NSError(domain: "NodWatch", code: 3, userInfo: [NSLocalizedDescriptionKey: "Empty speech audio"])
            }
            speechPlayer = player
            guard player.play() else {
                throw NSError(domain: "NodWatch", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not start playback"])
            }
        } catch {
            restoreListenSession()
            speechFinish?(error)
            speechFinish = nil
        }
    }

    /// Media playback ignores the silent switch and uses the loudspeaker.
    /// playAndRecord + mixWithOthers was sending TTS to the earpiece.
    private func routeSpeechOutput() throws {
        let session = AVAudioSession.sharedInstance()
        let wired = session.currentRoute.outputs.contains { $0.portType == .headphones }
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        if !wired {
            try? session.overrideOutputAudioPort(.speaker)
        }
    }

    private func restoreListenSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.defaultToSpeaker]
        )
        try? session.setActive(true)
        if let builtin = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtin)
        }
        try? session.overrideOutputAudioPort(.speaker)
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        if speechPlayer === player {
            restoreListenSession()
            speechFinish?(nil)
            speechFinish = nil
            speechPlayer = nil
        }
    }

    private func emit(_ action: String, mode: String = "") {
        var data: [String: Any] = ["action": action]
        if !mode.isEmpty {
            data["mode"] = mode
        }
        plugin?.notifyListeners("command", data: data)
    }

    private func emitPcm(_ data: String) {
        if uplinkActive, let raw = Data(base64Encoded: data), !raw.isEmpty {
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm"),
                object: nil,
                userInfo: ["data": raw]
            )
            return
        }
        if jsReady {
            plugin?.notifyListeners("pcm", data: ["data": data])
            return
        }
        pendingPcm.append(data)
        if pendingPcm.count > 80 {
            pendingPcm.removeFirst(pendingPcm.count - 80)
        }
    }

    private func emitPcmData(_ data: Data) {
        if uplinkActive {
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm"),
                object: nil,
                userInfo: ["data": data]
            )
            return
        }
        let chunk = 3200
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunk, data.count)
            emitPcm(data.subdata(in: offset ..< end).base64EncodedString())
            offset = end
        }
    }

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated {
            pushStatus(
                capture: lastCapture,
                hint: lastHint,
                original: lastOriginal,
                translation: lastTranslation,
                previous: lastPrevious,
                history: lastHistory
            )
        }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handle(message, live: true)
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        handle(message, live: true)
        var reply: [String: Any] = ["ok": true, "capture": lastCapture, "hint": lastHint]
        if !lastMode.isEmpty {
            reply["mode"] = lastMode
        }
        if !lastLangPair.isEmpty {
            reply["langPair"] = lastLangPair
        }
        replyHandler(reply)
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        handle(userInfo, live: false)
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        handle(applicationContext, live: false)
    }

    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let data = try? Data(contentsOf: file.fileURL), !data.isEmpty else { return }
        // Leftover PCM files must not start_listen. Watch already sent start/record live.
        emitPcmData(data)
    }
}
