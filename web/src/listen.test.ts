import { LISTEN_SCENES, notesBodyText, notesPrompt, sceneLabel } from './listen'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(sceneLabel('interview'), 'Live Q&A')
eq(LISTEN_SCENES.find((s) => s.id === 'interview')?.label, 'Live Q&A')
eq(sceneLabel('meeting'), 'Meeting')
eq(sceneLabel('lecture'), 'Lecture')

const zhNotes = notesPrompt(
  'meeting',
  [{ id: '1', ts: '0:01', text: 'We ship Friday.', translation: '我们周五发。' }],
  'zh',
  true,
)
if (zhNotes.includes('BILINGUAL')) throw new Error('Summary must not ask for bilingual captions')
if (!zhNotes.includes('Chinese only')) throw new Error('Summary must follow the notes language')
if (zhNotes.includes(':bi]')) throw new Error('NOTES tag stays single-language')

eq(notesBodyText('We ship Friday.\n>> 我们周五发。'), '我们周五发。', 'old bilingual notes keep the notes-language line')
eq(notesBodyText('我们周五发。'), '我们周五发。', 'single-language notes stay as written')
