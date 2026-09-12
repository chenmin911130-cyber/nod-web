/**
 * One version order for the two paths that carry the same Translate row (#219).
 *
 * The server sends the row twice: an incremental `chunk` over the control
 * WebSocket (the phone's caption pump) and the accumulated full text as a
 * `watch_copy` over the native audio socket (the locked-phone path). Both land
 * in the same `translatePairs` row, so without a shared version the row either
 * duplicates a chunk the snapshot already contains, or regresses from the full
 * text back to an earlier prefix because the chunk arrived after the snapshot.
 *
 * `copy_seq` / `seq` is the server's monotone copy version for that row (see
 * `Session._next_watch_copy_seq`). A missing version means "no ordering
 * information" (an older server, a locally typed row) and is always applied.
 */

/** Should a full-text snapshot replace the row's current text? */
export function snapshotApplies(current: number | undefined, incoming: number | undefined): boolean {
  if (incoming === undefined) return true
  if (current === undefined) return true
  return incoming >= current
}

/** Should an incremental chunk be appended, or does the row already hold it? */
export function chunkApplies(current: number | undefined, incoming: number | undefined): boolean {
  if (incoming === undefined) return true
  if (current === undefined) return true
  return incoming > current
}

/**
 * The row fields the version rules depend on. Deliberately structural so the
 * helpers stay usable without importing the whole app state.
 */
export type CopyRow = {
  translation: string
  copySeq?: number
  copyOrder?: number
  failed?: boolean
}

/** Append a versioned chunk. Returns the row unchanged when it is already held. */
export function applyChunk<T extends CopyRow>(row: T, chunk: string, seq?: number): T {
  if (!chunkApplies(row.copySeq, seq)) return row
  return { ...row, translation: row.translation + chunk, failed: false, copySeq: seq ?? row.copySeq } as T
}

/**
 * Replace the text with the full snapshot. Returns the row unchanged when it is
 * stale — or when the snapshot says exactly what the row already says, so a
 * replay/catch-up does not churn the list.
 */
export function applySnapshot<T extends CopyRow>(row: T, translation: string, seq?: number, failed?: boolean): T {
  if (!snapshotApplies(row.copySeq, seq)) return row
  const nextSeq = seq ?? row.copySeq
  const nextFailed = failed ?? row.failed
  if (row.translation === translation && row.copySeq === nextSeq && row.failed === nextFailed) return row
  return { ...row, translation, copySeq: nextSeq, failed: nextFailed } as T
}

/** One row of the reconnect batch the server sends on re-attach (#219). */
export type CopyBatchRow = {
  id: string
  original?: string
  translation?: string
  failed?: boolean
  seq?: number
  order?: number
}

/**
 * Merge one copy row into the phone's rows — the single entry point every real
 * path uses (the live watchCopy snapshot, the reconnect batch, a replayed row).
 *
 * It fills the stable sentence order onto rows that lack it, inserts a missing row
 * where that order says it belongs, applies the version rules to the text, and
 * re-sorts when the order changed. Ordering never uses `copySeq`: a retried early
 * sentence has the newest version but the oldest position (#219 review).
 */
export function applyCopyRow<T extends CopyRow & { id: string; original: string }>(
  pairs: T[],
  row: CopyBatchRow,
  make: (row: CopyBatchRow) => T,
): T[] {
  if (!row?.id) return pairs
  const at = pairs.findIndex((p) => p.id === row.id)
  let next = pairs
  let touched = false
  if (at < 0) {
    if (!(row.original || '').trim() && !(row.translation || '').trim()) return pairs
    const created = make(row)
    let insertAt = next.length
    if (typeof row.order === 'number') {
      const after = next.findIndex((p) => typeof p.copyOrder === 'number' && (p.copyOrder as number) > row.order!)
      if (after >= 0) insertAt = after
    }
    next = [...next.slice(0, insertAt), created, ...next.slice(insertAt)]
    touched = true
  } else {
    const current = next[at]
    const merged = applySnapshot(current, row.translation ?? current.translation, row.seq, row.failed)
    const original = row.original || current.original
    const copyOrder = current.copyOrder === undefined && typeof row.order === 'number' ? row.order : current.copyOrder
    if (merged !== current || original !== current.original || copyOrder !== current.copyOrder) {
      next = next.map((p, i) => (i === at ? { ...merged, original, copyOrder } : p))
      touched = true
    }
  }
  return touched ? sortCopyRows(next) : pairs
}

/**
 * Stable sort by the immutable sentence order. Rows without one (a locally typed
 * pair the server has not seen yet) keep their relative position and stay after
 * the ordered rows. Returns the same array when it is already ordered.
 */
export function sortCopyRows<T extends { copyOrder?: number }>(pairs: T[]): T[] {
  let last = -Infinity
  let sawUnordered = false
  for (const p of pairs) {
    if (typeof p.copyOrder === 'number') {
      if (sawUnordered || p.copyOrder < last) {
        const ordered = pairs.filter((q) => typeof q.copyOrder === 'number').sort((a, b) => (a.copyOrder as number) - (b.copyOrder as number))
        const unordered = pairs.filter((q) => typeof q.copyOrder !== 'number')
        return [...ordered, ...unordered]
      }
      last = p.copyOrder
    } else {
      sawUnordered = true
    }
  }
  return pairs
}

/** Merge a reconnect batch: `applyCopyRow` for each row, in order. */
export function upsertCopyRows<T extends CopyRow & { id: string; original: string }>(
  pairs: T[],
  rows: CopyBatchRow[],
  make: (row: CopyBatchRow) => T,
): T[] {
  let next = pairs
  for (const row of rows) next = applyCopyRow(next, row, make)
  return next
}

/**
 * Whether a copy row/frame belongs to the phone's current copy session (#219).
 * An unknown session on either side is accepted: the first row of a fresh
 * app/webview adopts the session, and an older phone build sends none.
 */
export function copySessionAccepts(current: string, incoming?: string): boolean {
  if (!incoming || !current) return true
  return incoming === current
}
