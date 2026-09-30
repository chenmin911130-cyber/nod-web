import { applyMeetingResume, assembleHistoryList, elapsedMsFromTranscriptTs, groupHistoryByDay, historyDurationLabel, historyRowStatus, historyRowTitle, historyRowWhen, historySessionMatches, localCaptureCanAppear, localCaptureHistoryId, mergeLocalCaptures, mergePendingHistory, modeIsSaveEligible, overlayNativeSaveJobs, parseRestoreDismissed, rememberRestoreDismissed, restoreAttachState, restoreAttachedClock, restoreElapsedMs, restoreFromSession, restoreIdOfferable, restoreLaunchSurface, restoreOfferBody, restoreSessionClock, restoreShouldNotAsk, resumeResetsKept, serializeRestoreDismissed, sessionCanSaveManually, sessionIsSaveEligible, sessionIsUnsaved, sessionSaveKeep, sessionShouldOfferSave, sessionShouldOpenSavePrompt, sessionShowsUnsaved, shouldOfferSaveOnce, startMeetingKind, attachRestoreIsCurrent, mergeAttachedLines, pickAttachedSession } from './historyRestore'
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

// #182: a saved Think answer comes back with its real sources and retrieval
// time, and a record written before Think existed comes back with none.
const qaSession: HistorySession = {
  id: 's3',
  mode: 'interview',
  scene: 'interview',
  title: 'qa',
  started_at: at(15, 0),
  stt_seconds: 4,
  items: [
    { kind: 'question', text: 'what is new?', qid: 'q1', at: at(15, 0) },
    {
      kind: 'answer',
      text: 'an answer',
      qid: 'q1',
      at: at(15, 0, 5),
      sources: {
        status: 'ok',
        retrieved_at: 1789012800,
        retrieved_at_text: '2026-09-10 04:00 UTC',
        results: [{ title: 'Apple News', url: 'https://example.com/apple', published_at: '2026-09-10' }],
        note: '',
      },
    },
    { kind: 'question', text: 'and now?', qid: 'q2', at: at(15, 1) },
    { kind: 'answer', text: 'second answer', qid: 'q2', at: at(15, 1, 5), sources: null },
  ],
}

const qaPayload = restoreFromSession(qaSession)
eq(qaPayload.turns.length.toString(), '2', 'both turns restore')
eq(qaPayload.turns[0].sources?.results[0].url ?? '', 'https://example.com/apple', 'the sources survive the restore')
eq(qaPayload.turns[0].sources?.retrieved_at_text ?? '', '2026-09-10 04:00 UTC', 'and the retrieval time with them')
eq(String(qaPayload.turns[1].sources), 'undefined', 'an old record restores without a source block')

// #182: an attachment answer was saved under kind `file_ask`, which the restore
// never read — so the whole answer (sources included) disappeared from History.
const attachPayload = restoreFromSession({
  ...qaSession,
  id: 's4',
  items: [
    { kind: 'question', text: 'review this', qid: 'q9', at: at(16, 0) },
    {
      kind: 'file_ask',
      text: 'an attachment answer',
      qid: 'q9',
      at: at(16, 0, 5),
      sources: {
        status: 'ok',
        retrieved_at: 1789012800,
        retrieved_at_text: '2026-09-10 04:00 UTC',
        results: [{ title: 'Apple News', url: 'https://example.com/apple', published_at: null }],
        note: '',
      },
    },
  ],
})
eq(attachPayload.turns.length.toString(), '1', 'a legacy file_ask answer restores')
eq(attachPayload.turns[0].a, 'an attachment answer', 'with its text')
eq(attachPayload.turns[0].sources?.results[0].url ?? '', 'https://example.com/apple', 'and its sources')

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
if (!sessionCanSaveManually({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: true, listening: false, paused: true })) {
  throw new Error('paused unsaved Meeting with content can be saved from More')
}
if (sessionCanSaveManually({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: true, listening: true, paused: false })) {
  throw new Error('live recording cannot be saved manually')
}
if (sessionCanSaveManually({ workspaceMode: 'meeting', ended: false, kept: true, hasContent: true, listening: false, paused: true })) {
  throw new Error('an already saved session cannot be saved manually')
}
if (sessionCanSaveManually({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: false, listening: false, paused: true })) {
  throw new Error('an empty session cannot be saved manually')
}
if (sessionCanSaveManually({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: true, listening: false, paused: true, sessionMode: 'translate' })) {
  throw new Error('a Translate session cannot be saved manually')
}
if (!sessionCanSaveManually({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, listening: false, paused: false })) {
  throw new Error('an ended unsaved Meeting with content can be saved manually')
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
// #196: gating on the session's OWN mode, not on the pane the user happens to be in.
if (sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, sessionMode: 'translate' })) {
  throw new Error('a Translate session must never offer Save, even from the Meeting pane')
}
if (!sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, sessionMode: 'meeting' })) {
  throw new Error('a Meeting session still offers Save')
}
if (!sessionShouldOfferSave({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, sessionMode: '' })) {
  throw new Error('an unknown mode (legacy) still offers Save')
}
if (shouldOfferSaveOnce({ workspaceMode: 'meeting', ended: true, kept: false, hasContent: true, offered: false, sessionMode: 'translate' })) {
  throw new Error('shouldOfferSaveOnce must honour the session mode')
}
if (sessionShouldOpenSavePrompt({ workspaceMode: 'meeting', kept: false, sessionMode: 'translate' })) {
  throw new Error('a Translate session must never open the Save prompt from the Meeting pane')
}
if (!sessionShouldOpenSavePrompt({ workspaceMode: 'meeting', kept: false, sessionMode: 'lecture' })) {
  throw new Error('a Lecture session still opens the Save prompt')
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
eq(historyDurationLabel(0), '<1m', 'a few seconds is not 0m')
eq(historyDurationLabel(29), '<1m', 'sub-minute audio is not rounded away')
eq(historyRowTitle({ title: 'Unsaved', mode: 'meeting' }), 'Session', 'Unsaved is never the title')
eq(historyRowTitle({ title: 'Q3 planning' }), 'Q3 planning', 'a real title stays')
eq(
  historyRowStatus({ kept: false, mode: 'meeting', nativeSave: 'failed', started_at: today.started_at, stt_seconds: 120 }, now),
  "Unsaved · Couldn't save. · Today, 9:41 AM • 2m",
  'Unsaved and Couldn\'t save appear once each, below the title',
)
eq(
  restoreOfferBody({ title: 'Standup', startedAt: today.started_at, sttSeconds: today.stt_seconds }, now),
  'Standup · Today, 9:41 AM • 48m',
  'restore banner names the old session',
)

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
eq(mPay.pairs.length.toString(), '0', 'meeting restore must not fill Translate pairs')

// A legacy Meeting translate row with no matching transcript qid no longer surfaces as TranslatePairs.
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
eq(lgPay.pairs.length.toString(), '0', 'meeting legacy unmatched translate must not surface as pairs')
eq(lgPay.lines[0].translation || '', '', 'no qid match -> line translation stays empty')

const meetingTwo: HistorySession = {
  id: 'm2',
  mode: 'meeting',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'Line one', qid: 'x1', at: at(11, 5) },
    { kind: 'transcript', text: 'Line two', qid: 'x2', at: at(11, 6) },
  ],
}
const m2Pay = restoreFromSession(meetingTwo)
eq(m2Pay.lines.length.toString(), '2', 'meeting restores both transcript lines')
eq(m2Pay.pairs.length.toString(), '0', 'meeting with two lines returns zero pairs')

const interviewSession: HistorySession = {
  id: 'iv',
  mode: 'interview',
  scene: 'interview',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [{ kind: 'transcript', text: 'Question context', qid: 'i1', at: at(11, 5) }],
}
eq(restoreFromSession(interviewSession).pairs.length.toString(), '0', 'interview session returns zero pairs')

const lectureSession: HistorySession = {
  id: 'lec',
  mode: 'meeting',
  scene: 'lecture',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [{ kind: 'transcript', text: 'Lecture note', qid: 'l1', at: at(11, 5) }],
}
eq(restoreFromSession(lectureSession).pairs.length.toString(), '0', 'lecture session returns zero pairs')

const noModeSession = {
  id: 'nom',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [{ kind: 'transcript', text: 'Legacy line', qid: 'n1', at: at(11, 5) }],
} as HistorySession
eq(restoreFromSession(noModeSession).pairs.length.toString(), '0', 'legacy no-mode session maps to meeting and returns zero pairs')

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

const idleRestore = {
  listening: false,
  paused: false,
  hasContent: false,
  pendingId: 'pending-1',
  dismissedIds: [] as string[],
  workspaceMode: 'meeting',
}
if (restoreLaunchSurface(idleRestore) !== 'page') throw new Error('crash reconnect lays the pending session onto the page, not a Ready ask')
if (restoreLaunchSurface({ ...idleRestore, listening: true }) !== 'none') throw new Error('listening never launches restore')
if (restoreLaunchSurface({ ...idleRestore, paused: true }) !== 'none') throw new Error('paused never launches restore')
if (restoreLaunchSurface({ ...idleRestore, hasContent: true }) !== 'none') throw new Error('page content never launches restore')
if (restoreLaunchSurface({ ...idleRestore, pendingId: '' }) !== 'none') throw new Error('empty pending id never launches restore')
if (restoreLaunchSurface({ ...idleRestore, dismissedIds: ['pending-1'] }) !== 'none') throw new Error('End / Not now dismissed id never relaunches')
if (restoreLaunchSurface({ ...idleRestore, workspaceMode: 'translate' }) !== 'none') throw new Error('Translate ready never auto-opens a pending meeting')
{
  const again = rememberRestoreDismissed(['pending-1'], 'pending-1')
  if (restoreLaunchSurface({ ...idleRestore, dismissedIds: again }) !== 'none') {
    throw new Error('Not now must stick so the same id does not relaunch')
  }
}
// #196: a Translate session has no Save concept. It must never become the pending
// restore target (in EITHER workspace), must never read as Unsaved, and a local
// Translate capture must keep its own mode instead of being relabelled a meeting.
if (restoreLaunchSurface({ ...idleRestore, pendingMode: 'translate' }) !== 'none') {
  throw new Error('a pending Translate session must never launch the Meeting restore surface')
}
if (restoreLaunchSurface({ ...idleRestore, pendingMode: 'Translate' }) !== 'none') {
  throw new Error('mode matching must be case-insensitive')
}
if (restoreLaunchSurface({ ...idleRestore, pendingMode: 'meeting' }) !== 'page') {
  throw new Error('a pending Meeting session still restores')
}
if (restoreLaunchSurface({ ...idleRestore, pendingMode: undefined }) !== 'page') {
  throw new Error('a pending row with no mode (legacy) stays recoverable')
}
if (modeIsSaveEligible('translate')) throw new Error('translate is not save-eligible')
if (!modeIsSaveEligible('meeting') || !modeIsSaveEligible('lecture') || !modeIsSaveEligible('interview')) {
  throw new Error('meeting / lecture / interview stay save-eligible')
}
if (!modeIsSaveEligible('') || !modeIsSaveEligible(undefined)) {
  throw new Error('an unknown mode stays eligible so legacy rows keep their entry')
}
if (sessionShowsUnsaved({ kept: false, mode: 'translate' })) {
  throw new Error('a Translate row is never shown as Unsaved')
}
if (!sessionShowsUnsaved({ kept: false, mode: 'meeting' })) {
  throw new Error('an unsaved Meeting row still shows as Unsaved')
}
if (!sessionShowsUnsaved({ kept: false })) {
  throw new Error('a legacy unsaved row without a mode still shows as Unsaved')
}
if (sessionShowsUnsaved({ kept: true, mode: 'meeting' })) {
  throw new Error('a kept row is never Unsaved')
}
if (!sessionIsUnsaved({ kept: false })) {
  throw new Error('the raw kept flag keeps its meaning for the save book')
}
if (sessionIsSaveEligible({ mode: 'translate' })) throw new Error('sessionIsSaveEligible must read the row mode')
{
  const local = [
    {
      captureId: 'c1',
      sessionId: 's-tr',
      bytes: 32000,
      sealed: true,
      intent: 'save',
      modifiedAt: at(11, 0),
      mode: 'translate',
    },
    {
      captureId: 'c2',
      sessionId: 's-m',
      bytes: 32000,
      sealed: true,
      intent: 'save',
      modifiedAt: at(10, 0),
      mode: 'meeting',
    },
    {
      captureId: 'c3',
      sessionId: '',
      bytes: 32000,
      sealed: true,
      intent: 'save',
      modifiedAt: at(9, 0),
    },
  ]
  const rows = mergeLocalCaptures(
    [] as Array<{ id: string; started_at?: string | null; mode?: string }>,
    local,
    (row) => ({
      id: row.sessionId || `local:${row.captureId}`,
      mode: row.mode || '',
      started_at: row.modifiedAt,
      kept: false,
    }),
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  eq(byId.get('s-tr')?.mode || '', 'translate', 'a local Translate capture keeps its own mode')
  eq(byId.get('s-m')?.mode || '', 'meeting', 'a local Meeting capture keeps meeting')
  eq(byId.get('local:c3')?.mode || '', '', 'a legacy capture with no mode is not assumed to be a meeting')
}
{
  const saved = { id: 'kept-1', title: 'Saved standup', started_at: '2026-09-09T10:00:00.000Z', kept: true as boolean | undefined }
  const pending = { id: 'pending-1', title: 'Crash meeting', started_at: '2026-09-09T09:00:00.000Z' }
  const merged = mergePendingHistory([saved], [pending])
  eq(merged.map((row) => row.id).join('|'), 'kept-1|pending-1', 'newer saved session ranks above older unsaved')
  if (sessionIsUnsaved(merged[0])) throw new Error('newer saved History row stays saved')
  if (!sessionIsUnsaved(merged[1])) throw new Error('older pending History row stays unsaved')
  const dup = mergePendingHistory(
    [{ id: 'pending-1', started_at: '2026-09-09T10:00:00.000Z', kept: true }],
    [{ id: 'pending-1', started_at: '2026-09-09T10:00:00.000Z' }],
  )
  eq(dup.map((row) => row.id).join('|'), 'pending-1', 'the same id is not listed twice')
  if (!sessionIsUnsaved(dup[0])) throw new Error('pending copy wins when the id collides')
  const acrossDays = mergePendingHistory(
    [{ id: 'older-kept', started_at: '2026-09-08T18:00:00.000Z', kept: true }],
    [{ id: 'newer-pending', started_at: '2026-09-09T08:00:00.000Z' }],
  )
  eq(acrossDays.map((row) => row.id).join('|'), 'newer-pending|older-kept', 'cross-day order uses timestamps not day labels')
  const sameTime = mergePendingHistory(
    [{ id: 'saved-noon', started_at: '2026-09-09T12:00:00.000Z', kept: true }],
    [{ id: 'pending-noon', started_at: '2026-09-09T12:00:00.000Z' }],
  )
  eq(sameTime.map((row) => row.id).join('|'), 'pending-noon|saved-noon', 'equal start times keep stable merge order')
  const missing = mergePendingHistory(
    [
      { id: 'dated', started_at: '2026-09-09T11:00:00.000Z', kept: true },
      { id: 'invalid', started_at: 'not-a-date', kept: true },
    ],
    [{ id: 'empty', started_at: null }],
  )
  eq(missing.map((row) => row.id).join('|'), 'dated|empty|invalid', 'missing and invalid start times sort last')
  const savedIn = [{ id: 's', started_at: '2026-09-09T10:00:00.000Z', kept: true }]
  const pendingIn = [{ id: 'p', started_at: '2026-09-09T09:00:00.000Z' }]
  mergePendingHistory(savedIn, pendingIn)
  eq(savedIn[0].id, 's', 'saved input is not mutated')
  eq(pendingIn[0].id, 'p', 'pending input is not mutated')
  const localMerged = mergeLocalCaptures(
    [{ id: 'cloud-1', started_at: '2026-09-09T10:00:00.000Z', kept: true }],
    [
      { captureId: 'cap-a', sessionId: 'cloud-1', bytes: 3200, sealed: true, intent: 'none', modifiedAt: '2026-09-09T11:00:00.000Z' },
      { captureId: 'cap-b', sessionId: '', bytes: 6400, sealed: true, intent: 'none', modifiedAt: '2026-09-09T12:00:00.000Z' },
      { captureId: 'cap-c', sessionId: '', bytes: 100, sealed: true, intent: 'discard', modifiedAt: '2026-09-09T13:00:00.000Z' },
    ],
    (row) => ({ id: row.sessionId || `local:${row.captureId}`, started_at: row.modifiedAt, kept: false }),
  )
  eq(localMerged.map((row) => row.id).join('|'), 'local:cap-b|cloud-1', 'local phone capture appears once and skips discard / already-listed sessions')
  const overlaid = overlayNativeSaveJobs(localMerged, [
    { sessionId: 'cloud-1', captureId: 'cap-a', save: 'local' },
  ])
  eq(overlaid.map((row) => `${row.id}:${row.nativeSave || ''}`).join('|'), 'local:cap-b:|cloud-1:local', 'native local keep still shows on a cloud History row')
  const liveSkipped = mergeLocalCaptures(
    [{ id: 'cloud-1', started_at: '2026-09-09T10:00:00.000Z', kept: true }],
    [{ captureId: 'live', sessionId: 'live-sess', bytes: 64000, sealed: false, intent: 'none', modifiedAt: '2026-09-09T12:00:00.000Z' }],
    (row) => ({ id: localCaptureHistoryId(row), started_at: row.modifiedAt, kept: false }),
  )
  eq(liveSkipped.map((row) => row.id).join('|'), 'cloud-1', 'an in-progress capture is not a finished Unsaved meeting')
  if (localCaptureCanAppear({ captureId: 'x', sessionId: 'gone', bytes: 3200, sealed: true, intent: 'none', modifiedAt: '' }, ['gone'])) {
    throw new Error('a discarded session id must not reappear as a local Unsaved row')
  }
  const assembledOk = assembleHistoryList({
    saved: { ok: true, sessions: [{ id: 'cloud-1', started_at: '2026-09-09T10:00:00.000Z' }] },
    pending: { ok: true, sessions: [] },
    local: [
      { captureId: 'cap-a', sessionId: 'cloud-1', bytes: 3200, sealed: true, intent: 'none', modifiedAt: '2026-09-09T11:00:00.000Z' },
      { captureId: 'cap-b', sessionId: '', bytes: 6400, sealed: true, intent: 'none', modifiedAt: '2026-09-09T12:00:00.000Z' },
    ],
    jobs: [{ sessionId: 'cloud-1', captureId: 'cap-a', save: 'failed' }],
    toLocalRow: (row) => ({ id: localCaptureHistoryId(row), started_at: row.modifiedAt }),
  })
  eq(assembledOk.error, '', 'a successful History load has no fetch error')
  eq(assembledOk.sessions.map((row) => row.id).join('|'), 'local:cap-b|cloud-1', 'local extras still fill gaps when cloud load succeeds')
  const cloudGone = assembleHistoryList({
    saved: { ok: false },
    pending: { ok: false },
    local: [
      { captureId: 'cap-a', sessionId: 'cloud-1', bytes: 3200, sealed: true, intent: 'none', modifiedAt: '2026-09-09T11:00:00.000Z' },
      { captureId: 'orphan', sessionId: '', bytes: 6400, sealed: true, intent: 'none', modifiedAt: '2026-09-09T12:00:00.000Z' },
    ],
    jobs: [{ sessionId: 'cloud-1', captureId: 'cap-a', save: 'failed' }],
    toLocalRow: (row) => ({ id: localCaptureHistoryId(row), started_at: row.modifiedAt }),
  })
  if (!cloudGone.error) throw new Error('a failed History fetch must not look like an empty list')
  eq(cloudGone.sessions.map((row) => row.id).join('|'), 'local:orphan', 'failed cloud load must not resurrect local copies of unknown sessions')
  const noSaveGone = assembleHistoryList({
    saved: { ok: true, sessions: [] },
    pending: { ok: true, sessions: [{ id: 'pending-1', started_at: '2026-09-09T09:00:00.000Z' }] },
    local: [{ captureId: 'cap-p', sessionId: 'pending-1', bytes: 3200, sealed: true, intent: 'none', modifiedAt: '2026-09-09T09:00:00.000Z' }],
    jobs: [{ sessionId: 'pending-1', captureId: 'cap-p', save: 'failed' }],
    discardedIds: ['pending-1'],
    toLocalRow: (row) => ({ id: localCaptureHistoryId(row), started_at: row.modifiedAt }),
  })
  eq(noSaveGone.sessions.length.toString(), '0', 'No Save removes the cloud pending row, local copy, and Retry save job')
}
if (JSON.stringify(rememberRestoreDismissed([], 'p1')) !== JSON.stringify(['p1'])) throw new Error('first dismiss is recorded')
if (JSON.stringify(rememberRestoreDismissed(['p1'], 'p1')) !== JSON.stringify(['p1'])) throw new Error('repeat dismiss does not duplicate')
if (JSON.stringify(parseRestoreDismissed(serializeRestoreDismissed(['a', 'b']))) !== JSON.stringify(['a', 'b'])) {
  throw new Error('dismissed ids round-trip through storage')
}
if (parseRestoreDismissed('not-json').length !== 0) throw new Error('corrupt storage is empty')
if (parseRestoreDismissed(null).length !== 0) throw new Error('missing storage is empty')

if (resumeResetsKept({ kept: false, hasContent: true })) throw new Error('unsaved resume must not clear kept')
if (!resumeResetsKept({ kept: true, hasContent: true })) throw new Error('kept + content resume must reset kept')
if (resumeResetsKept({ kept: true, hasContent: false })) throw new Error('kept empty resume must not reset kept')

const resumed = applyMeetingResume({
  meetingEnded: true,
  meetingStartedAt: 1_000,
  meetingElapsedMs: 90_000,
  composeSessionId: 7,
  meetingLines: [{ id: 'a' }],
  notesRaw: 'notes stay',
  catchNotes: [{ id: 'c' }],
}, 200_000)
if (resumed.meetingEnded) throw new Error('meeting_resume must clear ended')
if (resumed.meetingElapsedMs !== 90_000) throw new Error('meeting_resume must keep elapsedMs')
if (resumed.meetingStartedAt !== 110_000) throw new Error('meeting_resume must rewind startedAt so the clock continues')
if (resumed.composeSessionId !== 7) throw new Error('meeting_resume must keep the Ask compose session')
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

const liveClock = restoreAttachedClock(restored.elapsedMs, 500_000)
const liveAttach = restoreAttachState(liveClock, {
  partial: 'still drafting',
  partialSpeaker: 'B',
  speakerDecided: { B: 'confirmed' },
}, true)
if (liveAttach.partial !== 'still drafting') throw new Error('live attach must keep the in-flight partial')
if (liveAttach.partialSpeaker !== 'B') throw new Error('live attach must keep partialSpeaker')
if (liveAttach.speakerDecided.B !== 'confirmed') throw new Error('live attach must keep speakerDecided')
if (liveClock.meetingEnded) throw new Error('attached restore must not mark the live session ended')
if (liveClock.meetingStartedAt !== clock.meetingStartedAt) throw new Error('attached restore must keep the same startedAt')
if (liveClock.meetingElapsedMs !== 65_000) throw new Error('attached restore must keep elapsed')

if (pickAttachedSession([{ id: 'a' }, { id: 'b' }], 'b')?.id !== 'b') {
  throw new Error('attached restore must match usage_session_id')
}
if (pickAttachedSession([{ id: 'a' }, { id: 'b' }], 'missing')) {
  throw new Error('unknown id must not fall back to the first pending session')
}
if (pickAttachedSession([{ id: 'a' }], '')) {
  throw new Error('empty attach id must not pick a session')
}

if (!attachRestoreIsCurrent(3, 3)) throw new Error('matching seq is current')
if (attachRestoreIsCurrent(2, 3)) throw new Error('stale attach fetch must be ignored')
if (attachRestoreIsCurrent(0, 0)) throw new Error('seq 0 is not a started restore')

const merged = mergeAttachedLines(
  [
    { id: 'old', ts: '0:01', text: 'from history', rev: 0 },
    { id: 'lock', ts: '0:20', text: 'said while locked', rev: 0 },
  ],
  [
    { id: 'old', ts: '0:01', text: 'stale screen', rev: 0 },
    { id: 'lock', ts: '0:20', text: 'extended after fetch', rev: 2 },
    { id: 'new', ts: '0:45', text: 'arrived during fetch', rev: 0 },
  ],
)
eq(merged.map((l) => l.id).join(','), 'old,lock,new', 'restore order then live-only ids')
eq(merged[0].text, 'from history', 'stale on-screen text must not overwrite history')
eq(merged[1].text, 'extended after fetch', 'higher-rev live line overlays the snapshot')
eq(merged[2].text, 'arrived during fetch', 'lines that landed during the fetch stay')

