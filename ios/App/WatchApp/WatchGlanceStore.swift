import Foundation

enum WatchGlanceStore {
    private static let startedKey = "nod.watch.startedAt"
    private static let pausedKey = "nod.watch.pausedElapsed"

    static func startedAt() -> Date? {
        UserDefaults.standard.object(forKey: startedKey) as? Date
    }

    static func pausedElapsed() -> TimeInterval? {
        guard UserDefaults.standard.object(forKey: pausedKey) != nil else { return nil }
        return UserDefaults.standard.double(forKey: pausedKey)
    }

    static func setStartedAt(_ date: Date?) {
        UserDefaults.standard.removeObject(forKey: pausedKey)
        if let date {
            UserDefaults.standard.set(date, forKey: startedKey)
        } else {
            UserDefaults.standard.removeObject(forKey: startedKey)
        }
        ComplicationController.reload()
    }

    static func setPaused(elapsed: TimeInterval) {
        UserDefaults.standard.removeObject(forKey: startedKey)
        UserDefaults.standard.set(elapsed, forKey: pausedKey)
        ComplicationController.reload()
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: startedKey)
        UserDefaults.standard.removeObject(forKey: pausedKey)
        ComplicationController.reload()
    }
}
