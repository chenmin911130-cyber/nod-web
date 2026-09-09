import type { EngineMsg } from './types'
import type { SaveStatus } from './sessionSave'
import { keepShouldWaitForNotes } from './recordReport'

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

/** Phone Save still waits on in-flight Notes. Watch Save does not. */
export function watchKeepNotesWait(fromWatch: boolean, notesAskId: string): boolean {
  return fromWatch ? watchSaveShouldWaitForNotes() : keepShouldWaitForNotes(notesAskId)
}

export type PendingKeep = { content: boolean; audio: boolean; waitNotes: boolean }

/** After liveId binds, send keep_history or park for Notes. Watch pending has waitNotes=false. */
export function flushPendingKeepMessage(opts: {
  pending: PendingKeep | null
  liveId: string | null
  status: SaveStatus
  notesAskId: string
}): { send: Extract<EngineMsg, { type: 'keep_history' }> | null; parkNotes: boolean } {
  if (!opts.pending || !opts.liveId || opts.status !== 'saving') {
    return { send: null, parkNotes: false }
  }
  if (opts.pending.waitNotes && keepShouldWaitForNotes(opts.notesAskId)) {
    return { send: null, parkNotes: true }
  }
  return {
    send: keepHistoryMessage({
      content: opts.pending.content,
      audio: opts.pending.audio,
      id: opts.liveId,
    }),
    parkNotes: false,
  }
}

/** First Save pins phoneSessionId. Retry keeps that pin even if the phone moved on. */
export function watchSavePinnedId(opts: { pinnedId: string; phoneSessionId: string }): string {
  return opts.pinnedId || opts.phoneSessionId
}

/** WatchConnectivity Save body. Missing id must not go on the wire. */
export function watchSaveWireMessage(sessionId: string): { action: 'save'; sessionId: string } | null {
  if (!sessionId) return null
  return { action: 'save', sessionId }
}

/**
 * Saving with no pin yet: latch the incoming id and send Save. Already pinned
 * ids stay put. This is not an ack — Saved still needs history_kept.
 */
export function watchSavePinIncoming(opts: {
  saving: boolean
  pinnedId: string
  incomingSessionId: string
}): { pinnedId: string; send: boolean } {
  if (!opts.saving || opts.pinnedId || !opts.incomingSessionId) {
    return { pinnedId: opts.pinnedId, send: false }
  }
  return { pinnedId: opts.incomingSessionId, send: true }
}

/**
 * Phone keep target. Empty Watch id never falls back to the current session.
 * A delayed Save after the phone switched still keeps the original id.
 */
export function watchSaveKeepTarget(opts: {
  requestedId: string
  liveId: string | null
}): { keepId: string | null; adopt: boolean } {
  if (!opts.requestedId) return { keepId: null, adopt: false }
  if (!opts.liveId || opts.liveId === opts.requestedId) {
    return { keepId: opts.requestedId, adopt: true }
  }
  return { keepId: opts.requestedId, adopt: false }
}

/**
 * Watch apply must run this even when the payload is a WatchBridge `ok` reply.
 * Empty / unpinned ids never wildcard-match a late sessionId into Saved.
 */
export function watchApplySavePayload(opts: {
  saving: boolean
  requestId: string
  payload: { ok?: unknown; save?: string; sessionId?: string }
}): { requestId: string; ack: 'ignore' | 'saved' | 'failed' } {
  const incomingSessionId = opts.payload.sessionId || ''
  return {
    requestId: opts.requestId,
    ack: watchSaveAckApplies({
      requestedId: opts.requestId,
      incomingSave: opts.payload.save || '',
      incomingSessionId,
    }),
  }
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
