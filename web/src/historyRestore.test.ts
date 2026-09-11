import { applyMeetingResume, elapsedMsFromTranscriptTs, groupHistoryByDay, historyRowWhen, historySessionMatches, mergeLocalCaptures, overlayNativeSaveJobs, mergePendingHistory, parseRestoreDismissed, rememberRestoreDismissed, restoreAttachedClock, restoreElapsedMs, restoreFromSession, restoreIdOfferable, restoreLaunchSurface, restoreOfferBody, restoreSessionClock, restoreShouldNotAsk, resumeResetsKept, serializeRestoreDismissed, sessionIsUnsaved, sessionSaveKeep, sessionShouldOfferSave, sessionShouldOpenSavePrompt, shouldOfferSaveOnce, startMeetingKind, attachRestoreIsCurrent, mergeAttachedLines, pickAttachedSession } from './historyRestore'
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

