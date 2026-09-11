import { buildWatchFace, watchPreviousCaption, WATCH_LIVE_COPY_MAX } from './watchStatus'

const face = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: 'hello there',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: '1', original: 'hello there', translation: '你好' }],
  meetingLines: [],
})

if (face.translation !== '你好') throw new Error(`expected translation, got ${face.translation}`)
if (face.original !== 'hello there') throw new Error(`Watch Translate must keep bilingual source, got ${face.original}`)
if (face.previous) throw new Error('the first sentence has no previous line')
if (face.history[0]?.text !== '你好') throw new Error('expected history text')
if (!face.listening) throw new Error('expected listening')

if (watchPreviousCaption([]) !== '') throw new Error('empty pairs have no previous caption')
if (watchPreviousCaption([{ id: '1', original: 'hello', translation: '你好' }]) !== '') {
  throw new Error('one sentence is current, not previous')
}

const prev = watchPreviousCaption([
  { id: '1', original: 'hello there', translation: '你好' },
  { id: '2', original: 'see you tomorrow', translation: '明天见' },
])
if (prev !== '你好') throw new Error(`previous line must be the last finished caption, got ${prev}`)

const stacked = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [
    { id: '1', original: 'hello there', translation: '你好' },
    { id: '2', original: 'see you tomorrow', translation: '明天见' },
  ],
  meetingLines: [],
})
if (stacked.translation !== '明天见') throw new Error(`current sentence must stay large, got ${stacked.translation}`)
if (stacked.previous !== '你好') throw new Error(`Watch must keep one muted previous line, got ${stacked.previous}`)

const longZh = '今天的发布会改到下周一上午十点，请把客户邮件和测试清单一起带上，不要只发一句摘要。'
const longFace = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: '2', original: 'Move the launch and bring the checklist.', translation: longZh }],
  meetingLines: [],
})
if (longFace.translation !== longZh) {
  throw new Error(`Watch must keep the full current translation, got ${longFace.translation}`)
}
if (longFace.copyId !== '2') throw new Error(`current copy must keep its pair id, got ${longFace.copyId}`)

const overLimit = `${'段落一。\n\n'}${'后续说明，'.repeat(200)}`
if (overLimit.length <= 800) throw new Error('fixture must exceed the old 800 clip')
const sourceOver = `Move the launch window.\n\n${overLimit}`
const fullFace = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: 'long-1', original: sourceOver, translation: overLimit }],
  meetingLines: [],
})
if (fullFace.original.includes('…') && sourceOver.length <= WATCH_LIVE_COPY_MAX) {
  throw new Error('current original must not use the 800-char preview clip')
}
if (fullFace.translation !== overLimit) {
  throw new Error(`current translation must keep paragraphs and the full body, got len=${fullFace.translation.length}`)
}
if (!fullFace.original.includes('\n\n')) {
  throw new Error('current original must keep paragraph breaks')
}
if (fullFace.copyId !== 'long-1') throw new Error(`copy id must follow the pair, got ${fullFace.copyId}`)
if (fullFace.history[0]?.text.endsWith('…') !== true) {
  throw new Error('history remains a clipped preview')
}

const longQa = '字'.repeat(900)
const qaLong = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: false,
  translatePairs: [],
  meetingLines: [],
  turns: [{ id: 'q-long', q: 'Why ship Friday?\n\nPlease list every risk.', a: longQa }],
})
if (qaLong.translation !== longQa) {
  throw new Error(`Watch Q&A must keep a long answer whole, got len=${qaLong.translation.length}`)
}
if (qaLong.copyId !== 'q-long') throw new Error(`Q&A copy id must follow the turn, got ${qaLong.copyId}`)
if (!qaLong.original.includes('\n\n')) {
  throw new Error('Watch Q&A original must keep paragraph breaks')
}

const nearCap = '字'.repeat(WATCH_LIVE_COPY_MAX)
const nearFace = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: 'cap-ok', original: 'Keep the window.', translation: nearCap }],
  meetingLines: [],
})
if (nearFace.translation !== nearCap) {
  throw new Error('current copy at the Watch payload cap must stay unclipped')
}
const overCap = '字'.repeat(WATCH_LIVE_COPY_MAX + 40)
const capFace = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: 'cap-over', original: 'Keep the window.', translation: overCap }],
  meetingLines: [],
})
if (capFace.translation.length !== WATCH_LIVE_COPY_MAX || !capFace.translation.endsWith('…')) {
  throw new Error(`Watch live copy must cap at ${WATCH_LIVE_COPY_MAX}, got ${capFace.translation.length}`)
}

const meeting = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: 'we will ship friday',
  workspaceMode: 'meeting',
  translateOn: false,
  translatePairs: [],
  meetingLines: [{ id: 'm1', text: 'we will ship friday' }],
})
if (meeting.original !== 'we will ship friday') {
  throw new Error(`Watch Meeting must show the caption, got ${meeting.original}`)
}
if (meeting.hint !== 'we will ship friday') {
  throw new Error(`Watch Meeting hint must carry the caption when translation is off`)
}
if (meeting.previous) throw new Error('Meeting must not grow a previous-caption stack')

const same = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: '3', original: 'Buongiorno', translation: 'Buongiorno' }],
  meetingLines: [],
})
if (same.original) {
  throw new Error('Watch Translate must not send an original line')
}
if (same.translation !== 'Buongiorno') {
  throw new Error(`passthrough still shows the sentence once, got ${same.translation}`)
}

const doubled = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: '4', original: '你好', translation: '你好\n你好' }],
  meetingLines: [],
})
if (doubled.translation.includes('\n') || doubled.original === doubled.translation) {
  throw new Error(`Watch must collapse a repeated translation, got ${JSON.stringify(doubled)}`)
}

const qaOne = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: false,
  translatePairs: [],
  meetingLines: [],
  turns: [{ id: 'q1', q: 'Why ship Friday?', a: 'QA 还没完，建议下周一。' }],
})
if (qaOne.original !== 'Why ship Friday?') throw new Error(`Watch Q&A must show the question, got ${qaOne.original}`)
if (qaOne.translation !== 'QA 还没完，建议下周一。') throw new Error(`Watch Q&A must show the answer, got ${qaOne.translation}`)
if (qaOne.previous) throw new Error('the first Q&A answer has no previous line')

const qaTwo = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: false,
  translatePairs: [],
  meetingLines: [],
  turns: [
    { id: 'q1', q: 'Why ship Friday?', a: 'QA 还没完，建议下周一。' },
    { id: 'q2', q: 'Who owns launch?', a: '产品经理，周一同步。' },
  ],
})
if (qaTwo.original !== 'Who owns launch?') throw new Error(`current question must stay, got ${qaTwo.original}`)
if (qaTwo.translation !== '产品经理，周一同步。') throw new Error(`current answer must stay large, got ${qaTwo.translation}`)
if (qaTwo.previous !== 'QA 还没完，建议下周一。') {
  throw new Error(`Watch Q&A must keep one muted previous answer, got ${qaTwo.previous}`)
}

// A transient 'think' during a live session must stay "listening" so the Watch
// does not treat it as a Stop and jump back to the main face. Live Q&A answers
// are not auto-spoken, so keeping the mic on while drafting is safe.
const translateThink = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [{ id: '5', original: 'hello', translation: '' }],
  meetingLines: [],
})
if (!translateThink.listening) throw new Error('Translate think must still count as listening')

const meetingThink = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'meeting',
  translateOn: false,
  translatePairs: [],
  meetingLines: [{ id: 'm2', text: 'ship friday' }],
})
if (!meetingThink.listening) throw new Error('Meeting think must still count as listening')

// Live Q&A: drafting the answer (think) is still an in-session state — the Watch
// must stay on the Q&A page, not jump back to the main face.
const interviewThink = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: false,
  translatePairs: [],
  meetingLines: [],
  turns: [{ id: 'q3', q: 'Why?', a: '' }],
})
if (!interviewThink.listening) throw new Error('Interview think must still count as listening')

// --- Exhaustive capture × workspace matrix for buildWatchFace.listening ---
// listening is true only while the session is actively capturing (listening /
// recording), in EVERY workspace; off and paused are not. A generating model
// (engine) keeps capture='listening', which is exactly why the Watch no longer
// sees a transient run='think' as "Phone Stop".
function eqListen(capture: string, workspaceMode: string, expected: boolean): void {
  const f = buildWatchFace({
    capture,
    consentOpen: false,
    notesAskId: '',
    notesRaw: '',
    partial: '',
    workspaceMode,
    translateOn: workspaceMode === 'translate',
    translatePairs: workspaceMode === 'translate' ? [{ id: 'x', original: 'hi', translation: expected ? 'ok' : '' }] : [],
    meetingLines: workspaceMode === 'meeting' ? [{ id: 'm', text: 'hi' }] : [],
    turns: workspaceMode === 'interview' ? [{ id: 'q', q: 'why?', a: '' }] : [],
  })
  if (f.listening !== expected) {
    throw new Error(`capture=${capture} workspace=${workspaceMode} must report listening=${expected}, got ${f.listening}`)
  }
}
for (const ws of ['meeting', 'interview', 'translate']) {
  eqListen('off', ws, false)
  eqListen('listening', ws, true)
  eqListen('recording', ws, true)
  eqListen('paused', ws, false)
}
