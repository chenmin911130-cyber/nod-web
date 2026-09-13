import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchPhoneSession
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var listenPage = 0
    @State private var showStorage = false
    @State private var confirmDeleteId = ""
    /// The Live Q&A card the user opened. Opening a card pins the copy that was
    /// on screen, so a question that lands while it is being read cannot replace
    /// it (#218). Cleared by the user, or by leaving the reading state.
    @State private var openedQA: WatchQAPage.Card?
    /// Whether the Q&A card shows the full answer instead of the compact summary.
    /// Opening it is what pins `heldQA`; closing it hands the page back to the
    /// newest answer.
    @State private var qaExpanded = false

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
        let visual = aodDisplay
        return Group {
            switch visual.kind {
            case .platform:
                aodPlatformPage
            case .content:
                aodContentPage(active: visual.active, copyFailed: visual.copyFailed)
            case .idle:
                // Ready, or a finished session with nothing left to read. The system
                // dims a plain surface instead of the app drawing a hard black page.
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The dimmed screen shows the live question/answer (Live Q&A) or the
    /// original/translation (Translate) — not a mode name and a timer.
    ///
    /// Always On keeps drawing the frontmost app's UI but at a much lower refresh
    /// rate, so this page stays static: it reuses the copy the live page already
    /// holds (no second, drifting source) and adds no subsecond update. Like the
    /// bright page it omits the mode chip, and its waveform is held still because
    /// `dimmed` is true here. It deliberately keeps the full text reachable by
    /// scrolling, because the dim preview is not the whole content on a long answer.
    ///
    /// It also deliberately keeps the full copy rather than the compact Live Q&A
    /// summary (#218): this page must stay static, and it is a preview of the
    /// content the bright page holds, not a second, differently-summarised view.
    @ViewBuilder
    private func aodContentPage(active: Bool, copyFailed: Bool) -> some View {
        VStack(spacing: 4) {
            if active, let startedAt = session.startedAt {
                // A static clock, not the live `.timer` style: Always On must not
                // redraw every second.
                Text(clock(Date().timeIntervalSince(startedAt)))
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .foregroundStyle(timer)
            } else if session.paused {
                Text(WatchCopy.paused)
                    .font(.caption2)
                    .foregroundStyle(muted)
            }
            if session.original.isEmpty, session.translation.isEmpty {
                Text(session.mode == "interview" ? WatchCopy.hearQuestion : WatchCopy.listening)
                    .font(.caption2)
                    .foregroundStyle(ink)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                aodCopyPair(copyFailed: copyFailed)
            }
            Spacer(minLength: 0)
            // Held still by `dimmed`; it is an indicator of the state, never the
            // reason the dim screen keeps refreshing.
            listeningWaveform(active: true)
        }
    }

    /// The platform's own end-of-session surface (Save / saved / sending the tail)
    /// stays as it was, minus the live-only animation.
    @ViewBuilder
    private var aodPlatformPage: some View {
        if session.draining || session.drainFailed {
            VStack(spacing: 4) {
                Text(session.drainFailed ? WatchCopy.drainFailed : WatchCopy.sendingLast)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
                if session.pcmStalled {
                    stallWarning
                }
            }
        } else if session.savedAck {
            VStack(spacing: 6) {
                Text(WatchCopy.savedHistory)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
            }
        } else {
            // Save prompt / waiting for the phone to sync.
            Text(session.saving ? WatchCopy.saving : (session.pendingSync ? WatchCopy.pendingSync : WatchCopy.saveAsk))
                .font(.caption2)
                .foregroundStyle(muted)
                .multilineTextAlignment(.center)
        }
    }

    /// A dim preview of the copy: the longest text the screen can hold, scrollable
    /// so a long answer is still reachable. The live page's `copyPair` is not
    /// reused here because Always On must not carry its placeholder animation or
    /// its `focusable()` crown interaction.
    private func aodCopyPair(copyFailed: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if !session.original.isEmpty {
                    Text(session.original)
                        .font(.caption2)
                        .foregroundStyle(muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if copyFailed {
                    copyFailedNote
                } else if !session.translation.isEmpty {
                    Text(session.translation)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    // The answer is still coming: say so instead of showing an
                    // empty dim page.
                    Text(WatchCopy.drafting)
                        .font(.caption2)
                        .foregroundStyle(muted)
                }
            }
        }
        .id(session.copyId.isEmpty ? "aod" : session.copyId)
    }

    /// The Always On decision (see `WatchAod`). Pure inputs only, so the display
    /// branch can be unit-tested without a Watch.
    private var aodDisplay: WatchAodDisplay {
        WatchAod.display(
            draining: session.draining,
            drainFailed: session.drainFailed,
            offeringSave: session.offeringSave,
            pendingSync: session.pendingSync,
            savedAck: session.savedAck,
            listening: session.listening,
            paused: session.paused,
            hasContent: !session.original.isEmpty || !session.translation.isEmpty,
            copyFailed: session.copyFailed
        )
    }

    private var livePage: some View {
        VStack(spacing: 4) {
            if session.storageFailed {
                Text(WatchCopy.diskFull).font(.caption).foregroundStyle(Color.orange)
            }
            if session.pcmStalled && !session.draining && !session.drainFailed {
                stallWarning
                    .padding(.horizontal, 6)
            }
            if session.pcmRejected && !session.draining {
                rejectedWarning
                    .padding(.horizontal, 6)
            }
            Group {
                if session.offeringSave || session.pendingSync {
                    savePrompt
                } else if session.savedAck {
                    savedAck
                } else if session.draining || session.drainFailed {
                    drainPage
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
        }
        .onChange(of: session.listening) { listening in
            if listening { listenPage = 0 }
        }
    }

    private var drainPage: some View {
        VStack(spacing: 10) {
            Text(session.drainFailed ? WatchCopy.drainFailed : WatchCopy.sendingLast)
                .font(.headline)
                .foregroundStyle(ink)
                .multilineTextAlignment(.center)
            if session.pcmStalled {
                stallWarning
            }
            if session.pcmRejected {
                rejectedWarning
            }
            if session.drainFailed {
                Button(WatchCopy.done) { session.leaveIncomplete() }.tint(panel)
            }
            if session.drainFailed && !session.pcmRejected {
                Button(WatchCopy.retry) { session.retryDrain() }
                    .tint(cyan)
            }
        }
    }

    /// The overflow-stall (audio incomplete) warning, surfaceable on the recording
    /// page and the End/drain page. Survives End/Retry so the user is not told the
    /// session is complete once audio was dropped.
    private var stallWarning: some View {
        Text(session.pcmStallText.isEmpty ? WatchCopy.pcmIncomplete : session.pcmStallText)
            .font(.caption2)
            .foregroundStyle(Color.orange)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    /// A terminal session rejection (session ended server-side). Not retryable —
    /// the capture's session is already over, so Retry must not feed old audio
    /// into a new session (issue #165 P2-8).
    private var rejectedWarning: some View {
        Text(session.pcmRejectText.isEmpty ? WatchCopy.pcmRejected : session.pcmRejectText)
            .font(.caption2)
            .foregroundStyle(Color.red)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .center)
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
            if !session.unfinishedCaptureList.isEmpty {
                Button { showStorage = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "externaldrive")
                            .font(.caption)
                        Text(WatchCopy.manageStorage)
                            .font(.caption)
                        Text("(\(session.unfinishedCaptureList.count))")
                            .font(.caption.monospacedDigit())
                    }
                    .foregroundStyle(muted)
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showStorage, content: { storagePage })
    }

    private var storagePage: some View {
        let items = session.unfinishedCaptureList
        return VStack(spacing: 8) {
            Text(WatchCopy.unfinishedRecordings)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ink)
                .multilineTextAlignment(.center)
            if !session.storageErrorText.isEmpty {
                Text(session.storageErrorText).font(.caption2).foregroundStyle(Color.orange)
            }
            if items.isEmpty {
                Text(WatchCopy.noUnfinished)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
            } else {
                ScrollView {
                    ForEach(items, id: \.captureId) { item in
                        storageRow(item)
                    }
                }
            }
            Button(WatchCopy.done) { showStorage = false }
                .tint(panel)
        }
    }

    private func storageRow(_ item: WatchPcmStore.CaptureInfo) -> some View {
        let date = item.modifiedAt
        let when = date.formatted(date: .abbreviated, time: .shortened)
        return HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ByteCountFormatter.string(fromByteCount: Int64(item.bytes), countStyle: .file))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ink)
                Text("\(when) · \(item.shardCount)")
                    .font(.caption2)
                    .foregroundStyle(muted)
            }
            Spacer()
            if confirmDeleteId == item.captureId {
                Button(WatchCopy.confirmDelete) {
                    _ = session.deleteUnfinishedCapture(item.captureId)
                    confirmDeleteId = ""
                }
                .tint(Color.red)
            } else {
                Button {
                    confirmDeleteId = item.captureId
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundStyle(Color.red)
                }
                .buttonStyle(.plain)
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
            // Non-content page (Meeting): it has no copy to read, so the only live
            // status is the waveform. The REC chip is gone with it.
            listeningWaveform(active: true)
            Button(WatchCopy.pause) { session.pause() }
                .tint(panel)
        }
    }

    private var pausedControls: some View {
        VStack(spacing: 8) {
            capsule(WatchPhoneSession.modeLabel(session.mode))
            Text(WatchCopy.paused)
                .font(.caption)
            if session.hint == WatchCopy.linkLost {
                Text(WatchCopy.linkLost)
                    .font(.caption2)
                    .foregroundStyle(Color.orange)
                    .multilineTextAlignment(.center)
            }
            Text(clock(session.elapsedMs))
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(timer)
            Button(WatchCopy.resume) { session.resume() }
                .tint(cyan)
        }
    }

    private var translatePage: some View {
        VStack(spacing: 6) {
            // No mode / language chip here: the reading page starts straight at the
            // copy (confirmed design, #224). The mode stays visible before Start.
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
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                copyPair(original: session.original, translation: session.translation)
            }
            Spacer(minLength: 0)
            listeningWaveform(active: true)
        }
    }

    /// Live Q&A on the wrist: a compact answer card by default, the full answer
    /// after a tap (#218).
    ///
    /// The compact text is derived on the Watch from the answer already in
    /// `session` — `WatchQASummary` is the single seam for it, with no phone
    /// call, prompt or new sync field. If a question arrives while a card is
    /// open, the open card stays put and a "new answer" hint appears; only the
    /// user moves the page. Translate keeps its own page and is untouched.
    private var qaPage: some View {
        let display = qaDisplay
        return VStack(spacing: 6) {
            if display.newer {
                Button { returnToLatestQA() } label: {
                    HStack(spacing: 4) {
                        Text(WatchCopy.newAnswer)
                            .font(.caption2.weight(.semibold))
                        Image(systemName: "arrow.down")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(cyan)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(WatchCopy.newAnswer)
            } else if !session.previous.isEmpty {
                Text(session.previous)
                    .font(.caption2)
                    .foregroundStyle(muted)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let card = display.card {
                qaCard(card, expanded: display.expanded)
            } else {
                Text(WatchCopy.hearQuestion)
                    .font(.headline)
                    .foregroundStyle(ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
            listeningWaveform(active: true)
        }
        .onChange(of: session.copyId) { next in
            // A new question became the live one. Only an open card keeps the
            // page from following it; anything else follows immediately.
            if openedQA == nil { qaExpanded = false }
            // The live copy was cleared (New / restart): nothing left to hold.
            if next.isEmpty { resetQACard() }
        }
        .onChange(of: session.listening) { listening in
            if !listening { resetQACard() }
        }
    }

    /// The pure page decision (see `WatchQAPage`): the live copy, or the card the
    /// user opened when a newer question has already replaced the live copy.
    private var qaDisplay: WatchQAPage.Display {
        WatchQAPage.display(
            copyId: session.copyId,
            question: session.original,
            answer: session.translation,
            opened: openedQA,
            expanded: qaExpanded
        )
    }

    /// One Q&A card. Collapsed it is the compact summary; expanded it is the full
    /// answer. Both stay focusable so the crown scrolls a long answer, and the
    /// card itself is the tap target for the full text.
    @ViewBuilder
    private func qaCard(_ card: WatchQAPage.Card, expanded: Bool) -> some View {
        let summary = WatchQASummary.compact(from: card.answer)
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if !card.question.isEmpty {
                    Text(card.question)
                        .font(.caption2)
                        .foregroundStyle(muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if session.copyFailed, card.copyId == session.copyId {
                    copyFailedNote
                }
                if card.answer.isEmpty {
                    // Still coming: never leave the previous answer's summary here.
                    Text(WatchCopy.drafting)
                        .font(.headline)
                        .foregroundStyle(ink)
                } else if expanded {
                    Text(card.answer)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(summary.text)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if summary.hasMore {
                        Text(WatchCopy.fullText)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(cyan)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { toggleQAExpansion() }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            // The crown/tap reading path also has to be reachable without a tap
            // gesture (issue #218 keeps the accessibility actions available).
            .accessibilityAction(named: Text(WatchCopy.fullText)) { toggleQAExpansion() }
        }
        .id(card.copyId.isEmpty ? "qa-live" : card.copyId)
        .focusable()
    }

    private func toggleQAExpansion() {
        (openedQA, qaExpanded) = WatchQAPage.toggle(qaDisplay)
    }

    /// User-initiated only: nothing on the session's update path calls this, so a
    /// new question can never move the page on its own (#218).
    private func returnToLatestQA() {
        resetQACard()
    }

    private func resetQACard() {
        openedQA = nil
        qaExpanded = false
    }

    private var savePrompt: some View {
        VStack(spacing: 8) {
            if session.pendingSync && !session.saving && !session.saveFailed {
                Text(WatchCopy.pendingSync)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
                Button(WatchCopy.done) { session.finishPendingSave() }
                    .buttonStyle(.borderedProminent)
                    .tint(cyan)
            } else if session.saveFailed {
                Text(WatchCopy.saveFailed)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
                Button(WatchCopy.done) { session.finishPendingSave() }
                    .buttonStyle(.borderedProminent)
                    .tint(slate)
                    .foregroundStyle(Color.black)
                Button(WatchCopy.retry) { session.confirmSave() }
                    .buttonStyle(.borderedProminent)
                    .tint(cyan)
            } else {
                Text(session.saving ? WatchCopy.saving : WatchCopy.saveAsk)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)
                Button(WatchCopy.dontSave) { session.declineSave() }
                    .buttonStyle(.borderedProminent)
                    .tint(slate)
                    .foregroundStyle(Color.black)
                    .disabled(session.saving)
                Button(session.saving ? WatchCopy.saving : WatchCopy.save) { session.confirmSave() }
                    .buttonStyle(.borderedProminent)
                    .tint(cyan)
                    .disabled(session.saving)
            }
        }
    }

    /// The live copy failed on the phone: say so, instead of leaving a half
    /// sentence that reads as if it were still translating (#219).
    private var copyFailedNote: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(slate)
            Text(WatchCopy.translateFailed)
                .font(.caption2)
                .foregroundStyle(slate)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var savedAck: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title)
                .foregroundStyle(cyan)
            Text(WatchCopy.savedHistory)
                .font(.headline)
                .multilineTextAlignment(.center)
        }
    }

    /// Listening status as a small cyan waveform (confirmed design, #224).
    ///
    /// It is a status animation, not a level meter: it is driven by the listening
    /// state only and needs no audio/volume data from the phone. `active` is false
    /// when the session is not actually running (paused or ended), and `isActive`
    /// folds in Always On and Reduce Motion so the bars stay still there — the
    /// animation must never be what keeps the screen awake.
    private func listeningWaveform(active: Bool) -> some View {
        ListeningWaveform(
            isActive: WatchAod.waveformAnimates(
                listening: session.listening && active,
                paused: session.paused,
                dimmed: dimmed,
                reduceMotion: reduceMotion
            ),
            // Failures must not look like a healthy recording: a rejected session
            // or a stalled audio rail draws the bars flat instead of breathing.
            healthy: !session.pcmRejected && !session.pcmStalled
        )
    }

    private func copyPair(original: String, translation: String, placeholder: String? = nil) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if !original.isEmpty {
                    Text(original)
                        .font(.caption2)
                        .foregroundStyle(muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if session.copyFailed {
                    copyFailedNote
                }
                if let placeholder, translation.isEmpty, !session.copyFailed {
                    Text(placeholder)
                        .font(.headline)
                        .foregroundStyle(ink)
                } else if !translation.isEmpty {
                    Text(translation)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .id(session.copyId.isEmpty ? "live" : session.copyId)
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

    private func clock(_ seconds: TimeInterval) -> String {
        let sec = max(0, Int(seconds))
        let h = sec / 3600
        let m = (sec % 3600) / 60
        let s = sec % 60
        return "\(String(format: "%02d", h)):\(String(format: "%02d", m)):\(String(format: "%02d", s))"
    }
}

/// The listening waveform from the confirmed design (#224): a small cyan row of
/// rounded bars, centred, roughly 55x14 pt.
///
/// It replaces the old "Listening" text + red dot. It is a status animation, not a
/// level meter: there is deliberately no audio-level input and no new phone
/// protocol behind it. When `isActive` is false (paused, Always On, Reduce Motion)
/// the bars hold a still frame; `healthy == false` draws the resting frame flat so
/// a rejected or stalled session never looks like a healthy recording.
private struct ListeningWaveform: View {
    let isActive: Bool
    var healthy: Bool = true

    private let barCount = 9
    private let barWidth: CGFloat = 3
    private let barGap: CGFloat = 2.5
    private let maxHeight: CGFloat = 14
    private let minHeight: CGFloat = 4
    private let period: Double = 1.2

    /// Uneven rest shape, so a still frame still looks like a waveform instead of
    /// a solid block and matches the design at a glance.
    private static let restShape: [CGFloat] = [0.34, 0.58, 0.82, 1.0, 0.86, 0.64, 0.9, 0.52, 0.32]

    var body: some View {
        Group {
            if isActive, healthy {
                // Only the animated path keeps a timeline alive; a still waveform
                // is a plain view, so nothing redraws while paused / in Always On.
                TimelineView(.animation(minimumInterval: 1.0 / 15.0, paused: false)) { timeline in
                    bars(phase: timeline.date.timeIntervalSinceReferenceDate * 2 * .pi / period)
                }
            } else {
                bars(phase: nil)
            }
        }
        .frame(height: maxHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WatchCopy.listening)
    }

    private func bars(phase: Double?) -> some View {
        HStack(alignment: .center, spacing: barGap) {
            ForEach(0..<barCount, id: \.self) { index in
                Capsule()
                    .fill(Color(red: 0, green: 210 / 255, blue: 1))
                    .frame(width: barWidth, height: height(index, phase: phase))
            }
        }
    }

    private func height(_ index: Int, phase: Double?) -> CGFloat {
        let rest = Self.restShape[index % Self.restShape.count]
        guard let phase else {
            // Still frame: a healthy row rests at its shape; an unhealthy one goes
            // flat so "not recording properly" is visible even without motion.
            return healthy ? max(minHeight, maxHeight * rest) : minHeight
        }
        let wave = 1 + 0.30 * sin(phase + Double(index) * 0.7)
        return min(maxHeight, max(minHeight, maxHeight * rest * wave))
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
