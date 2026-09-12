import { applyChunk, applySnapshot, chunkApplies, snapshotApplies } from './copyVersion'

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
// Unversioned rows (older server) keep working.
if (applyChunk({ id: 'p2', translation: 'a' }, 'b').translation !== 'ab') {
  throw new Error('an unversioned chunk must still append')
}
if (applySnapshot({ id: 'p2', translation: 'a' }, 'c').translation !== 'c') {
  throw new Error('an unversioned snapshot must still replace')
}
