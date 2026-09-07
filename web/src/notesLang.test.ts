import { bilingualDisabled, notesBilingualOn, notesLangActions, type LangDispatch } from './listen'

function eq(got: unknown, want: unknown, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// A translate_target action must not rewrite the notes language: in the
// Translate workspace, changing the target dispatches only translate_to.
eq(notesLangActions('translate', 'zh'), [{ type: 'translate_to', lang: 'zh' }], 'translate_to must not touch notesLang')

// Meeting / Lecture notes dropdown, concrete language: drives BOTH the notes
// language and the translation target (the one control semantics).
eq(
  notesLangActions('meeting', 'zh'),
  [{ type: 'notes_translate_to', lang: 'zh' }, { type: 'notes_lang', lang: 'zh' }],
  'picking Chinese notes sets notesTranslateTo, not translateTo',
)
eq(
  notesLangActions('lecture', 'zh'),
  [{ type: 'notes_translate_to', lang: 'zh' }, { type: 'notes_lang', lang: 'zh' }],
  'lecture notes selector behaves like meeting',
)
eq(
  notesLangActions('meeting', 'zh').every((a) => a.type !== 'translate_to'),
  true,
  'meeting notes must not dispatch translate_to',
)

// Meeting / Lecture notes dropdown, auto: only notes_lang — notesTranslateTo stays.
eq(notesLangActions('meeting', 'auto'), [{ type: 'notes_lang', lang: 'auto' }], 'auto notes must not move notesTranslateTo')
eq(notesLangActions('interview', 'auto'), [{ type: 'notes_lang', lang: 'auto' }], 'interview auto notes keeps notesTranslateTo')

// Translate workspace: no notes_lang dispatch, so the notes language is never
// rewritten by a target swap.
const swapActions = notesLangActions('translate', 'en')
eq(
  swapActions.every((a) => a.type !== 'notes_lang'),
  true,
  'Translate target swap must not dispatch notes_lang',
)

// Notes Auto follows speech: bilingual is disabled even when notesTranslateTo exists.
eq(bilingualDisabled('auto', false, 'en'), true, 'auto notes disables Bilingual')
eq(bilingualDisabled('auto', true, 'en'), true, 'auto notes disables Bilingual even if the toggle was on')
eq(bilingualDisabled('zh', false, 'en'), false, 'concrete notes language never disables Bilingual')
eq(bilingualDisabled('auto', false, undefined), true, 'no target at all disables Bilingual')
eq(notesBilingualOn('auto', true), false, 'Auto notes does not run bilingual captions')
eq(notesBilingualOn('en', true), true, 'concrete notes language can run bilingual captions')

// Type sanity: the dispatch union shape is stable.
const _d: LangDispatch[] = notesLangActions('meeting', 'zh')
void _d
