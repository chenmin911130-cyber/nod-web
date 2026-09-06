import type { MeetingLine } from './types'
import { applyLineTranslationRev, applyLineUpdate, staleTranslateDone } from './meetingLines'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// line_update: a continuation replaces the line's text, bumps rev, clears the
// stale translation + give-up flag, keeps ts; unknown id is ignored.
{
  const lines: MeetingLine[] = [
    { id: 'm1', ts: '0:01', text: 'So one of the significant', translation: '所以其中一个重要', rev: 0, lang: 'en' },
    { id: 'm2', ts: '0:05', text: 'Next line.', translation: '下一行', rev: 0 },
  ]
  const out = applyLineUpdate(lines, 'm1', 'So one of the significant features', 'en', 'A', 1)
  eq(out[0].text, 'So one of the significant features', 'text replaced')
  eq(out[0].rev, 1, 'rev bumped')
  eq(out[0].translation, '', 'stale translation cleared')
  eq(out[0].translateFailed, false, 'give-up flag cleared')
  eq(out[0].ts, '0:01', 'ts kept from first fragment')
  eq(out[0].speaker, 'A', 'speaker refreshed')
  eq(out[1].text, 'Next line.', 'other line untouched')
}

// Unknown id is ignored (stale event after clear / workspace switch never rebuilds).
{
  const lines: MeetingLine[] = [{ id: 'm1', ts: '0:01', text: 'x', rev: 0 }]
  eq(applyLineUpdate(lines, 'm9', 'y', undefined, undefined, 5), lines, 'unknown id is a no-op')
}

// applyLineTranslationRev writes a chunk ONLY when id + rev match the bind.
{
  const lines: MeetingLine[] = [
    { id: 'm1', ts: '0:01', text: 'So one', rev: 0 },
    { id: 'm2', ts: '0:05', text: 'Next', rev: 0 },
  ]
  const out = applyLineTranslationRev(lines, 'm1', 0, 'thing')
  eq(out[0].translation, 'thing', 'chunk lands on the matching id + rev')
  eq(out[1].translation, undefined, 'no fallback onto a different line')
}

// A chunk for a stale rev (the line was extended -> rev bumped) is dropped, so a
// translated half-sentence is not written into the extended line.
{
  const lines: MeetingLine[] = [{ id: 'm1', ts: '0:01', text: 'extended text', rev: 1, translation: '' }]
  const out = applyLineTranslationRev(lines, 'm1', 0, 'stale chunk')
  eq(out[0].translation, '', 'stale-rev chunk is dropped')
}

// staleTranslateDone: true only when the line's rev no longer matches the bind.
eq(staleTranslateDone('m1', 0, { id: 'm1', ts: '0:01', rev: 1, text: 'x' }), true, 'extended line makes a done stale')
eq(staleTranslateDone('m1', 1, { id: 'm1', ts: '0:01', rev: 1, text: 'x' }), false, 'matching rev done is live')
eq(staleTranslateDone('m1', 0, undefined), false, 'no line -> not stale')
