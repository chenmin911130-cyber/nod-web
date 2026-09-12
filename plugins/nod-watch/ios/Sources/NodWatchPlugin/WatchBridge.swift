#if !PCM_REPLAY_TESTING
import AVFoundation
import WatchConnectivity
import UIKit
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
    private static let jobsKey = "nod.watch.saveJobs"
    private static let maxKeepAttempts = 8
    private var jobs: [String: SaveJob] = [:]
    private var inflight: Set<String> = []
    private var jobsLoaded = false
    #if PCM_REPLAY_TESTING
    static var testingKeep: ((String) -> (Int, Data?))?
    static var testingKeepAsync: ((String, @escaping (Int, Data?) -> Void) -> Void)?
    static var testingNow: (() -> TimeInterval)?
    static var testingKeepCalls = 0
    static var testingUserDefaults: UserDefaults?
    #endif
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
    private var lastCopySeq = 0
    /// Identity of the copy the Watch is currently showing. Kept so the
    /// "keep the longer text" tie-break only applies within one copy: a new
    /// sentence / New / mode switch must replace the older, longer text.
    private var lastCopyId = ""
    /// Control session the copy stream belongs to (server-minted).
    private var lastCopySession = ""
    /// The copy on the Watch is a failed one (model/quota failure, not a
    /// cancelled ask). The Watch shows an explicit failure state instead of the
    /// half sentence looking live.
    private var lastCopyFailed = false
    private var copyReplay: [[String: Any]] = []
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
            forName: Notification.Name("nod.uplink.watchCopy"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.applyWatchCopy((note.userInfo as? [String: Any]) ?? [:])
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
        #if !PCM_REPLAY_TESTING
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.resumeKeeps()
        }
        #endif
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
        #if !PCM_REPLAY_TESTING
        resumeKeeps()
        #endif
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
        let copies = copyReplay
        for row in copies {
            plugin?.notifyListeners("watchCopy", data: row)
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

    private static func intValue(_ obj: [String: Any], _ key: String) -> Int {
        if let n = obj[key] as? Int { return n }
        if let n = obj[key] as? Double { return Int(n) }
        return Int(obj[key] as? String ?? "") ?? 0
    }

    func applyWatchCopy(_ obj: [String: Any]) {
        let seq = Self.intValue(obj, "seq")
        // A strictly older version is a stale frame: an old row arriving after a
        // newer one, or after New / switch mode. Versions are monotone in time,
        // so a fresh session can never read as stale.
        if seq > 0, seq < lastCopySeq { return }
        let session = obj["session_id"] as? String ?? obj["sessionId"] as? String ?? ""
        if !session.isEmpty, !lastCopySession.isEmpty, session != lastCopySession {
            // New control session: the previous session's rows must not be
            // replayed to the phone or the Watch after New / switch mode.
            copyReplay.removeAll()
            lastCopyId = ""
        }
        if !session.isEmpty { lastCopySession = session }
        if seq > lastCopySeq { lastCopySeq = seq }
        let id = obj["id"] as? String ?? ""
        if !id.isEmpty { lastCopyId = id }
        lastCopyFailed = (obj["failed"] as? Bool) ?? ((obj["failed"] as? String) == "true")
        lastOriginal = obj["original"] as? String ?? lastOriginal
        lastTranslation = obj["translation"] as? String ?? lastTranslation
        var row: [String: Any] = [
            "id": id,
            "original": lastOriginal,
            "translation": lastTranslation,
            "seq": lastCopySeq,
            "failed": lastCopyFailed,
            "sessionId": obj["session_id"] as? String ?? obj["sessionId"] as? String ?? lastSessionId,
        ]
        if let done = obj["done"] as? Bool {
            row["done"] = done
        } else if let done = obj["done"] as? String {
            row["done"] = done == "true"
        }
        // Replay holds the last 24 COPIES (sentences), each at its latest text:
        // appending every streamed update let one long sentence evict several
        // earlier ones, so the phone could not catch up on everything it missed
        // while locked (#219).
        if !id.isEmpty, let at = copyReplay.firstIndex(where: { ($0["id"] as? String) == id }) {
            copyReplay[at] = row
        } else {
            copyReplay.append(row)
        }
        if copyReplay.count > 24 {
            copyReplay.removeFirst(copyReplay.count - 24)
        }
        plugin?.notifyListeners("watchCopy", data: row)
        pushStatus(
            capture: lastCapture,
            hint: lastHint,
            original: lastOriginal,
            translation: lastTranslation,
            previous: lastPrevious,
            history: lastHistory,
            copySeq: lastCopySeq,
            copyId: lastCopyId,
            copyFailed: lastCopyFailed
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
        sessionId: String = "",
        copySeq: Int? = nil,
        copyId: String = "",
        copyFailed: Bool? = nil
    ) {
        if !capture.isEmpty {
            lastCapture = capture
        }
        lastHint = hint
        // Only a push that knows the copy state changes the failure marker; a
        // control-only push (save / pcm_drained) must leave it alone.
        if let copyFailed { lastCopyFailed = copyFailed }
        var nextOriginal = original
        var nextTranslation = translation
        var nextPrevious = previous
        if let seq = copySeq {
            let sameCopy = copyId == lastCopyId
            if lastCopySeq > 0, seq < lastCopySeq {
                // The phone's JS face is behind the Watch (it was suspended while
                // locked, or rolled back): never let it overwrite newer copy.
                nextOriginal = lastOriginal
                nextTranslation = lastTranslation
                nextPrevious = lastPrevious
            } else if seq == lastCopySeq, sameCopy {
                // Same version of the same copy: keep the longer text, because a
                // chunk can land after the full snapshot.
                if original.count < lastOriginal.count { nextOriginal = lastOriginal }
                if translation.count < lastTranslation.count { nextTranslation = lastTranslation }
            } else {
                // Newer version, or the same version carrying a different copy
                // (New / switch mode / typed row): take the whole face.
                lastCopySeq = max(lastCopySeq, seq)
                lastCopyId = copyId
            }
        } else if lastCopySeq > 0 {
            // A control-only push (save, pcm_drained) must not blank the copy.
            nextOriginal = lastOriginal
            nextTranslation = lastTranslation
            nextPrevious = lastPrevious
        }
        lastOriginal = nextOriginal
        lastTranslation = nextTranslation
        lastPrevious = nextPrevious
        lastHistory = history
        if !mode.isEmpty {
            lastMode = mode
        }
        if !langPair.isEmpty {
            lastLangPair = langPair
        }
        if !save.isEmpty {
            let sid = sessionId.isEmpty ? lastSessionId : sessionId
            ensureJobsLoaded()
            if let job = jobs[sid], job.save == "saved", save != "saved" {
                /* Native History success is terminal for this session. */
            } else if let job = jobs[sid], job.save == "local", save == "failed" {
                /* JS timeout must not roll local persist back to failed. */
            } else {
                lastSave = save
            }
        }
        if !sessionId.isEmpty {
            lastSessionId = sessionId
            NotificationCenter.default.post(
                name: Notification.Name("nod.watch.pcm.bind"),
                object: nil,
                userInfo: ["captureId": "", "sessionId": sessionId, "mode": lastMode]
            )
        }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        var payload: [String: Any] = [
            "capture": lastCapture,
            "hint": hint,
            "original": lastOriginal,
            "translation": lastTranslation,
            "previous": lastPrevious,
            "copyFailed": lastCopyFailed ? "true" : "false",
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
                userInfo: ["captureId": captureId, "sessionId": lastSessionId, "mode": lastMode]
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
            _ = nativeWatchSave(sessionId: sessionId, captureId: captureId)
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
            if action != "save" {
                emit(action, mode: mode, sessionId: sessionId)
            }
        } else if action != "save" {
            pending.append((action, at, live, mode, sessionId))
        }
    }

    private struct SaveJob: Codable, Equatable {
        var sessionId: String
        var captureId: String
        var account: String
        var save: String
        var error: String
        var attempts: Int
        var nextAttemptAt: Double
    }

    private var defaults: UserDefaults {
        #if PCM_REPLAY_TESTING
        return Self.testingUserDefaults ?? UserDefaults(suiteName: "nod.watch.saveJobs.test") ?? .standard
        #else
        return .standard
        #endif
    }

    private func nowTs() -> TimeInterval {
        #if PCM_REPLAY_TESTING
        return Self.testingNow?() ?? Date().timeIntervalSince1970
        #else
        return Date().timeIntervalSince1970
        #endif
    }

    private func accountToken() -> String {
        defaults.string(forKey: Self.accountTokenKey) ?? ""
    }

    static func keepHttpFace(code: Int, body: Data?, sessionId: String) -> (save: String, error: String) {
        if (200 ..< 300).contains(code), let body,
           let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           obj["ok"] as? Bool == true {
            let id = obj["id"] as? String ?? ""
            if id == sessionId, !id.isEmpty { return ("saved", "") }
            return ("failed", "mismatch")
        }
        if code == 401 { return ("failed", "auth") }
        if code == 404 { return ("failed", "gone") }
        if code == 405 { return ("failed", "mismatch") }
        return ("local", "retryable")
    }

    static func keepShouldRetry(save: String, error: String, attempts: Int, now: Double, nextAttemptAt: Double) -> Bool {
        if save == "saved" { return false }
        if error == "auth" || error == "gone" || error == "mismatch" { return false }
        if attempts >= maxKeepAttempts { return false }
        return now >= nextAttemptAt
    }

    func storeAccount(token: String, origin: String) {
        if token.isEmpty {
            defaults.removeObject(forKey: Self.accountTokenKey)
        } else {
            defaults.set(token, forKey: Self.accountTokenKey)
        }
        if !origin.isEmpty {
            defaults.set(origin, forKey: Self.accountOriginKey)
        }
        if !token.isEmpty {
            resumeKeeps()
        }
    }

    func resumeKeeps() {
        ensureJobsLoaded()
        importKeepIntents()
        let now = nowTs()
        let account = accountToken()
        for job in jobs.values {
            guard job.account.isEmpty || job.account == account || account.isEmpty else { continue }
            guard Self.keepShouldRetry(
                save: job.save,
                error: job.error,
                attempts: job.attempts,
                now: now,
                nextAttemptAt: job.nextAttemptAt
            ) else { continue }
            enqueueKeep(job.sessionId)
        }
    }

    func retrySave(sessionId: String) {
        ensureJobsLoaded()
        guard !sessionId.isEmpty else { return }
        if var job = jobs[sessionId] {
            if job.save == "saved" {
                publishSave(sessionId: sessionId, save: "saved")
                return
            }
            job.error = ""
            job.nextAttemptAt = 0
            job.attempts = 0
            if job.save != "saved" { job.save = "local" }
            jobs[sessionId] = job
            persistJobs()
            enqueueKeep(sessionId)
            return
        }
        importKeepIntents()
        enqueueKeep(sessionId)
    }

    #if PCM_REPLAY_TESTING
    /// Rows replayed to the phone when the Watch asks (see `handleWatchReady`).
    func testingCopyReplay() -> [[String: Any]] { copyReplay }

    func testingResetJobs() {
        jobs = [:]
        inflight = []
        jobsLoaded = true
        defaults.removeObject(forKey: Self.jobsKey)
    }

    func testingUnloadJobs() {
        jobs = [:]
        inflight = []
        jobsLoaded = false
    }
    #endif

    /// Watch Save must not wait for WKWebView. Persist the keep intent, reply
    /// immediately, then POST History from native if a token exists.
    private func nativeWatchSave(sessionId: String, captureId: String) -> String {
        ensureJobsLoaded()
        if sessionId.isEmpty { return "failed" }
        if let existing = jobs[sessionId], existing.save == "saved" {
            publishSave(sessionId: sessionId, save: "saved")
            return "saved"
        }
        let cap = captureForSave(sessionId: sessionId, captureId: captureId)
        let reply = NSMutableDictionary()
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.intent"),
            object: nil,
            userInfo: [
                "intent": "keep",
                "captureId": cap,
                "sessionId": sessionId,
                "reply": reply,
            ]
        )
        guard (reply["ok"] as? Bool) == true else {
            upsertJob(sessionId: sessionId, captureId: cap, save: "failed", error: "gone")
            publishSave(sessionId: sessionId, save: "failed")
            return "failed"
        }
        let resolved = (reply["captureId"] as? String) ?? cap
        upsertJob(sessionId: sessionId, captureId: resolved, save: "local", error: "")
        enqueueKeep(sessionId)
        let face = jobs[sessionId]?.save ?? "failed"
        if face == "saved" || face == "failed" {
            return face
        }
        publishSave(sessionId: sessionId, save: "local")
        return "local"
    }

    private func captureForSave(sessionId: String, captureId: String) -> String {
        if !captureId.isEmpty { return captureId }
        if let cap = jobs[sessionId]?.captureId, !cap.isEmpty { return cap }
        return ""
    }

    private func importKeepIntents() {
        let reply = NSMutableDictionary()
        NotificationCenter.default.post(
            name: Notification.Name("nod.watch.pcm.pendingKeeps"),
            object: nil,
            userInfo: ["reply": reply]
        )
        let rows = reply["rows"] as? [[String: String]] ?? []
        let account = accountToken()
        var changed = false
        for row in rows {
            let sid = row["sessionId"] ?? ""
            let cap = row["captureId"] ?? ""
            guard !sid.isEmpty else { continue }
            if jobs[sid]?.save == "saved" { continue }
            if jobs[sid] == nil {
                jobs[sid] = SaveJob(
                    sessionId: sid,
                    captureId: cap,
                    account: account,
                    save: "local",
                    error: "",
                    attempts: 0,
                    nextAttemptAt: 0
                )
                changed = true
            }
        }
        if changed { persistJobs() }
    }

    private func enqueueKeep(_ sessionId: String) {
        guard let job = jobs[sessionId] else { return }
        guard !inflight.contains(sessionId) else { return }
        let now = nowTs()
        guard Self.keepShouldRetry(
            save: job.save,
            error: job.error,
            attempts: job.attempts,
            now: now,
            nextAttemptAt: job.nextAttemptAt
        ) else { return }
        inflight.insert(sessionId)
        startNativeKeep(sessionId, captureId: job.captureId)
    }

    private func startNativeKeep(_ sessionId: String, captureId: String) {
        #if PCM_REPLAY_TESTING
        if let asyncHook = Self.testingKeepAsync {
            Self.testingKeepCalls += 1
            asyncHook(sessionId) { [weak self] code, body in
                self?.applyKeepHttp(sessionId: sessionId, code: code, body: body)
                self?.inflight.remove(sessionId)
            }
            return
        }
        if let hook = Self.testingKeep {
            Self.testingKeepCalls += 1
            let (code, body) = hook(sessionId)
            applyKeepHttp(sessionId: sessionId, code: code, body: body)
            inflight.remove(sessionId)
            return
        }
        inflight.remove(sessionId)
        return
        #else
        let token = accountToken()
        var origin = defaults.string(forKey: Self.accountOriginKey) ?? ""
        if origin.isEmpty { origin = "https://nodpilot.com" }
        let root = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !token.isEmpty, let url = URL(string: "\(root)/api/account/history/\(sessionId)/keep") else {
            applyKeepHttp(sessionId: sessionId, code: token.isEmpty ? 401 : 0, body: nil)
            inflight.remove(sessionId)
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                self?.applyKeepHttp(sessionId: sessionId, code: code, body: data)
                self?.inflight.remove(sessionId)
            }
        }.resume()
        #endif
    }

    private func applyKeepHttp(sessionId: String, code: Int, body: Data?) {
        let result = Self.keepHttpFace(code: code, body: body, sessionId: sessionId)
        NSLog("nod.watch.keep session=%@ status=%d face=%@ error=%@", sessionId, code, result.save, result.error)
        ensureJobsLoaded()
        if jobs[sessionId]?.save == "saved" { return }
        var job = jobs[sessionId] ?? SaveJob(
            sessionId: sessionId,
            captureId: "",
            account: accountToken(),
            save: "local",
            error: "",
            attempts: 0,
            nextAttemptAt: 0
        )
        if result.save == "saved" {
            job.save = "saved"
            job.error = ""
        } else if result.error == "retryable" {
            job.attempts += 1
            job.error = "retryable"
            if job.attempts >= Self.maxKeepAttempts {
                job.save = "failed"
            } else {
                job.save = "local"
                job.nextAttemptAt = nowTs() + min(60, pow(2, Double(job.attempts)))
            }
        } else {
            job.save = "failed"
            job.error = result.error
        }
        jobs[sessionId] = job
        persistJobs()
        publishSave(sessionId: sessionId, save: job.save)
        #if !PCM_REPLAY_TESTING
        if job.save == "local", job.error == "retryable" {
            let delay = max(0.5, job.nextAttemptAt - nowTs())
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.enqueueKeep(sessionId)
            }
        }
        #endif
    }

    private func upsertJob(sessionId: String, captureId: String, save: String, error: String) {
        var job = jobs[sessionId] ?? SaveJob(
            sessionId: sessionId,
            captureId: captureId,
            account: accountToken(),
            save: save,
            error: error,
            attempts: 0,
            nextAttemptAt: 0
        )
        if job.save != "saved" {
            job.captureId = captureId.isEmpty ? job.captureId : captureId
            job.save = save
            job.error = error
            job.account = accountToken()
        }
        jobs[sessionId] = job
        persistJobs()
    }

    private func ensureJobsLoaded() {
        guard !jobsLoaded else { return }
        jobsLoaded = true
        guard let data = defaults.data(forKey: Self.jobsKey),
              let rows = try? JSONDecoder().decode([SaveJob].self, from: data) else { return }
        jobs = Dictionary(uniqueKeysWithValues: rows.map { ($0.sessionId, $0) })
    }

    private func persistJobs() {
        let rows = Array(jobs.values)
        if let data = try? JSONEncoder().encode(rows) {
            defaults.set(data, forKey: Self.jobsKey)
        }
    }

    private func publishSave(sessionId: String, save: String) {
        if lastSessionId.isEmpty || lastSessionId == sessionId {
            lastSave = save
            lastSessionId = sessionId
        }
        plugin?.notifyListeners("saveResult", data: ["save": save, "sessionId": sessionId])
        pushSaveToWatch(sessionId: sessionId, save: save)
    }

    func listSaves() -> [[String: String]] {
        ensureJobsLoaded()
        return jobs.map { key, job in
            ["sessionId": key, "captureId": job.captureId, "save": job.save, "error": job.error]
        }
    }

    private func pushSaveToWatch(sessionId: String, save: String) {
        #if PCM_REPLAY_TESTING
        return
        #else
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        var msg: [String: Any] = ["ok": true, "save": save, "sessionId": sessionId]
        if session.isReachable {
            session.sendMessage(msg, replyHandler: nil, errorHandler: { _ in
                try? session.updateApplicationContext(msg)
            })
        } else {
            try? session.updateApplicationContext(msg)
        }
        #endif
    }

    private func pushSaveToWatch() {
        pushSaveToWatch(sessionId: lastSessionId, save: lastSave)
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
        if (message["action"] as? String) == "save" {
            let sid = message["sessionId"] as? String ?? ""
            if sid.isEmpty {
                reply["save"] = "failed"
            } else {
                reply["sessionId"] = sid
                reply["save"] = jobs[sid]?.save ?? "failed"
            }
        } else if !lastSessionId.isEmpty {
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
