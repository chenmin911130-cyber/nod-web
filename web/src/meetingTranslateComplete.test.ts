import { nextMeetingLineToTranslate } from './meetingTranslate'
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

const now = 1_000_000

// 1. half_line_not_picked
eq(
  nextMeetingLineToTranslate(
    [base('a', { text: 'We went to the', updatedAt: now - 500 })],
    new Set(),
    now,
  )?.id,
  undefined,
  'half_line_not_picked',
)

// 2. sentence_end_picked
eq(
  nextMeetingLineToTranslate([base('a', { text: 'We went to the store.' })], new Set(), now)?.id,
  'a',
  'sentence_end_picked period',
)
eq(
  nextMeetingLineToTranslate([base('b', { text: 'He said "yes."' })], new Set(), now)?.id,
  'b',
  'sentence_end_picked quote',
)
eq(
  nextMeetingLineToTranslate([base('c', { text: '我们去了商店。' })], new Set(), now)?.id,
  'c',
  'sentence_end_picked zh',
)
eq(
  nextMeetingLineToTranslate([base('d', { text: 'He said “yes.”', updatedAt: now - 100 })], new Set(), now)?.id,
  'd',
  'sentence_end_picked curly en',
)
eq(
  nextMeetingLineToTranslate([base('e', { text: '他说：“好。”', updatedAt: now - 100 })], new Set(), now)?.id,
  'e',
  'sentence_end_picked curly zh',
)

// 3. older_line_picked_when_newer_exists
eq(
  nextMeetingLineToTranslate(
    [
      base('first', { text: 'We went to the', updatedAt: now - 500 }),
      base('second', { text: 'then we left', updatedAt: now - 100 }),
    ],
    new Set(),
    now,
  )?.id,
  'first',
  'older_line_picked_when_newer_exists',
)

// 4. quiet_fallback
eq(
  nextMeetingLineToTranslate(
    [base('a', { text: 'We went to the', updatedAt: now - 2600 })],
    new Set(),
    now,
  )?.id,
  'a',
  'quiet_fallback',
)

// 6. asked_failed_translated_still_skipped
eq(
  nextMeetingLineToTranslate([base('a', { text: 'Done.', translation: 'x' })], new Set(), now)?.id,
  undefined,
  'asked_failed_translated_still_skipped translated',
)
eq(
  nextMeetingLineToTranslate([base('a', { text: 'Done.', translateFailed: true })], new Set(), now)?.id,
  undefined,
  'asked_failed_translated_still_skipped failed',
)
eq(
  nextMeetingLineToTranslate([base('a', { text: 'Done.' })], new Set(['a']), now)?.id,
  undefined,
  'asked_failed_translated_still_skipped asked',
)

// 7. backlog_fifo_respects_completeness
eq(
  nextMeetingLineToTranslate(
    [base('only', { text: 'We went to the', at: now - 10_000, updatedAt: now - 500 })],
    new Set(),
    now,
  )?.id,
  undefined,
  'backlog_fifo_respects_completeness',
)

// boundary: empty text not a candidate
eq(
  nextMeetingLineToTranslate([base('a', { text: '   ' })], new Set(), now)?.id,
  undefined,
  'empty text not candidate',
)

const { COMPLETE_QUIET_MS, meetingLineComplete, nextMeetingTranslateWakeMs } = await import('./meetingTranslate')

// 5. wake_ms
eq(
  nextMeetingTranslateWakeMs(
    [base('a', { text: 'We went to the', updatedAt: now - 1000 })],
    new Set(),
    now,
  ),
  COMPLETE_QUIET_MS - 1000,
  'wake_ms incomplete last line',
)
eq(
  nextMeetingTranslateWakeMs(
    [base('a', { text: 'We went to the store.' })],
    new Set(),
    now,
  ),
  null,
  'wake_ms null when ready line exists',
)
eq(nextMeetingTranslateWakeMs([], new Set(), now), null, 'wake_ms null when no candidates')

// boundary: updatedAt missing falls back to at; both missing → quiet satisfied (0)
eq(meetingLineComplete(base('a', { text: 'no punct' }), [base('a', { text: 'no punct' })], now), true, 'both ts missing → quiet at 0')

console.log('meetingTranslateComplete ok')
