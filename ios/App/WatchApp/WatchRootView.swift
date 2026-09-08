import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchPhoneSession
    @ObservedObject private var recorder = WatchRecorder.shared
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var listenPage = 0

    private let canvas = Color(red: 5 / 255, green: 6 / 255, blue: 7 / 255)
    private let ink = Color(red: 245 / 255, green: 247 / 255, blue: 248 / 255)
    private let muted = Color(red: 164 / 255, green: 171 / 255, blue: 177 / 255)
    private let cyan = Color(red: 0, green: 196 / 255, blue: 232 / 255)
    private let panel = Color(red: 17 / 255, green: 21 / 255, blue: 24 / 255)
    private let timer = Color(red: 245 / 255, green: 197 / 255, blue: 66 / 255)

    var body: some View {
        Group {
            if dimmed && !keepsAlwaysOnTree {
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

    /// Translate / Live Q&A keep the reading TabView while dimmed so wrist-up
    /// restores the same ScrollView offset. Meeting and terminal states still swap.
    private var keepsAlwaysOnTree: Bool {
        (session.mode == "translate" || session.mode == "interview")
            && (session.listening || session.paused)
            && !session.ended
            && !session.statusUnknown
    }

    private var alwaysOnPage: some View {
        let qa = session.mode == "interview"
        let translate = session.mode == "translate"
        return Group {
            if session.statusUnknown || session.ended || (!session.listening && !session.paused) {
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
                dimReadingChrome
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
            if session.statusUnknown {
                connectionLostPage
            } else if session.ended, session.saveState == "saving" {
                savingPage
            } else if session.ended, session.saveMatched {
                savedPage
            } else if session.ended, session.saveState == "failed" {
                saveFailedPage
            } else if session.ended, !readingSession {
                endedPage
            } else if session.listening || session.paused || session.ending || (session.ended && readingSession) {
                TabView(selection: $listenPage) {
                    sessionPage.tag(0)
                    controlsPage.tag(1)
                }
                .tabViewStyle(.page)
                .background(canvas)
            } else if session.engine == "transcribing", !readingSession {
                transcribingPage
                    .background(canvas)
            } else {
                readyStart
                    .background(canvas)
            }
        }
        .padding(.horizontal, 6)
        .onChange(of: session.listening) { listening in
            if listening { listenPage = 0 }
        }
    }

    private var readingSession: Bool {
        session.mode == "translate" || session.mode == "interview"
    }

    private var transcribingPage: some View {
        VStack(spacing: 10) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            Text(WatchCopy.transcribing)
                .font(.headline)
                .foregroundStyle(ink)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var waveAnimating: Bool {
        listenPage == 0 && !dimmed && scenePhase == .active
    }

    private var listenWaveMode: WaveBars.Mode {
        recorder.isRunning ? .level(recorder.level) : .still
    }

    private var sessionPage: some View {
        Group {
            if readingSession, session.listening || session.paused || session.ended {
                readingPage
            } else if session.paused {
                pausedControls
            } else {
                listeningControls
            }
        }
    }

    private var controlsPage: some View {
        VStack(spacing: 10) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            if readingSession, session.ended, !session.listening, !session.paused {
                Text(WatchCopy.ended)
                    .font(.headline)
                    .foregroundStyle(ink)
                if session.elapsedMs > 0 {
                    Text(clock(session.elapsedMs))
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(muted)
                }
                Button {
                    session.startSession()
                } label: {
                    Text(session.starting ? WatchCopy.starting : WatchCopy.continueRecording)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(cyan)
                .foregroundStyle(Color.black)
                .disabled(session.starting)
                Text(WatchCopy.sameSession)
                    .font(.caption2)
                    .foregroundStyle(muted)
            } else {
                if session.paused {
                    pausedStatus
                    Text(clock(session.elapsedMs))
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(muted)
                } else {
                    recordingStatus
                    if let startedAt = session.startedAt {
                        Text(startedAt, style: .timer)
                            .font(.title3.monospacedDigit())
                            .foregroundStyle(muted)
                    }
                }
                if readingSession {
                    if session.listening {
                        Button {
                            session.pause()
                        } label: {
                            Label(session.pending == "pause" ? "…" : WatchCopy.pause, systemImage: "pause.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(panel)
                        .foregroundStyle(ink)
                        .disabled(session.pending != nil)
                    } else if session.paused {
                        Button {
                            session.resume()
                        } label: {
                            Label(session.pending == "resume" ? "…" : WatchCopy.resume, systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(cyan)
                        .foregroundStyle(Color.black)
                        .disabled(session.pending != nil)
                    }
                }
                Button {
                    session.finish()
                } label: {
                    Label(session.ending ? WatchCopy.ending : WatchCopy.endRecording, systemImage: "stop.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.red.opacity(0.18))
                .foregroundStyle(Color.red)
                .disabled(session.ending)
            }
        }
    }

    private var readyStart: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            Button {
                session.startSession()
            } label: {
                VStack(spacing: 6) {
                    if session.starting {
                        ProgressView()
                    } else {
                        WaveBars(mode: .breathe, animating: waveAnimating)
                            .frame(width: 56, height: 56)
                    }
                    Text(session.starting ? WatchCopy.starting : WatchCopy.start)
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .tint(cyan)
            .disabled(session.starting)
            .modifier(CrownStartStop())
            if let failure = session.failure {
                Text(failure)
                    .font(.caption2)
                    .foregroundStyle(timer)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var listeningControls: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            HStack(spacing: 6) {
                recordingStatus
                Spacer(minLength: 4)
                WaveBars(mode: listenWaveMode, animating: waveAnimating)
                    .frame(width: 24, height: 24)
                    .foregroundStyle(cyan)
            }
            if let startedAt = session.startedAt {
                Text(startedAt, style: .timer)
                    .font(.title.monospacedDigit().weight(.semibold))
                    .foregroundStyle(ink)
            }
            Button {
                session.pause()
            } label: {
                Label(session.pending == "pause" ? "…" : WatchCopy.pause, systemImage: "pause.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(panel)
            .foregroundStyle(ink)
            .disabled(session.pending != nil)
            if session.hint == WatchCopy.couldntChange {
                Text(session.hint)
                    .font(.caption2)
                    .foregroundStyle(timer)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var pausedControls: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            pausedStatus
            Text(clock(session.elapsedMs))
                .font(.title.monospacedDigit().weight(.semibold))
                .foregroundStyle(ink)
            Button {
                session.resume()
            } label: {
                Label(session.pending == "resume" ? "…" : WatchCopy.resume, systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(cyan)
            .foregroundStyle(Color.black)
            .disabled(session.pending != nil)
            if session.hint == WatchCopy.couldntChange {
                Text(session.hint)
                    .font(.caption2)
                    .foregroundStyle(timer)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var recordingStatus: some View {
        HStack(spacing: 6) {
            Circle().fill(Color.red).frame(width: 6, height: 6)
            Text(WatchCopy.recording)
                .font(.caption)
                .foregroundStyle(ink)
        }
    }

    private var pausedStatus: some View {
        HStack(spacing: 6) {
            Image(systemName: "pause.fill")
                .foregroundStyle(timer)
            Text(WatchCopy.paused)
                .font(.caption)
                .foregroundStyle(timer)
        }
    }

    private var readingPage: some View {
        let units = session.readingUnits
        let latestId = units.last?.id
        return ZStack {
            VStack(spacing: 6) {
                if session.mode == "translate" {
                    capsule(session.langPair)
                } else {
                    capsule("Live Q&A")
                }
                if session.pillShown {
                    Button {
                        session.openLatest()
                    } label: {
                        Text(session.mode == "translate" ? WatchCopy.newTranslation : WatchCopy.newAnswer)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.black)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(cyan, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            if units.isEmpty {
                                Image(systemName: "waveform")
                                    .font(.title2)
                                    .foregroundStyle(cyan)
                                Text(session.mode == "translate" ? WatchCopy.speakNaturally : WatchCopy.waitingForQuestion)
                                    .font(.caption)
                                    .foregroundStyle(muted)
                            } else {
                                ForEach(units) { unit in
                                    readingUnit(unit, isLatest: unit.id == latestId)
                                        .id(unit.id)
                                        .transition(reduceMotion ? .identity : .opacity)
                                        .onAppear {
                                            if unit.id == latestId { session.markLatestVisible(true) }
                                        }
                                        .onDisappear {
                                            if unit.id == latestId { session.markLatestVisible(false) }
                                        }
                                }
                                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: units.count)
                            }
                        }
                        .opacity(dimmed ? 0 : 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .focusable()
                    .onChange(of: session.scrollToId) { id in
                        guard let id else { return }
                        if dimmed {
                            session.clearScroll()
                            return
                        }
                        proxy.scrollTo(id, anchor: .top)
                        session.clearScroll()
                    }
                }
                captureRow
            }
            if dimmed {
                Color.black
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .ignoresSafeArea()
                dimReadingChrome
            }
        }
    }

    /// Always-on chrome for the reading page: capsule + status, never body copy.
    private var dimReadingChrome: some View {
        let translate = session.mode == "translate"
        return VStack(spacing: 6) {
            dimCapsule(translate ? session.langPair : "Live Q&A")
            if translate {
                if session.paused {
                    Text(WatchCopy.paused)
                        .font(.caption2)
                        .foregroundStyle(muted)
                    Text(clock(session.elapsedMs))
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .foregroundStyle(timer)
                } else {
                    HStack(spacing: 6) {
                        Circle().fill(Color.red).frame(width: 7, height: 7)
                        Text(WatchCopy.listeningStatus)
                            .font(.caption2)
                            .foregroundStyle(muted)
                    }
                }
            } else if session.paused {
                Text(clock(session.elapsedMs))
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(timer)
            } else if let startedAt = session.startedAt {
                Text(startedAt, style: .timer)
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(timer)
            }
        }
    }

    private func readingUnit(_ unit: WatchPhoneSession.ReadingUnit, isLatest: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !unit.original.isEmpty {
                Text(unit.original)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if unit.failed, unit.result.isEmpty {
                Text(session.mode == "translate" ? WatchCopy.couldntTranslate : WatchCopy.couldntAnswer)
                    .font(.caption)
                    .foregroundStyle(timer)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isLatest {
                    retryButton(id: unit.id)
                }
            } else if unit.result.isEmpty, isLatest, session.engine == "generating" {
                HStack(spacing: 6) {
                    if !dimmed {
                        ProgressView()
                            .scaleEffect(0.7)
                    }
                    Text(session.mode == "translate" ? WatchCopy.translating : WatchCopy.drafting)
                        .font(.caption)
                        .foregroundStyle(muted)
                }
            } else if !unit.result.isEmpty {
                Text(unit.result)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func retryButton(id: String) -> some View {
        let label: String = {
            if !session.reachable { return WatchCopy.openOnIphone }
            if session.retrying { return WatchCopy.retrying }
            return WatchCopy.retry
        }()
        return Button {
            session.retry(id: id)
        } label: {
            Text(label)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(panel)
        .foregroundStyle(ink)
        .disabled(session.retrying && session.reachable)
    }

    private var captureRow: some View {
        HStack(spacing: 6) {
            if session.ended, !session.listening, !session.paused {
                Text(WatchCopy.ended)
                    .font(.caption2)
                    .foregroundStyle(muted)
            } else if session.paused {
                Image(systemName: "pause.fill")
                    .foregroundStyle(timer)
                Text(WatchCopy.paused)
                    .font(.caption2)
                    .foregroundStyle(timer)
            } else if WatchRecorder.shared.isRunning, !session.reachable {
                Circle().fill(Color.red).frame(width: 6, height: 6)
                Text(WatchCopy.recordingOnWatchOffline)
                    .font(.caption2)
                    .foregroundStyle(muted)
            } else {
                Circle().fill(Color.red).frame(width: 6, height: 6)
                Text(WatchCopy.listeningStatus)
                    .font(.caption2)
                    .foregroundStyle(ink)
            }
        }
    }

    private var connectionLostPage: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone.slash")
                .font(.title2)
                .foregroundStyle(timer)
            Text(WatchCopy.iphoneDisconnected)
                .font(.headline)
                .foregroundStyle(ink)
                .multilineTextAlignment(.center)
            Text(WatchCopy.statusUnavailable)
                .font(.caption2)
                .foregroundStyle(muted)
                .multilineTextAlignment(.center)
            Button {
                session.reconnect()
            } label: {
                Text(session.reconnecting ? WatchCopy.reconnecting : WatchCopy.reconnect)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(panel)
            .foregroundStyle(cyan)
            .disabled(session.reconnecting)
            if session.reconnectFailed {
                Text(WatchCopy.openOnIphone)
                    .font(.caption2)
                    .foregroundStyle(timer)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var endedPage: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text("\(WatchCopy.ended) · \(clock(session.elapsedMs, compact: true))")
                    .font(.headline)
                    .foregroundStyle(ink)
                Button {
                    session.requestSave()
                } label: {
                    Text(WatchCopy.save)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(cyan)
                .foregroundStyle(Color.black)
                Button {
                    session.continueSession()
                } label: {
                    Text(session.starting ? WatchCopy.starting : WatchCopy.continueRecording)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(panel)
                .foregroundStyle(ink)
                .disabled(session.starting)
                Text(WatchCopy.sameSession)
                    .font(.caption2)
                    .foregroundStyle(muted)
                Button(WatchCopy.dontSave) {
                    session.discardSession()
                }
                .font(.caption)
                .foregroundStyle(muted)
                .frame(minHeight: 36)
            }
        }
    }

    private var savingPage: some View {
        VStack(spacing: 8) {
            Image(systemName: "cloud.arrow.up")
                .font(.title)
                .foregroundStyle(cyan)
            Text(WatchCopy.saving)
                .font(.headline)
                .foregroundStyle(ink)
            Text(WatchCopy.waitingConfirmation)
                .font(.caption)
                .foregroundStyle(muted)
                .multilineTextAlignment(.center)
            ProgressView()
        }
    }

    private var savedPage: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.title)
                .foregroundStyle(cyan)
            Text(WatchCopy.savedToHistory)
                .font(.headline)
                .foregroundStyle(ink)
            Text(WatchCopy.viewOnIphone)
                .font(.caption)
                .foregroundStyle(muted)
            Button {
                session.continueSession()
            } label: {
                Text(session.starting ? WatchCopy.starting : WatchCopy.continueRecording)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(cyan)
            .foregroundStyle(Color.black)
            .disabled(session.starting)
        }
    }

    private var saveFailedPage: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .foregroundStyle(timer)
            Text(WatchCopy.couldntSave)
                .font(.headline)
                .foregroundStyle(ink)
            Text(WatchCopy.saveFailedHelp)
                .font(.caption)
                .foregroundStyle(muted)
                .multilineTextAlignment(.center)
            Button {
                session.requestSave()
            } label: {
                Text(WatchCopy.retrySave)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(cyan)
            .foregroundStyle(Color.black)
        }
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

    private func clock(_ seconds: TimeInterval, compact: Bool = false) -> String {
        let sec = max(0, Int(seconds))
        let h = sec / 3600
        let m = (sec % 3600) / 60
        let s = sec % 60
        if compact, h == 0 {
            return String(format: "%02d:%02d", m, s)
        }
        return "\(String(format: "%02d", h)):\(String(format: "%02d", m)):\(String(format: "%02d", s))"
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
