import type { Turn } from './types'

/**
 * A `done` event only affects the interview UI when it belongs to a turn that
 * still exists (or carries no id — the quota / empty-question path, issued by
 * older servers before the queue rework). A stale `done` whose id is gone must
 * NOT clear busy or rewind status, else it finishes the wrong answer (#5),
 * e.g. after a cancel + immediate new ask where the old question's `done`
 * arrives after the new turn replaced it.
 */
export function doneAffectsInterview(turns: Turn[], evId: string): boolean {
  if (!evId) return true
  return turns.some((t) => t.id === evId)
}

/** Mark a turn failed without writing error copy into `a`. Empty id uses the first unanswered unfailed turn. */
export function markTurnFailed(turns: Turn[], id?: string): Turn[] {
  const i = id
    ? turns.findIndex((t) => t.id === id)
    : turns.findIndex((t) => !t.a && !t.failed)
  if (i < 0) return turns
  if (turns[i].a) return turns
  if (turns[i].failed) return turns
  const next = turns.slice()
  next[i] = { ...next[i], a: '', failed: true }
  return next
}

/** Re-ask a failed turn in place. Ignores if a pending ask is already in flight. */
export function retryTurn(turns: Turn[], id: string): Turn[] {
  if (turns.some((t) => t.id === '__pending_ask__')) return turns
  const i = turns.findIndex((t) => t.id === id)
  if (i < 0) return turns
  const next = turns.slice()
  next[i] = { ...next[i], id: '__pending_ask__', a: '', failed: false }
  return next
}
