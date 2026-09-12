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
export function applySnapshot<T extends CopyRow>(row: T, translation: string, seq?: number): T {
  if (!snapshotApplies(row.copySeq, seq)) return row
  return { ...row, translation, copySeq: seq ?? row.copySeq } as T
}
