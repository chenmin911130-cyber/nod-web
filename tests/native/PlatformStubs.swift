// External device/transport doubles. Production WatchPhoneSession, WatchCopy and
// WatchPcmStore are compiled unchanged apart from selecting these SDK boundaries.
import Foundation
public class WCSessionFile { let fileURL: URL; let metadata: [String: Any]?; init(_ url: URL, _ metadata: [String: Any]?) { fileURL = url; self.metadata = metadata } }
public class WCSessionFileTransfer { let file: WCSessionFile; var isTransferring = true; init(_ f: WCSessionFile) { file = f }; func cancel() { isTransferring = false } }
public enum WCSessionActivationState { case activated, notActivated }
public protocol WCSessionDelegate: AnyObject {}
public final class WCSession {
 static let `default` = WCSession()
 static func isSupported() -> Bool { true }
 weak var delegate: WCSessionDelegate?
 var activationState = WCSessionActivationState.activated
 var isReachable = true
 var isPaired = true
 var isWatchAppInstalled = true
 func updateApplicationContext(_ payload: [String: Any]) throws { receivedApplicationContext = payload }
 var receivedApplicationContext: [String: Any] = [:]
 var outstandingFileTransfers: [WCSessionFileTransfer] = []
 var messages: [[String: Any]] = []
 func activate() {}
 func sendMessage(_ msg: [String: Any], replyHandler: (([String: Any])->Void)?, errorHandler: ((Error)->Void)?) { messages.append(msg) }
 func transferUserInfo(_ msg: [String: Any]) { messages.append(msg) }
 @discardableResult func transferFile(_ url: URL, metadata: [String: Any]?) -> WCSessionFileTransfer { let ft = WCSessionFileTransfer(WCSessionFile(url, metadata)); outstandingFileTransfers.append(ft); return ft }
}
protocol WKExtendedRuntimeSessionDelegate: AnyObject {}
enum WKExtendedRuntimeSessionInvalidationReason { case expired, error }
class WKExtendedRuntimeSession { weak var delegate: WKExtendedRuntimeSessionDelegate?; func start() {}; func invalidate() {} }
public protocol AVAudioPlayerDelegate: AnyObject {}
public class AVAudioPlayer { var volume: Float = 0; var duration: Double = 1; weak var delegate: AVAudioPlayerDelegate?; init(contentsOf: URL, fileTypeHint: String?) throws {}; func prepareToPlay() {}; func play() -> Bool { true }; func stop() {} }
enum AVFileType: String { case mp3 }
class AVAudioSession {
 enum Category { case playback, playAndRecord }; enum Mode { case `default`, voiceChat }
 struct CategoryOptions: OptionSet { let rawValue: Int; static let mixWithOthers = Self(rawValue: 1); static let defaultToSpeaker = Self(rawValue: 2) }
 enum Port { case headphones, builtInMic, speaker }
 struct Input { let portType: Port }
 struct Route { var outputs: [Input] = [] }
 var currentRoute = Route()
 var availableInputs: [Input]? = []
 func overrideOutputAudioPort(_ port: Port) throws {}
 func setPreferredInput(_ input: Input) throws {}
 static func sharedInstance() -> AVAudioSession { AVAudioSession() }
 func setCategory(_ category: Category, mode: Mode, options: CategoryOptions = []) throws {}
 func setActive(_ active: Bool) throws {}
}
class WatchRecorder { static let shared = WatchRecorder(); var onPcm: ((Data)->Void)?; var isRunning = false; func start(_ completion: (Error?)->Void) { isRunning = true; completion(nil) }; func stop() { isRunning = false } }
enum WatchGlanceStore { static func clear() {}; static func setPaused(elapsed: TimeInterval) {}; static func setStartedAt(_ date: Date?) {} }

class NodWatchPlugin { func notifyListeners(_ event: String, data: [String: Any]) {} }
