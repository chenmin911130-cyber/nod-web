import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

final class WatchPhoneSession: NSObject, ObservableObject, WCSessionDelegate, WKExtendedRuntimeSessionDelegate, AVAudioPlayerDelegate {
    static let shared = WatchPhoneSession()

    @Published var listening = false
    @Published var starting = false
    @Published var paused = false
    @Published var startedAt: Date?
    @Published var elapsedMs: TimeInterval = 0
    @Published var hint = "Watch mic — tap Listen"
    @Published var original = ""
    @Published var translation = ""
    @Published var previous = ""
    @Published var history: [WatchHistItem] = []
    @Published var reachable = false
    @Published var speechLive = false
    @Published var speechVoice = "female"
    @Published var offeringSave = false
    @Published var saving = false
    @Published var saveFailed = false
    @Published var savedAck = false
    @Published var langPair = "Auto → CH"
    @Published var mode = "meeting"
    @Published var draining = false
    @Published var drainFailed = false

    private var localModeHeld = false
    private var phoneModeSeen = false
    private var speechPlayer: AVAudioPlayer?
    private var savedAckWork: DispatchWorkItem?
    private var saveWaitWork: DispatchWorkItem?
    private var saveRequestId = ""
    private var phoneSessionId = ""
    private var startBeganAt: Date?
    private var startWaitWork: DispatchWorkItem?
    private var drainWaitWork: DispatchWorkItem?
    private var transferTimer: Timer?
    private var pendingSaveOffer = false
    private var saveAfterDrain = false
    private var pcmDrained = false
    private let pcmStore = WatchPcmStore()
    private var lastTransferAt: [Int: Date] = [:]

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
    /// True when the Watch's own recorder was running right before a pause, so
    /// a phone-initiated resume reopens the mic only for a session that was
    /// actually recording on the Watch — not for a phone-mic session (which
    /// would otherwise double the audio into one transcription).
    private var micWasRunningBeforePause = false
    /// True when this session opened the Watch recorder from a local Start / Record.
    /// Phone-initiated sessions stay false so Pause / Resume / speech do not seize the mic.
    private var localWatchMic = false

    override private init() {
        super.init()
        WatchRecorder.shared.onPcm = { [weak self] data in
            self?.forwardPcm(data)
        }
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        DispatchQueue.main.async { [weak self] in
            self?.transferTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.flushTransfers()
            }
        }
    }

    private static let modeKey = "nod.watch.listenMode"

    /// Phone workspace is the source of truth. Leftover Watch chips must not win.
    private static func storedMode() -> String {
        "meeting"
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

    func pickMode(_ next: String) {
        setMode(next)
        localModeHeld = true
    }

    static func usesWatchMic(localStart: Bool) -> Bool {
        localStart
    }

    /// Crown is Start/Stop. Side is Pause/Resume. Do not call toggle() from the crown.
    static func hardwareAction(
        key: String,
        listening: Bool,
        paused: Bool,
        offeringSave: Bool,
        saved: Bool
    ) -> String {
        if offeringSave || saved { return "" }
        if key == "crown" {
            return (listening || paused) ? "stop" : "start"
        }
        if paused { return "resume" }
        if listening { return "pause" }
        return ""
    }

    func applyHardware(_ key: String) {
        guard !starting else { return }
        switch Self.hardwareAction(
            key: key,
            listening: listening,
            paused: paused,
            offeringSave: offeringSave,
            saved: savedAck
        ) {
        case "start": startSession()
        case "stop": finish()
        case "pause": pause()
        case "resume": resume()
        default: break
        }
    }

    func toggle() {
        guard !starting else { return }
        if paused {
            resume()
            return
        }
        if listening || WatchRecorder.shared.isRunning {
            pause()
            return
        }
        startSession()
    }

    func record() {
        guard !starting else { return }
        if paused {
            resume()
            return
        }
        if WatchRecorder.shared.isRunning {
            return
        }
        resetPcmBuffer()
        pcmStore.beginCapture()
        lastTransferAt.removeAll()
        original = ""
        translation = ""
        previous = ""
        elapsedMs = 0
        localModeHeld = phoneModeSeen
        starting = true
        startBeganAt = Date()
        hint = WatchCopy.starting
        send(action: "record")
        localWatchMic = true
        if Self.usesWatchMic(localStart: true) {
            beginMic(hint: WatchCopy.starting, setListening: false)
        }
        armStartWait()
    }

    func pause() {
        guard listening || WatchRecorder.shared.isRunning else { return }
        if let startedAt {
            elapsedMs = Date().timeIntervalSince(startedAt)
        }
        WatchRecorder.shared.stop()
        stopRuntime()
        listening = false
        paused = true
        WatchGlanceStore.setPaused(elapsed: elapsedMs)
        hint = WatchCopy.paused
        send(action: "pause")
    }

    func resume() {
        guard paused else { return }
        paused = false
        startedAt = Date().addingTimeInterval(-elapsedMs)
        send(action: "resume")
        if Self.usesWatchMic(localStart: localWatchMic) {
            beginMic(hint: reachable ? "Watch mic" : "Recording on Watch", resetClock: false)
        } else {
            listening = true
            WatchGlanceStore.setStartedAt(startedAt)
            hint = "Phone mic"
        }
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
        let resumeMic = listening && Self.usesWatchMic(localStart: localWatchMic) && WatchRecorder.shared.isRunning
        if resumeMic {
            WatchRecorder.shared.stop()
            stopRuntime()
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("nod-play.mp3")
            try data.write(to: url, options: .atomic)
            let player = try AVAudioPlayer(contentsOf: url, fileTypeHint: AVFileType.mp3.rawValue)
            player.delegate = self
            player.volume = 1
            player.prepareToPlay()
            speechPlayer = player
            guard player.play() else {
                hint = "Could not play speech"
                resumeMicAfterSpeech()
                return
            }
        } catch {
            hint = "Could not play speech"
            resumeMicAfterSpeech()
        }
    }

    private func resumeMicAfterSpeech() {
        speechPlayer = nil
        guard listening, !paused, Self.usesWatchMic(localStart: localWatchMic), !WatchRecorder.shared.isRunning else { return }
        beginMic(hint: reachable ? "Watch mic" : "Recording on Watch", resetClock: false)
    }

    func finish() {
        guard !starting else { return }
        let hadContent = !original.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !translation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        paused = false
        WatchRecorder.shared.stop()
        stopRuntime()
        listening = false
        startedAt = nil
        elapsedMs = 0
        WatchGlanceStore.clear()
        offeringSave = false
        savedAck = false
        saving = false
        saveFailed = false
        localModeHeld = false
        localWatchMic = false
        pendingSaveOffer = hadContent
        saveAfterDrain = false
        drainFailed = false
        pcmDrained = false
        pcmStore.freeze()
        draining = true
        hint = WatchCopy.replaying
        armDrainWait()
        flushTransfers()
        send(action: "drain")
        maybeCompleteDrain()
    }

    func confirmSave() {
        if draining {
            saveAfterDrain = true
            pendingSaveOffer = true
            return
        }
        if saving { return }
        saveWaitWork?.cancel()
        savedAckWork?.cancel()
        offeringSave = true
        savedAck = false
        saving = true
        saveFailed = false
        saveRequestId = Self.savePinnedId(pinnedId: saveRequestId, phoneSessionId: phoneSessionId)
        hint = WatchCopy.saving
        armSaveWait()
        guard Self.saveShouldSend(saveRequestId) else { return }
        send(action: "save")
    }

    func declineSave() {
        saveWaitWork?.cancel()
        saveWaitWork = nil
        offeringSave = false
        savedAck = false
        saving = false
        saveFailed = false
        saveRequestId = ""
        hint = WatchCopy.ready
        send(action: "discard")
    }

    func startSession() {
        guard !listening, !paused, !starting else { return }
        savedAckWork?.cancel()
        saveWaitWork?.cancel()
        saveWaitWork = nil
        resetPcmBuffer()
        pcmStore.beginCapture()
        lastTransferAt.removeAll()
        draining = false
        drainFailed = false
        pcmDrained = false
        pendingSaveOffer = false
        saveAfterDrain = false
        original = ""
        translation = ""
        previous = ""
        elapsedMs = 0
        offeringSave = false
        savedAck = false
        saving = false
        saveFailed = false
        saveRequestId = ""
        localModeHeld = phoneModeSeen
        starting = true
        startBeganAt = Date()
        hint = WatchCopy.starting
        send(action: "start")
        localWatchMic = true
        if Self.usesWatchMic(localStart: true) {
            beginMic(hint: WatchCopy.starting, setListening: false)
        }
        armStartWait()
    }

    /// Phone capture wins until 8s. `off` while waiting is not a timeout.
    static func startOutcome(capture: String, waitedMs: Int) -> String {
        if capture == "listening" || capture == "recording" { return "started" }
        if waitedMs >= 8000 { return "timeout" }
        return "waiting"
    }

    private func armStartWait() {
        startWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.starting else { return }
            self.failStart()
        }
        startWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    private func failStart() {
        startWaitWork?.cancel()
        startWaitWork = nil
        starting = false
        startBeganAt = nil
        listening = false
        paused = false
        startedAt = nil
        elapsedMs = 0
        WatchRecorder.shared.stop()
        stopRuntime()
        resetPcmBuffer()
        pcmStore.discardCapture()
        WatchGlanceStore.clear()
        hint = WatchCopy.couldntStart
        localWatchMic = false
        send(action: "stop")
    }

    private func armSaveWait() {
        saveWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.saving else { return }
            self.saving = false
            self.saveFailed = true
            self.hint = WatchCopy.saveFailed
        }
        saveWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    private func applySaveStatus(_ save: String, sessionId: String) {
        guard !saveRequestId.isEmpty, !sessionId.isEmpty, sessionId == saveRequestId else { return }
        if save == "saved" {
            saveWaitWork?.cancel()
            saveWaitWork = nil
            offeringSave = false
            saving = false
            saveFailed = false
            savedAck = true
            hint = WatchCopy.saved
            scheduleReady()
            return
        }
        if save == "failed" {
            saveWaitWork?.cancel()
            saveWaitWork = nil
            saving = false
            saveFailed = true
            hint = WatchCopy.saveFailed
        }
    }

    private func scheduleReady() {
        savedAckWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.savedAck else { return }
            self.savedAck = false
            self.hint = WatchCopy.ready
        }
        savedAckWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    private func beginMic(hint: String, resetClock: Bool = true, setListening: Bool = true) {
        WatchRecorder.shared.start { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.stopRuntime()
                    if self.starting {
                        self.failStart()
                        return
                    }
                    self.listening = false
                    self.paused = false
                    self.startedAt = nil
                    WatchGlanceStore.clear()
                    self.hint = error.localizedDescription
                    return
                }
                if setListening {
                    self.listening = true
                    self.paused = false
                    if resetClock || self.startedAt == nil {
                        self.startedAt = Date()
                        self.elapsedMs = 0
                    }
                    WatchGlanceStore.setStartedAt(self.startedAt)
                    self.hint = hint
                }
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

    /// First Save pins phoneSessionId. Retry keeps that pin even if the phone moved on.
    static func savePinnedId(pinnedId: String, phoneSessionId: String) -> String {
        pinnedId.isEmpty ? phoneSessionId : pinnedId
    }

    static func saveShouldSend(_ pinnedId: String) -> Bool {
        !pinnedId.isEmpty
    }

    static func saveWireMessage(sessionId: String) -> String? {
        sessionId.isEmpty ? nil : sessionId
    }

    /// Saving with no pin yet: latch the incoming id and send Save.
    static func savePinIncoming(saving: Bool, pinnedId: String, incomingSessionId: String) -> (pinnedId: String, send: Bool) {
        if saving, pinnedId.isEmpty, !incomingSessionId.isEmpty {
            return (incomingSessionId, true)
        }
        return (pinnedId, false)
    }

    /// Start / Record carry the Watch chip. Pause / Stop / leftovers must not.
    static func commandShouldSendMode(_ action: String) -> Bool {
        action == "start" || action == "record"
    }

    /// A held Watch mode stays until the phone reports the same workspace.
    static func phoneModeShouldApply(localModeHeld: Bool, watchListening: Bool, watchPaused: Bool) -> Bool {
        if localModeHeld { return false }
        return true
    }

    /// Phone reports the authoritative `capture` (ADR 0001). The Watch mirrors
    /// the session state directly — no latch, no inference — while its own
    /// recorder / runtime stay controlled by local Start / Pause / Resume.
    private func syncFromCapture(_ capture: String) {
        switch capture {
        case "listening", "recording":
            if starting {
                startWaitWork?.cancel()
                startWaitWork = nil
                starting = false
                startBeganAt = nil
                paused = false
                listening = true
                startedAt = Date()
                elapsedMs = 0
                WatchGlanceStore.setStartedAt(startedAt)
                hint = Self.usesWatchMic(localStart: true)
                    ? (reachable ? "Watch mic" : "Recording on Watch")
                    : "Phone mic"
                return
            }
            // Live session: the Watch shows listening. It does NOT seize the mic
            // from local Watch Start; a phone-initiated session just mirrors.
            if !listening || paused {
                let resuming = paused
                paused = false
                listening = true
                if startedAt == nil {
                    startedAt = Date()
                    elapsedMs = 0
                }
                WatchGlanceStore.setStartedAt(startedAt)
                // Only reopen the Watch mic after a pause of a session that was
                // recording on the Watch. A plain off->listening for a phone-mic
                // session must NOT start the Watch recorder, or both mics feed
                // one transcription (double audio).
                if resuming && micWasRunningBeforePause && !WatchRecorder.shared.isRunning {
                    beginMic(hint: reachable ? "Watch mic" : "Recording on Watch", resetClock: false)
                }
                micWasRunningBeforePause = false
            }
        case "paused":
            if !paused {
                micWasRunningBeforePause = WatchRecorder.shared.isRunning
                if let startedAt { elapsedMs = Date().timeIntervalSince(startedAt) }
                WatchRecorder.shared.stop()
                stopRuntime()
                listening = false
                paused = true
                WatchGlanceStore.setPaused(elapsed: elapsedMs)
                hint = WatchCopy.paused
            }
        case "off":
            // Start in flight: phone often pushes a stale capture:off before
            // listening. Do not treat it as failure or kill the Watch recorder.
            if starting { return }
            // Session is over. Stop the Watch side, but leave offeringSave /
            // savedAck alone — the Watch's own Stop->Save flow owns them, and a
            // phone-initiated stop arrives with them already false.
            if listening || paused || WatchRecorder.shared.isRunning {
                WatchRecorder.shared.stop()
                stopRuntime()
                listening = false
                paused = false
                startedAt = nil
                elapsedMs = 0
                WatchGlanceStore.clear()
                localModeHeld = false
                localWatchMic = false
                flushUnsent()
                resetPcmBuffer()
                if !offeringSave, !savedAck {
                    hint = WatchCopy.ready
                }
            }
        default:
            break
        }
    }


    static func flushShouldSend(pendingBytes: Int) -> Bool {
        pendingBytes > 0
    }

    static func intField(_ payload: [String: Any], _ key: String) -> Int? {
        if let n = payload[key] as? Int { return n }
        if let n = payload[key] as? Double { return Int(n) }
        if let s = payload[key] as? String, let n = Int(s) { return n }
        return nil
    }

    static func flag(_ payload: [String: Any], _ key: String) -> Bool {
        if let b = payload[key] as? Bool { return b }
        if let n = payload[key] as? Int { return n != 0 }
        if let s = payload[key] as? String {
            return s == "true" || s == "1"
        }
        return false
    }

    private func resetPcmBuffer() {
        pcmLock.lock()
        pendingPcm.removeAll(keepingCapacity: true)
        liveStreamed = false
        pcmLock.unlock()
    }

    private func forwardPcm(_ data: Data) {
        guard !data.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            self?.sendPcm(data)
        }
    }

    private func sendPcm(_ data: Data) {
        guard let placed = pcmStore.append(data) else {
            WatchRecorder.shared.stop()
            stopRuntime()
            if listening {
                hint = WatchCopy.diskFull
            }
            flushTransfers()
            return
        }
        let session = WCSession.default
        let reachable = session.activationState == .activated && session.isReachable
        if Self.pcmShouldBuffer(reachable: reachable) {
            return
        }
        pcmLock.lock()
        liveStreamed = true
        pcmLock.unlock()
        var payload: [String: Any] = [
            "pcm": data.base64EncodedString(),
            "kind": "pcm16",
            "sr": "16000",
            "captureId": pcmStore.captureId,
            "seq": String(placed.seq),
            "byteOffset": String(placed.offset),
        ]
        if !pcmStore.sessionId.isEmpty {
            payload["sessionId"] = pcmStore.sessionId
        }
        session.sendMessage(payload, replyHandler: { [weak self] reply in
            DispatchQueue.main.async { self?.apply(reply, live: false) }
        }, errorHandler: { [weak self] _ in
            self?.pcmStore.closeShard()
            self?.flushTransfers()
        })
    }

    private func flushTransfers() {
        if draining || !reachable {
            pcmStore.closeShard()
        }
        let now = Date()
        for shard in pcmStore.unackedShards() {
            if let at = lastTransferAt[shard.seq], now.timeIntervalSince(at) < 8 { continue }
            lastTransferAt[shard.seq] = now
            WCSession.default.transferFile(shard.url, metadata: pcmStore.metadata(for: shard))
        }
        maybeCompleteDrain()
    }

    private func flushUnsent() {
        flushTransfers()
    }

    private func armDrainWait() {
        drainWaitWork?.cancel()
        let slack = Double(pcmStore.lastByte) / 32_000.0 + 90
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.draining else { return }
            self.draining = false
            self.drainFailed = true
            self.hint = WatchCopy.drainFailed
        }
        drainWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(30, slack), execute: work)
    }

    static func pcmAckApplies(
        liveCaptureId: String,
        liveSessionId: String,
        ackCaptureId: String,
        ackSessionId: String
    ) -> Bool {
        if ackCaptureId.isEmpty || liveCaptureId.isEmpty || ackCaptureId != liveCaptureId { return false }
        if !ackSessionId.isEmpty, !liveSessionId.isEmpty, ackSessionId != liveSessionId { return false }
        return true
    }

    static func pcmDrainApplies(
        liveCaptureId: String,
        liveSessionId: String,
        liveLastByte: Int,
        drainCaptureId: String,
        drainSessionId: String,
        drainByte: Int
    ) -> Bool {
        if !pcmAckApplies(
            liveCaptureId: liveCaptureId,
            liveSessionId: liveSessionId,
            ackCaptureId: drainCaptureId,
            ackSessionId: drainSessionId
        ) {
            return false
        }
        return drainByte == liveLastByte
    }

    private func maybeCompleteDrain() {
        guard draining, !drainFailed, pcmStore.frozen else { return }
        if pcmStore.lastByte == 0 {
            completeDrain()
            return
        }
        guard pcmDrained else { return }
        completeDrain()
    }

    private func completeDrain() {
        drainWaitWork?.cancel()
        drainWaitWork = nil
        draining = false
        drainFailed = false
        send(action: "stop")
        let offer = pendingSaveOffer
        pendingSaveOffer = false
        if saveAfterDrain {
            saveAfterDrain = false
            offeringSave = offer
            confirmSave()
            return
        }
        offeringSave = offer
        hint = offer ? WatchCopy.saveAsk : WatchCopy.ready
    }

    func retryDrain() {
        drainFailed = false
        pcmDrained = false
        draining = true
        hint = WatchCopy.replaying
        lastTransferAt.removeAll()
        armDrainWait()
        flushTransfers()
        send(action: "drain")
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
        if Self.commandShouldSendMode(action), phoneModeSeen {
            payload["mode"] = mode
        }
        if action == "start" || action == "record" || action == "drain", !pcmStore.captureId.isEmpty {
            payload["captureId"] = pcmStore.captureId
        }
        if action == "drain" {
            payload["lastByte"] = String(pcmStore.lastByte)
            if !pcmStore.sessionId.isEmpty {
                payload["sessionId"] = pcmStore.sessionId
            }
        }
        if action == "save" {
            guard let wire = Self.saveWireMessage(sessionId: saveRequestId) else { return }
            payload["sessionId"] = wire
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
            if self.starting {
                self.hint = WatchCopy.starting
            } else if self.draining {
                self.hint = WatchCopy.replaying
            } else if self.drainFailed {
                self.hint = WatchCopy.drainFailed
            } else if self.listening {
                self.hint = "Recording on Watch"
            } else if self.paused {
                self.hint = WatchCopy.paused
            } else {
                self.hint = "Waking iPhone…"
            }
        }
    }

    /// Leftover file / application context must not play when the Watch app opens.
    static func speechShouldPlay(live: Bool) -> Bool {
        live
    }

    static func speechFileShouldPlay(at: TimeInterval?, now: TimeInterval) -> Bool {
        guard let at else { return false }
        return now - at <= 30
    }

    private func apply(_ payload: [String: Any], live: Bool) {
        if let sessionId = payload["sessionId"] as? String, !sessionId.isEmpty {
            phoneSessionId = sessionId
            pcmStore.bindSession(sessionId)
            let pin = Self.savePinIncoming(saving: saving, pinnedId: saveRequestId, incomingSessionId: sessionId)
            if pin.send {
                saveRequestId = pin.pinnedId
                send(action: "save")
            }
        }
        if let ack = Self.intField(payload, "pcmAckByte"), ack > 0 {
            let ackCapture = (payload["pcmAckCaptureId"] as? String)
                ?? (payload["captureId"] as? String)
                ?? ""
            let ackSession = (payload["pcmAckSessionId"] as? String)
                ?? (payload["sessionId"] as? String)
                ?? ""
            if Self.pcmAckApplies(
                liveCaptureId: pcmStore.captureId,
                liveSessionId: pcmStore.sessionId,
                ackCaptureId: ackCapture,
                ackSessionId: ackSession
            ) {
                pcmStore.ack(ack, captureId: ackCapture, sessionId: ackSession)
                lastTransferAt = lastTransferAt.filter { seq, _ in
                    pcmStore.unackedShards().contains(where: { $0.seq == seq })
                }
            }
        }
        if Self.flag(payload, "pcmDrained") {
            let drainCapture = (payload["pcmDrainedCaptureId"] as? String) ?? ""
            let drainSession = (payload["pcmDrainedSessionId"] as? String) ?? ""
            let drainByte = Self.intField(payload, "pcmDrainedByte") ?? -1
            if Self.pcmDrainApplies(
                liveCaptureId: pcmStore.captureId,
                liveSessionId: pcmStore.sessionId,
                liveLastByte: pcmStore.lastByte,
                drainCaptureId: drainCapture,
                drainSessionId: drainSession,
                drainByte: drainByte
            ) {
                pcmDrained = true
                pcmStore.ack(pcmStore.lastByte, captureId: drainCapture, sessionId: drainSession)
                maybeCompleteDrain()
            }
        }
        if let save = payload["save"] as? String {
            applySaveStatus(save, sessionId: (payload["sessionId"] as? String) ?? "")
        }
        if payload["ok"] != nil { return }
        if let next = payload["mode"] as? String, ["meeting", "lecture", "interview", "translate"].contains(next) {
            phoneModeSeen = true
            if next == mode {
                localModeHeld = false
            } else if Self.phoneModeShouldApply(localModeHeld: localModeHeld, watchListening: listening, watchPaused: paused) {
                setMode(next)
            }
        }
        if let pair = payload["langPair"] as? String, !pair.isEmpty {
            langPair = pair
        }
        if let capture = payload["capture"] as? String {
            syncFromCapture(capture)
        }
        if let hint = payload["hint"] as? String, !hint.isEmpty, !paused, !offeringSave, !savedAck, !saving, !saveFailed, !starting, !localWatchMic, !draining, !drainFailed {
            self.hint = hint
        }
        if let original = payload["original"] as? String {
            self.original = original
        }
        if let translation = payload["translation"] as? String {
            self.translation = translation
        }
        if let previous = payload["previous"] as? String {
            self.previous = previous
        }
        if Self.speechShouldPlay(live: live) {
            if let data = payload["speechData"] as? Data, !data.isEmpty {
                playSpeech(data)
            } else if let speech = payload["speech"] as? String,
                      let data = Data(base64Encoded: speech),
                      !data.isEmpty {
                playSpeech(data)
            }
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
                self.hint = "Open Nodpilot on iPhone once"
            }
            if !session.receivedApplicationContext.isEmpty {
                self.apply(session.receivedApplicationContext, live: false)
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
                if self.original.isEmpty, self.translation.isEmpty {
                    self.hint = session.isReachable ? "Watch mic" : "Recording on Watch"
                }
                self.flushTransfers()
            } else if self.draining {
                self.flushTransfers()
            } else if self.paused {
                self.hint = WatchCopy.paused
            }
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { self.resumeMicAfterSpeech() }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        DispatchQueue.main.async { self.resumeMicAfterSpeech() }
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
        guard (file.metadata?["kind"] as? String) == "speech" else { return }
        let at = (file.metadata?["at"] as? String).flatMap(TimeInterval.init)
        guard Self.speechFileShouldPlay(at: at, now: Date().timeIntervalSince1970) else { return }
        guard let data = try? Data(contentsOf: file.fileURL), !data.isEmpty else { return }
        DispatchQueue.main.async { self.playSpeech(data) }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
}
