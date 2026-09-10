import AVFoundation
import Foundation

/// 16 kHz mono PCM16 from the Watch microphone via AVAudioEngine.
/// There is no WAV / file-recorder fallback: a new capture must not write a
/// recording file on the Watch. Startup failure is visible to the caller.
final class WatchRecorder {
    static let shared = WatchRecorder()

    var onPcm: ((Data) -> Void)?

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var running = false
    private var captureGen = 0
    private let targetSampleRate: Double = 16_000

    var isRunning: Bool { running }

    func start(completion: @escaping (Error?) -> Void) {
        if running {
            Self.persist("already-running")
            completion(nil)
            return
        }
        Self.persist("starting")
        requestMic { [weak self] granted in
            guard let self else { return }
            guard granted else {
                Self.persist("denied: Allow microphone on the Watch")
                completion(Self.fail(1, "Allow microphone on the Watch"))
                return
            }
            DispatchQueue.main.async {
                do {
                    try self.prepareSession()
                    try self.beginEngine()
                    Self.persist("engine-ok")
                    completion(nil)
                } catch {
                    self.teardown()
                    let wrapped = Self.wrap(error)
                    Self.persist("fail \(wrapped.code) \(wrapped.localizedDescription) domain=\((error as NSError).domain)")
                    completion(wrapped)
                }
            }
        }
    }

    static func persist(_ text: String) {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("nod-mic-last.txt")
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(text)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
            return
        }
        try? line.write(to: url, atomically: true, encoding: .utf8)
    }

    func stop() {
        teardown()
    }

    private func requestMic(_ done: @escaping (Bool) -> Void) {
        if #available(watchOS 10.0, *) {
            AVAudioApplication.requestRecordPermission { done($0) }
            return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { done($0) }
    }

    private func prepareSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [])
        try session.setActive(true)
    }

    private func beginEngine() throws {
        let engine = AVAudioEngine()
        self.engine = engine

        let input = engine.inputNode
        var format = input.outputFormat(forBus: 0)
        if format.sampleRate <= 0 || format.channelCount <= 0 {
            format = input.inputFormat(forBus: 0)
        }
        if format.sampleRate <= 0 || format.channelCount <= 0 {
            Thread.sleep(until: Date().addingTimeInterval(0.25))
            format = input.outputFormat(forBus: 0)
            if format.sampleRate <= 0 || format.channelCount <= 0 {
                format = input.inputFormat(forBus: 0)
            }
        }
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw Self.fail(2, "Watch microphone is not ready")
        }

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true
        ) else {
            throw Self.fail(3, "Could not build Watch PCM format")
        }
        converter = AVAudioConverter(from: format, to: outputFormat)

        engine.connect(input, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0

        captureGen += 1
        let gen = captureGen
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, gen == self.captureGen else { return }
            self.emit(buffer, outputFormat: outputFormat)
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    private func emit(_ buffer: AVAudioPCMBuffer, outputFormat: AVAudioFormat) {
        guard running, let converter else { return }
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
        if !data.isEmpty {
            onPcm?(data)
        }
    }

    private func teardownEngine() {
        captureGen += 1
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning {
                engine.stop()
            }
        }
        engine = nil
        converter = nil
    }

    private func teardown() {
        running = false
        teardownEngine()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private static func fail(_ code: Int, _ message: String) -> NSError {
        NSError(domain: "NodWatch", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func wrap(_ error: Error) -> NSError {
        let ns = error as NSError
        if ns.domain == "NodWatch" { return ns }
        return fail(ns.code, "Mic failed (\(ns.code))")
    }
}
