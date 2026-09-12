import { mergeQaRows, QA_FAILED_TEXT } from './watchQa'
import { buildWatchFace } from './watchStatus'
import type { Turn } from './types'

// #219 follow-up: while the phone is locked the whole Live Q&A answer can be
// generated and read on the Watch. The phone's webview is suspended and the
// control socket is parked, so `turns` is missing that answer until the server's
// recovery batch arrives on reattach. The merge must add the missing turns in the
// server's order and must never re-create a turn the list already has (that would
// duplicate the answer both panes show).

// The common case: the phone asked the current question, then locked. The batch
// carries the older turns AND the now-answered current one.
const pending: Turn[] = [{ id: 'q-current', q: 'Current?', a: '' }]
const merged = mergeQaRows(pending, [
  { id: 'q-old', question: 'Old question?', answer: 'Old answer', order: 1, done: true },
  { id: 'q-locked', question: 'Asked while locked?', answer: 'Answered while locked', order: 2, done: true },
  { id: 'q-current', question: 'Current?', answer: 'the real answer', order: 3, done: true },
])
if (merged.rows !== 2) throw new Error(`expected 2 recovered turns, got ${merged.rows}`)
if (merged.turns.length !== 3) throw new Error(`expected 3 turns, got ${merged.turns.length}`)
if (merged.turns.map((t) => t.id).join(',') !== 'q-old,q-locked,q-current') {
  throw new Error(`unexpected merged order: ${merged.turns.map((t) => t.id).join(',')}`)
}
if (merged.turns[2].a !== '') {
  throw new Error('the recoverable text belongs to the server row, not to the live pending turn')
}
if (merged.order.join(',') !== 'q-old,q-locked,q-current') {
  throw new Error(`unexpected order list: ${merged.order.join(',')}`)
}

// A replayed batch is idempotent: no duplicate turn, no extra append.
const replay = mergeQaRows(merged.turns, [
  { id: 'q-old', question: 'Old question?', answer: 'Old answer', order: 1 },
  { id: 'q-locked', question: 'Asked while locked?', answer: 'Answered while locked', order: 2 },
])
if (replay.rows !== 0) throw new Error('a replayed batch adds nothing')
if (replay.turns.length !== merged.turns.length) throw new Error('a replayed batch must not duplicate turns')

// The live turn stays last, so the Watch face built from the turns is still the
// live copy — a recovered answer must not displace it.
const face = buildWatchFace({
  capture: 'listening',
  consentOpen: false,
  notesAskId: '',
  notesRaw: '',
  partial: '',
  workspaceMode: 'interview',
  translateOn: true,
  translatePairs: [],
  meetingLines: [],
  turns: merged.turns,
})
if (face.copyId !== 'q-current') throw new Error(`expected the live turn as copy id, got ${face.copyId}`)
if (face.original !== 'Current?') throw new Error(`expected the question as original, got ${face.original}`)

// A fully caught-up phone (every batch row already known) is untouched.
const caught = mergeQaRows(merged.turns, merged.turns.map((t, i) => ({ id: t.id, question: t.q, answer: t.a, order: i + 1 })))
if (caught.turns !== merged.turns) throw new Error('a batch of known turns must not rewrite the list')

// A failed turn keeps a visible failure instead of an empty card.
const failed = mergeQaRows([], [{ id: 'q-fail', question: 'Quota?', answer: '', failed: true, order: 1 }])
if (failed.turns[0].a !== QA_FAILED_TEXT) throw new Error(`failed turn must show the failure, got ${failed.turns[0].a}`)

// An unfinished turn is recovered without a done flag and stays readable.
const half = mergeQaRows([], [{ id: 'q-half', question: 'Half?', answer: 'half answer', done: false }])
if (half.turns[0].a !== 'half answer') throw new Error('a half answer is still recovered')

// With nothing pending, recovered turns append after what the phone has.
const appended = mergeQaRows([{ id: 'q1', q: 'One?', a: 'One.' }], [{ id: 'q2', question: 'Two?', answer: 'Two.' }])
if (appended.turns.map((t) => t.id).join(',') !== 'q1,q2') throw new Error('recovered turns append when nothing is pending')

console.log('watchQa tests passed')
