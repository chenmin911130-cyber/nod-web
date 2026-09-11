/** Phone Listen/Translate chrome (#190, #193). Capture/session only — not engine/Ask busy. */

export type ListenWorkspace = 'meeting' | 'translate' | 'interview'
export type ListenAskPlacement = 'field' | 'bar' | 'fab' | 'dock' | 'hidden'
export type EndedSheetDock = 'default' | 'expanded'
export type BottomBarMode = 'ready' | 'recording' | 'paused' | 'ended'

/**
 * #193 item 1: the top New is for a finished session that actually holds
 * content. Ready (fresh or empty End) never shows it, capture states never
 * show it, and a History restore that is not `ended` does not add it either.
 */
export function showListenNew(input: {
  phone: boolean
  workspace: ListenWorkspace
  listening: boolean
  paused: boolean
  ended: boolean
  hasContent: boolean
}): boolean {
  if (!input.phone) return false
  if (input.workspace !== 'meeting') return false
  if (input.listening || input.paused) return false
  return input.ended && input.hasContent
}

/**
 * #193 item 8: Translate has no Save concept, so its More sheet must not offer
 * a Save row at all (disabling it would still advertise a Save entry).
 */
export function variantHasSave(input: { variant: 'listen' | 'translate' | 'interview' }): boolean {
  return input.variant !== 'translate'
}

/**
 * The ended sheet and the top New must agree on what "has content" means, or
 * the New button can appear without a sheet (or the other way round).
 */
export function endedHasContent(input: {
  lines: number
  partial: boolean
  catchNotes: number
  notesRaw: string
}): boolean {
  return input.lines > 0 || input.partial || input.catchNotes > 0 || Boolean(input.notesRaw.trim())
}

/**
 * Which bottom-bar shape the phone chrome shows. Reuses the same capture/ended
 * truth as `listenControlMode`, so the bar and the (hidden) top row can never
 * disagree: an empty End stays Ready.
 */
export function bottomBarMode(input: {
  listening: boolean
  paused: boolean
  ended: boolean
  hasContent: boolean
}): BottomBarMode {
  if (input.ended && input.hasContent) return 'ended'
  if (input.paused) return 'paused'
  if (input.listening) return 'recording'
  return 'ready'
}

/**
 * #193 items 4/5: Listen and Translate both draw their controls in the bottom
 * bar, so the older top status row would be a duplicate. Live Q&A keeps its
 * own chrome.
 */
export function hideTopStatusRow(input: { variant: 'listen' | 'translate' | 'interview' }): boolean {
  return input.variant !== 'interview'
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
 * #193 item 3: pointer travel that turns a press on the Ask bubble into a
 * drag. Below it the press is a tap, so opening/closing the input and the
 * keyboard stays reliable even while the bubble is draggable.
 */
export const ASK_DRAG_SLOP = 6

export function askDragMoved(input: { dx: number; dy: number; slop?: number }): boolean {
  const slop = input.slop ?? ASK_DRAG_SLOP
  return Math.abs(input.dx) > slop || Math.abs(input.dy) > slop
}

/** Keep the draggable bubble inside the visible region of the current layout. */
export function askBubbleBounds(input: {
  viewportW: number
  viewportH: number
  size: number
  gutter: number
  topInset: number
  bottomInset: number
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const minX = input.gutter
  const minY = input.topInset + input.gutter
  const maxX = Math.max(minX, input.viewportW - input.size - input.gutter)
  const maxY = Math.max(minY, input.viewportH - input.bottomInset - input.size - input.gutter)
  return { minX, minY, maxX, maxY }
}

export function clampAskBubble(input: {
  x: number
  y: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
  return { x: clamp(input.x, input.minX, input.maxX), y: clamp(input.y, input.minY, input.maxY) }
}

/**
 * #193 item 5: Translate's capture clock. It is driven by capture only — an
 * engine that is generating/transcribing is not a pause — it freezes on pause,
 * continues on resume, and a capture that starts after `off` is a new session.
 */
export type CaptureClock = { accumMs: number; startedAt: number | null; paused: boolean }

export const IDLE_CAPTURE_CLOCK: CaptureClock = { accumMs: 0, startedAt: null, paused: false }

export function advanceCaptureClock(
  clock: CaptureClock,
  input: { capture: string; now: number },
): CaptureClock {
  const capturing = input.capture === 'listening' || input.capture === 'recording'
  if (capturing) {
    if (clock.startedAt != null) return clock
    // Resume continues the session; a start that follows `off` is a new one.
    if (clock.paused) return { accumMs: clock.accumMs, startedAt: input.now, paused: false }
    return { accumMs: 0, startedAt: input.now, paused: false }
  }
  if (input.capture === 'paused') {
    if (clock.startedAt == null) return clock.paused ? clock : { ...clock, paused: true }
    return { accumMs: clock.accumMs + Math.max(0, input.now - clock.startedAt), startedAt: null, paused: true }
  }
  // off (or a foreign capture): bank the last segment, keep the total so the
  // ended state can show the real length. The next start resets it.
  if (clock.startedAt == null) return clock.paused ? { ...clock, paused: false } : clock
  return { accumMs: clock.accumMs + Math.max(0, input.now - clock.startedAt), startedAt: null, paused: false }
}

/**
 * The clock is only allowed to see capture while its own workspace is the one
 * on screen, so switching Meeting <-> Translate never shows the other
 * workspace's session length.
 */
export function clockCapture(workspace: string, clockWorkspace: string, capture: string): string {
  return workspace === clockWorkspace ? capture : 'off'
}

export function captureClockMs(clock: CaptureClock, now: number): number {
  if (clock.startedAt == null) return Math.max(0, clock.accumMs)
  return Math.max(0, clock.accumMs + (now - clock.startedAt))
}

/**
 * nod-mic / Watch / browser capture expose no input amplitude today.
 * Static low bars are the honest meter — do not fake a looping waveform.
 */
export const STATIC_VOLUME_SHAPE = [0.28, 0.48, 0.72, 0.95, 0.62, 0.38, 0.52, 0.3] as const

/** #193 item 6: the meter is the "dynamic" object of this round — ~20% larger. */
export const METER_BAR_PX = 22

export function volumeBarHeights(level: number | null): number[] {
  if (level == null || !Number.isFinite(level)) {
    return STATIC_VOLUME_SHAPE.map((h) => Math.max(0.16, h * 0.34))
  }
  const amp = Math.max(0, Math.min(1, level))
  return STATIC_VOLUME_SHAPE.map((h) => 0.16 + h * amp)
}
