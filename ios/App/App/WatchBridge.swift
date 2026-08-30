import Foundation
import WatchConnectivity

/// Phone-side WatchConnectivity. Watch mic PCM is forwarded to JS; start/stop
/// are queued until the workspace is ready so consent / start_listen stay intact.
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    weak var plugin: NodWatchPlugin?
    private(set) var jsReady = false
    private var pending: [String] = []
    private var pendingPcm: [String] = []
    private var lastListening = false
    private var lastHint = "Ready"

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate == nil {
            session.delegate = self
        }
        if session.activationState != .activated {
            session.activate()
        }
        pushStatus(listening: lastListening, hint: lastHint)
    }

    func markJsReady() {
        jsReady = true
        let queued = pending
        pending.removeAll()
        for action in queued {
            emit(action)
        }
        let pcm = pendingPcm
        pendingPcm.removeAll()
        for chunk in pcm {
            plugin?.notifyListeners("pcm", data: ["data": chunk])
        }
        pushStatus(listening: lastListening, hint: lastHint)
    }

    func pushStatus(listening: Bool, hint: String) {
        lastListening = listening
        lastHint = hint
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        let payload: [String: Any] = [
            "listening": listening,
            "hint": hint,
        ]
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        do {
            try session.updateApplicationContext(payload)
        } catch {
            /* watch may be locked / unreachable */
        }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        }
    }

    private func handle(_ message: [String: Any]) {
        if let pcm = message["pcm"] as? String, !pcm.isEmpty {
            emitPcm(pcm)
        }
        let raw = (message["action"] as? String ?? "").lowercased()
        let action = raw == "stop" ? "stop" : raw == "start" ? "start" : ""
        guard !action.isEmpty else { return }
        if jsReady {
            emit(action)
        } else {
            pending.append(action)
        }
    }

    private func emit(_ action: String) {
        plugin?.notifyListeners("command", data: ["action": action])
    }

    private func emitPcm(_ data: String) {
        if jsReady {
            plugin?.notifyListeners("pcm", data: ["data": data])
            return
        }
        pendingPcm.append(data)
        if pendingPcm.count > 80 {
            pendingPcm.removeFirst(pendingPcm.count - 80)
        }
    }

    private func emitPcmData(_ data: Data) {
        let chunk = 3200
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunk, data.count)
            emitPcm(data.subdata(in: offset ..< end).base64EncodedString())
            offset = end
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated {
            pushStatus(listening: lastListening, hint: lastHint)
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handle(message)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        handle(message)
        replyHandler(["ok": true, "listening": lastListening, "hint": lastHint])
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        handle(userInfo)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        handle(applicationContext)
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let data = try? Data(contentsOf: file.fileURL), !data.isEmpty else { return }
        if jsReady {
            if pending.last != "start" {
                emit("start")
            }
            emitPcmData(data)
        } else {
            pending.append("start")
            emitPcmData(data)
        }
    }
}
