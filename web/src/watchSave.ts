import type { EngineMsg } from './types'
import type { SaveStatus } from './sessionSave'

/**
 * Watch Stop no longer auto-keeps History. Meeting / Lecture Save is an
 * explicit Save tap (wrist or phone). The `autoNotes` argument is kept so
 * callers do not have to change, but it is ignored.
 */
export function watchStopShouldAutoKeepHistory(_autoNotes?: boolean): boolean {
  return false
}

/** Watch Stop asks on the wrist. The iPhone Meeting dialog stays for phone Stop. */
export function watchStopShouldOpenPhoneSave(): boolean {
  return false
}

/** Save writes the current usage session through the server. Audio follows the phone default. */
export function watchSaveCommand(): Extract<EngineMsg, { type: 'keep_history' }> {
  return { type: 'keep_history', content: true, audio: true }
}

/** Don't save deletes the current usage session on the server. */
export function watchDiscardCommand(): Extract<EngineMsg, { type: 'discard_history' }> {
  return { type: 'discard_history' }
}

/** Phone saveBook.status on the Watch payload. undecided is none. */
export function watchSaveWireStatus(status: SaveStatus): 'none' | 'saving' | 'saved' | 'failed' {
  return status === 'undecided' ? 'none' : status
}

/**
 * Watch Saved is only the keep ack for the session this wrist asked to save.
 * A leftover history_kept from restore must not flip the face.
 */
export function watchSaveView(input: {
  save: string
  sessionId: string
  requestedId: string
  waitedMs: number
}): 'idle' | 'saving' | 'saved' | 'failed' {
  const matched = input.save === 'saved' && idsMatch(input.sessionId, input.requestedId)
  if (matched) return 'saved'
  if (input.save === 'failed') return 'failed'
  if (input.waitedMs >= 15_000 && input.save !== 'saved') return 'failed'
  if (input.save === 'saving') return 'saving'
  return 'idle'
}

function idsMatch(sessionId: string, requestedId: string): boolean {
  if (requestedId) return sessionId === requestedId
  return sessionId.length > 0
}
