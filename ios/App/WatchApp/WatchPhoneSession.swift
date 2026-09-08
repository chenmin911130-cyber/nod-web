import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

final class WatchPhoneSession: NSObject, ObservableObject, WCSessionDelegate, WKExtendedRuntimeSessionDelegate, AVAudioPlayerDelegate {
    static let shared = WatchPhoneSession()

    @Published var listening = false
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
    @Published var ending = false
    @Published var ended = false
    @Published var saveState = "none"
    @Published var sessionId = ""
    @Published var langPair = "Auto → ZH"
    @Published var engine = "idle"
    @Published var mode = "meeting"
    @Published var starting = false
    @Published var pending: String?
    @Published var blocked = ""
    @Published var failure: String?
    @Published var lastStatusAt: Date?
    @Published var reconnecting = false
    @Published var reconnectFailed = false
    @Published var failed = false
    @Published var retrying = false
    @Published var pillShown = false
    @Published var scrollToId: String?

    private var localModeHeld = false
    private var phoneModeSeen = false
    private var speechPlayer: AVAudioPlayer?
    private var saveRequestedId: String?
    private var saveWaitWork: DispatchWorkItem?
    private var endWaitWork: DispatchWorkItem?
    private var discardWaitWork: DispatchWorkItem?
    private var startWaitWork: DispatchWorkItem?
    private var pendingWaitWork: DispatchWorkItem?
    private var startBeganAt: Date?
    private var lastCapture = ""
    private var lastReconnectAt: Date?
    private var staleWatch: DispatchWorkItem?
    private var retryWaitWork: DispatchWorkItem?
    private var lastLatestId = ""
    var latestVisible = true

    struct WatchHistItem: Identifiable, Equatable {
        let id: String
        let title: String
        let text: String
        let failed: Bool
    }

    struct ReadingUnit: Identifiable, Equatable {
        let id: String
        var original: String
        var result: String
        var failed: Bool
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
    /// True when this Watch session started capture on the wrist.
    /// Phone-initiated listening only mirrors capture and must not open the Watch mic.
    private var localMic = false

    override private init() {
        super.init()
        WatchRecorder.shared.onPcm = { [weak self] data in
            self?.forwardPcm(data)
        }
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
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

    var saveMatched: Bool {
        WatchPhoneSession.saveIsConfirmed(saveState: saveState, sessionId: sessionId, requestedId: saveRequestedId)
    }

    static func saveIsConfirmed(saveState: String, sessionId: String, requestedId: String?) -> Bool {
        guard saveState == "saved" else { return false }
        if let requestedId, !requestedId.isEmpty {
            return sessionId == requestedId
        }
        return !sessionId.isEmpty
    }

    static func statusUnknown(
        reachable: Bool,
        recorderRunning: Bool,
        listening: Bool,
        paused: Bool,
        ended: Bool,
        staleSec: TimeInterval,
        reconnectFailed: Bool
    ) -> Bool {
        if recorderRunning { return false }
        if !listening, !paused, !ended { return false }
        return !reachable || (staleSec > 20 && reconnectFailed)
    }

    var statusUnknown: Bool {
        let stale = lastStatusAt.map { Date().timeIntervalSince($0) } ?? TimeInterval.infinity
        return Self.statusUnknown(
            reachable: reachable,
            recorderRunning: WatchRecorder.shared.isRunning,
            listening: listening,
            paused: paused,
            ended: ended,
            staleSec: stale,
            reconnectFailed: reconnectFailed
        )
    }

    /// Crown is Start/Stop. Side is Pause/Resume. Do not call toggle() from the crown.
    static func hardwareAction(
        key: String,
        listening: Bool,
        paused: Bool,
        ended: Bool,
        saving: Bool,
        saved: Bool,
        starting: Bool,
        pending: String?
    ) -> String {
        if ended || saving || saved { return "" }
        if starting || pending != nil { return "" }
        if key == "crown" {
            return (listening || paused) ? "stop" : "start"
        }
        if paused { return "resume" }
        if listening { return "pause" }
        return ""
    }

    static func startOutcome(capture: String, blocked: String, waitedMs: Int) -> String {
        if capture == "listening" || capture == "recording" { return "started" }
        if !blocked.isEmpty { return "blocked:\(blocked)" }
        if waitedMs >= 8000 { return "timeout" }
        return "waiting"
    }

    static func offShouldStopRecorder(
        starting: Bool,
        listening: Bool,
        paused: Bool,
        recorderRunning: Bool
    ) -> Bool {
        !starting && (listening || paused || recorderRunning)
    }

    static func readingAnchor(atLatest: Bool, newUnit: Bool, pillShown: Bool) -> (scroll: Bool, pill: Bool) {
        if atLatest {
            return (newUnit, false)
        }
        if newUnit {
            return (false, true)
        }
        return (false, pillShown)
    }

    static func readingUnits(
        history: [WatchHistItem],
        original: String,
        translation: String,
        failed: Bool
    ) -> [ReadingUnit] {
        var units = history.reversed().map {
            ReadingUnit(id: $0.id, original: $0.title, result: $0.text, failed: $0.failed)
        }
        if let newest = history.first, let idx = units.indices.last, units[idx].id == newest.id {
            if !original.isEmpty { units[idx].original = original }
            units[idx].result = translation
            units[idx].failed = failed
        } else if !original.isEmpty || !translation.isEmpty {
            units.append(ReadingUnit(id: history.first?.id ?? "live", original: original, result: translation, failed: failed))
        }
        return units
    }

    var readingUnits: [ReadingUnit] {
        Self.readingUnits(history: history, original: original, translation: translation, failed: failed)
    }

    private func failureCopy(forBlocked blocked: String) -> String {
        switch blocked {
        case "signin": return WatchCopy.signInOnIphone
        case "consent": return WatchCopy.confirmOnIphone
        case "quota": return WatchCopy.limitReached
        default: return WatchCopy.couldntStart
        }
    }

    private func failStart(reason: String) {
        starting = false
        startWaitWork?.cancel()
        startBeganAt = nil
        if Self.usesWatchMic(localStart: localMic) {
            WatchRecorder.shared.stop()
            stopRuntime()
        }
        localMic = false
        listening = false
        paused = false
        if reason == "timeout" {
            failure = WatchCopy.couldntStart
        } else if reason.hasPrefix("blocked:") {
            failure = failureCopy(forBlocked: String(reason.dropFirst("blocked:".count)))
        } else if ["signin", "consent", "quota"].contains(reason) {
            failure = failureCopy(forBlocked: reason)
        } else {
            failure = reason
        }
    }

    func applyHardware(_ key: String) {
        switch Self.hardwareAction(
            key: key,
            listening: listening,
            paused: paused,
            ended: ended,
            saving: saveState == "saving",
            saved: saveMatched,
            starting: starting,
            pending: pending
        ) {
        case "start": startSession()
        case "stop": finish()
        case "pause": pause()
        case "resume": resume()
        default: break
        }
    }

    func toggle() {
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
        if paused {
            resume()
            return
        }
        if WatchRecorder.shared.isRunning {
            return
        }
        resetPcmBuffer()
        original = ""
        translation = ""
        previous = ""
        elapsedMs = 0
        localModeHeld = phoneModeSeen
        localMic = true
        send(action: "record")
        beginMic(hint: "Recording · Pause anytime, Done for report")
    }

    func pause() {
        guard pending == nil else { return }
        guard listening || WatchRecorder.shared.isRunning else { return }
        if let startedAt {
            elapsedMs = Date().timeIntervalSince(startedAt)
        }
        if Self.usesWatchMic(localStart: localMic) {
            WatchRecorder.shared.stop()
            stopRuntime()
        }
        pending = "pause"
        send(action: "pause")
        armPendingWait()
    }

    func resume() {
        guard paused, pending == nil else { return }
        pending = "resume"
        send(action: "resume")
        if Self.usesWatchMic(localStart: localMic) {
            beginMic(hint: reachable ? "Watch mic" : "Recording on Watch", resetClock: false, setListening: false)
        }
        armPendingWait()
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
        let resumeMic = listening && Self.usesWatchMic(localStart: localMic) && WatchRecorder.shared.isRunning
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
        guard listening, !paused, Self.usesWatchMic(localStart: localMic), !WatchRecorder.shared.isRunning else { return }
        beginMic(hint: reachable ? "Watch mic" : "Recording on Watch", resetClock: false)
    }

    func finish() {
        if let startedAt {
            elapsedMs = Date().timeIntervalSince(startedAt)
        }
        paused = false
        WatchRecorder.shared.stop()
        stopRuntime()
        listening = false
        ending = true
        WatchGlanceStore.clear()
        localModeHeld = false
        localMic = false
        send(action: "stop")
        flushUnsent()
        resetPcmBuffer()
        endWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.ending else { return }
            self.ending = false
            self.syncFromCapture(self.lastCapture)
            self.hint = WatchCopy.couldntEnd
        }
        endWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    func requestSave() {
        guard ended, saveState != "saving" else { return }
        saveRequestedId = sessionId
        saveState = "saving"
        send(action: "save")
        saveWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.saveState == "saved" || self.saveState == "failed" { return }
            self.saveState = "failed"
        }
        saveWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    func discardSession() {
        guard ended, saveState != "saving" else { return }
        send(action: "discard")
        discardWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.ended else { return }
            self.hint = WatchCopy.couldntDiscard
        }
        discardWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    func continueSession() {
        guard ended, !starting else { return }
        ending = false
        saveState = "none"
        saveRequestedId = nil
        saveWaitWork?.cancel()
        endWaitWork?.cancel()
        discardWaitWork?.cancel()
        startSessionFromCurrent(resetClock: false)
    }

    func startSession() {
        guard !listening, !paused, !starting else { return }
        saveWaitWork?.cancel()
        endWaitWork?.cancel()
        discardWaitWork?.cancel()
        resetPcmBuffer()
        original = ""
        translation = ""
        previous = ""
        elapsedMs = 0
        startedAt = nil
        ending = false
        ended = false
        saveState = "none"
        saveRequestedId = nil
        sessionId = ""
        localModeHeld = phoneModeSeen
        startSessionFromCurrent(resetClock: true)
    }

    private func startSessionFromCurrent(resetClock: Bool) {
        starting = true
        localMic = true
        failure = nil
        startBeganAt = Date()
        send(action: "start")
        if Self.usesWatchMic(localStart: localMic) {
            beginMic(
                hint: reachable ? "Watch mic" : "Recording on Watch",
                resetClock: resetClock,
                setListening: false
            )
        }
        armStartWait()
    }

    private func armStartWait() {
        startWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.starting else { return }
            let waited = Int((Date().timeIntervalSince(self.startBeganAt ?? Date())) * 1000)
            let outcome = Self.startOutcome(capture: self.lastCapture, blocked: self.blocked, waitedMs: max(waited, 8000))
            if outcome == "started" { return }
            if outcome.hasPrefix("blocked:") {
                self.failStart(reason: outcome)
            } else {
                self.failStart(reason: "timeout")
            }
        }
        startWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    private func armPendingWait() {
        pendingWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pending != nil else { return }
            self.pending = nil
            self.hint = WatchCopy.couldntChange
        }
        pendingWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    private func beginMic(hint: String, resetClock: Bool = true, setListening: Bool = true) {
        WatchRecorder.shared.start { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.stopRuntime()
                    self.listening = false
                    self.paused = false
                    self.startedAt = nil
                    WatchGlanceStore.clear()
                    if self.starting {
                        self.failStart(reason: error.localizedDescription)
                    } else {
                        self.hint = error.localizedDescription
                    }
                    return
                }
                if setListening {
                    self.listening = true
                    self.paused = false
                }
                if setListening, resetClock || self.startedAt == nil {
                    self.startedAt = Date()
                    self.elapsedMs = 0
                }
                if setListening {
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
                starting = false
                startWaitWork?.cancel()
                startBeganAt = nil
                ended = false
                failure = nil
                WKInterfaceDevice.current().play(.start)
                if Self.usesWatchMic(localStart: self.localMic), !WatchRecorder.shared.isRunning {
                    beginMic(
                        hint: reachable ? "Watch mic" : "Recording on Watch",
                        resetClock: false,
                        setListening: false
                    )
                }
            }
            if pending == "resume" {
                pending = nil
                pendingWaitWork?.cancel()
                WKInterfaceDevice.current().play(.click)
            }
            // Live session: the Watch shows listening. It does NOT seize the mic
            // from local Watch Start; a phone-initiated session just mirrors.
            if !listening || paused {
                let resuming = paused
                paused = false
                listening = true
                startedAt = Date().addingTimeInterval(-elapsedMs)
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
            if pending == "pause" {
                pending = nil
                pendingWaitWork?.cancel()
                WKInterfaceDevice.current().play(.click)
            }
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
            ending = false
            endWaitWork?.cancel()
            if starting { break }
            // Session capture is off. ended is owned by the payload, not this branch.
            if Self.offShouldStopRecorder(
                starting: starting,
                listening: listening,
                paused: paused,
                recorderRunning: WatchRecorder.shared.isRunning
            ) {
                WatchRecorder.shared.stop()
                stopRuntime()
                listening = false
                paused = false
                WatchGlanceStore.clear()
                localModeHeld = false
                localMic = false
                flushUnsent()
                resetPcmBuffer()
                if !ended {
                    startedAt = nil
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
        DispatchQueue.main.async { [weak self] in
            self?.sendPcm(data)
        }
    }

    private func sendPcm(_ data: Data) {
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

    func retry(id: String) {
        guard !id.isEmpty else { return }
        if !reachable {
            send(action: "retry", extra: ["id": id])
            return
        }
        if retrying { return }
        retrying = true
        send(action: "retry", extra: ["id": id])
        retryWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.retrying = false
        }
        retryWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    func markLatestVisible(_ visible: Bool) {
        latestVisible = visible
        if visible {
            pillShown = false
        }
    }

    func openLatest() {
        pillShown = false
        latestVisible = true
        scrollToId = history.first?.id ?? readingUnits.last?.id
    }

    func clearScroll() {
        scrollToId = nil
    }

    func reconnect(silent: Bool = false) {
        if reconnecting { return }
        if let lastReconnectAt, Date().timeIntervalSince(lastReconnectAt) < 2 { return }
        lastReconnectAt = Date()
        if !silent {
            reconnecting = true
        }
        reconnectFailed = false
        let payload: [String: Any] = ["action": "sync", "at": Date().timeIntervalSince1970]
        guard WCSession.isSupported() else {
            reconnecting = false
            reconnectFailed = true
            return
        }
        let session = WCSession.default
        guard session.isReachable else {
            reconnecting = false
            reconnectFailed = true
            return
        }
        session.sendMessage(payload, replyHandler: { [weak self] reply in
            DispatchQueue.main.async {
                self?.reconnecting = false
                var r = reply
                r.removeValue(forKey: "ok")
                self?.apply(r, live: false)
            }
        }, errorHandler: { [weak self] _ in
            DispatchQueue.main.async {
                self?.reconnecting = false
                self?.reconnectFailed = true
            }
        })
    }

    private func scheduleStaleCheck() {
        staleWatch?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.reachable {
                self.reconnect(silent: true)
            } else {
                self.objectWillChange.send()
            }
        }
        staleWatch = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 21, execute: work)
    }

    func send(action: String, extra: [String: Any] = [:]) {
        var payload: [String: Any] = ["action": action, "at": Date().timeIntervalSince1970]
        extra.forEach { payload[$0] = $1 }
        if Self.commandShouldSendMode(action), phoneModeSeen {
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
        var endedDropped = false
        if let endedVal = Self.payloadBool(payload["ended"]) {
            let wasEnded = ended
            ended = endedVal
            if endedVal {
                ending = false
                endWaitWork?.cancel()
            } else if wasEnded {
                endedDropped = true
                discardWaitWork?.cancel()
                saveWaitWork?.cancel()
                saveRequestedId = nil
                if saveState != "saving" {
                    saveState = "none"
                }
                if !listening, !paused {
                    hint = WatchCopy.ready
                }
            }
        }
        if let ms = Self.payloadInt(payload["elapsedMs"]), ms != 0 {
            elapsedMs = TimeInterval(ms) / 1000.0
        }
        if let save = payload["save"] as? String {
            saveState = save.isEmpty ? "none" : save
            if save == "saved" || save == "failed" {
                saveWaitWork?.cancel()
            }
        }
        if let sid = payload["sessionId"] as? String {
            sessionId = sid
        }
        if let engine = payload["engine"] as? String {
            self.engine = engine
        }
        if let blockedVal = payload["blocked"] as? String {
            blocked = blockedVal
        }
        if let failedVal = Self.payloadBool(payload["failed"]) {
            failed = failedVal
        }
        if let capture = payload["capture"] as? String {
            lastCapture = capture
            lastStatusAt = Date()
            reconnecting = false
            reconnectFailed = false
            scheduleStaleCheck()
            syncFromCapture(capture)
        }
        if endedDropped {
            let cap = payload["capture"] as? String ?? ""
            if cap != "listening", cap != "recording", cap != "paused" {
                startedAt = nil
                elapsedMs = 0
            }
        }
        if starting, !blocked.isEmpty {
            let waited = Int((Date().timeIntervalSince(startBeganAt ?? Date())) * 1000)
            let outcome = Self.startOutcome(capture: lastCapture, blocked: blocked, waitedMs: waited)
            if outcome.hasPrefix("blocked:") {
                failStart(reason: outcome)
            }
        }
        if let hint = payload["hint"] as? String, !hint.isEmpty, !paused, !ended, !ending, !starting {
            self.hint = hint
        }
        if let original = payload["original"] as? String {
            self.original = original
        }
        if let translation = payload["translation"] as? String {
            self.translation = translation
        }
        if retrying, !failed || !translation.isEmpty {
            retrying = false
            retryWaitWork?.cancel()
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
            let next = rows.compactMap { row -> WatchHistItem? in
                guard let row = row as? [String: Any] else { return nil }
                let id = (row["id"] as? String) ?? ""
                let title = (row["title"] as? String) ?? ""
                let text = (row["text"] as? String) ?? ""
                let itemFailed = Self.payloadBool(row["failed"]) ?? false
                guard !id.isEmpty, !text.isEmpty || !title.isEmpty else { return nil }
                return WatchHistItem(id: id, title: title, text: text, failed: itemFailed)
            }
            self.history = next
            if next.isEmpty {
                pillShown = false
                lastLatestId = ""
                latestVisible = true
            } else {
                let latestId = next.first?.id ?? ""
                if lastLatestId.isEmpty {
                    lastLatestId = latestId
                } else if !latestId.isEmpty, latestId != lastLatestId {
                    let decision = Self.readingAnchor(atLatest: latestVisible, newUnit: true, pillShown: pillShown)
                    pillShown = decision.pill
                    if decision.scroll {
                        scrollToId = latestId
                    }
                    lastLatestId = latestId
                }
            }
        }
    }

    private static func payloadBool(_ raw: Any?) -> Bool? {
        if let value = raw as? Bool { return value }
        if let value = raw as? NSNumber { return value.boolValue }
        return nil
    }

    private static func payloadInt(_ raw: Any?) -> Int? {
        if let value = raw as? Int { return value }
        if let value = raw as? NSNumber { return value.intValue }
        if let value = raw as? Double { return Int(value) }
        return nil
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
            let wasReachable = self.reachable
            self.reachable = session.isReachable
            if Self.liveStreamShouldReset(listening: self.listening, reachable: session.isReachable) {
                self.pcmLock.lock()
                self.liveStreamed = false
                self.pcmLock.unlock()
            }
            if !wasReachable, session.isReachable {
                self.reconnect()
            }
            if self.listening {
                if self.original.isEmpty, self.translation.isEmpty {
                    self.hint = session.isReachable ? "Watch mic" : "Recording on Watch"
                }
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
