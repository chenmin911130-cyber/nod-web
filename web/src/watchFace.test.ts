import { buildWatchAlwaysOn, buildWatchScreen, watchLangPair, watchListenPane, watchStatusMode } from './watchFace'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

const translateListening = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})

eq(translateListening.phase, 'translateListening', 'Translate while listening with no sentence')
eq(translateListening.mascot, false, 'Watch must not show the pet')
eq(translateListening.showModePicker, false, 'Watch must not pick Meeting / Lecture')
eq(translateListening.showHistoryList, false, 'Watch must not list History')
eq(translateListening.modeLabel, 'Translate', 'mode capsule')
eq(translateListening.langPair, 'Auto → CH', 'default pair follows Chinese captions')
eq(translateListening.status, '听着', 'listening status')
eq(translateListening.rec, true, 'REC while listening')
eq(translateListening.swipeStop, true, 'Translate listening Stop lives on the swipe page')
eq(translateListening.waveform, true, 'Translate listening keeps a waveform')
eq(translateListening.playLabel, undefined, 'Watch Translate has no Play')

const translateResult = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: 'Hello, how are you?',
  translation: '你好，你好吗？',
  question: '',
  answer: '',
  drafting: false,
})
eq(translateResult.phase, 'translateResult', 'current sentence covers the listening chrome')
eq(translateResult.original, 'Hello, how are you?', 'Watch Translate keeps bilingual source')
eq(translateResult.translation, '你好，你好吗？', 'translation is the large line')
eq(translateResult.playLabel, undefined, 'Watch Translate has no Play')
eq(translateResult.primary, undefined, 'Stop is on the swipe page, not under the sentence')
eq(translateResult.swipeStop, true, 'swipe right opens Stop')
eq(translateResult.waveform, true, 'waveform shows listening is still on')
eq(translateResult.previous, undefined, 'the first sentence has no previous line')

const stackedResult = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: 'see you tomorrow',
  translation: '明天见',
  previous: '你好',
  question: '',
  answer: '',
  drafting: false,
})
eq(stackedResult.previous, '你好', 'Watch Translate keeps one muted previous line')
eq(stackedResult.translation, '明天见', 'the current sentence stays the large line')
eq(translateResult.clipLines, 3, 'long Translate copy starts at three lines')
eq(translateResult.mascot, false, 'result must not show the pet')
eq(
  translateResult.translation,
  '你好，你好吗？',
  'current sentence stays whole, not a three-line clip',
)

const longZh = '今天的发布会改到下周一上午十点，请把客户邮件和测试清单一起带上。'
const longResult = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: 'Move the launch to Monday at 10 and bring the customer email plus the test checklist.',
  translation: longZh,
  question: '',
  answer: '',
  drafting: false,
})
eq(longResult.translation, longZh, 'a long current sentence stays whole for crown scroll')
eq(longResult.clipLines, 3, 'the viewport is three lines, not an infinite scroll')
eq(longResult.crownScroll, true, 'long Translate copy scrolls instead of clipping')
eq(longResult.swipeStop, true, 'long Translate result still swipes to Stop')
eq(longResult.original, 'Move the launch to Monday at 10 and bring the customer email plus the test checklist.', 'long Translate stays bilingual')

const ready = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(ready.phase, 'ready', 'idle is Ready')
eq(ready.primary, 'Start', 'one Start button')
eq(ready.status, undefined, 'Ready has no status line')
eq(ready.modeLabel, 'Meeting', 'Watch capsule matches the phone Meeting scene')
eq(ready.showModePicker, false, 'Ready has no mode list')

const listening = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(listening.phase, 'listening', 'Listen session chrome')
eq(listening.statusEn, 'Recording', 'web listening line')
eq(listening.status, '录音中', 'Chinese recording status')
eq(listening.primary, 'Pause', 'Pause is the main recording button')
eq(listening.secondary, 'End recording', 'End recording lives on the swipe page')
eq(listening.swipeStop, true, 'recording swipes to End recording')
eq(listening.rec, true, 'REC while Listen is running')

const paused = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'lecture',
  listening: false,
  paused: true,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(paused.phase, 'paused', 'Pause freezes the session')
eq(paused.status, '已暂停', 'paused status')
eq(paused.primary, 'Resume', 'Resume is the main paused button')
eq(paused.secondary, 'End recording', 'End recording stays on the swipe page')
eq(paused.swipeStop, true, 'paused swipes to End recording')
eq(paused.modeLabel, 'Lecture', 'Lecture is a read-only capsule')

const qaWait = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(qaWait.phase, 'qaWaiting', 'Live Q&A waits for a question')
eq(qaWait.status, '听问题', 'waiting copy')
eq(qaWait.modeLabel, 'Live Q&A', 'Q&A capsule')
eq(qaWait.swipeStop, true, 'Live Q&A waiting Stop lives on the swipe page')
eq(qaWait.playLabel, undefined, 'Live Q&A has no Play')

const qaDraft = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: 'Why ship Friday?',
  answer: '',
  drafting: true,
})
eq(qaDraft.phase, 'qaDrafting', 'drafting after a question')
eq(qaDraft.question, 'Why ship Friday?', 'question stays one gray line')
eq(qaDraft.status, '起草中', 'drafting copy')
eq(qaDraft.swipeStop, true, 'Q&A draft Stop lives on the swipe page')
eq(qaDraft.playLabel, undefined, 'Q&A draft has no Play')

const qaAnswer = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  question: 'Why ship Friday?',
  answer: 'QA 还没完，建议下周一。',
  drafting: false,
})
eq(qaAnswer.phase, 'qaAnswer', 'answer replaces the draft')
eq(qaAnswer.answer, 'QA 还没完，建议下周一。', 'answer is the large line')
eq(qaAnswer.previous, undefined, 'the first Q&A answer has no previous line')
eq(qaAnswer.waveform, true, 'Q&A answer keeps the listening waveform')
eq(qaAnswer.playLabel, undefined, 'Q&A answer has no Play')
eq(qaAnswer.primary, undefined, 'Q&A Stop is on the swipe page')
eq(qaAnswer.swipeStop, true, 'swipe right opens Stop')
eq(qaAnswer.clipLines, 3, 'Q&A answer starts at three lines')
eq(qaAnswer.crownScroll, true, 'long Q&A answers scroll instead of clipping')

const qaStacked = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: '',
  translation: '',
  previous: 'QA 还没完，建议下周一。',
  question: 'Who owns launch?',
  answer: '产品经理，周一同步。',
  drafting: false,
})
eq(qaStacked.previous, 'QA 还没完，建议下周一。', 'Q&A keeps one muted previous answer')
eq(qaStacked.answer, '产品经理，周一同步。', 'the current answer stays the large line')
eq(watchListenPane('interview', true), 'qa', 'a new answer must not open the Stop page')

const ended = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: true,
  save: 'none',
  elapsedMs: 90_000,
  original: 'Hello',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(ended.phase, 'ended', 'Meeting End opens Ended')
eq(ended.primary, 'Save', 'Save is the main Ended button')
eq(ended.secondary, 'Continue recording', 'Continue recording stays on Ended')
eq(ended.tertiary, "Don't save", 'Don\'t save is the weak third action')

const savingFace = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'lecture',
  listening: false,
  paused: false,
  ended: true,
  save: 'saving',
  original: 'Hello',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(savingFace.phase, 'saving', 'keep in flight is Saving')
eq(savingFace.tertiary, undefined, 'Saving has no Don\'t save')

const saved = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: true,
  save: 'saved',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(saved.phase, 'saved', 'matching keep ack is Saved')
eq(saved.statusEn, 'Saved to History', 'saved copy points at History')
eq(saved.mascot, false, 'saved must not show the pet')
eq(saved.tertiary, undefined, 'Saved has no Don\'t save')
eq(saved.primary, 'Continue recording', 'Saved can continue the same session')

const saveFailed = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: true,
  save: 'failed',
  original: 'Hello',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(saveFailed.phase, 'saveFailed', 'timeout or keep fail is Couldn\'t save')
eq(saveFailed.primary, 'Retry save', 'failed offers Retry save')
eq(saveFailed.tertiary, undefined, 'failed has no Don\'t save')

const translateEnded = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: true,
  save: 'none',
  original: 'Hello',
  translation: '你好',
  question: '',
  answer: '',
  drafting: false,
})
eq(translateEnded.phase, 'ready', 'Translate End does not open Ended')

const qaEnded = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: false,
  paused: false,
  ended: true,
  save: 'none',
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(qaEnded.phase, 'ready', 'Live Q&A End does not open Ended')

eq(watchStatusMode('translate', 'meeting'), 'translate', 'Translate stays Translate')
eq(watchStatusMode('interview', 'interview'), 'interview', 'Live Q&A stays interview')
eq(watchStatusMode('meeting', 'lecture'), 'lecture', 'Lecture is a capsule, not a picker')
eq(watchStatusMode('meeting', 'meeting'), 'meeting', 'Meeting stays on the phone workspace')
eq(ready.modeLabel, 'Meeting', 'leftover Lecture must not win when the phone scene is Meeting')

eq(watchLangPair('zh'), 'Auto → CH', 'Chinese captions')
eq(watchLangPair('it'), 'Auto → IT', 'Italian captions follow the phone target')
eq(watchLangPair('en'), 'Auto → EN', 'English captions')

const italian = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  original: 'Buongiorno',
  translation: 'Buongiorno',
  question: '',
  answer: '',
  drafting: false,
  translateTo: 'it',
})
eq(italian.langPair, 'Auto → IT', 'Watch pair must track the phone Translate target')
eq(italian.playLabel, undefined, 'Watch Translate has no Play')
eq(italian.original, '', 'same-language copy stays one line')
eq(watchListenPane('translate', false), 'translate', 'empty Translate stays on the live pane')
eq(watchListenPane('translate', true), 'translate', 'a new sentence must not open the Stop page')

const meetingOn = buildWatchAlwaysOn({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  translation: '',
  answer: 'secret',
})
eq(meetingOn.show, true, 'Meeting Always On stays up')
eq(meetingOn.showTimer, true, 'Meeting Always On keeps the clock')
eq(meetingOn.recDot, true, 'Meeting Always On keeps the red dot')
eq(meetingOn.line, undefined, 'Meeting Always On must not show copy')
eq(meetingOn.modeLabel, undefined, 'Meeting Always On is timer + dot only')

const qaOn = buildWatchAlwaysOn({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  translation: '对面不该看见这句',
  answer: '对面不该看见这句',
})
eq(qaOn.modeLabel, 'Live Q&A', 'Q&A Always On keeps the capsule')
eq(qaOn.showTimer, true, 'Q&A Always On keeps the clock')
eq(qaOn.line, undefined, 'Q&A Always On must not leak the answer')
eq(qaOn.recDot, false, 'Q&A Always On is capsule + clock')

const trOn = buildWatchAlwaysOn({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  ended: false,
  save: 'none',
  translation: '请把合同放到桌上',
  answer: '',
})
eq(trOn.line, '请把合同放到桌上', 'Translate Always On keeps the sentence')
eq(trOn.showTimer, false, 'Translate Always On is the sentence, not a clock')

const pausedOn = buildWatchAlwaysOn({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: true,
  ended: false,
  save: 'none',
  translation: '',
  answer: '',
})
eq(pausedOn.line, '已暂停', 'paused Always On says 已暂停')
eq(pausedOn.showTimer, true, 'paused Always On keeps the frozen clock')

const readyOn = buildWatchAlwaysOn({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: false,
  save: 'none',
  translation: '',
  answer: '',
})
eq(readyOn.show, false, 'Ready must not occupy Always On')

const savedOn = buildWatchAlwaysOn({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  ended: true,
  save: 'saved',
  translation: '',
  answer: '',
})
eq(savedOn.show, false, 'saved ack must not occupy Always On')
