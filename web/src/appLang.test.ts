import { applyNotesTranslateTo } from './meetingTranslate'
import type { MeetingLine } from './types'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

const failed: MeetingLine = { id: 'x', ts: '00:00', text: 'line', translateFailed: true, translation: '' }

const reset = applyNotesTranslateTo([failed], 'en', 'ja', false)
eq(reset[0].translateFailed, false, 'notes_translate_to resets translateFailed while listening')
eq(reset[0].translation, '', 'translation stays empty after a notes target change')

const ended = applyNotesTranslateTo([failed], 'en', 'ja', true)
eq(ended[0].translateFailed, true, 'notes_translate_to after End leaves existing lines alone')
eq(ended, [failed], 'ended meeting reuses the same line objects')

const same = applyNotesTranslateTo([failed], 'ja', 'ja', false)
eq(same[0].translateFailed, true, 'same notes target leaves a give-up line alone')

console.log('appLang ok')
