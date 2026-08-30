import Capacitor
import Foundation

@objc(NodWatchPlugin)
public class NodWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NodWatchPlugin"
    public let jsName = "NodWatch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStatus", returnType: CAPPluginReturnPromise),
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
        WatchBridge.shared.pushStatus(listening: listening, hint: hint)
        call.resolve()
    }
}
