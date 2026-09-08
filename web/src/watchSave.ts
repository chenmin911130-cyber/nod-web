import type { EngineMsg } from './types'

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

/** Save writes the current usage session through the server. Audio follows the phone default. */
export function watchSaveCommand(): Extract<EngineMsg, { type: 'keep_history' }> {
  return { type: 'keep_history', content: true, audio: true }
}

/** Don't save deletes the current usage session on the server. */
export function watchDiscardCommand(): Extract<EngineMsg, { type: 'discard_history' }> {
  return { type: 'discard_history' }
}

/** Saved ack is a flash, then Ready. No Start on that screen. */
export function watchSavedAckMs(): number {
  return 2000
}
