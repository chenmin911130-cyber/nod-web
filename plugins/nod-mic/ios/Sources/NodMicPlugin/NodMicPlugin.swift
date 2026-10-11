import AVFoundation
import Capacitor
import Foundation
import UserNotifications

@objc(NodMicPlugin)
public class NodMicPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NodMicPlugin"
    public let jsName = "NodMic"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isActive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startKeepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopKeepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startUplink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopUplink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPendingCaptures", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePendingCapture", returnType: CAPPluginReturnPromise),
    ]

    private var engine = AVAudioEngine()
    private var running = false
    private var captureGen = 0
    private let targetSampleRate: Double = 16_000
    private var converter: AVAudioConverter?
    private let listenNotificationId = "nod.listening"
    // #35: iOS only keeps an app alive in the background (UIBackgroundModes: audio)
    // while audio is actually PLAYING. The mic tap only records — it never plays —
    // so a lock-screen suspends the process/WKWebView and PCM stops reaching the
    // server (→ 25s zero-PCM → "No microphone audio …"). A looping SILENT clip
    // (all-zero PCM) keeps the session genuinely in the playing state, so the app
    // and the JS stays alive and the tap keeps firing. Inaudible by construction.
    private var silentPlayer: AVAudioPlayer?
    private var keepAlive = false
    private var interruptionObserver: NSObjectProtocol?
    private var uplinkLinkObserver: NSObjectProtocol?

    @objc func start(_ call: CAPPluginCall) {
        if running {
            call.resolve()
            return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Microphone permission denied")
                return
            }
            DispatchQueue.main.async {
                self.captureGen += 1
                self.startCapture(call, attempt: 0, gen: self.captureGen)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.captureGen += 1
            self.teardown()
            self.clearListeningNotification()
            call.resolve()
        }
    }

    @objc func isActive(_ call: CAPPluginCall) {
        call.resolve(["active": running])
    }

    @objc func startKeepAlive(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                if self.running {
                    self.startSilentLoop()
                    self.keepAlive = true
                    call.resolve()
                    return
                }
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true)
                self.startSilentLoop()
                self.keepAlive = true
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func stopKeepAlive(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.keepAlive = false
            if self.running {
                call.resolve()
                return
            }
            self.stopSilentLoop()
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.resumeAfterInterruption()
            call.resolve()
        }
    }

    @objc func startUplink(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("Missing url")
            return
        }
        AudioUplink.shared.start(url: url) { error in
            if let error {
                call.reject(error.localizedDescription)
            } else {
                call.resolve()
            }
        }
    }

    @objc func stopUplink(_ call: CAPPluginCall) {
        AudioUplink.shared.stop()
        call.resolve()
    }

    @objc func listPendingCaptures(_ call: CAPPluginCall) {
        let rows = WatchPcmIngest.shared.listCaptures().map { info -> [String: Any] in
            [
                "captureId": info.captureId,
                "sessionId": info.sessionId,
                "bytes": info.bytes,
                "sealed": info.sealed,
                "intent": info.intent,
                "modifiedAt": ISO8601DateFormatter().string(from: info.modifiedAt),
                // #196: "" means unknown (capture written before the mode was recorded).
                "mode": info.mode,
            ]
        }
        call.resolve(["captures": rows])
    }

    @objc func deletePendingCapture(_ call: CAPPluginCall) {
        let id = call.getString("captureId") ?? ""
        let sid = call.getString("sessionId") ?? ""
        var freed = 0
        if !id.isEmpty { freed += WatchPcmIngest.shared.deleteCapture(id) }
        if !sid.isEmpty { freed += WatchPcmIngest.shared.deleteCaptures(sessionId: sid) }
        call.resolve(["freed": freed])
    }

    override public func load() {
        super.load()
        _ = AudioUplink.shared
        _ = WatchPcmIngest.shared
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        }
        uplinkLinkObserver = NotificationCenter.default.addObserver(
            forName: .nodUplinkLink,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self else { return }
            let enabled = note.userInfo?["enabled"] as? Bool ?? false
            let connected = note.userInfo?["connected"] as? Bool ?? false
            let pendingMs = note.userInfo?["pendingMs"] as? Int ?? 0
            DispatchQueue.main.async {
                self.notifyListeners("uplinkState", data: [
                    "enabled": enabled,
                    "connected": connected,
                    "pendingMs": pendingMs,
                ])
            }
        }
    }

    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        if type == .began { return }
        resumeAfterInterruption()
    }

    private func resumeAfterInterruption() {
        guard running || keepAlive else { return }
        do {
            if running {
                try beginCapture()
                return
            }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            if silentPlayer?.isPlaying != true {
                stopSilentLoop()
                startSilentLoop()
            }
        } catch {
            /* next resume() / start() retries */
        }
    }

    private func startCapture(_ call: CAPPluginCall, attempt: Int, gen: Int) {
        guard gen == captureGen else {
            call.reject("Microphone stopped")
            return
        }
        do {
            try beginCapture()
            showListeningNotification()
            call.resolve()
        } catch {
            teardown()
            // First listen after Watch/TTS often sees sampleRate 0. Retry
            // before telling the JS layer the mic failed.
            if attempt < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                    guard let self else { return }
                    self.startCapture(call, attempt: attempt + 1, gen: gen)
                }
                return
            }
            call.reject(error.localizedDescription)
        }
    }

    private func beginCapture() throws {
        let session = AVAudioSession.sharedInstance()
        // Hear the room (Mac speakers, people nearby). Do not use voiceChat /
        // HFP — those switch to the headphone mic and cancel "echo" so YouTube
        // playing from a laptop never reaches STT.
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.defaultToSpeaker, .mixWithOthers]
        )
        try session.setActive(true, options: [])
        if let builtin = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtin)
        }
        try? session.overrideOutputAudioPort(.speaker)

        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.reset()
        engine.prepare()

        var input = engine.inputNode
        var format = input.inputFormat(forBus: 0)
        if format.sampleRate <= 0 || format.channelCount <= 0 {
            engine = AVAudioEngine()
            engine.prepare()
            input = engine.inputNode
            format = input.inputFormat(forBus: 0)
        }
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(
                domain: "NodMic",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Microphone is not ready"]
            )
        }

        let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true
        )
        guard let outputFormat else {
            throw NSError(
                domain: "NodMic",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Could not build PCM format"]
            )
        }
        converter = AVAudioConverter(from: format, to: outputFormat)

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.emitPcm(buffer, outputFormat: outputFormat)
        }

        try engine.start()
        running = true
        if self.silentPlayer?.isPlaying != true {
            self.stopSilentLoop()
        }
        startSilentLoop()
    }

    private func emitPcm(_ buffer: AVAudioPCMBuffer, outputFormat: AVAudioFormat) {
        guard running else { return }
        guard let converter else { return }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let outFrames = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outFrames) else { return }
        var error: NSError?
        var supplied = false
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        }
        converter.convert(to: out, error: &error, withInputFrom: inputBlock)
        if error != nil { return }
        guard let channel = out.int16ChannelData?[0], out.frameLength > 0 else { return }
        let data = Data(bytes: channel, count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        if AudioUplink.shared.isEnabled {
            AudioUplink.shared.enqueue(data)
            return
        }
        let payload = data.base64EncodedString()
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("pcm", data: ["data": payload])
        }
    }

    private func teardown() {
        running = false
        keepAlive = false
        stopSilentLoop()
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning {
            engine.stop()
        }
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    // MARK: - Background keep-alive (issue #35)

    /// A 1-second, 16-bit mono, all-zero WAV. Played in a loop at full volume it is
    /// inaudible (every sample is 0) but keeps the AVAudioSession truly "playing",
    /// which is what lets iOS keep the app + WKWebView running while locked.
    private static func silentWav(sampleRate: Int = 8000, seconds: Double = 1.0) -> Data? {
        let dataSize = Int(seconds * Double(sampleRate)) * 2  // 16-bit mono
        func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        var d = Data()
        d.append(Data("RIFF".utf8))
        d.append(le32(UInt32(36 + dataSize)))
        d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8))
        d.append(le32(16))                                  // PCM fmt chunk size
        d.append(le16(1))                                   // audio format = PCM
        d.append(le16(1))                                   // channels = mono
        d.append(le32(UInt32(sampleRate)))                  // sample rate
        d.append(le32(UInt32(sampleRate * 2)))              // byte rate
        d.append(le16(2))                                   // block align
        d.append(le16(16))                                  // bits per sample
        d.append(Data("data".utf8))
        d.append(le32(UInt32(dataSize)))
        d.append(Data(count: dataSize))                     // silence
        return d
    }

    private func startSilentLoop() {
        guard silentPlayer == nil else { return }
        guard let wav = Self.silentWav() else { return }
        do {
            let player = try AVAudioPlayer(data: wav)
            player.numberOfLoops = -1
            player.volume = 1.0  // content is all-zero, so this is inaudible
            player.prepareToPlay()
            player.play()
            silentPlayer = player
        } catch {
            silentPlayer = nil
        }
    }

    private func stopSilentLoop() {
        silentPlayer?.stop()
        silentPlayer = nil
    }

    private func showListeningNotification() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "Nodpilot"
            content.body = "Listening — tap to return to the app"
            content.sound = nil
            let request = UNNotificationRequest(
                identifier: self.listenNotificationId,
                content: content,
                trigger: nil
            )
            center.add(request, withCompletionHandler: nil)
        }
    }

    private func clearListeningNotification() {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [listenNotificationId])
        center.removePendingNotificationRequests(withIdentifiers: [listenNotificationId])
    }

    deinit {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        if let uplinkLinkObserver {
            NotificationCenter.default.removeObserver(uplinkLinkObserver)
        }
        teardown()
        clearListeningNotification()
    }
}
