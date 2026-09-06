import { historyRowWhen } from './historyRestore'

export type SaveDisposition = 'undecided' | 'saving' | 'saved' | 'discarded'

export type SavePromptReason = 'stop' | 'engine' | 'leave' | 'restore' | 'user'

export type RestoreOffer = {
  id: string
  title: string
  startedAt: string | null
  sttSeconds?: number
}

export type SaveBook = {
  generation: number
  liveId: string
  byId: Record<string, SaveDisposition>
  restore: RestoreOffer | null
  seenRestoreIds: string[]
}

export type SavePromptDecision =
  | { kind: 'none' }
  | { kind: 'modal'; source: 'leave' | 'restore' | 'user' }

const PLACEHOLDER_PREFIX = 'live-'

export function isPlaceholderId(id: string): boolean {
  return id.startsWith(PLACEHOLDER_PREFIX)
}

export function emptySaveBook(): SaveBook {
  return {
    generation: 0,
    liveId: `${PLACEHOLDER_PREFIX}0`,
    byId: { [`${PLACEHOLDER_PREFIX}0`]: 'undecided' },
    restore: null,
    seenRestoreIds: [],
  }
}

export function liveDisposition(book: SaveBook): SaveDisposition {
  return book.byId[book.liveId] ?? 'undecided'
}

export function setLiveDisposition(book: SaveBook, disposition: SaveDisposition): SaveBook {
  return setDisposition(book, book.liveId, disposition)
}

export function setDisposition(book: SaveBook, id: string, disposition: SaveDisposition): SaveBook {
  if (!id) return book
  return { ...book, byId: { ...book.byId, [id]: disposition } }
}

export function beginLiveSession(book: SaveBook): SaveBook {
  const generation = book.generation + 1
  const liveId = `${PLACEHOLDER_PREFIX}${generation}`
  return {
    ...book,
    generation,
    liveId,
    byId: { ...book.byId, [liveId]: 'undecided' },
    restore: null,
  }
}

export function bindLiveSessionId(book: SaveBook, id: string): SaveBook {
  if (!id || book.liveId === id) return book
  if (!isPlaceholderId(book.liveId)) return book
  // An id already on the book belongs to an older live/restore session.
  if (id in book.byId) return book
  const current = liveDisposition(book)
  return {
    ...book,
    liveId: id,
    byId: { ...book.byId, [id]: current },
  }
}

export function shouldBindEngineSessionId(input: {
  listening?: boolean
  listenWanted?: boolean
  paused?: boolean
}): boolean {
  return !input.listening && !input.listenWanted && !input.paused
}

export function markRestoreSeen(book: SaveBook, id: string): SaveBook {
  if (!id || book.seenRestoreIds.includes(id)) return book
  return { ...book, seenRestoreIds: [...book.seenRestoreIds, id] }
}

export function setRestoreOffer(book: SaveBook, restore: RestoreOffer | null): SaveBook {
  return { ...book, restore }
}

/** history_kept marks the intended session. A newer live session is left alone. */
export function applyKeptAck(book: SaveBook, ackId: string | undefined, intendedId: string): SaveBook {
  if (!keepAckMatchesTarget({
    intendedId,
    liveId: book.liveId,
    ackId,
    knownIds: Object.keys(book.byId),
  })) {
    return book
  }
  const id = ackId || intendedId
  if (!id) return setLiveDisposition(book, 'saved')
  let next = book
  if (intendedId === book.liveId && isPlaceholderId(book.liveId) && ackId) {
    next = {
      ...book,
      liveId: ackId,
      byId: { ...book.byId, [ackId]: liveDisposition(book) },
    }
  }
  return setDisposition(next, id, 'saved')
}

export const KEEP_ACK_TIMEOUT_MS = 12_000

export type PendingAfterKeep = 'new' | 'start' | null

export type KeepAfterNotesJob = {
  content: boolean
  audio: boolean
  liveId: string
  generation: number
}

/** The ack belongs to the keep we sent, not some other session. */
export function keepAckMatchesTarget(input: {
  intendedId: string
  liveId: string
  ackId?: string
  knownIds?: string[]
}): boolean {
  const ack = input.ackId
  if (!ack) return false
  if (ack === input.intendedId) return true
  if (ack === input.liveId && isPlaceholderId(input.intendedId)) return true
  if (isPlaceholderId(input.intendedId) && input.intendedId === input.liveId) {
    return !(input.knownIds || []).includes(ack)
  }
  return false
}

/** New session / Start wait for the matching live keep ack, not another session's. */
export function keepAckContinuesPending(input: {
  pending: PendingAfterKeep
  intendedId: string
  liveId: string
  ackId?: string
  knownIds?: string[]
}): boolean {
  if (!input.pending) return false
  if (!keepAckMatchesTarget(input)) return false
  return input.intendedId === input.liveId || input.ackId === input.liveId
}

/** A deferred keep is only for this live generation. Clear / New session bumps generation. */
export function keepAfterNotesStillValid(
  job: Pick<KeepAfterNotesJob, 'liveId' | 'generation'>,
  book: SaveBook,
): boolean {
  if (job.generation !== book.generation) return false
  return job.liveId === book.liveId || isPlaceholderId(job.liveId)
}

/** Keep failed or timed out: leave content on screen and allow Save again. */
export function applyKeepFailed(book: SaveBook, intendedId: string, ackId?: string): SaveBook {
  if (ackId && !keepAckMatchesTarget({
    intendedId,
    liveId: book.liveId,
    ackId,
    knownIds: Object.keys(book.byId),
  })) {
    return book
  }
  const ids = [intendedId, book.liveId].filter((id, i, all) => id && all.indexOf(id) === i)
  let next = book
  for (const id of ids) {
    const current = next.byId[id] ?? (id === next.liveId ? liveDisposition(next) : undefined)
    if (current === 'saving') next = setDisposition(next, id, 'undecided')
  }
  return next
}

export function restorePromptBody(offer: RestoreOffer, nowMs = Date.now()): string {
  const title = (offer.title || 'Untitled').trim()
  const when = historyRowWhen(offer.startedAt, offer.sttSeconds || 0, nowMs)
  return when ? `${title} · ${when}` : title
}

export function decideSavePrompt(input: {
  reason: SavePromptReason
  workspaceMode: string
  hasContent: boolean
  disposition: SaveDisposition
  paused?: boolean
  listening?: boolean
  listenWanted?: boolean
  liveId?: string
  restore?: RestoreOffer | null
  seenRestoreIds?: string[]
}): SavePromptDecision {
  if (input.reason === 'restore') {
    const restore = input.restore
    if (!restore) return { kind: 'none' }
    if (input.listening || input.listenWanted || input.paused) return { kind: 'none' }
    if ((input.seenRestoreIds || []).includes(restore.id)) return { kind: 'none' }
    if (input.liveId && restore.id === input.liveId) return { kind: 'none' }
    if (input.hasContent && input.liveId && restore.id !== input.liveId) return { kind: 'none' }
    return { kind: 'modal', source: 'restore' }
  }

  if (input.reason === 'stop' || input.reason === 'engine') {
    return { kind: 'none' }
  }

  if (input.workspaceMode !== 'meeting') return { kind: 'none' }
  if (input.paused || input.listening) return { kind: 'none' }
  if (!input.hasContent) return { kind: 'none' }
  if (input.disposition !== 'undecided') return { kind: 'none' }

  if (input.reason === 'leave' || input.reason === 'user') {
    return { kind: 'modal', source: input.reason }
  }
  return { kind: 'none' }
}

export function shouldShowSaveBanner(input: {
  workspaceMode: string
  ended: boolean
  hasContent: boolean
  disposition: SaveDisposition
  listening?: boolean
  paused?: boolean
  promptOpen?: boolean
}): boolean {
  if (input.promptOpen) return false
  if (input.workspaceMode !== 'meeting' || !input.ended) return false
  if (input.listening || input.paused) return false
  if (!input.hasContent) return false
  return input.disposition === 'undecided'
}
