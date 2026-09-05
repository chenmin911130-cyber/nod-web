import { groupHistoryByDay, historyRowWhen, historySessionMatches, restoreFromSession, sessionSaveKeep, sessionShouldOfferSave, sessionShouldOpenSavePrompt } from './historyRestore'
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
