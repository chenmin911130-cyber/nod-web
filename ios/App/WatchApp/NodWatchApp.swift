import SwiftUI

@main
struct NodWatchApp: App {
    @StateObject private var session = WatchPhoneSession.shared

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(session)
        }
    }
}
