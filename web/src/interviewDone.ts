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
