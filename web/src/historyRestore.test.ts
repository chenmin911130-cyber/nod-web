import { applyMeetingResume, elapsedMsFromTranscriptTs, groupHistoryByDay, historyRowWhen, historySessionMatches, restoreElapsedMs, restoreFromSession, restoreIdOfferable, restoreSessionClock, restoreShouldNotAsk, resumeResetsKept, sessionSaveKeep, sessionShouldOfferSave, sessionShouldOpenSavePrompt, shouldOfferSaveOnce, startMeetingKind } from './historyRestore'
import type { HistorySession } from './components/HistoryPane'

function at(h: number, m: number, s = 0): string {
  return new Date(2026, 7, 31, h, m, s).toISOString()
}

function eq(got: string, want: string, label: string) {
  if (got !== want) throw new Error(`${label}: expected "${want}", got "${got}"`)
}

// A translate session stores each line as a transcript+translate pair, so the
// transcript items are interleaved with translate items. The pair's timestamp
// must come from ITS OWN transcript line, not from items[i] where i is the
// transcript-index offset into the full items array.
const session: HistorySession = {
  id: 's1',
  mode: 'translate',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'line one', qid: 't1', at: at(11, 5) },
    { kind: 'translate', text: '第一行', qid: 't1', at: at(11, 5, 1) },
    { kind: 'transcript', text: 'line two', qid: 't2', at: at(11, 6) },
    { kind: 'translate', text: '第二行', qid: 't2', at: at(11, 6, 1) },
  ],
}

const payload = restoreFromSession(session)

eq(payload.pairs.length.toString(), '2', 'pair count')
eq(payload.pairs[0].ts, '11:05', 'first pair ts')
eq(payload.pairs[1].ts, '11:06', 'second pair ts must come from its own transcript line')

const lecture: HistorySession = {
  id: 's2',
  mode: 'meeting',
  scene: 'lecture',
  title: 'Intro to markets',
  started_at: at(14, 0),
  stt_seconds: 12,
  items: [{ kind: 'transcript', text: 'Elasticity measures how quantity responds to price.' }],
  copy_text: 'Intro to markets\nElasticity measures how quantity responds to price.',
}

if (!historySessionMatches(lecture, '')) throw new Error('empty search keeps every session')
if (!historySessionMatches(lecture, 'elasticity')) throw new Error('search must hit transcript text')
if (!historySessionMatches(lecture, 'LECTURE')) throw new Error('search must hit scene')
if (historySessionMatches(lecture, 'interview debrief')) throw new Error('unrelated query must miss')

if (!sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true })) {
  throw new Error('ended Meeting / Lecture with content must offer Save')
}
if (sessionShouldOfferSave({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: true, listening: false, paused: true })) {
  throw new Error('paused Meeting must not offer Save')
}
if (!sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, listening: false })) {
  throw new Error('Stop with content must offer Save')
}
if (sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: true, hasContent: true })) {
  throw new Error('already saved session must not offer Save again')
}
if (sessionShouldOfferSave({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: true, listening: true })) {
  throw new Error('live Meeting must not offer Save')
}
if (sessionShouldOfferSave({ workspaceMode: 'interview', ended: true, kept: false, hasContent: true })) {
  throw new Error('Interview must not use the Meeting Save button')
}
if (sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: false })) {
  throw new Error('empty session must not offer Save')
}

if (!sessionShouldOpenSavePrompt({ workspaceMode: 'meeting', kept: false })) {
  throw new Error('Meeting save_prompt must open Save')
}
if (sessionShouldOpenSavePrompt({ workspaceMode: 'meeting', kept: false, paused: true })) {
  throw new Error('Pause must not open Save / Don\'t save')
}
if (sessionShouldOpenSavePrompt({ workspaceMode: 'interview', kept: false })) {
  throw new Error('Interview save_prompt must not open Save')
}
if (sessionShouldOpenSavePrompt({ workspaceMode: 'translate', kept: false })) {
  throw new Error('Translate save_prompt must not open Save')
}
if (sessionShouldOpenSavePrompt({ workspaceMode: 'meeting', kept: true })) {
  throw new Error('already saved Meeting must not open Save again')
}

const keepAll = sessionSaveKeep()
eq(JSON.stringify(keepAll), '{"content":true,"audio":true}', 'Save keeps content and recording by default')
if ('filesToDevice' in keepAll) throw new Error('Save must not include Files export')
const keepQuiet = sessionSaveKeep({ audio: false })
eq(JSON.stringify(keepQuiet), '{"content":true,"audio":false}', 'Save can drop recording but still keep content')

const now = new Date(2026, 8, 3, 14, 0).getTime()
const today = { id: 't', title: 'Q3 planning', started_at: new Date(2026, 8, 3, 9, 41).toISOString(), stt_seconds: 48 * 60 }
const yesterday = { id: 'y', title: 'Budget review', started_at: new Date(2026, 8, 2, 15, 16).toISOString(), stt_seconds: 22 * 60 }
const older = { id: 'o', title: 'Roadmap update', started_at: new Date(2024, 8, 18, 10, 0).toISOString(), stt_seconds: 22 * 60 }
eq(historyRowWhen(today.started_at, today.stt_seconds, now), 'Today, 9:41 AM • 48m', 'today row keeps day + clock + duration')
eq(historyRowWhen(yesterday.started_at, yesterday.stt_seconds, now), 'Yesterday, 3:16 PM • 22m', 'yesterday row keeps day + clock + duration')
eq(historyRowWhen(older.started_at, older.stt_seconds, now), 'Sep 18, 2024 • 22m', 'older row is the calendar day')

const groups = groupHistoryByDay([today, yesterday, older], now)
eq(groups.map((g) => g.label).join('|'), 'Today|Yesterday|Sep 18, 2024', 'History is a day list, not a dump on the home screen')
eq(groups[0].sessions[0].title, 'Q3 planning', 'today bucket keeps the morning session')
eq(groups[1].sessions[0].title, 'Budget review', 'yesterday bucket stays off the home screen')

const spoke: HistorySession = {
  id: 'spk',
  mode: 'meeting',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'Hello', qid: 'a1', at: at(11, 5), speaker: 'Speaker 1' },
    { kind: 'transcript', text: 'World', qid: 'a2', at: at(11, 6), speaker: 'Speaker 2' },
  ],
}
const spokePayload = restoreFromSession(spoke)
eq(spokePayload.lines[0].speaker || '', 'Speaker 1', 'restored line keeps its speaker')
eq(spokePayload.lines[1].speaker || '', 'Speaker 2', 'restored line keeps speaker for the next turn')

// A restored line's ts is the elapsed time since the session started (mm:ss),
// matching the live caption clock — not a wall-clock HH:MM.
const timed: HistorySession = {
  id: 'tm',
  mode: 'meeting',
  scene: 'meeting',
  title: 't',
  started_at: at(11, 0, 0),
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'Zero', qid: 'z', at: at(11, 0, 3) },
    { kind: 'transcript', text: 'Later', qid: 'l', at: at(11, 0, 65) },
  ],
}
const timedPayload = restoreFromSession(timed)
eq(timedPayload.lines[0].ts, '00:03', 'first line is seconds after start')
eq(timedPayload.lines[1].ts, '01:05', 'second line is mm:ss after start')

// A MEETING session restores a translation onto its source line by qid (issue #31
// §3.2): transcript(qid=m1) + translate(qid=m1) -> lines[0].translation is set,
// and the translation is NOT duplicated into a sequential pair.
const meeting: HistorySession = {
  id: 'm1s',
  mode: 'meeting',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'So one of the significant', qid: 'm1', at: at(11, 5) },
    { kind: 'translate', text: '所以其中重要', qid: 'm1', at: at(11, 5, 1) },
  ],
}
const mPay = restoreFromSession(meeting)
eq(mPay.lines.length.toString(), '1', 'one meeting line restored')
eq(mPay.lines[0].translation || '', '所以其中重要', 'meeting line carries its qid-attached translation')
eq(mPay.pairs.length.toString(), '1', 'pairs fallback keeps the source row')
eq(mPay.pairs[0].translation, '', 'the qid-matched translation is not duplicated into pairs')

// A translate row with NO matching transcript qid (legacy) still falls back to the
// sequential pairing that feeds TranslatePairs.
const legacy: HistorySession = {
  id: 'lg',
  mode: 'meeting',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'Hello world', at: at(11, 5) },
    { kind: 'translate', text: '你好世界', at: at(11, 5, 1) },
  ],
}
const lgPay = restoreFromSession(legacy)
eq(lgPay.pairs.length.toString(), '1', 'unmatched translate falls back to sequential pairs')
eq(lgPay.pairs[0].translation, '你好世界', 'legacy no-qid pair keeps its translation')
eq(lgPay.lines[0].translation || '', '', 'no qid match -> line translation stays empty')

// ---- #36: one Save UI per session + restore dedupe ----

// shouldOfferSaveOnce: a session that has already been offered is never re-offered.
if (shouldOfferSaveOnce({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, offered: true })) {
  throw new Error('once offered, the same session must never be re-prompted (Stop/left/restore)')
}
if (!shouldOfferSaveOnce({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, offered: false })) {
  throw new Error('ended Meeting with content and no prior offer must offer Save once')
}
if (shouldOfferSaveOnce({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, offered: false, paused: true })) {
  throw new Error('paused never offers Save, even before a prior offer')
}
if (shouldOfferSaveOnce({ workspaceMode: 'meeting', ended: true, kept: true, hasContent: true, offered: false })) {
  throw new Error('already-kept session never offers Save')
}

// restoreIdOfferable: the same pending id is only offerable once.
const seen = new Set<string>()
if (!restoreIdOfferable(seen, 'p1')) throw new Error('first offer of a pending id is allowed')
if (restoreIdOfferable(seen, 'p1')) throw new Error('the same pending id must not re-offer on reconnect')
if (!restoreIdOfferable(seen, 'p2')) throw new Error('a DIFFERENT pending id is allowed')
if (restoreIdOfferable(seen, '')) throw new Error('an empty id is never offerable')

// restoreShouldNotAsk: no restore while listening / paused / page has content.
if (!restoreShouldNotAsk({ listening: true, paused: false, hasContent: false })) throw new Error('listening suppress restore')
if (!restoreShouldNotAsk({ listening: false, paused: true, hasContent: false })) throw new Error('paused suppress restore')
if (!restoreShouldNotAsk({ listening: false, paused: false, hasContent: true })) throw new Error('page content suppress restore')
if (restoreShouldNotAsk({ listening: false, paused: false, hasContent: false })) throw new Error('idle empty view may offer restore')

if (resumeResetsKept({ kept: false, hasContent: true })) throw new Error('unsaved resume must not clear kept')
if (!resumeResetsKept({ kept: true, hasContent: true })) throw new Error('kept + content resume must reset kept')
if (resumeResetsKept({ kept: true, hasContent: false })) throw new Error('kept empty resume must not reset kept')

const resumed = applyMeetingResume({
  meetingEnded: true,
  meetingStartedAt: 1_000,
  meetingElapsedMs: 90_000,
  meetingLines: [{ id: 'a' }],
  notesRaw: 'notes stay',
  catchNotes: [{ id: 'c' }],
}, 200_000)
if (resumed.meetingEnded) throw new Error('meeting_resume must clear ended')
if (resumed.meetingElapsedMs !== 90_000) throw new Error('meeting_resume must keep elapsedMs')
if (resumed.meetingStartedAt !== 110_000) throw new Error('meeting_resume must rewind startedAt so the clock continues')
if (resumed.meetingLines.length !== 1 || resumed.notesRaw !== 'notes stay' || resumed.catchNotes.length !== 1) {
  throw new Error('meeting_resume must keep lines / notes / catchNotes')
}

// Path A (End → Save → Start): ended + elapsed + content → meeting_resume, kept resets.
if (startMeetingKind({ meetingStartedAt: 1, meetingEnded: true, hasContent: true }) !== 'meeting_resume') {
  throw new Error('path A Start must resume the same session')
}
if (!resumeResetsKept({ kept: true, hasContent: true })) {
  throw new Error('path A Start must clear Saved')
}

// Path B before the fix: restore_session set ended=false, elapsed=0 → meeting_clock from zero
// while lines still showed 01:05 and historyKept stayed true.
if (startMeetingKind({ meetingStartedAt: Date.now(), meetingEnded: false, hasContent: true }) !== 'meeting_clock') {
  throw new Error('old restore Start would zero the clock (the screenshot)')
}

eq(elapsedMsFromTranscriptTs('01:05').toString(), '65000', '01:05 is 65s')
eq(restoreElapsedMs({ lines: [{ ts: '00:09' }, { ts: '01:05' }], sttSeconds: 12 }).toString(), '65000', 'last line ts wins over shorter stt_seconds')
eq(restoreElapsedMs({ lines: [], sttSeconds: 33 }).toString(), '33000', 'stt_seconds fills in when lines have no ts')

const restored = restoreFromSession({
  id: 's-restore',
  mode: 'meeting',
  scene: 'meeting',
  title: 'Host',
  started_at: at(18, 10),
  stt_seconds: 12,
  items: [
    { kind: 'transcript', text: 'Host line one', at: at(18, 10, 9) },
    { kind: 'transcript', text: 'Host line at 01:05', at: at(18, 11, 5) },
  ],
})
eq(restored.elapsedMs.toString(), '65000', 'restore elapsed follows last transcript ts from started_at')

const clock = restoreSessionClock(restored.elapsedMs, 500_000)
if (!clock.meetingEnded) throw new Error('restored session is ended until Start')
if (clock.meetingElapsedMs !== 65_000) throw new Error('restored clock must be 01:05')
if (startMeetingKind({
  meetingStartedAt: clock.meetingStartedAt,
  meetingEnded: clock.meetingEnded,
  hasContent: restored.lines.length > 0,
}) !== 'meeting_resume') {
  throw new Error('path B Start after restore must meeting_resume like path A')
}
if (!resumeResetsKept({ kept: true, hasContent: restored.lines.length > 0 })) {
  throw new Error('path B Start must hide Saved to History')
}
