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
  failed?: boolean
}

/** Append a versioned chunk. Returns the row unchanged when it is already held. */
export function applyChunk<T extends CopyRow>(row: T, chunk: string, seq?: number): T {
  if (!chunkApplies(row.copySeq, seq)) return row
  return { ...row, translation: row.translation + chunk, failed: false, copySeq: seq ?? row.copySeq } as T
}

/** Replace the text with the full snapshot. Returns the row unchanged when stale. */
export function applySnapshot<T extends CopyRow>(row: T, translation: string, seq?: number, failed?: boolean): T {
  if (!snapshotApplies(row.copySeq, seq)) return row
  return { ...row, translation, copySeq: seq ?? row.copySeq, failed: failed ?? row.failed } as T
}

/** One row of the reconnect batch the server sends on re-attach (#219). */
export type CopyBatchRow = {
  id: string
  original?: string
  translation?: string
  failed?: boolean
  seq?: number
}

/**
 * Merge a reconnect batch into the phone's rows.
 *
 * The batch exists because the native replay holds only 24 sentences: a longer
 * lock screen would leave gaps. Rows the phone already has go through the same
 * version rules as the live paths, so a batch can never regress newer text;
 * missing rows are created (keeping their failure state) in batch order.
 */
export function upsertCopyRows<T extends CopyRow & { id: string; original: string }>(
  pairs: T[],
  rows: CopyBatchRow[],
  make: (row: CopyBatchRow) => T,
): T[] {
  let next = pairs
  for (const row of rows) {
    if (!row?.id) continue
    const at = next.findIndex((p) => p.id === row.id)
    if (at < 0) {
      if (!(row.original || '').trim() && !(row.translation || '').trim()) continue
      next = [...next, make(row)]
      continue
    }
    const merged = applySnapshot(next[at], row.translation || '', row.seq, row.failed)
    const original = row.original || next[at].original
    if (merged === next[at] && original === next[at].original) continue
    next = next.map((p, i) => (i === at ? { ...merged, original } : p))
  }
  return next
}
