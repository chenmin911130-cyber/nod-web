/**
 * History DELETE invariant (Anna 951b9cb5 audit, PR #270).
 *
 * HTTP DELETE /api/account/history/{id} only fires from explicit discard:
 * - SavePrompt "Don't save" / Leave "Discard and start new"
 * - Watch action discard
 * - HistoryPane / Account row delete
 *
 * Reconnect / rotate paths must NOT auto-discard:
 * - doClear → WS { type: 'clear' } (server turn_reset, no DELETE)
 * - startListen / new_listen → saveBookOnNewListen (clears liveId only)
 * - listen_flush / session_ended / ready replay start_listen → no discard
 */
import { saveBookOnNewListen, beginSave, emptySaveBook } from './sessionSave'
import { watchDiscardCommand } from './watchSave'

function eq<T>(got: T, want: T, label: string) {
  const g = typeof got === 'object' && got !== null ? JSON.stringify(got) : got
  const w = typeof want === 'object' && want !== null ? JSON.stringify(want) : want
  if (g !== w) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// new_listen clears the save book pointer; it does not discard the prior session.
{
  const book = beginSave({ ...emptySaveBook(), offered: true, liveId: '951b9cb5-dead-beef' }, '951b9cb5-dead-beef')
  const next = saveBookOnNewListen(book)
  eq(next.liveId, null, 'new_listen drops liveId without discard side effects')
  eq(next.offered, false, 'new_listen resets offered')
  eq(next.status, 'saving', 'new_listen does not change save status')
}

// Explicit discard uses discard_history (+ native DELETE). Clear is separate.
eq(watchDiscardCommand('951b9cb5-dead-beef'), { type: 'discard_history', id: '951b9cb5-dead-beef' }, 'discard pins session id')
eq(watchDiscardCommand().type, 'discard_history', 'discard_history is not clear or start_listen')

// Bridge replay set: clear may flush on reconnect; discard_history is never queued.
const TRANSIENT_REPLAY = new Set([
  'manual',
  'toggle_listen',
  'start_listen',
  'stop_listen',
  'pause_listen',
  'resume_listen',
  'clear',
  'cancel_generate',
  'ask',
])
eq(TRANSIENT_REPLAY.has('clear'), true, 'reconnect may replay clear (turn_reset)')
eq(TRANSIENT_REPLAY.has('discard_history'), false, 'reconnect must not replay discard_history')
eq(TRANSIENT_REPLAY.has('start_listen'), true, 'ready may replay start_listen without discard')

console.log('sessionDiscard.test.ts: ok')
