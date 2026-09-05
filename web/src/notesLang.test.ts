import { bilingualDisabled, notesLangActions, type LangDispatch } from './listen'

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
  [{ type: 'translate_to', lang: 'zh' }, { type: 'notes_lang', lang: 'zh' }],
  'picking Chinese notes sets translateTo to Chinese too',
)
eq(
  notesLangActions('lecture', 'zh'),
  [{ type: 'translate_to', lang: 'zh' }, { type: 'notes_lang', lang: 'zh' }],
  'lecture notes selector behaves like meeting',
)

// Meeting / Lecture notes dropdown, auto: only notes_lang — translateTo stays.
eq(notesLangActions('meeting', 'auto'), [{ type: 'notes_lang', lang: 'auto' }], 'auto notes must not move translateTo')
eq(notesLangActions('interview', 'auto'), [{ type: 'notes_lang', lang: 'auto' }], 'interview auto notes keeps translateTo')

// Translate workspace: no notes_lang dispatch, so the notes language is never
// rewritten by a target swap.
const swapActions = notesLangActions('translate', 'en')
eq(
  swapActions.every((a) => a.type !== 'notes_lang'),
  true,
  'Translate target swap must not dispatch notes_lang',
)

// bilingualDisabled: auto notes + a concrete translateTo stays enabled (the
// bilingual target comes from translateTo, not the notes language).
eq(bilingualDisabled('auto', false, 'en'), false, 'auto notes + concrete translateTo keeps Bilingual enabled')
eq(bilingualDisabled('auto', true, 'en'), false, 'bilingual already on + auto notes stays enabled')
eq(bilingualDisabled('zh', false, 'en'), false, 'concrete notes language never disables Bilingual')
eq(bilingualDisabled('auto', false, undefined), true, 'no target at all disables Bilingual')

// Type sanity: the dispatch union shape is stable.
const _d: LangDispatch[] = notesLangActions('meeting', 'zh')
void _d
