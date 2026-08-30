import Combine
import Foundation
import WatchConnectivity

final class WatchPhoneSession: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchPhoneSession()

    @Published var listening = false
    @Published var hint = "Watch mic — tap Listen"
    @Published var reachable = false

    private var pendingPcm = Data()
    private var liveStreamed = false
    private let maxPending = 8 * 1024 * 1024

    override private init() {
        super.init()
        WatchRecorder.shared.onPcm = { [weak self] data in
            self?.forwardPcm(data)
        }
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func toggle() {
        if WatchRecorder.shared.isRunning {
            stopRecording()
            return
        }
        startRecording()
    }

    private func startRecording() {
        pendingPcm.removeAll(keepingCapacity: true)
        liveStreamed = false
        send(action: "start")
        WatchRecorder.shared.start { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.hint = error.localizedDescription
                    self.listening = false
                    return
                }
                self.listening = true
                self.hint = self.reachable ? "Watch mic" : "Recording on Watch"
            }
        }
    }

    private func stopRecording() {
        WatchRecorder.shared.stop()
        listening = false
        hint = "Ready"
        send(action: "stop")
        flushUnsent()
        pendingPcm.removeAll()
        liveStreamed = false
    }

    private func forwardPcm(_ data: Data) {
        if pendingPcm.count < maxPending {
            pendingPcm.append(data)
        }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        liveStreamed = true
        session.sendMessage(["pcm": data.base64EncodedString()], replyHandler: nil, errorHandler: nil)
    }

    private func flushUnsent() {
        guard !liveStreamed, !pendingPcm.isEmpty else { return }
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("nod-watch.pcm")
        do {
            try pendingPcm.write(to: url, options: .atomic)
            WCSession.default.transferFile(url, metadata: ["kind": "pcm16", "sr": "16000"])
        } catch {
            WCSession.default.transferUserInfo(["pcm": pendingPcm.base64EncodedString()])
        }
    }

    func send(action: String) {
        let payload = ["action": action]
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.isReachable {
            session.sendMessage(payload, replyHandler: { [weak self] reply in
                DispatchQueue.main.async { self?.apply(reply) }
            }, errorHandler: { _ in
                session.transferUserInfo(payload)
            })
            return
        }
        session.transferUserInfo(payload)
        DispatchQueue.main.async {
            if self.listening {
                self.hint = "Recording on Watch"
            } else {
                self.hint = "Waking iPhone…"
            }
        }
    }

    private func apply(_ payload: [String: Any]) {
        if let hint = payload["hint"] as? String, !hint.isEmpty {
            self.hint = hint
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if activationState != .activated {
                self.hint = "Open Nod on iPhone once"
            }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if self.listening {
                self.hint = session.isReachable ? "Watch mic" : "Recording on Watch"
            }
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async { self.apply(message) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.apply(applicationContext) }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
}
