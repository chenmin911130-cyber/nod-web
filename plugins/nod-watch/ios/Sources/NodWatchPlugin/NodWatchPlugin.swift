import AVFoundation
import Capacitor
import Foundation
import UIKit

@objc(NodWatchPlugin)
public class NodWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NodWatchPlugin"
    public let jsName = "NodWatch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSaves", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        WatchBridge.shared.plugin = self
        WatchBridge.shared.activate()
    }

    @objc func ready(_ call: CAPPluginCall) {
        WatchBridge.shared.markJsReady()
        call.resolve()
    }

    @objc func setStatus(_ call: CAPPluginCall) {
        let capture = call.getString("capture") ?? ""
        let hint = call.getString("hint") ?? ""
        let original = call.getString("original") ?? ""
        let translation = call.getString("translation") ?? ""
        let previous = call.getString("previous") ?? ""
        let mode = call.getString("mode") ?? ""
        let langPair = call.getString("langPair") ?? ""
        let save = call.getString("save") ?? ""
        let sessionId = call.getString("sessionId") ?? ""
        if call.getBool("pcmDrained") == true {
            WatchBridge.shared.markPcmDrained(
                sessionId: sessionId,
                captureId: call.getString("pcmDrainedCaptureId") ?? "",
                byteOffset: call.getInt("pcmDrainedByte") ?? 0
            )
            if (call.getString("capture") ?? "").isEmpty, (call.getString("hint") ?? "").isEmpty {
                call.resolve()
                return
            }
        }
        var history: [[String: String]] = []
        if let rows = call.getArray("history") {
            for row in rows {
                guard let dict = row as? JSObject else { continue }
                history.append([
                    "id": (dict["id"] as? String) ?? "",
                    "title": (dict["title"] as? String) ?? "",
                    "text": (dict["text"] as? String) ?? "",
                ])
            }
        }
        WatchBridge.shared.pushStatus(
            capture: capture,
            hint: hint,
            original: original,
            translation: translation,
            previous: previous,
            history: history,
            mode: mode,
            langPair: langPair,
            save: save,
            sessionId: sessionId
        )
        call.resolve()
    }

    private var fileExport: FileExport?

    @objc func shareFile(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let name = call.getString("name") else {
            call.reject("Missing file")
            return
        }
        saveFiles(call, items: [["data": b64, "name": name]])
    }

    @objc func saveToFiles(_ call: CAPPluginCall) {
        let items = (call.getArray("files") ?? []).compactMap { $0 as? [String: Any] }
        saveFiles(call, items: items)
    }

    private func saveFiles(_ call: CAPPluginCall, items: [[String: Any]]) {
        let remotes = (call.getArray("remotes") ?? []).compactMap { $0 as? [String: Any] }
        DispatchQueue.global(qos: .userInitiated).async {
            var urls: [URL] = []
            for item in items {
                guard let b64 = item["data"] as? String,
                      let name = item["name"] as? String,
                      let data = Data(base64Encoded: b64)
                else { continue }
                let safe = name.replacingOccurrences(of: "/", with: "-")
                do {
                    let written = try Self.writeExport(data: data, name: safe)
                    let ready = Self.preparedExportURL(written)
                    Self.copyToDocuments(ready)
                    urls.append(ready)
                } catch {
                    call.reject(error.localizedDescription)
                    return
                }
            }
            var remoteFailed = 0
            for remote in remotes {
                guard let urlStr = remote["url"] as? String,
                      let name = remote["name"] as? String,
                      let remoteURL = URL(string: urlStr)
                else {
                    remoteFailed += 1
                    continue
                }
                var request = URLRequest(url: remoteURL)
                if let token = remote["token"] as? String, !token.isEmpty {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                let safe = name.replacingOccurrences(of: "/", with: "-")
                do {
                    let data = try Self.download(request)
                    if data.count < 12 || String(data: data.prefix(4), encoding: .ascii) != "RIFF" {
                        remoteFailed += 1
                        continue
                    }
                    let written = try Self.writeExport(data: data, name: safe)
                    let ready = Self.preparedExportURL(written)
                    Self.copyToDocuments(ready)
                    urls.append(ready)
                } catch {
                    remoteFailed += 1
                }
            }
            if !remotes.isEmpty && remoteFailed == remotes.count && urls.isEmpty {
                call.reject("Could not download recording")
                return
            }
            guard !urls.isEmpty else {
                call.reject("Missing file")
                return
            }
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else {
                    call.reject("No view")
                    return
                }
                let picker = UIDocumentPickerViewController(forExporting: urls, asCopy: true)
                if #available(iOS 16.0, *) {
                    picker.shouldShowFileExtensions = true
                }
                let export = FileExport(call: call)
                picker.delegate = export
                self.fileExport = export
                vc.present(picker, animated: true)
            }
        }
    }

    private static func exportDirectory() -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NodExport", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func writeExport(data: Data, name: String) throws -> URL {
        let url = exportDirectory().appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        try data.write(to: url, options: .atomic)
        return url
    }

    private static func preparedExportURL(_ url: URL) -> URL {
        guard url.pathExtension.lowercased() == "wav" else { return url }
        return convertWavToM4A(url) ?? upsampleWavTo44100(url) ?? url
    }

    private static func download(_ request: URLRequest) throws -> Data {
        let box = DownloadBox()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, error in
            box.data = data
            box.error = error
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 120)
        if let error = box.error { throw error }
        guard let data = box.data, !data.isEmpty else {
            throw NSError(domain: "NodWatch", code: 1, userInfo: [NSLocalizedDescriptionKey: "Empty download"])
        }
        return data
    }

    private static func copyToDocuments(_ url: URL) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        let dest = docs.appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: dest)
        try? FileManager.default.copyItem(at: url, to: dest)
    }

    private static func upsampleWavTo44100(_ wav: URL) -> URL? {
        guard let src = try? Data(contentsOf: wav), src.count > 44 else { return nil }
        guard String(data: src.prefix(4), encoding: .ascii) == "RIFF" else { return nil }
        let rate = src.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 24, as: UInt32.self) }
        let channels = src.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 22, as: UInt16.self) }
        let bits = src.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 34, as: UInt16.self) }
        guard bits == 16, channels >= 1, rate > 0, rate < 44100 else { return nil }
        let pcm = src.subdata(in: 44..<src.count)
        let samples = pcm.count / 2
        guard samples > 0 else { return nil }
        let outSamples = max(1, Int((Double(samples) * 44100.0 / Double(rate)).rounded()))
        var pcmOut = Data(count: outSamples * 2)
        pcm.withUnsafeBytes { srcRaw in
            let srcSamples = srcRaw.bindMemory(to: Int16.self)
            pcmOut.withUnsafeMutableBytes { dstRaw in
                let dstSamples = dstRaw.bindMemory(to: Int16.self)
                for i in 0..<outSamples {
                    let srcPos = Double(i) * Double(samples - 1) / Double(max(outSamples - 1, 1))
                    let i0 = Int(srcPos)
                    let i1 = min(samples - 1, i0 + 1)
                    let t = srcPos - Double(i0)
                    let mixed = Double(srcSamples[i0]) * (1 - t) + Double(srcSamples[i1]) * t
                    dstSamples[i] = Int16(max(-32768, min(32767, mixed.rounded())))
                }
            }
        }
        var header = Data()
        let dataLen = UInt32(pcmOut.count)
        let riffLen = UInt32(36 + pcmOut.count)
        let byteRate = UInt32(44100 * Int(channels) * 2)
        header.append(contentsOf: Array("RIFF".utf8))
        header.append(contentsOf: withUnsafeBytes(of: riffLen.littleEndian, Array.init))
        header.append(contentsOf: Array("WAVEfmt ".utf8))
        header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: channels.littleEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: UInt32(44100).littleEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: UInt16(channels * 2).littleEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: UInt16(16).littleEndian, Array.init))
        header.append(contentsOf: Array("data".utf8))
        header.append(contentsOf: withUnsafeBytes(of: dataLen.littleEndian, Array.init))
        let dest = wav.deletingPathExtension().appendingPathExtension("wav")
        do {
            try (header + pcmOut).write(to: dest, options: .atomic)
            return dest
        } catch {
            return nil
        }
    }

    private static func convertWavToM4A(_ wav: URL) -> URL? {
        let dest = wav.deletingPathExtension().appendingPathExtension("m4a")
        try? FileManager.default.removeItem(at: dest)
        let asset = AVURLAsset(url: wav)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            return convertWavToM4AWithAudioFile(wav, dest: dest)
        }
        session.outputURL = dest
        session.outputFileType = .m4a
        let done = DispatchSemaphore(value: 0)
        session.exportAsynchronously { done.signal() }
        _ = done.wait(timeout: .now() + 90)
        if session.status == .completed, FileManager.default.fileExists(atPath: dest.path) {
            try? FileManager.default.removeItem(at: wav)
            return dest
        }
        return convertWavToM4AWithAudioFile(wav, dest: dest)
    }

    private static func convertWavToM4AWithAudioFile(_ wav: URL, dest: URL) -> URL? {
        do {
            let src = try AVAudioFile(forReading: wav)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: src.fileFormat.sampleRate,
                AVNumberOfChannelsKey: src.fileFormat.channelCount,
                AVEncoderBitRateKey: 64_000,
            ]
            try? FileManager.default.removeItem(at: dest)
            let out = try AVAudioFile(forWriting: dest, settings: settings)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: src.processingFormat, frameCapacity: AVAudioFrameCount(max(src.length, 1))) else {
                return nil
            }
            try src.read(into: buffer)
            try out.write(from: buffer)
            try? FileManager.default.removeItem(at: wav)
            return dest
        } catch {
            return nil
        }
    }

    @objc func playSpeech(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"),
              let data = Data(base64Encoded: b64),
              !data.isEmpty
        else {
            call.reject("Missing audio")
            return
        }
        let dest = call.getString("dest") ?? "phone"
        WatchBridge.shared.playSpeech(data, dest: dest) { error in
            if let error {
                call.reject(error.localizedDescription)
                return
            }
            call.resolve()
        }
    }

    @objc func stopSpeech(_ call: CAPPluginCall) {
        WatchBridge.shared.stopSpeechPlayback()
        call.resolve()
    }

    @objc func storeAccount(_ call: CAPPluginCall) {
        WatchBridge.shared.storeAccount(
            token: call.getString("token") ?? "",
            origin: call.getString("origin") ?? ""
        )
        call.resolve()
    }

    @objc func listSaves(_ call: CAPPluginCall) {
        call.resolve(["saves": WatchBridge.shared.listSaves()])
    }
}

private final class DownloadBox {
    var data: Data?
    var error: Error?
}

private final class FileExport: NSObject, UIDocumentPickerDelegate {
    let call: CAPPluginCall

    init(call: CAPPluginCall) {
        self.call = call
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        call.resolve()
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        call.resolve()
    }
}
