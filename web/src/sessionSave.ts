import { modeIsSaveEligible } from './historyRestore'

export type SaveStatus = 'undecided' | 'saving' | 'saved' | 'failed'
export type PendingAfterSave = 'none' | 'new' | 'signout' | 'delete'
export type KeepFailReason = 'timeout' | 'error' | 'disconnect'

export type SaveBook = {
  liveId: string | null
  generation: number
  status: SaveStatus
  offered: boolean
  pendingAfterSave: PendingAfterSave
  /**
   * #196: the mode the session this book refers to was opened in ('' = unknown,
   * which stays eligible for legacy rows). A session whose mode has no Save concept
   * (translate) must never open the Save UI — not even after the user switches the
   * workspace back to Meeting, which is exactly what a workspace-only check allowed.
   */
  sessionMode?: string
}

export type KeepAfterNotesJob = {
  content: boolean
  audio: boolean
  liveId: string
  generation: number
}

export type KeepAckResult = {
  book: SaveBook
  action: PendingAfterSave
}

export const KEEP_ACK_TIMEOUT_MS = 15_000
export const KEEP_CAPTURE_SETTLE_MS = 800

export type NewSessionDecision = 'clear' | 'sheet' | 'blocked'

export function emptySaveBook(): SaveBook {
  return {
    liveId: null,
    generation: 0,
    status: 'undecided',
    offered: false,
    pendingAfterSave: 'none',
    sessionMode: '',
  }
}

/** Start a keep. Records the live id; generation is the book's current value. */
export function beginSave(book: SaveBook, liveId: string): SaveBook {
  return {
    ...book,
    liveId: liveId || book.liveId,
    status: 'saving',
  }
}

/**
 * Only the matching live keep becomes saved. Stale acks (other id, or a
 * generation that has already been bumped) leave the book untouched.
 */
export function applyKeepAck(
  book: SaveBook,
  ackId: string | undefined,
  liveId: string | null,
  generation: number,
): KeepAckResult {
  if (!ackId || !liveId || ackId !== liveId) return { book, action: 'none' }
  if (book.generation !== generation) return { book, action: 'none' }
  if (book.liveId && book.liveId !== liveId) return { book, action: 'none' }
  const action = book.pendingAfterSave
  return {
    book: { ...book, liveId, status: 'saved', pendingAfterSave: 'none' },
    action,
  }
}

export function applyKeepFailed(book: SaveBook, _reason: KeepFailReason): SaveBook {
  if (book.status !== 'saving') return book
  return abandonDestructivePending({ ...book, status: 'failed' })
}

/** Drop delete/signout leave-after-save. New session stays queued for Retry. */
export function abandonDestructivePending(book: SaveBook): SaveBook {
  if (book.pendingAfterSave === 'delete' || book.pendingAfterSave === 'signout') {
    return { ...book, pendingAfterSave: 'none' }
  }
  return book
}

/** A delete/signout ack only runs if that sheet is still on screen. */
export function leaveActionStillArmed(
  action: PendingAfterSave,
  open: { account: boolean; deleteSheet: boolean },
): boolean {
  if (action === 'delete') return open.deleteSheet
  if (action === 'signout') return open.account
  return action === 'new'
}

export function bumpGeneration(book: SaveBook): SaveBook {
  return { ...book, generation: book.generation + 1 }
}

export function markOffered(book: SaveBook): SaveBook {
  return { ...book, offered: true }
}

export function bindLiveId(book: SaveBook, id: string | undefined, sessionMode?: string): SaveBook {
  if (!id) return book
  const next: SaveBook = { ...book, liveId: id }
  // #196: only overwrite when the caller actually knows the session's mode.
  if (sessionMode !== undefined) next.sessionMode = sessionMode
  return next
}

export function setPendingAfterSave(book: SaveBook, pending: PendingAfterSave): SaveBook {
  return { ...book, pendingAfterSave: pending }
}

export function cancelCollect(book: SaveBook): SaveBook {
  if (book.status !== 'saving') return book
  return { ...book, status: 'undecided' }
}

export function keepAfterNotesStillValid(
  job: Pick<KeepAfterNotesJob, 'liveId' | 'generation'>,
  book: SaveBook,
): boolean {
  if (!job.liveId || job.generation !== book.generation) return false
  return job.liveId === book.liveId
}

export function decideNewSession(input: {
  capture: string
  busy: boolean
  hasContent: boolean
  kept: boolean
  workspaceMode: string
}): NewSessionDecision {
  if (input.workspaceMode === 'translate') return 'clear'
  if (!input.hasContent) return 'clear'
  if (input.kept && input.capture === 'off') return 'clear'
  return 'sheet'
}

/** Wait until capture is off and the last line / line_update has been quiet. */
export function keepShouldWaitForCapture(input: {
  capture: string
  lastLineAt: number | null
  now: number
  settleMs?: number
}): boolean {
  if (input.capture !== 'off') return true
  if (input.lastLineAt == null) return false
  const settle = input.settleMs ?? KEEP_CAPTURE_SETTLE_MS
  return input.now - input.lastLineAt < settle
}

export function savePromptSurface(input: {
  phone: boolean
  workspaceMode: string
  kept: boolean
  offered: boolean
  hasContent: boolean
  /**
   * #196: the SESSION's own mode (from the save book). `workspaceMode` is only the
   * pane the user is looking at: after a Translate session, switching back to
   * Meeting used to make this return a surface and ask Save for a session that has
   * no Save concept.
   */
  sessionMode?: string
}): 'banner' | 'modal' | 'none' {
  if (input.kept || !input.hasContent) return 'none'
  if (!modeIsSaveEligible(input.sessionMode)) return 'none'
  if (input.workspaceMode === 'translate') return 'none'
  if (input.workspaceMode !== 'meeting') return 'none'
  if (input.offered) return 'none'
  return input.phone ? 'banner' : 'modal'
}
