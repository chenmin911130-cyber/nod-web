import { BACKLOG_MS, meetingLinesAfterTargetChange, nextMeetingLineToTranslate } from './meetingTranslate'
import { parseHeardLang } from './translateGate'
import type { MeetingLine } from './types'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

const base = (id: string, extra?: Partial<MeetingLine>): MeetingLine => ({
  id,
  ts: '00:00',
  text: 'some line',
  ...extra,
})

// nextMeetingLineToTranslate: a line that gave up (translateFailed) must not be
// re-enqueued — that was the resend loop on a misbehaving model.
const asked = new Set<string>(['a'])
const lines: MeetingLine[] = [
  base('c', { text: 'newest' }),
  base('b', { translation: 'done' }),
  base('a', { translateFailed: true }),
]
eq(nextMeetingLineToTranslate(lines, asked)?.id, 'c', 'newest untranslated unasked line is chosen')
eq(nextMeetingLineToTranslate(lines, new Set(['a', 'b', 'c']))?.id, undefined, 'nothing when every line is asked/done/failed')
const withFailedNewest: MeetingLine[] = [base('z', { translateFailed: true, text: 'gave up' }), base('y', { text: 'ok' })]
eq(nextMeetingLineToTranslate(withFailedNewest, new Set())?.id, 'y', 'a translateFailed line is skipped even when it is the newest')
eq(nextMeetingLineToTranslate([base('only', { translateFailed: true })], asked)?.id, undefined, 'a lone translateFailed line is not re-selected')

const now = 1_000_000
eq(
  nextMeetingLineToTranslate(
    [base('old', { text: 'old', at: now - BACKLOG_MS - 1 }), base('new', { text: 'new', at: now - 100 })],
    new Set(),
    now,
  )?.id,
  'old',
  'backlog >= BACKLOG_MS picks oldest untranslated',
)
eq(
  nextMeetingLineToTranslate(
    [base('old', { text: 'old', at: now - BACKLOG_MS + 500 }), base('new', { text: 'new', at: now - 100 })],
    new Set(),
    now,
  )?.id,
  'new',
  'no backlog picks newest untranslated',
)
eq(nextMeetingLineToTranslate([], new Set(), now)?.id, undefined, 'empty list yields nothing')

// meetingLinesAfterTargetChange: a line that gave up (translateFailed) becomes
// retryable when the translation target changes — the give-up flag resets (its
// translation stays empty); a same-target change leaves the lines untouched.
const goneUp = base('x', { translateFailed: true, translation: '' })
const goneUpAfter = meetingLinesAfterTargetChange([goneUp], 'en', 'zh')
eq(goneUpAfter[0].translateFailed, false, 'target change resets translateFailed')
eq(goneUpAfter[0].translation, '', 'translation stays empty on target-change reset')
eq(meetingLinesAfterTargetChange([goneUp], 'en', 'en')[0].translateFailed, true, 'same target leaves a give-up line alone')

// parseHeardLang: the STT tag must be trusted (this is what stamps meeting
// line.lang so passthrough can use it).
eq(parseHeardLang('en', 'Let us move to the next item'), 'en', 'an explicit en STT tag wins')
eq(parseHeardLang(undefined, '我们下周开会'), 'zh', 'no tag falls back to script for Han')
eq(parseHeardLang(undefined, 'We move on'), 'en', 'no tag falls back to Latin for English')

console.log('meetingTranslate ok')
