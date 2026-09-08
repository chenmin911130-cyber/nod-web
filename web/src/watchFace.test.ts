import { buildWatchAlwaysOn, buildWatchScreen, watchAlwaysOnKeepsTree, watchLangPair, watchListenPane, watchStatusMode } from './watchFace'

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
eq(translateListening.langPair, 'Auto → ZH', 'default pair follows Chinese captions')
eq(translateListening.status, '自然说话即可', 'waiting copy')
eq(translateListening.statusEn, 'Speak naturally', 'web waiting line')
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
eq(translateResult.langPair, 'Auto → ZH', 'result pair uses ZH')
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
eq(stackedResult.previous, undefined, 'W3 reading page drops the previous line')
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

const startingReady = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
  starting: true,
})
eq(startingReady.phase, 'ready', 'Starting stays on Ready')
eq(startingReady.primary, 'Starting…', 'Start button becomes Starting…')

const failedReady = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: false,
  paused: false,
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
  failure: 'Open Nodpilot on iPhone to sign in',
})
eq(failedReady.phase, 'ready', 'a start failure stays on Ready')
eq(failedReady.status, 'Open Nodpilot on iPhone to sign in', 'Ready shows the failure line')
eq(failedReady.primary, 'Start', 'Start stays tappable after a failure')

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
eq(qaWait.status, '等待问题', 'waiting copy')
eq(qaWait.statusEn, 'Waiting for a question', 'web waiting line')
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
  engine: 'generating',
})
eq(qaDraft.phase, 'qaDrafting', 'drafting after a question')
eq(qaDraft.question, 'Why ship Friday?', 'question stays one gray line')
eq(qaDraft.status, '正在生成…', 'drafting copy')
eq(qaDraft.statusEn, 'Drafting…', 'web drafting line')
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
eq(qaStacked.previous, undefined, 'W3 reading page drops the previous answer')
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
if (translateEnded.phase === 'ready') {
  throw new Error('translate ended with content must stay on a reading phase')
}
eq(translateEnded.captureLine, 'Ended', 'translate ended captureLine')

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
eq(qaEnded.phase, 'ready', 'Live Q&A End with no content returns Ready')

const qaEndedContent = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: false,
  paused: false,
  ended: true,
  save: 'none',
  original: '',
  translation: '',
  question: 'Why ship Friday?',
  answer: 'QA 还没完，建议下周一。',
  drafting: false,
})
if (qaEndedContent.phase === 'ready') {
  throw new Error('interview ended with content must stay on a reading phase')
}
eq(qaEndedContent.captureLine, 'Ended', 'interview ended captureLine')

const translateEndedEmpty = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
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
eq(translateEndedEmpty.phase, 'ready', 'translate ended with no content returns Ready')

eq(watchStatusMode('translate', 'meeting'), 'translate', 'Translate stays Translate')
eq(watchStatusMode('interview', 'interview'), 'interview', 'Live Q&A stays interview')
eq(watchStatusMode('meeting', 'lecture'), 'lecture', 'Lecture is a capsule, not a picker')
eq(watchStatusMode('meeting', 'meeting'), 'meeting', 'Meeting stays on the phone workspace')
eq(ready.modeLabel, 'Meeting', 'leftover Lecture must not win when the phone scene is Meeting')

eq(watchLangPair('zh'), 'Auto → ZH', 'Chinese captions')
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

const translateGenerating = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  original: 'Hello, how are you?',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
  engine: 'generating',
})
eq(translateGenerating.phase, 'translateGenerating', 'engine generating with source only')
eq(translateGenerating.original, 'Hello, how are you?', 'source stays while translating')
eq(translateGenerating.statusEn, 'Translating…', 'web translating line')
eq(translateGenerating.langPair, 'Auto → ZH', 'generating pair uses ZH')

const qaTranscribing = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  original: '',
  translation: '',
  question: 'Why ship Friday?',
  answer: '',
  drafting: true,
  engine: 'transcribing',
})
if (qaTranscribing.phase === 'qaDrafting') {
  throw new Error('a transcribing question must not show Drafting')
}

const pausedTranslate = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: false,
  paused: true,
  original: 'Hello, how are you?',
  translation: '你好，你好吗？',
  question: '',
  answer: '',
  drafting: false,
})
eq(pausedTranslate.phase, 'translateResult', 'paused Translate stays on the reading page')
eq(pausedTranslate.paused, true, 'paused Translate marks paused on the reading screen')

const pausedQa = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: false,
  paused: true,
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
})
eq(pausedQa.phase, 'qaWaiting', 'paused Live Q&A stays on the reading page')
eq(pausedQa.paused, true, 'paused Live Q&A marks paused on the reading screen')

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
  langPair: 'Auto → ZH',
})
eq(trOn.line, undefined, 'Translate Always On must not show the sentence')
eq(trOn.modeLabel, 'Auto → ZH', 'Translate Always On keeps the language pair')
eq(trOn.showTimer, false, 'Translate Always On is the capsule, not a clock')
eq(trOn.recDot, true, 'Translate Always On keeps the red dot')
eq(trOn.show, true, 'Translate Always On stays up')

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

const lost = buildWatchScreen({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  original: '',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
  statusUnknown: true,
})
eq(lost.phase, 'connectionLost', 'unknown capture shows Connection lost')
eq(lost.primary, 'Reconnect', 'Reconnect is the only action')
eq(lost.rec, undefined, 'Connection lost has no rec dot')

const lostOn = buildWatchAlwaysOn({
  workspaceMode: 'meeting',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  translation: '',
  answer: '',
  statusUnknown: true,
})
eq(lostOn.show, false, 'unknown capture blacks out Always On')

eq(watchAlwaysOnKeepsTree('translate', true, false, false, false), true, 'translate listening keeps the reading tree')
eq(watchAlwaysOnKeepsTree('interview', false, true, false, false), true, 'interview paused keeps the reading tree')
eq(watchAlwaysOnKeepsTree('meeting', true, false, false, false), false, 'meeting still swaps to Always On')
eq(watchAlwaysOnKeepsTree('translate', true, false, true, false), false, 'ended still swaps to Always On')
eq(watchAlwaysOnKeepsTree('translate', true, false, false, true), false, 'unknown status still swaps to Always On')
eq(watchAlwaysOnKeepsTree('translate', false, false, false, false), false, 'ready does not keep the reading tree')

const translateFailed = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  original: 'hello',
  translation: '',
  question: '',
  answer: '',
  drafting: false,
  failed: true,
})
eq(translateFailed.phase, 'translateFailed', 'empty failed translation is Retry')
eq(translateFailed.statusEn, "Couldn't translate", 'failed copy')
eq(translateFailed.primary, 'Retry', 'Retry is the only action')

const translateFailedHasText = buildWatchScreen({
  workspaceMode: 'translate',
  listenScene: 'meeting',
  listening: true,
  paused: false,
  original: 'hello',
  translation: '你好',
  question: '',
  answer: '',
  drafting: false,
  failed: true,
})
eq(translateFailedHasText.phase, 'translateResult', 'failed with translation stays a result')

const qaFailed = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  original: '',
  translation: '',
  question: 'Why?',
  answer: '',
  drafting: false,
  failed: true,
})
eq(qaFailed.phase, 'qaFailed', 'empty failed answer is Couldn\'t answer')
eq(qaFailed.statusEn, "Couldn't answer", 'qa failed copy')
eq(qaFailed.primary, 'Retry', 'Q&A failed shows Retry')

const qaFailedHasAnswer = buildWatchScreen({
  workspaceMode: 'interview',
  listenScene: 'interview',
  listening: true,
  paused: false,
  original: '',
  translation: '',
  question: 'Why?',
  answer: 'Because the launch slipped.',
  drafting: false,
  failed: true,
})
eq(qaFailedHasAnswer.phase, 'qaAnswer', 'failed but answer nonempty → normal result phase')


