import type { SaveBook } from './sessionSave'

/** After a Record session stops, wait until capture is off and the engine is idle. */
export function shouldGenerateAutoReport(input: {
  flagged: boolean
  heardListen: boolean
  capture: string
  engine: string
  workspaceMode: string
  busy: boolean
  lineCount: number
}): 'wait' | 'skip' | 'generate' {
  if (!input.flagged) return 'skip'
  if (input.capture !== 'off' || input.engine !== 'idle') return 'wait'
  if (!input.heardListen) return 'wait'
  if (input.workspaceMode === 'translate') return 'skip'
  if (input.busy) return 'wait'
  if (input.lineCount === 0) return 'skip'
  return 'generate'
}

/** Wait for Notes only when this Save is about to leave the session.
 * Watch Save and a stay-put phone Save keep immediately; late Notes still
 * land on the same usage_session_id. */
export function keepShouldWaitForNotes(input: {
  notesAskId: string
  pendingAfterSave: SaveBook['pendingAfterSave'] | null
  fromWatch: boolean
}): boolean {
  return Boolean(input.notesAskId) && !input.fromWatch && input.pendingAfterSave != null && input.pendingAfterSave !== 'none'
}

/** When a Meeting is stopped with the mic NOT live (capture='paused'), the
 * server listener is still attached and must be released — otherwise capture
 * stays 'paused' and shouldGenerateAutoReport returns 'wait' forever, so Notes
 * never auto-generate. When capture is already 'off' there is nothing to
 * release. ('listening'/'recording' are handled by the primary-stop path.) */
export function stopShouldReleaseListener(capture: string): boolean {
  return capture === 'paused'
}
