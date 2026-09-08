import { doneAffectsInterview, markTurnFailed, retryTurn } from './interviewDone'
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

const base: Turn[] = [
  { id: 'q1', q: 'Why Friday?', a: 'Ship Monday.' },
  { id: 'q2', q: 'Who owns it?', a: '' },
]
eq(
  markTurnFailed(base, 'q2'),
  [
    { id: 'q1', q: 'Why Friday?', a: 'Ship Monday.' },
    { id: 'q2', q: 'Who owns it?', a: '', failed: true },
  ],
  'markTurnFailed by id keeps a empty',
)
eq(
  markTurnFailed(base),
  [
    { id: 'q1', q: 'Why Friday?', a: 'Ship Monday.' },
    { id: 'q2', q: 'Who owns it?', a: '', failed: true },
  ],
  'markTurnFailed without id takes the first unanswered unfailed turn',
)
const already = markTurnFailed(base, 'q2')
eq(markTurnFailed(already), already, 'markTurnFailed without id does not overwrite an already-failed turn')
eq(markTurnFailed(already, 'q2'), already, 'markTurnFailed by id does not rewrite an already-failed empty answer')

eq(
  retryTurn(already, 'q2'),
  [
    { id: 'q1', q: 'Why Friday?', a: 'Ship Monday.' },
    { id: '__pending_ask__', q: 'Who owns it?', a: '', failed: false },
  ],
  'retryTurn reuses the row as pending',
)
eq(
  retryTurn([{ id: '__pending_ask__', q: 'In flight', a: '' }, ...already], 'q2'),
  [{ id: '__pending_ask__', q: 'In flight', a: '' }, ...already],
  'retryTurn is a no-op while another ask is pending',
)
