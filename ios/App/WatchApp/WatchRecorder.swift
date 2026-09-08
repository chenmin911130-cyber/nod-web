import AVFoundation
import Foundation

/// 16 kHz mono PCM16 from the Watch microphone. Prefers a live engine tap;
/// if watchOS refuses the engine, falls back to a WAV recorder and streams
/// new bytes. Both paths append a raw PCM spool so unsent audio can be
/// retransmitted after a drop. The spool file is kept until the session
/// confirms delivery — teardown must not delete it.
final class WatchRecorder {
    static let shared = WatchRecorder()

    var onPcm: ((Data, Int) -> Void)?
    var onWriteFailed: (() -> Void)?

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var fileRecorder: AVAudioRecorder?
    private var wavURL: URL?
    private var wavReadOffset = 0
    private var spoolHandle: FileHandle?
    private(set) var fileURL: URL?
    private(set) var fileOffset = 0
    private var pump: DispatchSourceTimer?
    private var running = false
    private var writeFailed = false
    private let targetSampleRate: Double = 16_000
    private let queue = DispatchQueue(label: "nod.watch.recorder")
    private let spoolQueue = DispatchQueue(label: "nod.watch.spool")
    private let wavHeaderBytes = 44

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
                    try self.openSpool()
                    do {
                        try self.beginEngine()
                        Self.persist("engine-ok")
                    } catch {
                        self.teardownEngine()
                        try self.beginFileRecorder()
                        Self.persist("file-recorder-ok")
                    }
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

    func bytes(from offset: Int, length: Int) -> Data? {
        spoolQueue.sync {
            try? spoolHandle?.synchronize()
            guard let fileURL, offset >= 0, length > 0 else { return nil }
            guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return nil }
            defer { try? handle.close() }
            do {
                try handle.seek(toOffset: UInt64(offset))
                let data = handle.readData(ofLength: length)
                return data.isEmpty ? nil : data
            } catch {
                return nil
            }
        }
    }

    func discardSpool() {
        spoolQueue.sync {
            try? spoolHandle?.close()
            spoolHandle = nil
            if let fileURL {
                try? FileManager.default.removeItem(at: fileURL)
            }
            fileURL = nil
            fileOffset = 0
            writeFailed = false
        }
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

    private func openSpool() throws {
        try spoolQueue.sync {
            if spoolHandle != nil { return }
            if let fileURL {
                let handle = try FileHandle(forWritingTo: fileURL)
                handle.seekToEndOfFile()
                spoolHandle = handle
                return
            }
            let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("nod-watch-spool.pcm")
            try? FileManager.default.removeItem(at: url)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            spoolHandle = try FileHandle(forWritingTo: url)
            fileURL = url
            fileOffset = 0
            writeFailed = false
        }
    }

    private func writeSpool(_ data: Data) -> Int? {
        spoolQueue.sync {
            guard !writeFailed else { return nil }
            do {
                if spoolHandle == nil {
                    return nil
                }
                let start = fileOffset
                try spoolHandle?.write(contentsOf: data)
                fileOffset += data.count
                return start
            } catch {
                writeFailed = true
                DispatchQueue.main.async { self.onWriteFailed?() }
                return nil
            }
        }
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

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.emit(buffer, outputFormat: outputFormat)
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    private func beginFileRecorder() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("nod-watch-live.wav")
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: targetSampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let rec = try AVAudioRecorder(url: url, settings: settings)
        rec.prepareToRecord()
        guard rec.record() else {
            throw Self.fail(4, "Watch microphone would not start")
        }
        fileRecorder = rec
        wavURL = url
        wavReadOffset = wavHeaderBytes
        running = true
        startPump()
    }

    private func startPump() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.3, repeating: 0.2)
        timer.setEventHandler { [weak self] in
            self?.pumpFile()
        }
        timer.resume()
        pump = timer
    }

    private func pumpFile() {
        guard running, let wavURL else { return }
        guard let handle = try? FileHandle(forReadingFrom: wavURL) else { return }
        defer { try? handle.close() }
        let size = Int((try? handle.seekToEnd()) ?? 0)
        guard size > wavReadOffset else { return }
        do {
            try handle.seek(toOffset: UInt64(wavReadOffset))
            let data = handle.readData(ofLength: size - wavReadOffset)
            wavReadOffset += data.count
            if !data.isEmpty {
                emitPcm(data)
            }
        } catch {
            return
        }
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
        emitPcm(data)
    }

    private func emitPcm(_ data: Data) {
        guard !data.isEmpty else { return }
        guard let offset = writeSpool(data) else { return }
        onPcm?(data, offset)
    }

    private func teardownEngine() {
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
        // pumpFile() guards on `running`. Flush leftover WAV bytes first or
        // the last pump period (~200ms) never reaches onPcm / transferFile.
        if fileRecorder?.isRecording == true {
            queue.sync { self.pumpFile() }
            fileRecorder?.stop()
        }
        running = false
        pump?.cancel()
        pump = nil
        fileRecorder = nil
        wavURL = nil
        wavReadOffset = 0
        teardownEngine()
        spoolQueue.sync {
            try? spoolHandle?.synchronize()
            try? spoolHandle?.close()
            spoolHandle = nil
        }
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
