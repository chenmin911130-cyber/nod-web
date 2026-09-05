import { doneAffectsInterview } from './interviewDone'
import type { Turn } from './types'

const turns: Turn[] = [{ id: 'q1', q: 'What is a mutex?', a: '' }]

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(doneAffectsInterview(turns, 'q99'), false, 'stale done (id not in turns) must not affect the interview')
eq(doneAffectsInterview(turns, 'q1'), true, 'a done that owns a live turn still affects the interview')
eq(doneAffectsInterview(turns, ''), true, 'empty-id done (quota / empty question) still affects the interview')
eq(doneAffectsInterview([], 'q1'), false, 'a done with no matching turn in an empty list is stale')
eq(doneAffectsInterview([], ''), true, 'an empty-id done on an empty list is still the quota path')
