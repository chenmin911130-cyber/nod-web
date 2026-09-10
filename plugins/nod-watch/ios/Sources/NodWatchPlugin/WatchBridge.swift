#if !PCM_REPLAY_TESTING
import AVFoundation
import WatchConnectivity
#endif
import Foundation

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
    private static let accountTokenKey = "nod.watch.accountToken"
    private static let accountOriginKey = "nod.watch.accountOrigin"
    private var lastPcmAckByte = 0
    private var lastPcmCaptureId = ""
    private var lastPcmAckSessionId = ""
    private var ackTimer: DispatchWorkItem?
    /// Coalesced-ack rate limit: ordinary progress is pushed at most once per
    /// second (the latest cursor), but the LAST consumed progress is always sent
    /// when the window opens — a tail send so the final byte is never dropped
    /// (issue #165 P2-4).
    private let ackCoalesceWindow: TimeInterval = 1.0
    private var ackTimerActive = false
    private var pendingAckByte = 0
    private var pendingAckCapture = ""
    private var pendingAckSession = ""
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
    private var lastPcmReady = false
    private var lastPcmSealed = false
    private var lastHandshakeFailed = false
    private var lastHandshakeStatus = 0
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
            forName: Notification.Name("nod.watch.pcm.held"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.pushPcmAck()
        }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("nod.uplink.handshakeFailed"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            let code = (note.userInfo?["status"] as? Int) ?? 0
            self?.markUplinkHandshakeFailed(status: code)
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

    /// Coalesce consumed-progress acks to at most one send per second. Ordinary
    /// progress only updates a pending snapshot; a single timer drains it once the
    /// window opens. If the LAST consumed lands inside the window, the timer still
    /// sends the final cursor (a tail send) — with the rate limit, a burst of
    /// high-frequency consumed notifications can never starve the final ack, nor
    /// can a delayed/no-next-frame leave the last byte unacknowledged (P2-4).
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
        lastPcmReady = (reply["pcmReady"] as? Bool) ?? lastPcmReady
        lastPcmSealed = (reply["pcmSealed"] as? Bool) ?? lastPcmSealed
        if !capture.isEmpty {
            lastPcmCaptureId = capture
        }
        if !session.isEmpty {
            lastPcmAckSessionId = session
        }
        // Remember the latest cursor; do not advance lastPcmAckByte until it is
        // actually sent, so a coalesced send carries the newest progress.
        pendingAckByte = ack
        pendingAckCapture = capture
        pendingAckSession = session
        if ackTimerActive {
            return  // a drain is already scheduled; it will send the updated snapshot
        }
        ackTimerActive = true
        let work = DispatchWorkItem { [weak self] in
            self?.sendCoalescedAck()
        }
        ackTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ackCoalesceWindow, execute: work)
    }

    private func sendCoalescedAck() {
        ackTimerActive = false
        ackTimer = nil
        // Re-check identity at send time: a stale snapshot must never pair an old
        // offset with a newer capture (issue #165 P2-4). If the capture changed,
        // drop the pending snapshot rather than send it.
        if !pendingAckCapture.isEmpty, !lastPcmCaptureId.isEmpty,
           pendingAckCapture != lastPcmCaptureId {
            pendingAckByte = 0
            pendingAckCapture = ""
            pendingAckSession = ""
            return
        }
        guard pendingAckByte != lastPcmAckByte else { return }
        lastPcmAckByte = pendingAckByte
        guard WCSession.isSupported() else { return }
        let wc = WCSession.default
        guard wc.activationState == .activated, wc.isReachable else { return }
        var msg: [String: Any] = ["pcmAckByte": String(pendingAckByte), "ok": true]
        if !pendingAckCapture.isEmpty {
            msg["pcmAckCaptureId"] = pendingAckCapture
        }
        if !pendingAckSession.isEmpty {
            msg["pcmAckSessionId"] = pendingAckSession
        }
        msg["pcmReady"] = lastPcmReady ? "true" : "false"
        msg["pcmSealed"] = lastPcmSealed ? "true" : "false"
        wc.sendMessage(msg, replyHandler: nil, errorHandler: nil)
    }

    func markUplinkHandshakeFailed(status: Int) {
        lastHandshakeFailed = true
        lastHandshakeStatus = status
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory
        )
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
        payload["pcmReady"] = lastPcmReady ? "true" : "false"
        payload["pcmSealed"] = lastPcmSealed ? "true" : "false"
        if lastHandshakeFailed {
            payload["uplinkHandshakeFailed"] = "true"
            payload["uplinkHandshakeStatus"] = String(lastHandshakeStatus)
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
                lastPcmReady = false
                lastPcmSealed = false
                lastHandshakeFailed = false
                lastHandshakeStatus = 0
                // Reset the coalesced-ack snapshot + timer so a stale offset from
                // an old capture is never paired with the new capture (issue #165 P2-4).
                ackTimer?.cancel()
                ackTimer = nil
                ackTimerActive = false
                pendingAckByte = 0
                pendingAckCapture = ""
                pendingAckSession = ""
            }
            lastPcmCaptureId = captureId
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.bind"),
                object: nil,
                userInfo: ["captureId": captureId, "sessionId": lastSessionId]
            )
            let readyReply = NSMutableDictionary()
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.ack"),
                object: nil,
                userInfo: ["reply": readyReply]
            )
            lastPcmReady = (readyReply["pcmReady"] as? Bool) ?? false
            if let ack = readyReply["ackByte"] as? Int {
                lastPcmAckByte = ack
            }
        }
        if action == "discard" {
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.discard"),
                object: nil,
                userInfo: ["captureId": captureId.isEmpty ? lastPcmCaptureId : captureId]
            )
        }
        if action == "save" {
            lastSave = nativeWatchSave(sessionId: sessionId)
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

    func storeAccount(token: String, origin: String) {
        if token.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.accountTokenKey)
        } else {
            UserDefaults.standard.set(token, forKey: Self.accountTokenKey)
        }
        if !origin.isEmpty {
            UserDefaults.standard.set(origin, forKey: Self.accountOriginKey)
        }
    }

    /// Watch Save must not wait for WKWebView. Persist the keep intent, reply
    /// `local` immediately, then POST History from native if a token exists.
    private func nativeWatchSave(sessionId: String) -> String {
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.intent"),
            object: nil,
            userInfo: [
                "intent": "keep",
                "captureId": lastPcmCaptureId,
                "sessionId": sessionId,
            ]
        )
        if sessionId.isEmpty { return "failed" }
        lastSessionId = sessionId
        startNativeKeep(sessionId)
        return "local"
    }

    private func startNativeKeep(_ sessionId: String) {
        #if PCM_REPLAY_TESTING
        return
        #else
        let token = UserDefaults.standard.string(forKey: Self.accountTokenKey) ?? ""
        var origin = UserDefaults.standard.string(forKey: Self.accountOriginKey) ?? ""
        if origin.isEmpty { origin = "https://nodpilot.com" }
        let root = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !token.isEmpty, let url = URL(string: "\(root)/api/account/history/\(sessionId)/keep") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200 ..< 300).contains(code) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.lastSessionId = sessionId
                self.lastSave = "saved"
                self.pushSaveToWatch()
            }
        }.resume()
        #endif
    }

    private func pushSaveToWatch() {
        #if PCM_REPLAY_TESTING
        return
        #else
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        var msg: [String: Any] = ["ok": true, "save": lastSave]
        if !lastSessionId.isEmpty { msg["sessionId"] = lastSessionId }
        session.sendMessage(msg, replyHandler: nil, errorHandler: nil)
        #endif
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
            lastPcmReady = (reply["pcmReady"] as? Bool) ?? lastPcmReady
            lastPcmSealed = (reply["pcmSealed"] as? Bool) ?? lastPcmSealed
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
        reply["pcmReady"] = lastPcmReady ? "true" : "false"
        reply["pcmSealed"] = lastPcmSealed ? "true" : "false"
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
