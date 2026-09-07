export type SaveStatus = 'undecided' | 'saving' | 'saved' | 'failed'
export type PendingAfterSave = 'none' | 'new'
export type KeepFailReason = 'timeout' | 'error' | 'disconnect'

export type SaveBook = {
  liveId: string | null
  generation: number
  status: SaveStatus
  offered: boolean
  pendingAfterSave: PendingAfterSave
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
  return { ...book, status: 'failed' }
}

export function bumpGeneration(book: SaveBook): SaveBook {
  return { ...book, generation: book.generation + 1 }
}

export function markOffered(book: SaveBook): SaveBook {
  return { ...book, offered: true }
}

export function bindLiveId(book: SaveBook, id: string | undefined): SaveBook {
  if (!id) return book
  return { ...book, liveId: id }
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
}): 'banner' | 'modal' | 'none' {
  if (input.kept || !input.hasContent) return 'none'
  if (input.workspaceMode === 'translate') return 'none'
  if (input.workspaceMode !== 'meeting') return 'none'
  if (input.offered) return 'none'
  return input.phone ? 'banner' : 'modal'
}
