import { historySessionMatches, restoreFromSession, sessionSaveKeep, sessionShouldOfferSave, sessionShouldOpenSavePrompt } from './historyRestore'
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
if (!sessionShouldOfferSave({ workspaceMode: 'meeting', ended: false, kept: false, hasContent: true, listening: false })) {
  throw new Error('paused Meeting with content must offer Save')
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
