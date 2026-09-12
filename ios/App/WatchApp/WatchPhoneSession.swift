import Combine
import Foundation
#if !PCM_REPLAY_TESTING
import AVFoundation
import WatchConnectivity
import WatchKit
#endif

final class WatchPhoneSession: NSObject, ObservableObject, WCSessionDelegate, WKExtendedRuntimeSessionDelegate, AVAudioPlayerDelegate {
    static let shared = WatchPhoneSession(sendBuffer: WatchSendBuffer(), pcmStore: WatchPcmStore())

    @Published var listening = false
    @Published var starting = false
    @Published var paused = false
    @Published var startedAt: Date?
    @Published var elapsedMs: TimeInterval = 0
    @Published var hint = "Watch mic — tap Listen"
    @Published var original = ""
    @Published var translation = ""
    @Published var previous = ""
    @Published var copyId = "" {
        didSet {
            if copyId != oldValue { resetCopyPages() }
        }
    }
    /// Pages of the live copy, by page index. The phone sends the copy paged so a
    /// long original/translation is never clipped; the Watch shows the longest
    /// prefix it holds (`copyPageTotal` bounds the join).
    private var copyOriginalPages: [Int: String] = [:]
    private var copyTranslationPages: [Int: String] = [:]
    private var copyPageTotal = 0
    @Published var history: [WatchHistItem] = []
    @Published var reachable = false
    @Published var speechLive = false
    @Published var speechVoice = "female"
    @Published var offeringSave = false
    @Published var saving = false
    @Published var saveFailed = false
    @Published var savedAck = false
    @Published var pendingSync = false
    @Published var langPair = "Auto → CH"
    @Published var mode = "meeting"
    @Published var draining = false
    @Published var drainFailed = false
    @Published var pcmStalled = false
    @Published var pcmStallText = ""
    @Published var storageFailed = false
    @Published var storageErrorText = ""
    @Published var pcmRejected = false
    @Published var pcmRejectText = ""

    /// Unfinished (non-current) capture recordings on disk, for the storage
    /// management page (issue #165 review P2-7). Each carries an identifiable
    /// size + modified time; the user must confirm before delete.
    var unfinishedCaptureList: [WatchPcmStore.CaptureInfo] {
        pcmStore.unfinishedCaptures()
    }

    /// Delete a user-confirmed, non-current capture. Returns the freed bytes (0 if
    /// refused — e.g. the current recording). The current capture is never deleted.
    func deleteUnfinishedCapture(_ id: String) -> Int {
        let inSystem = WCSession.default.outstandingFileTransfers.contains {
            $0.file.metadata?["captureId"] as? String == id
        }
        let inLocal = outstandingTransfers.keys.contains { $0.hasPrefix(id + "|") }
        guard !inSystem, !inLocal else {
            storageErrorText = WatchCopy.transferBusy
            return 0
        }
        let freed = pcmStore.deleteCapture(id)
        storageErrorText = freed > 0 ? "" : WatchCopy.deleteFailed
        return freed
    }

    private var localModeHeld = false
    private var phoneModeSeen = false
    private var speechPlayer: AVAudioPlayer?
    private var savedAckWork: DispatchWorkItem?
    private var saveWaitWork: DispatchWorkItem?
    private var saveRequestId = ""
    private var saveRequestCaptureId = ""
    private var saveTerminal = ""
    private var saveDismissed = false
    private var phoneSessionId = ""
    private var startBeganAt: Date?
    private var startWaitWork: DispatchWorkItem?
    private var drainWaitWork: DispatchWorkItem?
    private var transferTimer: Timer?
    private var pendingSaveOffer = false
    private var saveAfterDrain = false
    private var pcmHeld = false
    private var phonePcmReady = false
    private let pcmStore: WatchPcmStore
    private let sendBuffer: WatchSendBuffer
    private let sendQueue = DispatchQueue(label: "nod.watch.pcm.send")
    /// Leftover Watch-disk shards from older builds. New captures never write here.
    private var lastTransferAt: [Int: Date] = [:]
    private var outstandingTransfers: [String: WCSessionFileTransfer] = [:]

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

    convenience init(pcmStore: WatchPcmStore, connect: Bool = true) {
        self.init(sendBuffer: WatchSendBuffer(), pcmStore: pcmStore, connect: connect)
    }

    init(sendBuffer: WatchSendBuffer, pcmStore: WatchPcmStore, connect: Bool = true) {
        self.sendBuffer = sendBuffer
        self.pcmStore = pcmStore
        super.init()
        WatchRecorder.shared.onPcm = { [weak self] data in
            guard let self else { return }
            self.sendQueue.async { self.sendPcm(data) }
        }
        guard connect, WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        DispatchQueue.main.async { [weak self] in
            self?.transferTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.flushUnacked()
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
        saved: Bool,
        pendingSync: Bool
    ) -> String {
        if offeringSave || saved || pendingSync { return "" }
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
            saved: savedAck,
            pendingSync: pendingSync
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
        sendBuffer.beginCapture()
        phoneSessionId = ""
        phonePcmReady = false
        storageFailed = false
        storageErrorText = ""
        pcmRejected = false
        pcmRejectText = ""
        pcmStalled = false
        pcmStallText = ""
        lastTransferAt.removeAll()
        original = ""
        translation = ""
        previous = ""
        copyId = ""
        resetCopyPages()
        elapsedMs = 0
        localModeHeld = phoneModeSeen
        starting = true
        startBeganAt = Date()
        hint = WatchCopy.starting
        send(action: "record")
        localWatchMic = true
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
        paused = false
        WatchRecorder.shared.stop()
        stopRuntime()
        listening = false
        startedAt = nil
        elapsedMs = 0
        WatchGlanceStore.clear()
        offeringSave = false
        pendingSync = false
        savedAck = false
        saving = false
        saveFailed = false
        localModeHeld = false
        localWatchMic = false
        saveAfterDrain = false
        drainFailed = false
        pcmHeld = false
        if pcmRejected {
            draining = false
            drainFailed = true
            return
        }
        draining = true
        hint = WatchCopy.sendingLast
        sendQueue.async { [weak self] in
            guard let self else { return }
            self.sendBuffer.freeze()
            self.flushUnackedLocked()
            let last = self.sendBuffer.lastByte
            DispatchQueue.main.async {
                // #193 item 8: Translate has no Save concept, so a Translate
                // session must not offer Save on the wrist either — same rule
                // the phone's More sheet now applies. Meeting / Lecture /
                // Interview keep the existing offer.
                self.pendingSaveOffer = last > 0 && self.mode != "translate"
                self.armDrainWait()
                self.send(action: "drain")
                self.maybeCompleteDrain()
            }
        }
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
        pendingSync = false
        savedAck = false
        saving = true
        saveFailed = false
        saveDismissed = false
        saveTerminal = ""
        saveRequestId = Self.savePinnedId(pinnedId: saveRequestId, phoneSessionId: phoneSessionId)
        if saveRequestCaptureId.isEmpty, !sendBuffer.captureId.isEmpty {
            saveRequestCaptureId = sendBuffer.captureId
        }
        hint = WatchCopy.saving
        armSaveWait()
        guard Self.saveShouldSend(saveRequestId) else { return }
        send(action: "save")
    }

    func declineSave() {
        saveWaitWork?.cancel()
        saveWaitWork = nil
        offeringSave = false
        pendingSync = false
        savedAck = false
        saving = false
        saveFailed = false
        saveRequestId = ""
        saveRequestCaptureId = ""
        saveTerminal = ""
        saveDismissed = false
        hint = WatchCopy.ready
        send(action: "discard")
    }

    func finishPendingSave() {
        saveWaitWork?.cancel()
        saveWaitWork = nil
        offeringSave = false
        pendingSync = false
        saving = false
        saveFailed = false
        savedAck = false
        saveDismissed = true
        hint = WatchCopy.ready
    }

    func startSession() {
        guard !listening, !paused, !starting else { return }
        savedAckWork?.cancel()
        saveWaitWork?.cancel()
        saveWaitWork = nil
        resetPcmBuffer()
        sendBuffer.beginCapture()
        phoneSessionId = ""
        phonePcmReady = false
        storageFailed = false
        storageErrorText = ""
        pcmRejected = false
        pcmRejectText = ""
        pcmStalled = false
        pcmStallText = ""
        lastTransferAt.removeAll()
        draining = false
        drainFailed = false
        pcmHeld = false
        pendingSaveOffer = false
        saveAfterDrain = false
        original = ""
        translation = ""
        previous = ""
        copyId = ""
        resetCopyPages()
        elapsedMs = 0
        offeringSave = false
        pendingSync = false
        savedAck = false
        saving = false
        saveFailed = false
        saveRequestId = ""
        saveRequestCaptureId = ""
        saveTerminal = ""
        saveDismissed = false
        localModeHeld = phoneModeSeen
        starting = true
        startBeganAt = Date()
        hint = WatchCopy.starting
        send(action: "start")
        localWatchMic = true
        armStartWait()
    }

    /// Phone capture wins until 8s. Persist-ready is required before Recording.
    static func startOutcome(capture: String, pcmReady: Bool, waitedMs: Int) -> String {
        if (capture == "listening" || capture == "recording"), pcmReady { return "started" }
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
        phonePcmReady = false
        WatchRecorder.shared.stop()
        stopRuntime()
        resetPcmBuffer()
        sendBuffer.discardCapture()
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

    struct WatchSaveUi: Equatable {
        var terminal: String
        var dismissed: Bool
        var pendingSync: Bool
        var offeringSave: Bool
        var saveFailed: Bool
        var savedAck: Bool
        var saving: Bool
        var hint: String
    }

    /// Terminal History/local face stays put. Done (dismissed) ignores late local/failed.
    static func reduceSaveStatus(_ ui: WatchSaveUi, save: String) -> WatchSaveUi {
        if ui.terminal == "saved", save != "saved" { return ui }
        if ui.dismissed, save != "saved" { return ui }
        var next = ui
        next.saving = false
        if save == "saved" {
            next.terminal = "saved"
            next.pendingSync = false
            next.offeringSave = false
            next.saveFailed = false
            next.savedAck = true
            next.hint = WatchCopy.savedHistory
            return next
        }
        if save == "local" {
            next.terminal = "local"
            next.pendingSync = true
            next.offeringSave = false
            next.saveFailed = false
            next.hint = WatchCopy.pendingSync
            return next
        }
        if save == "failed" {
            next.terminal = "failed"
            next.pendingSync = false
            next.offeringSave = true
            next.saveFailed = true
            next.hint = WatchCopy.saveFailed
            return next
        }
        return ui
    }

    private func applySaveStatus(_ save: String, sessionId: String) {
        guard !saveRequestId.isEmpty, !sessionId.isEmpty, sessionId == saveRequestId else { return }
        let before = WatchSaveUi(
            terminal: saveTerminal,
            dismissed: saveDismissed,
            pendingSync: pendingSync,
            offeringSave: offeringSave,
            saveFailed: saveFailed,
            savedAck: savedAck,
            saving: saving,
            hint: hint
        )
        let next = Self.reduceSaveStatus(before, save: save)
        if next == before { return }
        saveWaitWork?.cancel()
        saveWaitWork = nil
        saveTerminal = next.terminal
        pendingSync = next.pendingSync
        offeringSave = next.offeringSave
        saveFailed = next.saveFailed
        savedAck = next.savedAck
        saving = next.saving
        hint = next.hint
        if next.savedAck, !before.savedAck {
            scheduleReady()
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

    static func saveWireMessage(sessionId: String, captureId: String = "") -> (sessionId: String, captureId: String)? {
        if sessionId.isEmpty { return nil }
        return (sessionId, captureId)
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
                if !phonePcmReady { return }
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
                if Self.usesWatchMic(localStart: localWatchMic), !WatchRecorder.shared.isRunning {
                    beginMic(hint: hint, resetClock: false)
                }
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
                if !offeringSave, !savedAck, !pendingSync {
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

    /// Whether a page may be applied at all. Pages of the copy on screen always
    /// extend it; a page of another copy only when it is page 0, because a copy
    /// starts at page 0. A late page of a superseded copy (New / Stop) can
    /// therefore never put the old translation back on the Watch.
    static func copyPageApplies(incomingId: String, currentId: String, pageIndex: Int) -> Bool {
        if incomingId == currentId { return true }
        return pageIndex == 0
    }

    /// Whether an incoming page begins a new copy instead of extending the copy on
    /// screen. A different copy id always restarts. Page 0 restarts only when it
    /// supersedes a page 0 we already hold and its text changed: a page 0
    /// re-delivered by the OS (the application context after the Watch app
    /// relaunches) must keep the pages queued behind it.
    static func copyPageStartsNewCopy(
        incomingId: String,
        currentId: String,
        pageIndex: Int,
        incomingOriginal: String,
        incomingTranslation: String,
        storedOriginal: String?,
        storedTranslation: String?
    ) -> Bool {
        if incomingId != currentId { return true }
        guard pageIndex == 0 else { return false }
        guard let storedOriginal, let storedTranslation else { return false }
        return incomingOriginal != storedOriginal || incomingTranslation != storedTranslation
    }

    /// Drop paged copy state. `copyId`'s didSet calls this on a copy change; the
    /// session reset points (New / Stop) also clear it explicitly.
    private func resetCopyPages() {
        copyOriginalPages.removeAll()
        copyTranslationPages.removeAll()
        copyPageTotal = 0
    }

    /// Longest run of pages held from index 0. A missing page shows its prefix
    /// rather than gluing a later page onto the head.
    private func joinedCopy(_ pages: [Int: String]) -> String {
        guard copyPageTotal > 0 else { return "" }
        var text = ""
        for index in 0..<copyPageTotal {
            guard let page = pages[index] else { break }
            text += page
        }
        return text
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

    private func sendPcm(_ data: Data) {
        let snap = sendBuffer.snapshot()
        guard !snap.frozen, !snap.captureId.isEmpty else { return }
        guard !pcmRejected, !storageFailed else { return }
        guard let offset = sendBuffer.append(data) else {
            DispatchQueue.main.async { self.pauseForUnreliableLink(WatchCopy.linkLost) }
            return
        }
        let session = WCSession.default
        let reachable = session.activationState == .activated && session.isReachable
        if !reachable {
            DispatchQueue.main.async { self.pauseForUnreliableLink(WatchCopy.linkLost) }
            return
        }
        pcmLock.lock()
        liveStreamed = true
        pcmLock.unlock()
        var payload: [String: Any] = [
            "pcm": data.base64EncodedString(),
            "kind": "pcm16",
            "sr": "16000",
            "captureId": snap.captureId,
            "byteOffset": String(offset),
        ]
        let sessionId = sendBuffer.sessionId
        if !sessionId.isEmpty {
            payload["sessionId"] = sessionId
        }
        session.sendMessage(payload, replyHandler: { [weak self] reply in
            DispatchQueue.main.async { self?.apply(reply, live: false) }
        }, errorHandler: { [weak self] _ in
            DispatchQueue.main.async {
                self?.pauseForUnreliableLink(WatchCopy.linkLost)
            }
        })
        _ = offset
    }

    private func pauseForUnreliableLink(_ message: String) {
        guard listening || WatchRecorder.shared.isRunning, !paused else {
            if draining { flushUnacked() }
            return
        }
        WatchRecorder.shared.stop()
        stopRuntime()
        if let startedAt {
            elapsedMs = Date().timeIntervalSince(startedAt)
        }
        listening = false
        paused = true
        WatchGlanceStore.setPaused(elapsed: elapsedMs)
        hint = message
        send(action: "pause")
        flushUnacked()
    }

    private func flushUnacked() {
        sendQueue.async { [weak self] in
            self?.flushUnackedLocked()
        }
    }

    private func flushUnackedLocked() {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        let capture = sendBuffer.captureId
        let sessionId = sendBuffer.sessionId
        for frame in sendBuffer.unackedFrames() {
            var payload: [String: Any] = [
                "pcm": frame.data.base64EncodedString(),
                "kind": "pcm16",
                "sr": "16000",
                "captureId": capture,
                "byteOffset": String(frame.offset),
            ]
            if !sessionId.isEmpty {
                payload["sessionId"] = sessionId
            }
            session.sendMessage(payload, replyHandler: { [weak self] reply in
                DispatchQueue.main.async { self?.apply(reply, live: false) }
            }, errorHandler: { _ in })
        }
    }

    /// "captureId|seq" — leftover Watch-disk transfers from older builds only.
    static func transferKey(capture: String, seq: Int) -> String {
        "\(capture)|\(seq)"
    }

    static func hasOutstandingTransfer(_ transfers: [String: Any], capture: String, seq: Int) -> Bool {
        transfers[transferKey(capture: capture, seq: seq)] != nil
    }

    private func flushUnsent() {
        flushUnacked()
    }

    private func armDrainWait() {
        drainWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.draining else { return }
            self.draining = false
            self.drainFailed = true
            self.hint = WatchCopy.drainFailed
        }
        drainWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
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
        guard draining, !drainFailed, sendBuffer.snapshot().frozen else { return }
        let snap = sendBuffer.snapshot()
        if snap.lastByte == 0 {
            completeDrain()
            return
        }
        guard snap.ackedByte >= snap.lastByte || pcmHeld else { return }
        completeDrain()
    }

    private func completeDrain() {
        drainWaitWork?.cancel()
        drainWaitWork = nil
        draining = false
        drainFailed = false
        send(action: "stop")
        let offer = pendingSaveOffer && mode != "translate"
        pendingSaveOffer = false
        if saveAfterDrain {
            saveAfterDrain = false
            offeringSave = offer
            confirmSave()
            return
        }
        offeringSave = offer
        hint = offer ? WatchCopy.savedLocal : WatchCopy.ready
    }

    /// User chooses to leave an incomplete capture. Keep its files, detach it
    /// from the active recording, and return to a usable Start/storage page.
    func leaveIncomplete() {
        guard drainFailed || pcmRejected || storageFailed else { return }
        WatchRecorder.shared.stop()
        stopRuntime()
        drainWaitWork?.cancel()
        drainWaitWork = nil
        if !pcmRejected { send(action: "stop") }
        pcmStore.retireCapture()
        sendBuffer.discardCapture()
        listening = false
        paused = false
        starting = false
        draining = false
        drainFailed = false
        offeringSave = false
        pendingSync = false
        pendingSaveOffer = false
        saveAfterDrain = false
        hint = WatchCopy.ready
    }

    private func cancelCaptureTransfers(_ id: String) {
        for transfer in WCSession.default.outstandingFileTransfers {
            if transfer.file.metadata?["captureId"] as? String == id { transfer.cancel() }
        }
    }

    func retryDrain() {
        // A terminal rejection (session ended server-side) is not retryable: the
        // session is already over, so Retry must not feed old audio into a dead
        // session or into a new capture (issue #165 P2-8).
        guard !pcmRejected else { return }
        drainFailed = false
        pcmHeld = false
        draining = true
        hint = WatchCopy.sendingLast
        lastTransferAt.removeAll()
        armDrainWait()
        flushUnacked()
        send(action: "drain")
        maybeCompleteDrain()
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
        if action == "start" || action == "record" || action == "drain" || action == "discard", !sendBuffer.captureId.isEmpty {
            payload["captureId"] = sendBuffer.captureId
        }
        if action == "drain" {
            payload["lastByte"] = String(sendBuffer.lastByte)
            if !sendBuffer.sessionId.isEmpty {
                payload["sessionId"] = sendBuffer.sessionId
            }
        }
        if action == "save" {
            guard let wire = Self.saveWireMessage(sessionId: saveRequestId, captureId: saveRequestCaptureId) else { return }
            payload["sessionId"] = wire.sessionId
            if !wire.captureId.isEmpty {
                payload["captureId"] = wire.captureId
            }
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
                self.hint = WatchCopy.sendingLast
            } else if self.drainFailed {
                self.hint = WatchCopy.drainFailed
            } else if self.listening {
                self.hint = session.isReachable ? "Watch mic" : WatchCopy.linkLost
            } else if self.paused {
                if self.hint != WatchCopy.linkLost {
                    self.hint = WatchCopy.paused
                }
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
        // Validate against the bound capture BEFORE applying any top-level
        // sessionId from this payload. A stale status cannot authenticate itself.
        if Self.flag(payload, "pcmRejected") {
            let sid = payload["pcmRejectSessionId"] as? String ?? ""
            let cap = payload["pcmRejectCaptureId"] as? String ?? ""
            guard !sid.isEmpty, !cap.isEmpty,
                  sid == sendBuffer.sessionId, cap == sendBuffer.captureId else { return }
        }
        if let sessionId = payload["sessionId"] as? String, !sessionId.isEmpty {
            phoneSessionId = sessionId
            sendBuffer.bindSession(sessionId)
            pcmStore.bindSession(sessionId)
            let pin = Self.savePinIncoming(saving: saving, pinnedId: saveRequestId, incomingSessionId: sessionId)
            if pin.send {
                saveRequestId = pin.pinnedId
                if saveRequestCaptureId.isEmpty {
                    saveRequestCaptureId = sendBuffer.captureId
                }
                send(action: "save")
            }
        }
        if Self.flag(payload, "pcmReady") {
            let readyCapture = (payload["pcmAckCaptureId"] as? String)
                ?? (payload["captureId"] as? String)
                ?? ""
            if readyCapture.isEmpty || readyCapture == sendBuffer.captureId {
                phonePcmReady = true
            }
        }
        if let ack = Self.intField(payload, "pcmAckByte"), ack >= 0 {
            let ackCapture = (payload["pcmAckCaptureId"] as? String)
                ?? (payload["captureId"] as? String)
                ?? ""
            let ackSession = (payload["pcmAckSessionId"] as? String)
                ?? (payload["sessionId"] as? String)
                ?? ""
            if Self.pcmAckApplies(
                liveCaptureId: sendBuffer.captureId,
                liveSessionId: sendBuffer.sessionId,
                ackCaptureId: ackCapture.isEmpty ? sendBuffer.captureId : ackCapture,
                ackSessionId: ackSession
            ) || (ackCapture == sendBuffer.captureId) {
                sendBuffer.ack(ack, captureId: sendBuffer.captureId, sessionId: ackSession)
                if sendBuffer.snapshot().frozen, ack >= sendBuffer.lastByte {
                    pcmHeld = true
                    maybeCompleteDrain()
                }
            }
        }
        if Self.flag(payload, "pcmSealed") {
            let sealCapture = (payload["pcmAckCaptureId"] as? String)
                ?? (payload["captureId"] as? String)
                ?? sendBuffer.captureId
            if sealCapture == sendBuffer.captureId {
                pcmHeld = true
                maybeCompleteDrain()
            }
        }
        if Self.flag(payload, "pcmDrained") {
            // Cloud drain is phone-side only. Watch End already completed on persist.
        }
        if Self.flag(payload, "pcmStalled") {
            let stallSession = (payload["pcmStallSessionId"] as? String) ?? ""
            if stallSession.isEmpty || phoneSessionId.isEmpty || stallSession == phoneSessionId {
                let message = (payload["pcmStallText"] as? String)
                    ?? "Recording incomplete — audio may be missing"
                pcmStalled = true
                pcmStallText = message
                if !message.isEmpty, !offeringSave, !savedAck, !saving, !saveFailed, !pendingSync, !starting {
                    hint = message
                }
            }
        }
        if Self.flag(payload, "pcmRejected") {
            pcmRejected = true
            pcmRejectText = payload["pcmRejectText"] as? String ?? WatchCopy.pcmRejected
            WatchRecorder.shared.stop()
            stopRuntime()
            sendBuffer.freeze()
            listening = false
            paused = false
            localWatchMic = false
            drainWaitWork?.cancel()
            drainWaitWork = nil
            draining = false
            drainFailed = true
            hint = pcmRejectText
            cancelCaptureTransfers(pcmStore.captureId)
            // The status also carries old capture/save fields; do not let them
            // restart capture or offer Save after this terminal failure.
            return
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
        if let capture = payload["capture"] as? String, !pcmRejected, !storageFailed {
            syncFromCapture(capture)
        }
        if let hint = payload["hint"] as? String, !hint.isEmpty, !paused, !offeringSave, !savedAck, !saving, !saveFailed, !pendingSync, !starting, !localWatchMic, !draining, !drainFailed, !pcmStalled {
            self.hint = hint
        }
        let pageTotal = Self.intField(payload, "copySegTotal") ?? 0
        let pageIndex = Self.intField(payload, "copySegIndex") ?? -1
        let paged = pageTotal > 0 && pageIndex >= 0 && pageIndex < pageTotal
        let pageCopyId = payload["copyId"] as? String ?? copyId
        if paged {
            // A late page of a superseded copy is ignored for the copy fields only:
            // the rest of the payload (capture, hint, save, speech) still applies.
            if Self.copyPageApplies(incomingId: pageCopyId, currentId: copyId, pageIndex: pageIndex) {
                let incomingId = pageCopyId
                let incomingOriginal = payload["original"] as? String ?? ""
                let incomingTranslation = payload["translation"] as? String ?? ""
                if Self.copyPageStartsNewCopy(
                    incomingId: incomingId,
                    currentId: copyId,
                    pageIndex: pageIndex,
                    incomingOriginal: incomingOriginal,
                    incomingTranslation: incomingTranslation,
                    storedOriginal: copyOriginalPages[0],
                    storedTranslation: copyTranslationPages[0]
                ) {
                    resetCopyPages()
                    copyId = incomingId
                }
                copyPageTotal = pageTotal
                copyOriginalPages[pageIndex] = incomingOriginal
                copyTranslationPages[pageIndex] = incomingTranslation
                original = joinedCopy(copyOriginalPages)
                translation = joinedCopy(copyTranslationPages)
            }
        } else {
            // Unpaged payload: the whole copy (backwards compatible), so drop any
            // pages a previous paged copy left behind.
            if payload["original"] != nil || payload["translation"] != nil {
                resetCopyPages()
            }
            if let original = payload["original"] as? String {
                self.original = original
            }
            if let translation = payload["translation"] as? String {
                self.translation = translation
            }
            if let copyId = payload["copyId"] as? String {
                self.copyId = copyId
            }
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
            if self.listening, !session.isReachable {
                self.pauseForUnreliableLink(WatchCopy.linkLost)
            } else if self.draining {
                self.flushUnacked()
            } else if self.paused {
                if session.isReachable {
                    self.flushUnacked()
                }
                if self.hint != WatchCopy.linkLost {
                    self.hint = WatchCopy.paused
                }
            } else if self.listening {
                if self.original.isEmpty, self.translation.isEmpty {
                    self.hint = session.isReachable ? "Watch mic" : WatchCopy.linkLost
                }
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

    /// Outgoing transferFile completion. Releases the matching in-flight record so
    /// the shard may be re-sent later if needed; it NEVER deletes the original —
    /// a successful transfer means the bytes reached the phone, not that STT
    /// drained. On error the shard stays in unackedShards for a bounded Retry,
    /// not an immediate infinite reschedule (issue #165 review P2-3).
    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        DispatchQueue.main.async {
            // WCSessionFileTransfer on watchOS exposes only `progress` — no
            // transferIdentifier or fileURL. The completion delivers the same
            // instance `transferFile` returned, so match the in-flight record by
            // object identity (unique per shard).
            for (key, ft) in self.outstandingTransfers where ft === fileTransfer {
                self.outstandingTransfers.removeValue(forKey: key)
            }
        }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
}
