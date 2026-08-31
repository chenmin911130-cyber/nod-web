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
        CAPPluginMethod(name: "playSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeech", returnType: CAPPluginReturnPromise),
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
        let listening = call.getBool("listening") ?? false
        let hint = call.getString("hint") ?? ""
        let original = call.getString("original") ?? ""
        let translation = call.getString("translation") ?? ""
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
            listening: listening,
            hint: hint,
            original: original,
            translation: translation,
            history: history
        )
        call.resolve()
    }

    @objc func shareFile(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"),
              let name = call.getString("name"),
              let data = Data(base64Encoded: b64)
        else {
            call.reject("Missing file")
            return
        }
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("No view")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, _, _, error in
                if let error {
                    call.reject(error.localizedDescription)
                    return
                }
                call.resolve()
            }
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 8, height: 8)
            }
            vc.present(sheet, animated: true)
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
        WatchBridge.shared.playSpeech(data) { error in
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
}
