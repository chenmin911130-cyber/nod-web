import { LISTEN_SCENES, nodTag, notesBodyText, notesPrompt, outLangRule, sceneLabel } from './listen'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// A: Summary gets its own language channel.
eq(nodTag('SUMMARY', 'zh', false), '[NOD_SUMMARY:zh]', 'summary tag')
eq(nodTag('SUMMARY', 'auto', true), '[NOD_SUMMARY:auto:bi]', 'summary tag bilingual')
eq(nodTag('NOTES', 'zh', false, 'meeting'), '[NOD_NOTES:meeting:zh]', 'notes tag keeps scene')
if (!outLangRule('zh', 'summary').includes('Chinese only')) throw new Error('summary fixed lang')
if (!outLangRule('auto', 'summary').includes('majority language')) throw new Error('summary auto follows transcript')

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
