import type { Turn } from './types'

/** The floor text a failed Live Q&A turn shows (same words the live path writes). */
export const QA_FAILED_TEXT = 'Generation stopped. Please try again.'

/**
 * Merge the server's Live Q&A recovery batch into the turn list.
 *
 * The phone's webview is suspended while it is locked, so a whole answer can be
 * generated and read on the Watch before the phone ever sees it. Unlike the
 * Translate copy, a Q&A turn is NOT a pair the phone can rebuild from a copy row:
 * it lives in `turns`, so an untouched pane would show nothing next to a Watch
 * that already has the answer.
 *
 * A turn the phone already owns wins — the live path and its Retry decide that
 * row's text, and re-creating it would duplicate the answer. Recovered turns are
 * inserted BEFORE the pending turn (the one still waiting for an answer), so the
 * newest turn stays last: `buildWatchFace` shows the last turn, and a recovered
 * answer must never displace the live one the Watch is streaming.
 *
 * `order` is the turn order after the merge, so the caller can persist the
 * conversation's order for later batches.
 */
export function mergeQaRows(
  turns: Turn[],
  rows: Array<{ id?: string; question?: string; answer?: string; failed?: boolean; done?: boolean; order?: number }>,
): { turns: Turn[]; order: string[]; rows: number } {
  const known = new Set(turns.map((turn) => turn.id))
  const recovered: Turn[] = []
  for (const row of rows) {
    const id = String(row.id || '')
    if (!id || known.has(id)) continue
    known.add(id)
    const answer = String(row.answer || '')
    recovered.push({
      id,
      q: String(row.question || ''),
      a: answer || (row.failed ? QA_FAILED_TEXT : ''),
    })
  }
  if (!recovered.length) return { turns, order: turns.map((turn) => turn.id), rows: 0 }
  const pending = turns.findIndex((turn) => !turn.a.trim())
  const at = pending < 0 ? turns.length : pending
  const next = [...turns.slice(0, at), ...recovered, ...turns.slice(at)]
  return { turns: next, order: next.map((turn) => turn.id), rows: recovered.length }
}
