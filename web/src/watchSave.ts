import type { EngineMsg } from './types'
import type { SaveStatus } from './sessionSave'

/**
 * A Watch-driven session (AutoNotes) keeps History automatically on save_prompt,
 * the same way a Watch Stop does — the wrist already asked. Without AutoNotes,
 * the phone Meeting dialog asks first, so this returns false.
 */
export function watchStopShouldAutoKeepHistory(autoNotes?: boolean): boolean {
  return autoNotes === true
}

/** Watch Stop asks on the wrist. The iPhone Meeting dialog stays for phone Stop. */
export function watchStopShouldOpenPhoneSave(): boolean {
  return false
}

/** Watch Save never waits for Notes. Phone Save still can. */
export function watchSaveShouldWaitForNotes(): boolean {
  return false
}

export type WatchSaveFace = 'none' | 'saving' | 'saved' | 'failed'

/** Fields the phone must push on the Watch status chain. */
export function watchSaveStatusPayload(opts: {
  status: SaveStatus
  liveId: string | null
}): { save: WatchSaveFace; sessionId: string } {
  const save: WatchSaveFace =
    opts.status === 'saving' || opts.status === 'saved' || opts.status === 'failed'
      ? opts.status
      : 'none'
  return { save, sessionId: opts.liveId || '' }
}

/**
 * Watch only flips Saved/Couldn't save when the ack names the request id.
 * Empty ids never wildcard-match.
 */
export function watchSaveAckApplies(opts: {
  requestedId: string
  incomingSave: string
  incomingSessionId: string
}): 'ignore' | 'saved' | 'failed' {
  if (!opts.requestedId || !opts.incomingSessionId) return 'ignore'
  if (opts.requestedId !== opts.incomingSessionId) return 'ignore'
  if (opts.incomingSave === 'saved') return 'saved'
  if (opts.incomingSave === 'failed') return 'failed'
  return 'ignore'
}

/** Repeat Save on the same live session must not start a second keep. */
export function watchSaveRepeatAction(opts: {
  kept: boolean
  status: SaveStatus
}): 'echoSaved' | 'ignore' | 'start' {
  if (opts.kept || opts.status === 'saved') return 'echoSaved'
  if (opts.status === 'saving') return 'ignore'
  return 'start'
}

/** Save writes the current usage session through the server. Audio follows the phone default. */
export function watchSaveCommand(id?: string): Extract<EngineMsg, { type: 'keep_history' }> {
  if (id) return { type: 'keep_history', content: true, audio: true, id }
  return { type: 'keep_history', content: true, audio: true }
}

export function keepHistoryMessage(opts: {
  content: boolean
  audio: boolean
  id?: string
}): Extract<EngineMsg, { type: 'keep_history' }> {
  if (opts.id) return { type: 'keep_history', content: opts.content, audio: opts.audio, id: opts.id }
  return { type: 'keep_history', content: opts.content, audio: opts.audio }
}

/** Don't save deletes the current usage session on the server. */
export function watchDiscardCommand(): Extract<EngineMsg, { type: 'discard_history' }> {
  return { type: 'discard_history' }
}

/** Saved ack is a flash, then Ready. No Start on that screen. */
export function watchSavedAckMs(): number {
  return 2000
}

/** Wrist timeout while the phone JS may be parked. */
export function watchSaveTimeoutMs(): number {
  return 15_000
}
