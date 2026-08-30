import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchPhoneSession

    var body: some View {
        VStack(spacing: 8) {
            Text("NOD")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(red: 0, green: 0.82, blue: 1))
                .tracking(1.4)
            Text(session.listening ? "Listening" : "Ready")
                .font(.headline)
            Text(session.hint)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(3)
            Button(session.listening ? "Stop" : "Listen") {
                session.toggle()
            }
            .tint(session.listening ? .red : Color(red: 0, green: 0.82, blue: 1))
        }
        .padding(.horizontal, 8)
    }
}
