import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchPhoneSession
    @Environment(\.isLuminanceReduced) private var dimmed
    @State private var page = 0

    var body: some View {
        Group {
            if dimmed, session.listening, let startedAt = session.startedAt {
                alwaysOn(title: "I'm listening.", startedAt: startedAt)
            } else if dimmed, session.paused {
                alwaysOnFrozen(title: "Paused")
            } else {
                TabView(selection: $page) {
                    NavigationStack {
                        livePage
                    }
                    .tag(0)
                    historyPage.tag(1)
                }
            }
        }
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--probe-mic") {
                session.toggle()
            }
        }
    }

    private func alwaysOn(title: String, startedAt: Date) -> some View {
        VStack(spacing: 6) {
            Image("PetShiba")
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(Circle())
            Text(title)
                .font(.caption2)
            Text(startedAt, style: .timer)
                .font(.title3.monospacedDigit().weight(.semibold))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func alwaysOnFrozen(title: String) -> some View {
        VStack(spacing: 6) {
            Image("PetShiba")
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(Circle())
            Text(title)
                .font(.caption2)
            Text(clock(session.elapsedMs))
                .font(.title3.monospacedDigit().weight(.semibold))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var livePage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("NOD")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(red: 0, green: 0.82, blue: 1))
                        .tracking(1.4)
                    Spacer()
                    Text(session.listening ? "Listening" : session.paused ? "Paused" : "Ready")
                        .font(.caption2.weight(.semibold))
                }
                if !session.listening && !session.paused {
                    modePicker
                }
                if session.listening || session.paused {
                    HStack(spacing: 8) {
                        Image("PetShiba")
                            .resizable()
                            .scaledToFill()
                            .frame(width: 28, height: 28)
                            .clipShape(Circle())
                        VStack(alignment: .leading, spacing: 0) {
                            Text(session.paused ? "Paused" : "I'm listening.")
                                .font(.caption2)
                            if session.listening, let startedAt = session.startedAt {
                                Text(startedAt, style: .timer)
                                    .font(.caption.monospacedDigit().weight(.semibold))
                            } else {
                                Text(clock(session.elapsedMs))
                                    .font(.caption.monospacedDigit().weight(.semibold))
                            }
                        }
                    }
                }
                if !session.translation.isEmpty {
                    Text(session.translation)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    if !session.original.isEmpty {
                        Text(session.original)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if !session.original.isEmpty {
                    Text(session.original)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(session.hint)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if session.listening || session.paused {
                    Text(WatchPhoneSession.modeLabel(session.mode))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(red: 0, green: 0.82, blue: 1))
                }
                if session.listening {
                    Button("Pause") {
                        session.pause()
                    }
                    .tint(.orange)
                    Button("Done") {
                        session.finish()
                    }
                    .tint(.red)
                } else if session.paused {
                    Button("Resume") {
                        session.resume()
                    }
                    .tint(Color(red: 0, green: 0.82, blue: 1))
                    Button("Done") {
                        session.finish()
                    }
                    .tint(.red)
                } else {
                    Button("Listen") {
                        session.toggle()
                    }
                    .tint(Color(red: 0, green: 0.82, blue: 1))
                    Button("Record") {
                        session.record()
                    }
                    .tint(.orange)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private var modePicker: some View {
        Picker("Mode", selection: Binding(
            get: { session.mode },
            set: { session.setMode($0) }
        )) {
            Text("Meeting").tag("meeting")
            Text("Lecture").tag("lecture")
            Text("Interview").tag("interview")
            Text("Translate").tag("translate")
        }
        .pickerStyle(.navigationLink)
        .tint(Color(red: 0, green: 0.82, blue: 1))
    }

    private var historyPage: some View {
        List {
            if session.history.isEmpty {
                Text("History appears here after the iPhone translates or transcribes.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(session.history) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(item.text)
                            .font(.footnote)
                            .lineLimit(4)
                    }
                }
            }
        }
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let sec = max(0, Int(seconds))
        let h = sec / 3600
        let m = (sec % 3600) / 60
        let s = sec % 60
        return "\(String(format: "%02d", h)):\(String(format: "%02d", m)):\(String(format: "%02d", s))"
    }
}
