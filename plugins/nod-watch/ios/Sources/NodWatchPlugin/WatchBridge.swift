import AVFoundation
import Foundation
import WatchConnectivity

/// Phone-side WatchConnectivity. Watch mic PCM is forwarded to JS; start/stop
/// are queued until the workspace is ready so consent / start_listen stay intact.
public final class WatchBridge: NSObject, WCSessionDelegate, AVAudioPlayerDelegate {
    public static let shared = WatchBridge()

    weak var plugin: NodWatchPlugin?
    private(set) var jsReady = false
    private var pending: [(action: String, at: Double?, live: Bool, mode: String, sessionId: String)] = []
    private var pendingPcm: [String] = []
    private var lastCapture = ""
    private var lastHint = "Ready"
    private var lastOriginal = ""
    private var lastTranslation = ""
    private var lastPrevious = ""
    private var lastHistory: [[String: String]] = []
    private var lastMode = ""
    private var lastLangPair = ""
    private var lastSave = "none"
    private var lastSessionId = ""
    private var lastPcmAckByte = 0
    private var lastPcmCaptureId = ""
    private var lastPcmAckSessionId = ""
    private var lastPcmDrained = false
    private var lastPcmDrainedCaptureId = ""
    private var lastPcmDrainedSessionId = ""
    private var lastPcmDrainedByte = 0
    private var lastPcmStalled = false
    private var lastPcmStallSessionId = ""
    private var lastPcmStallText = ""
    private var lastPcmRejected = false
    private var lastPcmRejectSessionId = ""
    private var lastPcmRejectCaptureId = ""
    private var lastPcmRejectText = ""
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
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.uplink.consumed"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.pushPcmAck()
        }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm.serverDrained"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            let session = note.userInfo?["sessionId"] as? String ?? ""
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let offset = (note.userInfo?["byteOffset"] as? Int) ?? 0
            self?.markPcmDrained(sessionId: session, captureId: capture, byteOffset: offset)
        }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm.serverStalled"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            let session = note.userInfo?["sessionId"] as? String ?? ""
            let message = note.userInfo?["text"] as? String ?? ""
            self?.markPcmStalled(sessionId: session, text: message)
        }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.watch.pcm.serverRejected"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            let session = note.userInfo?["sessionId"] as? String ?? ""
            let capture = note.userInfo?["captureId"] as? String ?? ""
            let reason = note.userInfo?["reason"] as? String ?? "session_ended"
            let message = note.userInfo?["text"] as? String ?? ""
            self?.markPcmRejected(sessionId: session, captureId: capture, reason: reason, text: message)
        }
    }

    private func pushPcmAck() {
        let reply = NSMutableDictionary()
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.ack"),
            object: nil,
            userInfo: ["reply": reply]
        )
        let ack = reply["ackByte"] as? Int ?? 0
        let capture = reply["captureId"] as? String ?? lastPcmCaptureId
        let session = reply["sessionId"] as? String ?? lastSessionId
        if !capture.isEmpty {
            lastPcmCaptureId = capture
        }
        if !session.isEmpty {
            lastPcmAckSessionId = session
        }
        guard ack != lastPcmAckByte else { return }
        lastPcmAckByte = ack
        guard WCSession.isSupported() else { return }
        let wc = WCSession.default
        guard wc.activationState == .activated, wc.isReachable else { return }
        var msg: [String: Any] = ["pcmAckByte": String(ack), "ok": true]
        if !lastPcmCaptureId.isEmpty {
            msg["pcmAckCaptureId"] = lastPcmCaptureId
        }
        if !lastPcmAckSessionId.isEmpty {
            msg["pcmAckSessionId"] = lastPcmAckSessionId
        }
        wc.sendMessage(msg, replyHandler: nil, errorHandler: nil)
    }

    func markPcmDrained(sessionId: String, captureId: String, byteOffset: Int) {
        guard !captureId.isEmpty, !sessionId.isEmpty, byteOffset >= 0 else { return }
        lastPcmDrained = true
        lastPcmDrainedCaptureId = captureId
        lastPcmDrainedSessionId = sessionId
        lastPcmDrainedByte = byteOffset
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory
        )
    }

    func markPcmStalled(sessionId: String, text: String) {
        if !sessionId.isEmpty {
            lastPcmStallSessionId = sessionId
        }
        lastPcmStallText = text.isEmpty ? "Recording incomplete — audio may be missing" : text
        lastPcmStalled = true
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory
        )
    }

    func markPcmRejected(sessionId: String, captureId: String, reason: String, text: String) {
        lastPcmRejected = true
        if !sessionId.isEmpty {
            lastPcmRejectSessionId = sessionId
        }
        if !captureId.isEmpty {
            lastPcmRejectCaptureId = captureId
        }
        lastPcmRejectText = text.isEmpty ? "会话已结束，补传未完成。" : text
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory
        )
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
                emit(item.action, mode: item.mode, sessionId: item.sessionId)
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
        langPair: String = "",
        save: String = "",
        sessionId: String = ""
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
        if !save.isEmpty {
            lastSave = save
        }
        if !sessionId.isEmpty {
            lastSessionId = sessionId
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.bind"),
                object: nil,
                userInfo: ["captureId": "", "sessionId": sessionId]
            )
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
        payload["save"] = lastSave
        if !lastSessionId.isEmpty {
            payload["sessionId"] = lastSessionId
        }
        payload["pcmAckByte"] = String(lastPcmAckByte)
        if !lastPcmCaptureId.isEmpty {
            payload["pcmAckCaptureId"] = lastPcmCaptureId
        }
        if !lastPcmAckSessionId.isEmpty {
            payload["pcmAckSessionId"] = lastPcmAckSessionId
        } else if !lastSessionId.isEmpty {
            payload["pcmAckSessionId"] = lastSessionId
        }
        payload["pcmDrained"] = lastPcmDrained ? "true" : "false"
        if lastPcmDrained {
            payload["pcmDrainedCaptureId"] = lastPcmDrainedCaptureId
            payload["pcmDrainedSessionId"] = lastPcmDrainedSessionId
            payload["pcmDrainedByte"] = String(lastPcmDrainedByte)
        }
        payload["pcmStalled"] = lastPcmStalled ? "true" : "false"
        if lastPcmStalled {
            if !lastPcmStallSessionId.isEmpty {
                payload["pcmStallSessionId"] = lastPcmStallSessionId
            }
            payload["pcmStallText"] = lastPcmStallText
        }
        payload["pcmRejected"] = lastPcmRejected ? "true" : "false"
        if lastPcmRejected {
            if !lastPcmRejectSessionId.isEmpty {
                payload["pcmRejectSessionId"] = lastPcmRejectSessionId
            }
            if !lastPcmRejectCaptureId.isEmpty {
                payload["pcmRejectCaptureId"] = lastPcmRejectCaptureId
            }
            payload["pcmRejectText"] = lastPcmRejectText
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
        let listenCtl = action == "start" || action == "stop" || action == "record" || action == "pause" || action == "resume" || action == "drain"
        if !listenCtl { return true }
        if live { return true }
        guard let at else { return false }
        return now - at <= 30
    }

    private func handle(_ message: [String: Any], live: Bool) {
        if let pcm = message["pcm"] as? String, !pcm.isEmpty {
            ingestPcmMessage(message, raw: pcm)
        }
        let raw = (message["action"] as? String ?? "").lowercased()
        let allowed = ["stop", "start", "record", "pause", "resume", "speak", "save", "discard", "tts_live", "tts_tap", "tts_female", "tts_male", "drain"]
        let action = allowed.contains(raw) ? raw : ""
        guard !action.isEmpty else { return }
        let mode = Self.watchListenMode(message["mode"] as? String ?? "")
        let sessionId = message["sessionId"] as? String ?? ""
        let captureId = message["captureId"] as? String ?? ""
        let at = message["at"] as? Double
        let now = Date().timeIntervalSince1970
        guard Self.shouldRunWatchCommand(action, at: at, live: live, now: now) else { return }
        if (action == "start" || action == "record"), !captureId.isEmpty {
            if captureId != lastPcmCaptureId {
                lastPcmAckByte = 0
                lastPcmDrained = false
                lastPcmAckSessionId = ""
                lastPcmDrainedCaptureId = ""
                lastPcmDrainedSessionId = ""
                lastPcmDrainedByte = 0
                lastPcmStalled = false
                lastPcmStallSessionId = ""
                lastPcmStallText = ""
                lastPcmRejected = false
                lastPcmRejectSessionId = ""
                lastPcmRejectCaptureId = ""
                lastPcmRejectText = ""
            }
            lastPcmCaptureId = captureId
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.bind"),
                object: nil,
                userInfo: ["captureId": captureId, "sessionId": lastSessionId]
            )
        }
        if action == "drain" {
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.drain"),
                object: nil,
                userInfo: [
                    "lastByte": Self.intField(message, "lastByte"),
                    "captureId": captureId,
                    "sessionId": sessionId.isEmpty ? lastSessionId : sessionId,
                ]
            )
            return
        }
        if action == "stop", live {
            NotificationCenter.default.post(name: Notification.Name("nod.watch.pcm.reset"), object: nil)
        }
        if jsReady {
            emit(action, mode: mode, sessionId: sessionId)
        } else {
            pending.append((action, at, live, mode, sessionId))
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

    private func emit(_ action: String, mode: String = "", sessionId: String = "") {
        var data: [String: Any] = ["action": action]
        if !mode.isEmpty {
            data["mode"] = mode
        }
        if !sessionId.isEmpty {
            data["sessionId"] = sessionId
        }
        plugin?.notifyListeners("command", data: data)
    }

    private func ingestPcmMessage(_ message: [String: Any], raw: String) {
        guard let data = Data(base64Encoded: raw), !data.isEmpty else { return }
        let captureId = message["captureId"] as? String ?? ""
        if captureId.isEmpty {
            return
        }
        let sessionId = message["sessionId"] as? String ?? lastSessionId
        let offset = Self.intField(message, "byteOffset")
        if uplinkActive {
            let reply = NSMutableDictionary()
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.live"),
                object: nil,
                userInfo: [
                    "data": data,
                    "captureId": captureId,
                    "sessionId": sessionId,
                    "byteOffset": offset,
                    "reply": reply,
                ]
            )
            if let ack = reply["ackByte"] as? Int {
                lastPcmAckByte = ack
            }
            if let cap = reply["captureId"] as? String, !cap.isEmpty {
                lastPcmCaptureId = cap
            }
            if let sess = reply["sessionId"] as? String, !sess.isEmpty {
                lastPcmAckSessionId = sess
            }
            return
        }
        emitPcm(raw)
    }

    static func intField(_ message: [String: Any], _ key: String) -> Int {
        if let n = message[key] as? Int { return n }
        if let n = message[key] as? Double { return Int(n) }
        if let s = message[key] as? String, let n = Int(s) { return n }
        return 0
    }

    private func emitPcm(_ data: String) {
        if uplinkActive {
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
        reply["save"] = lastSave
        if !lastSessionId.isEmpty {
            reply["sessionId"] = lastSessionId
        }
        reply["pcmAckByte"] = String(lastPcmAckByte)
        if !lastPcmCaptureId.isEmpty {
            reply["pcmAckCaptureId"] = lastPcmCaptureId
        }
        if !lastPcmAckSessionId.isEmpty {
            reply["pcmAckSessionId"] = lastPcmAckSessionId
        } else if !lastSessionId.isEmpty {
            reply["pcmAckSessionId"] = lastSessionId
        }
        reply["pcmDrained"] = lastPcmDrained ? "true" : "false"
        if lastPcmDrained {
            reply["pcmDrainedCaptureId"] = lastPcmDrainedCaptureId
            reply["pcmDrainedSessionId"] = lastPcmDrainedSessionId
            reply["pcmDrainedByte"] = String(lastPcmDrainedByte)
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
        let meta = file.metadata ?? [:]
        let kind = ((meta["kind"] as? String) ?? "").lowercased()
        if kind == "speech" { return }
        let captureId = (meta["captureId"] as? String) ?? ""
        guard !captureId.isEmpty else { return }
        let sessionId = (meta["sessionId"] as? String) ?? lastSessionId
        let seq = Self.intField(meta, "seq")
        let offset = Self.intField(meta, "byteOffset")
        let reply = NSMutableDictionary()
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.file"),
            object: nil,
            userInfo: [
                "url": file.fileURL,
                "captureId": captureId,
                "sessionId": sessionId,
                "seq": seq,
                "byteOffset": offset,
                "reply": reply,
            ]
        )
        if let ack = reply["ackByte"] as? Int {
            lastPcmAckByte = ack
        }
        if let cap = reply["captureId"] as? String, !cap.isEmpty {
            lastPcmCaptureId = cap
        }
        if let sess = reply["sessionId"] as? String, !sess.isEmpty {
            lastPcmAckSessionId = sess
        }
    }
}
