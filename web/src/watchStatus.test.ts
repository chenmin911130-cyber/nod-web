import {
  buildWatchFace,
  watchEndedFor,
  watchHaptic,
  watchPreviousCaption,
  watchReadingAnchor,
  watchRmsToLevel,
  type WatchHaptic,
  type WatchHapticSnap,
} from './watchStatus'

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

function eqAnchor(got: { scroll: boolean; pill: boolean }, want: { scroll: boolean; pill: boolean }, label: string) {
  if (got.scroll !== want.scroll || got.pill !== want.pill) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}
eqAnchor(watchReadingAnchor({ atLatest: true, newUnit: true, pillShown: false }), { scroll: true, pill: false }, 'at latest + new unit scrolls')
eqAnchor(watchReadingAnchor({ atLatest: false, newUnit: true, pillShown: false }), { scroll: false, pill: true }, 'scrolled away + new unit shows pill')
eqAnchor(watchReadingAnchor({ atLatest: false, newUnit: false, pillShown: true }), { scroll: false, pill: true }, 'still away keeps pill')
eqAnchor(watchReadingAnchor({ atLatest: true, newUnit: false, pillShown: true }), { scroll: false, pill: false }, 'back at latest clears pill')

const qaHist = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: false,
  translatePairs: [],
  meetingLines: [{ id: 'm', text: 'ignore me' }],
  turns: [
    { id: 'q1', q: 'Why ship Friday?', a: 'QA 还没完，建议下周一。' },
    { id: 'q2', q: 'Who owns launch?', a: '产品经理，周一同步。' },
  ],
})
if (qaHist.history[0]?.id !== 'q2' || qaHist.history[1]?.id !== 'q1') {
  throw new Error(`interview history must be newest first from turns, got ${JSON.stringify(qaHist.history)}`)
}
if (qaHist.failed) throw new Error('interview history with answers is not failed')

const qaFailedFace = buildWatchFace({
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
    { id: 'q2', q: 'Who owns launch?', a: '', failed: true },
  ],
})
if (!qaFailedFace.failed) throw new Error('interview latest failed turn must set face.failed')
if (qaFailedFace.history[0]?.failed !== true) throw new Error('interview history[0] must carry failed')

const qaAnsweredAfterFail = buildWatchFace({
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
    { id: 'q2', q: 'Who owns launch?', a: '', failed: true },
    { id: 'q3', q: 'Next step?', a: 'Sync Monday.' },
  ],
})
if (qaAnsweredAfterFail.failed) throw new Error('latest answered turn must clear interview failed')

const nineTurns = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, q: `Q${i}`, a: `A${i}` }))
const qaCap = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: false,
  translatePairs: [],
  meetingLines: [],
  turns: nineTurns,
})
if (qaCap.history.length !== 8 || qaCap.history[0]?.id !== 't8') {
  throw new Error(`interview history caps at 8 newest, got ${JSON.stringify(qaCap.history.map((h) => h.id))}`)
}

const failedFace = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'translate',
  translateOn: true,
  translatePairs: [
    { id: 'ok', original: 'hi', translation: '你好' },
    { id: 'bad', original: 'later', translation: '', failed: true },
  ],
  meetingLines: [],
})
if (!failedFace.failed) throw new Error('failed follows the latest nonempty pair')
if (failedFace.history[0]?.failed !== true) throw new Error('latest history item carries failed')

function eqEnded(got: boolean, want: boolean, label: string) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
}
const pair = [{ id: '1', original: 'hello', translation: '你好' }]
const emptyPair = [{ id: '1', original: '  ', translation: '' }]
const turn = [{ id: 'q1', q: 'Why?', a: 'Because.' }]
const emptyTurn = [{ id: 'q1', q: '  ', a: '' }]
eqEnded(watchEndedFor({ workspaceMode: 'translate', capture: 'off', translatePairs: pair }), true, 'translate off+content')
eqEnded(watchEndedFor({ workspaceMode: 'translate', capture: 'off', translatePairs: emptyPair }), false, 'translate off empty')
eqEnded(watchEndedFor({ workspaceMode: 'translate', capture: 'listening', translatePairs: pair }), false, 'translate listening+content')
eqEnded(watchEndedFor({ workspaceMode: 'interview', capture: 'off', turns: turn }), true, 'interview off+content')
eqEnded(watchEndedFor({ workspaceMode: 'interview', capture: 'off', turns: emptyTurn }), false, 'interview off empty')
eqEnded(watchEndedFor({ workspaceMode: 'interview', capture: 'listening', turns: turn }), false, 'interview listening+content')
eqEnded(
  watchEndedFor({ workspaceMode: 'meeting', capture: 'off', meetingEnded: true, hasSaveableContent: true }),
  true,
  'meeting ended+content',
)
eqEnded(
  watchEndedFor({ workspaceMode: 'meeting', capture: 'off', meetingEnded: true, hasSaveableContent: false }),
  false,
  'meeting ended without content',
)
eqEnded(
  watchEndedFor({ workspaceMode: 'meeting', capture: 'listening', meetingEnded: false, hasSaveableContent: true }),
  false,
  'meeting live with content is not ended',
)

if (watchRmsToLevel(0) !== 0) throw new Error('silent RMS must be level 0')
if (watchRmsToLevel(32768) !== 1) throw new Error('full-scale Int16 RMS must be level 1')
if (watchRmsToLevel(65536) !== 1) throw new Error('above full-scale must clamp to 1')

function hapticSnap(p: Partial<WatchHapticSnap> = {}): WatchHapticSnap {
  return {
    starting: false,
    listening: false,
    paused: false,
    pending: null,
    ending: false,
    ended: false,
    capture: 'off',
    saveMatched: false,
    failure: null,
    blocked: '',
    statusUnknown: false,
    saveState: 'none',
    failed: false,
    ...p,
  }
}

function eqHaptic(prev: Partial<WatchHapticSnap>, next: Partial<WatchHapticSnap>, want: WatchHaptic, label: string) {
  const got = watchHaptic(hapticSnap(prev), hapticSnap(next))
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
}

eqHaptic({ starting: true }, { listening: true }, 'start', 'starting → listening')
eqHaptic({ pending: 'pause' }, { paused: true, pending: null }, 'click', 'pending pause → paused')
eqHaptic({ pending: 'resume', paused: true }, { listening: true, pending: null }, 'click', 'pending resume → listening')
eqHaptic({ ending: true }, { ending: false, ended: true }, 'stop', 'ending → ended')
eqHaptic({ ending: true, capture: 'listening' }, { ending: false, capture: 'off' }, 'stop', 'ending → capture off')
eqHaptic({ saveMatched: false }, { saveMatched: true }, 'success', 'saveMatched false → true')
eqHaptic({ failure: null }, { failure: 'Couldn’t start' }, 'failure', 'failure nil → non-nil')
eqHaptic({ blocked: '' }, { blocked: 'quota' }, 'failure', 'blocked empty → nonempty')
eqHaptic({ statusUnknown: false }, { statusUnknown: true }, 'failure', 'statusUnknown false → true')
eqHaptic({ saveState: 'saving' }, { saveState: 'failed' }, 'failure', 'saveState → failed')
eqHaptic({ failed: false }, { failed: true }, 'failure', 'failed false → true')
eqHaptic(
  { failure: 'Couldn’t translate', failed: true },
  { failure: 'Couldn’t translate', failed: true },
  null,
  'same failure two frames does not repeat',
)
eqHaptic(
  { listening: true, translation: '' },
  { listening: true, translation: '明天见' },
  null,
  'new translation no haptic',
)
eqHaptic(
  { listening: true, reachable: false },
  { listening: true, reachable: true },
  null,
  'reconnect no haptic',
)
eqHaptic({ listening: true, capture: 'listening' }, { listening: true, capture: 'listening' }, null, 'status push no haptic')

