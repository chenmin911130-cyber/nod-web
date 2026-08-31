import { buildWatchFace } from './watchStatus'

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
if (face.original !== 'hello there') throw new Error(`expected original, got ${face.original}`)
if (face.history[0]?.text !== '你好') throw new Error('expected history text')
if (!face.listening) throw new Error('expected listening')
