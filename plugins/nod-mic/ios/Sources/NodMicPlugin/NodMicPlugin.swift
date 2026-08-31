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
    ]

    private let engine = AVAudioEngine()
    private var running = false
    private let targetSampleRate: Double = 16_000
    private var converter: AVAudioConverter?
    private let listenNotificationId = "nod.listening"

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
                do {
                    try self.beginCapture()
                    self.showListeningNotification()
                    call.resolve()
                } catch {
                    self.teardown()
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.teardown()
            self.clearListeningNotification()
            call.resolve()
        }
    }

    @objc func isActive(_ call: CAPPluginCall) {
        call.resolve(["active": running])
    }

    private func beginCapture() throws {
        let session = AVAudioSession.sharedInstance()
        // Hear the room (Mac speakers, people nearby). Do not use voiceChat /
        // HFP — those switch to the headphone mic and cancel "echo" so YouTube
        // playing from a laptop never reaches STT.
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.defaultToSpeaker]
        )
        try session.setActive(true, options: [])
        if let builtin = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtin)
        }
        try? session.overrideOutputAudioPort(.speaker)

        engine.reset()
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
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
        notifyListeners("pcm", data: ["data": data.base64EncodedString()])
    }

    private func teardown() {
        running = false
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning {
            engine.stop()
        }
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func showListeningNotification() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "Nod"
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
        teardown()
        clearListeningNotification()
    }
}
