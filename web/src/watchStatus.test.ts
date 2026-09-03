import { buildWatchFace, watchPreviousCaption } from './watchStatus'

const face = buildWatchFace({
  run: 'listen',
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
  run: 'listen',
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
  run: 'listen',
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
  run: 'listen',
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
  run: 'listen',
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
  run: 'listen',
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
  run: 'listen',
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
  run: 'listen',
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
