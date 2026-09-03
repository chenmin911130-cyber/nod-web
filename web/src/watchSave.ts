import type { EngineMsg } from './types'

/** Watch Stop asks on the wrist. Do not silently keep History. */
export function watchStopShouldAutoKeepHistory(): boolean {
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

/** Saved ack is a flash, then Ready. No Start on that screen. */
export function watchSavedAckMs(): number {
  return 2000
}
