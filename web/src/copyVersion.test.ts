import { applyChunk, applySnapshot, chunkApplies, snapshotApplies, upsertCopyRows } from './copyVersion'

// No version on either side: keep the old behaviour (apply).
if (!snapshotApplies(undefined, undefined)) throw new Error('unversioned snapshot must apply')
if (!chunkApplies(undefined, undefined)) throw new Error('unversioned chunk must apply')
if (!snapshotApplies(5, undefined)) throw new Error('snapshot without a version must apply')
if (!chunkApplies(5, undefined)) throw new Error('chunk without a version must apply')

// A snapshot is the accumulated text for the same version, so re-applying it is
// safe; an older snapshot is stale.
if (!snapshotApplies(undefined, 5)) throw new Error('first versioned snapshot must apply')
if (!snapshotApplies(5, 5)) throw new Error('same-version snapshot is idempotent, not stale')
if (snapshotApplies(6, 5)) throw new Error('older snapshot must not replace newer text')

// A chunk is a delta: the snapshot that carries the same version already has it.
if (!chunkApplies(undefined, 5)) throw new Error('first versioned chunk must append')
if (chunkApplies(5, 5)) throw new Error('a chunk already contained in the snapshot must not append twice')
if (!chunkApplies(5, 6)) throw new Error('the next chunk must append')
if (chunkApplies(6, 5)) throw new Error('a chunk older than the applied version must be dropped')

// The race the version exists for: full snapshot v5 lands first, then the
// matching chunk v5 → no duplication; the next chunk v6 still appends.
const afterSnapshot = chunkApplies(5, 5) ? 'duplicated' : 'ok'
if (afterSnapshot !== 'ok') throw new Error('snapshot-then-chunk duplicated the row')

// The row helpers the reducer actually calls.
type Row = { id: string; translation: string; copySeq?: number; failed?: boolean }

const fresh: Row = { id: 'p1', translation: '' }
const chunked = applyChunk(fresh, '你好', 5)
if (chunked.translation !== '你好' || chunked.copySeq !== 5) {
  throw new Error(`chunk must append and stamp the version, got ${JSON.stringify(chunked)}`)
}
if (applyChunk(chunked, '你好', 5) !== chunked) {
  throw new Error('a snapshot that already contains this chunk must leave the row identical')
}
const half = applyChunk(chunked, '，', 6)
if (half.translation !== '你好，' || half.copySeq !== 6) {
  throw new Error(`next chunk must append, got ${JSON.stringify(half)}`)
}
const failedRow = { ...half, failed: true }
if (applyChunk(failedRow, '！', 7).failed) throw new Error('a fresh chunk clears the failed state')

const snapshotted = applySnapshot(half, '你好，世界', 7)
if (snapshotted.translation !== '你好，世界' || snapshotted.copySeq !== 7) {
  throw new Error(`snapshot must replace the whole text, got ${JSON.stringify(snapshotted)}`)
}
if (applySnapshot(snapshotted, '你好', 6) !== snapshotted) {
  throw new Error('a stale snapshot must leave the row identical')
}
if (applySnapshot(snapshotted, '你好，世界！', 8).translation !== '你好，世界！') {
  throw new Error('a newer snapshot must apply')
}
// A failed snapshot marks the row; a later successful one clears it, and a stale
// failure cannot mark a row that has already moved on (#219).
const failedRow2 = applySnapshot(snapshotted, '半句', 8, true)
if (!failedRow2.failed) throw new Error('a failed snapshot must mark the row failed')
const recovered = applySnapshot(failedRow2, '完整译文', 9, false)
if (recovered.failed) throw new Error('a successful retry must clear the failure')
if (applySnapshot(recovered, '半句', 8, true) !== recovered) {
  throw new Error('a stale failed snapshot must not mark a newer row')
}
// Unversioned rows (older server) keep working.
if (applyChunk({ id: 'p2', translation: 'a' }, 'b').translation !== 'ab') {
  throw new Error('an unversioned chunk must still append')
}
if (applySnapshot({ id: 'p2', translation: 'a' }, 'c').translation !== 'c') {
  throw new Error('an unversioned snapshot must still replace')
}

// Reconnect catch-up (#219): the server sends the copy session's rows because the
// native replay holds only 24 sentences. Missing rows are created (with their
// failure state), older rows never regress a newer one.
type Pair = { id: string; original: string; translation: string; copySeq?: number; failed?: boolean }
const existing: Pair[] = [
  { id: 'a', original: 'A', translation: '甲', copySeq: 10 },
  { id: 'b', original: 'B', translation: '', copySeq: undefined },
]
const make = (row: { id: string; original?: string; translation?: string; failed?: boolean; seq?: number }): Pair => ({
  id: row.id,
  original: row.original || '',
  translation: row.translation || '',
  copySeq: row.seq,
  failed: Boolean(row.failed),
})
const caught = upsertCopyRows(existing, [
  { id: 'a', original: 'A', translation: '甲', seq: 10 },        // same version: unchanged
  { id: 'b', original: 'B', translation: '乙', failed: true, seq: 11 }, // fills a gap + failure
  { id: 'c', original: 'C', translation: '丙', seq: 12 },        // brand new row
  { id: 'a', original: 'A', translation: '旧', seq: 9 },         // stale: must not regress
  { id: '', original: '', translation: '', seq: 13 },            // empty id: skipped
], make)
if (caught.length !== 3) throw new Error(`batch must add the missing rows, got ${caught.length}`)
if (caught[0].translation !== '甲' || caught[0].copySeq !== 10) throw new Error('a same-version batch row must not change the row')
if (caught[1].translation !== '乙' || !caught[1].failed) throw new Error('a newly seen failed row must keep its failure state')
if (caught[2].id !== 'c' || caught[2].translation !== '丙') throw new Error('missing rows are appended in batch order')
if (upsertCopyRows(caught, [{ id: 'a', original: 'A', translation: '旧', seq: 9 }], make) !== caught) {
  throw new Error('a stale batch row must leave the list identical')
}
if (upsertCopyRows([], [{ id: 'd', original: '', translation: '' }], make).length !== 0) {
  throw new Error('an empty row is not a row')
}
