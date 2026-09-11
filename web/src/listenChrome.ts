/** Phone Listen chrome for #190. Capture/session only — not engine/Ask busy. */

export type ListenWorkspace = 'meeting' | 'translate' | 'interview'
export type ListenAskPlacement = 'field' | 'bar' | 'fab' | 'dock' | 'hidden'
export type EndedSheetDock = 'default' | 'expanded'

export function showListenNew(input: {
  phone: boolean
  workspace: ListenWorkspace
  listening: boolean
  paused: boolean
}): boolean {
  if (!input.phone) return false
  if (input.workspace !== 'meeting') return false
  if (input.listening || input.paused) return false
  return true
}

export function hideListenStatusRow(input: {
  variant: 'listen' | 'translate' | 'interview'
  chrome: 'recording' | 'paused' | 'ended' | 'ready'
}): boolean {
  return input.variant === 'listen' && (input.chrome === 'recording' || input.chrome === 'paused' || input.chrome === 'ended')
}

export function listenAskPlacement(input: {
  phone: boolean
  qa: boolean
  ready: boolean
  listening: boolean
  paused: boolean
  ended: boolean
  hasContent: boolean
}): ListenAskPlacement {
  if (input.qa || !input.phone) return 'field'
  if (input.ready) return 'hidden'
  if (input.listening || input.paused) return 'bar'
  if (input.ended && input.hasContent) return 'fab'
  return 'dock'
}

export function endedSheetAvailable(input: {
  phone: boolean
  qa: boolean
  listening: boolean
  paused: boolean
  ended: boolean
  hasContent: boolean
}): boolean {
  return input.phone && !input.qa && !input.listening && !input.paused && input.ended && input.hasContent
}

export function emptyEndShowsReady(input: { ended: boolean; hasContent: boolean }): boolean {
  return input.ended && !input.hasContent
}

/** History restore with content must still show Ask/content even when ended is false. */
export function historyRestoreHidesAsk(input: { ended: boolean; hasContent: boolean }): boolean {
  return !input.hasContent
}

export function endedSheetGesture(target: 'handle' | 'tabs' | 'body'): 'resize' | 'scroll' {
  return target === 'body' ? 'scroll' : 'resize'
}

export function composeSessionKey(workspace: string, composeSessionId: number): string {
  return `${workspace}:${composeSessionId}`
}

export function nextComposeSessionId(
  action: 'listen_new' | 'clear' | 'restore' | 'meeting_resume' | 'meeting_clock' | 'continue',
  prev: number,
): number {
  if (action === 'listen_new' || action === 'clear' || action === 'restore') return prev + 1
  return prev
}

/**
 * Vertical travel (px) below which a pointer gesture on the ended sheet counts
 * as a tap, not a drag. `endedDockFromPointer` and the resize handlers share
 * this so a gesture can never sit in a gap between "tap" and "drag".
 */
export const ENDED_TAP_SLOP = 10

export function endedDockFromPointer(input: {
  startY: number
  endY: number
  moved: boolean
  tapSlop?: number
}): 'toggle' | EndedSheetDock {
  const slop = input.tapSlop ?? ENDED_TAP_SLOP
  const dy = input.startY - input.endY
  if (!input.moved && Math.abs(dy) <= slop) return 'toggle'
  return dy > 0 ? 'expanded' : 'default'
}

export function nextComposeDraft(prevKey: string, nextKey: string, draft: string): string {
  return prevKey && prevKey === nextKey ? draft : ''
}

export function nextComposeFiles<T>(prevKey: string, nextKey: string, files: T[]): T[] {
  return prevKey && prevKey === nextKey ? files : []
}

/** Opening Ask is UI-only. Capture stays on the existing pause/end handlers. */
export function askToggleAffectsCapture(_open: boolean): false {
  return false
}

/**
 * nod-mic / Watch / browser capture expose no input amplitude today.
 * Static low bars are the honest meter — do not fake a looping waveform.
 */
export const STATIC_VOLUME_SHAPE = [0.28, 0.48, 0.72, 0.95, 0.62, 0.38, 0.52, 0.3] as const

export function volumeBarHeights(level: number | null): number[] {
  if (level == null || !Number.isFinite(level)) {
    return STATIC_VOLUME_SHAPE.map((h) => Math.max(0.16, h * 0.34))
  }
  const amp = Math.max(0, Math.min(1, level))
  return STATIC_VOLUME_SHAPE.map((h) => 0.16 + h * amp)
}
