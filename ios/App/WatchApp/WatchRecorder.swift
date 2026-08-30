import AVFoundation
import Foundation

/// 16 kHz mono PCM16 from the Watch microphone. Live chunks go to the phone
/// when reachable; leftover bytes are handed back on stop for a file transfer.
final class WatchRecorder {
    static let shared = WatchRecorder()

    var onPcm: ((Data) -> Void)?

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var running = false
    private let targetSampleRate: Double = 16_000

    var isRunning: Bool { running }

    func start(completion: @escaping (Error?) -> Void) {
        if running {
            completion(nil)
            return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                completion(
                    NSError(
                        domain: "NodWatch",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Watch microphone permission denied"]
                    )
                )
                return
            }
            DispatchQueue.main.async {
                do {
                    try self.begin()
                    completion(nil)
                } catch {
                    self.teardown()
                    completion(error)
                }
            }
        }
    }

    func stop() {
        teardown()
    }

    private func begin() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio, options: [])
        try session.setActive(true)

        engine.reset()
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(
                domain: "NodWatch",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Watch microphone is not ready"]
            )
        }

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true
        ) else {
            throw NSError(
                domain: "NodWatch",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Could not build Watch PCM format"]
            )
        }
        converter = AVAudioConverter(from: format, to: outputFormat)

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.emit(buffer, outputFormat: outputFormat)
        }
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

    private func teardown() {
        running = false
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning {
            engine.stop()
        }
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
