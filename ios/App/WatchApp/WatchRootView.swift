import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchPhoneSession
    @Environment(\.isLuminanceReduced) private var dimmed
    @State private var listenPage = 0

    private let ink = Color(red: 244 / 255, green: 248 / 255, blue: 252 / 255)
    private let muted = Color(red: 142 / 255, green: 163 / 255, blue: 184 / 255)
    private let cyan = Color(red: 0, green: 210 / 255, blue: 1)
    private let panel = Color(red: 10 / 255, green: 16 / 255, blue: 24 / 255)
    private let slate = Color(red: 168 / 255, green: 182 / 255, blue: 196 / 255)
    private let ready = Color(red: 61 / 255, green: 220 / 255, blue: 132 / 255)
    private let timer = Color(red: 245 / 255, green: 197 / 255, blue: 66 / 255)

    var body: some View {
        Group {
            if dimmed {
                alwaysOnPage
            } else {
                livePage
            }
        }
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--probe-mic") {
                session.toggle()
            }
        }
    }

    private var alwaysOnPage: some View {
        let qa = session.mode == "interview"
        let translate = session.mode == "translate"
        return Group {
            if session.offeringSave || session.savedAck || (!session.listening && !session.paused) {
                Color.black
            } else if session.paused {
                VStack(spacing: 6) {
                    Text(WatchCopy.paused)
                        .font(.caption2)
                        .foregroundStyle(muted)
                    Text(clock(session.elapsedMs))
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .foregroundStyle(timer)
                }
            } else if qa {
                VStack(spacing: 6) {
                    dimCapsule("Live Q&A")
                    if let startedAt = session.startedAt {
                        Text(startedAt, style: .timer)
                            .font(.title3.monospacedDigit().weight(.semibold))
                            .foregroundStyle(timer)
                    }
                }
            } else if translate {
                // Always-On bilingual: source (muted, small) above target (ink, large),
                // mirroring the live page but static (no animation — AOD is dim/battery-lean).
                VStack(spacing: 4) {
                    if session.original.isEmpty, session.translation.isEmpty {
                        Text(WatchCopy.listening)
                            .font(.caption2)
                            .foregroundStyle(muted)
                            .multilineTextAlignment(.center)
                    } else {
                        if !session.original.isEmpty {
                            Text(session.original)
                                .font(.caption2)
                                .foregroundStyle(muted)
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                        }
                        if !session.translation.isEmpty {
                            Text(session.translation)
                                .font(.caption)
                                .foregroundStyle(ink)
                                .multilineTextAlignment(.center)
                                .lineLimit(3)
                        }
                    }
                }
            } else {
                VStack(spacing: 8) {
                    if let startedAt = session.startedAt {
                        Text(startedAt, style: .timer)
                            .font(.title3.monospacedDigit().weight(.semibold))
                            .foregroundStyle(timer)
                    }
                    Circle().fill(Color.red).frame(width: 7, height: 7)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var livePage: some View {
        Group {
            if session.offeringSave {
                savePrompt
            } else if session.savedAck {
                savedAck
            } else if session.listening || session.paused {
                TabView(selection: $listenPage) {
                    sessionPage.tag(0)
                    stopPage.tag(1)
                }
            } else {
                readyStart
            }
        }
        .padding(.horizontal, 6)
        .onChange(of: session.listening) { listening in
            if listening { listenPage = 0 }
        }
    }

    private var sessionPage: some View {
        Group {
            if session.mode == "translate", session.listening {
                translatePage
            } else if session.mode == "interview", session.listening {
                qaPage
            } else if session.paused {
                pausedControls
            } else {
                listeningControls
            }
        }
    }

    private var stopPage: some View {
        VStack(spacing: 10) {
            Text(WatchCopy.stopListening)
                .font(.caption)
                .foregroundStyle(muted)
            Button(WatchCopy.stop) { session.finish() }
                .tint(cyan)
                .modifier(CrownStartStop())
        }
    }

    private var readyStart: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            Button {
                session.startSession()
            } label: {
                VStack(spacing: 6) {
                    Image(systemName: "waveform")
                        .font(.title2.weight(.semibold))
                    Text(WatchCopy.start)
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .disabled(session.starting)
            .tint(cyan)
            .modifier(CrownStartStop())
            if session.starting || session.hint == WatchCopy.couldntStart {
                Text(session.hint)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
            } else {
                HStack(spacing: 6) {
                    Circle().fill(ready).frame(width: 7, height: 7)
                    Text(WatchCopy.ready)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(ink)
                }
            }
        }
    }

    private var listeningControls: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            Text(WatchCopy.listening)
                .font(.caption)
                .foregroundStyle(timer)
            if let startedAt = session.startedAt {
                Text(startedAt, style: .timer)
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(timer)
            }
            recChip
            Button(WatchCopy.pause) { session.pause() }
                .tint(panel)
            listeningWave
        }
    }

    private var pausedControls: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            Text(WatchCopy.paused)
                .font(.caption)
            Text(clock(session.elapsedMs))
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(timer)
            Button(WatchCopy.resume) { session.resume() }
                .tint(cyan)
        }
    }

    private var translatePage: some View {
        VStack(spacing: 6) {
            Text(session.langPair)
                .font(.caption.weight(.semibold))
                .foregroundStyle(cyan)
            if !session.previous.isEmpty {
                Text(session.previous)
                    .font(.caption2)
                    .foregroundStyle(muted)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if session.original.isEmpty, session.translation.isEmpty {
                Text(WatchCopy.listening)
                    .font(.headline)
                    .foregroundStyle(ink)
            } else {
                if !session.original.isEmpty {
                    Text(session.original)
                        .font(.caption2)
                        .foregroundStyle(muted)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !session.translation.isEmpty {
                    copyScroll(session.translation)
                }
            }
            Spacer(minLength: 0)
            listeningWave
        }
    }

    private var qaPage: some View {
        VStack(spacing: 6) {
            capsule("Live Q&A")
            if !session.previous.isEmpty {
                Text(session.previous)
                    .font(.caption2)
                    .foregroundStyle(muted)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if session.original.isEmpty, session.translation.isEmpty {
                Text(WatchCopy.hearQuestion)
                    .font(.headline)
                    .foregroundStyle(ink)
            } else {
                if !session.original.isEmpty {
                    Text(session.original)
                        .font(.caption2)
                        .foregroundStyle(muted)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if session.translation.isEmpty {
                    Text(WatchCopy.drafting)
                        .font(.headline)
                        .foregroundStyle(ink)
                } else {
                    copyScroll(session.translation)
                }
            }
            Spacer(minLength: 0)
            listeningWave
        }
    }

    private var savePrompt: some View {
        VStack(spacing: 8) {
            Button(WatchCopy.dontSave) { session.declineSave() }
                .buttonStyle(.borderedProminent)
                .tint(slate)
                .foregroundStyle(Color.black)
                .disabled(session.saving)
            Button(session.saveFailed ? WatchCopy.retry : session.saving ? WatchCopy.saving : WatchCopy.save) { session.confirmSave() }
                .buttonStyle(.borderedProminent)
                .tint(cyan)
                .disabled(session.saving)
        }
    }

    private var savedAck: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title)
                .foregroundStyle(cyan)
            Text(WatchCopy.saved)
                .font(.headline)
        }
    }

    private var recChip: some View {
        HStack(spacing: 4) {
            Circle().fill(Color.red).frame(width: 6, height: 6)
            Text("REC")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(cyan)
        }
    }

    private var listeningWave: some View {
        Image(systemName: "waveform")
            .font(.title3.weight(.semibold))
            .foregroundStyle(cyan)
            .modifier(ListeningPulse())
            .accessibilityLabel(WatchCopy.listening)
    }

    private func copyScroll(_ text: String) -> some View {
        ScrollView {
            Text(text)
                .font(.body.weight(.semibold))
                .foregroundStyle(ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .id(text)
        .focusable()
    }

    private func capsule(_ title: String) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(cyan)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(
                Capsule().stroke(cyan.opacity(0.7), lineWidth: 1)
            )
    }

    private func dimCapsule(_ title: String) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(
                Capsule().stroke(muted.opacity(0.6), lineWidth: 1)
            )
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let sec = max(0, Int(seconds))
        let h = sec / 3600
        let m = (sec % 3600) / 60
        let s = sec % 60
        return "\(String(format: "%02d", h)):\(String(format: "%02d", m)):\(String(format: "%02d", s))"
    }
}

private struct ListeningPulse: ViewModifier {
    func body(content: Content) -> some View {
        if #available(watchOS 10.0, *) {
            content.symbolEffect(.variableColor.iterative, isActive: true)
        } else {
            content
        }
    }
}

private struct CrownStartStop: ViewModifier {
    func body(content: Content) -> some View {
        if #available(watchOS 11.0, *) {
            content.handGestureShortcut(.primaryAction)
        } else {
            content
        }
    }
}
