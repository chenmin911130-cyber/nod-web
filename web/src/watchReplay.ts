/** Watch → phone PCM persist / replay (#165).

Ack layers (delete only after the next layer owns a copy):
1. Watch disk — appended on every capture frame. Copy failure does not delete it.
2. Phone inbound file — persist then stream. Not an STT ack.
3. AudioUplink queue / socket write — not enough to stop STT or delete Watch copies.
4. Server `pcm_drained` for this capture+session+offset — then Watch may delete,
   then `stop_listen`. Socket send / phone persist is not enough to delete Watch
   copies; drain failure must still have shards to retry. STT reconnect hands
   off unsent PCM (buffer then queue) after the sender has exited. Confirm
   requires STT-sent bytes to reach the End offset. Drain retry re-requests
   confirmation or resumes from the STT consume offset — never from byte 0.
   Old clients omit `pcm_end`; `stop_listen` stays immediate.

Caps: Watch disk 32 MiB (stop capture, keep files, visible error). Uplink RAM
2 MiB with backpressure; never drop-oldest on the Watch ingest path.
*/

export const WATCH_PCM_BYTES_PER_SEC = 16_000 * 2
export const WATCH_PCM_FRAME_BYTES = 3200
export const WATCH_PCM_MIN_CHUNK_BYTES = 1600
export const WATCH_SHARD_BYTES = 160_000
export const WATCH_DISK_LIMIT_BYTES = 32 * 1024 * 1024
export const UPLINK_MAX_PENDING_BYTES = 2 * 1024 * 1024
export const WATCH_DRAIN_SLACK_SEC = 90

export type WatchStartListenMsg = { type: 'start_listen'; mic?: 'watch' }

export type WatchPcmDecision =
  | 'accept'
  | 'duplicate'
  | 'overlap'
  | 'future'
  | 'stale-session'
  | 'stale-capture'

export function watchStartListenCommand(fromWatch: boolean): WatchStartListenMsg {
  return fromWatch ? { type: 'start_listen', mic: 'watch' } : { type: 'start_listen' }
}

export function watchReadyResendListen(opts: {
  listenWanted: boolean
  watchMic: boolean
}): WatchStartListenMsg | null {
  if (!opts.listenWanted) return null
  return watchStartListenCommand(opts.watchMic)
}

export function watchAttachedShouldStartListen(): boolean {
  return false
}

export function watchFileShouldStartListenReplay(): boolean {
  return false
}

export function watchPcmDecision(opts: {
  liveCaptureId: string
  liveSessionId: string
  incomingCaptureId: string
  incomingSessionId: string
  nextByte: number
  incomingOffset: number
  incomingBytes: number
}): WatchPcmDecision {
  if (!opts.incomingCaptureId) return 'stale-capture'
  if (opts.liveCaptureId && opts.incomingCaptureId !== opts.liveCaptureId) return 'stale-capture'
  if (opts.incomingSessionId && opts.liveSessionId && opts.incomingSessionId !== opts.liveSessionId) {
    return 'stale-session'
  }
  if (opts.incomingBytes <= 0) return 'duplicate'
  const end = opts.incomingOffset + opts.incomingBytes
  if (end <= opts.nextByte) return 'duplicate'
  if (opts.incomingOffset > opts.nextByte) return 'future'
  if (opts.incomingOffset < opts.nextByte) return 'overlap'
  return 'accept'
}

/** Skip bytes the live path already consumed. */
export function watchPcmOverlapSlice(nextByte: number, offset: number, bytes: Uint8Array): Uint8Array {
  if (offset >= nextByte) return bytes
  const skip = Math.min(bytes.length, nextByte - offset)
  return bytes.subarray(skip)
}

export function watchDiskWouldExceed(used: number, incoming: number, limit = WATCH_DISK_LIMIT_BYTES): boolean {
  return used + incoming > limit
}

export function watchUplinkCanTake(queued: number, incoming: number, max = UPLINK_MAX_PENDING_BYTES): boolean {
  return queued + incoming <= max
}

export function watchUplinkTakeBytes(queued: number, incoming: number, max = UPLINK_MAX_PENDING_BYTES): number {
  if (incoming <= 0) return 0
  return Math.max(0, Math.min(incoming, max - queued))
}

export function watchEndShouldSendStop(opts: {
  frozen: boolean
  lastByte: number
  nextByte: number
  uplinkQueued: number
  serverDrained: boolean
  ackCaptureId: string
  liveCaptureId: string
  ackSessionId: string
  liveSessionId: string
  drainByte?: number
}): boolean {
  if (!opts.frozen || !opts.serverDrained) return false
  if (!watchPcmDrainApplies({
    liveCaptureId: opts.liveCaptureId,
    liveSessionId: opts.liveSessionId,
    liveLastByte: opts.lastByte,
    drainCaptureId: opts.ackCaptureId,
    drainSessionId: opts.ackSessionId,
    drainByte: opts.drainByte ?? opts.lastByte,
  })) {
    return false
  }
  return opts.nextByte >= opts.lastByte && opts.uplinkQueued === 0
}

export function watchPcmAckApplies(opts: {
  liveCaptureId: string
  liveSessionId: string
  ackCaptureId: string
  ackSessionId: string
}): boolean {
  if (!opts.ackCaptureId || !opts.liveCaptureId || opts.ackCaptureId !== opts.liveCaptureId) return false
  if (opts.ackSessionId && opts.liveSessionId && opts.ackSessionId !== opts.liveSessionId) return false
  return true
}

export function watchPcmDrainApplies(opts: {
  liveCaptureId: string
  liveSessionId: string
  liveLastByte: number
  drainCaptureId: string
  drainSessionId: string
  drainByte: number
}): boolean {
  if (!watchPcmAckApplies({
    liveCaptureId: opts.liveCaptureId,
    liveSessionId: opts.liveSessionId,
    ackCaptureId: opts.drainCaptureId,
    ackSessionId: opts.drainSessionId,
  })) {
    return false
  }
  return opts.drainByte === opts.liveLastByte
}

export function watchConsumedApplies(opts: {
  liveCaptureId: string
  liveSessionId: string
  consumeCaptureId: string
  consumeSessionId: string
}): boolean {
  return watchPcmAckApplies({
    liveCaptureId: opts.liveCaptureId,
    liveSessionId: opts.liveSessionId,
    ackCaptureId: opts.consumeCaptureId,
    ackSessionId: opts.consumeSessionId,
  })
}

/** Sealed shards only, and only after server drain. Socket ack must not unlink. */
export function watchMayDeleteShard(opts: {
  openSeq: number
  seq: number
  offset: number
  bytes: number
  ack: number
  serverDrained: boolean
}): boolean {
  if (!opts.serverDrained) return false
  if (opts.openSeq > 0 && opts.seq === opts.openSeq) return false
  return opts.offset + opts.bytes <= opts.ack
}

/** Capacity shortage must leave the pump, not reread the same file in a loop. */
export function watchFilePumpStep(opts: { queued: number; parked: number }): 'paused' | 'continue' | 'done' {
  if (opts.parked <= 0) return 'done'
  if (opts.queued >= UPLINK_MAX_PENDING_BYTES) return 'paused'
  return 'continue'
}

export function watchPersistDelayBytes(): number {
  return 0
}

export function watchEnqueueWaitsForConsume(): boolean {
  return false
}

export type WatchPcmEndMsg = { type: 'pcm_end'; id: string; capture_id: string; byte_offset: number }

export function watchPcmEndMessage(opts: { sessionId: string; captureId: string; lastByte: number }): WatchPcmEndMsg | null {
  if (!opts.sessionId || !opts.captureId || opts.lastByte < 0) return null
  return { type: 'pcm_end', id: opts.sessionId, capture_id: opts.captureId, byte_offset: opts.lastByte }
}

export type WatchDrainMsg = {
  action: 'drain'
  lastByte: number
  captureId: string
  sessionId: string
}

/** End freeze: tell the phone to flush the tail and wait for pcm_drained. Not stop_listen. */
export function watchDrainMessage(opts: {
  lastByte: number
  captureId: string
  sessionId: string
}): WatchDrainMsg | null {
  if (!opts.captureId || opts.lastByte < 0) return null
  return {
    action: 'drain',
    lastByte: opts.lastByte,
    captureId: opts.captureId,
    sessionId: opts.sessionId,
  }
}

export function watchSaveTimerMayStart(opts: { draining: boolean; stopSent: boolean }): boolean {
  return !opts.draining && opts.stopSent
}

export function watchDrainDeadlineSec(lastByte: number): number {
  return lastByte / WATCH_PCM_BYTES_PER_SEC + WATCH_DRAIN_SLACK_SEC
}

export function watchDrainTimedOut(opts: { freezeAt: number; now: number; lastByte: number }): boolean {
  return opts.now - opts.freezeAt >= watchDrainDeadlineSec(opts.lastByte)
}

export function watchMayDeleteWatchCopy(serverDrained: boolean): boolean {
  return serverDrained
}

/** Retry re-requests confirmation, or resumes after STT-consumed bytes. Never rewinds to 0 unless STT sent nothing. */
export function watchIngestRewindForRetry(opts: {
  pcmEndSent: boolean
  nextByte: number
  sttTxByte?: number
}): number {
  if (!opts.pcmEndSent) return opts.nextByte
  if (opts.sttTxByte == null) return opts.nextByte
  return Math.min(opts.nextByte, Math.max(0, opts.sttTxByte))
}

export function watchMayDeletePhoneCopy(uplinkSent: boolean): boolean {
  return uplinkSent
}

export function watchFailedPersistMayDelete(): boolean {
  return false
}

export function watchMinFramePad(bytes: number): number {
  if (bytes <= 0) return 0
  if (bytes >= WATCH_PCM_MIN_CHUNK_BYTES) return bytes
  return WATCH_PCM_MIN_CHUNK_BYTES
}

type Parked = { offset: number; bytes: Uint8Array; key: string }

/** Ordered Watch PCM ingest: persist, dedupe, backpressure into a 2 MiB uplink. */
export class WatchReplayIngest {
  nextByte = 0
  captureId = ''
  sessionId = ''
  uplinkQueued = 0
  uplinkSent = 0
  droppedOldest = 0
  startListenCalls = 0
  phoneFiles = new Map<string, Uint8Array>()
  watchDeleted = new Set<string>()
  phoneDeleted = new Set<string>()
  delivered: number[] = []
  pcmEndSent = false
  private parked: Parked[] = []
  private persistOk = true
  private watchKeys = new Set<string>()

  setPersistOk(ok: boolean): void {
    this.persistOk = ok
  }

  bind(captureId: string, sessionId: string): void {
    if (this.captureId && captureId && captureId !== this.captureId) {
      this.nextByte = 0
      this.parked = []
      this.uplinkQueued = 0
      this.uplinkSent = 0
      this.watchDeleted.clear()
      this.watchKeys.clear()
    }
    if (captureId) this.captureId = captureId
    if (sessionId) this.sessionId = sessionId
  }

  ingest(opts: {
    captureId: string
    sessionId: string
    offset: number
    bytes: Uint8Array
    key: string
    fromFile?: boolean
  }): WatchPcmDecision {
    if (opts.fromFile && !this.captureId) return 'stale-capture'
    const decision = watchPcmDecision({
      liveCaptureId: this.captureId,
      liveSessionId: this.sessionId,
      incomingCaptureId: opts.captureId,
      incomingSessionId: opts.sessionId,
      nextByte: this.nextByte,
      incomingOffset: opts.offset,
      incomingBytes: opts.bytes.length,
    })
    if (decision === 'stale-capture' || decision === 'stale-session' || decision === 'duplicate') {
      return decision
    }
    if (!this.captureId) this.captureId = opts.captureId
    if (!this.sessionId && opts.sessionId) this.sessionId = opts.sessionId

    if (opts.fromFile) {
      if (!this.persistOk) return decision
      this.phoneFiles.set(opts.key, opts.bytes)
    }
    this.watchKeys.add(opts.key)

    if (decision === 'future') {
      this.parked.push({ offset: opts.offset, bytes: opts.bytes, key: opts.key })
      this.parked.sort((a, b) => a.offset - b.offset)
      return decision
    }

    const slice = watchPcmOverlapSlice(this.nextByte, opts.offset, opts.bytes)
    this.feed(slice, opts.key)
    this.flushParked()
    return decision === 'overlap' ? 'overlap' : 'accept'
  }

  /** Simulate AudioUplink sending the next `n` queued bytes (1× realtime). */
  consume(n: number): void {
    const take = Math.min(n, this.uplinkQueued)
    this.uplinkQueued -= take
    this.uplinkSent += take
    this.flushParked()
    for (const [key, bytes] of this.phoneFiles) {
      if (this.uplinkSent >= this.endOf(key, bytes) && watchMayDeletePhoneCopy(true)) {
        this.phoneFiles.delete(key)
        this.phoneDeleted.add(key)
      }
    }
  }

  ackByte(): number {
    return this.nextByte
  }

  markServerDrained(): void {
    for (const key of this.watchKeys) {
      if (watchMayDeleteWatchCopy(true)) this.watchDeleted.add(key)
    }
  }

  rewindForRetry(sttTxByte?: number): void {
    this.nextByte = watchIngestRewindForRetry({
      pcmEndSent: true,
      nextByte: this.nextByte,
      sttTxByte,
    })
    this.pcmEndSent = false
  }

  private endOf(key: string, bytes: Uint8Array): number {
    const parts = key.split(':')
    const offset = Number(parts[1] || 0)
    return offset + bytes.length
  }

  private feed(bytes: Uint8Array, key: string): void {
    let i = 0
    while (i < bytes.length) {
      const frame = Math.min(WATCH_PCM_FRAME_BYTES, bytes.length - i)
      const take = watchUplinkTakeBytes(this.uplinkQueued, frame)
      if (take <= 0) {
        this.parked.push({ offset: this.nextByte, bytes: bytes.subarray(i), key })
        this.parked.sort((a, b) => a.offset - b.offset)
        return
      }
      const chunk = bytes.subarray(i, i + take)
      this.uplinkQueued += take
      this.nextByte += take
      for (let b = 0; b < take; b++) this.delivered.push(chunk[b]!)
      i += take
      if (this.phoneFiles.has(key) && this.nextByte >= this.endOf(key, this.phoneFiles.get(key)!)) {
        if (watchMayDeleteWatchCopy(false)) this.watchDeleted.add(key)
      }
    }
  }

  private flushParked(): void {
    while (this.parked.length) {
      if (watchUplinkTakeBytes(this.uplinkQueued, 1) <= 0) return
      const head = this.parked[0]!
      const decision = watchPcmDecision({
        liveCaptureId: this.captureId,
        liveSessionId: this.sessionId,
        incomingCaptureId: this.captureId,
        incomingSessionId: this.sessionId,
        nextByte: this.nextByte,
        incomingOffset: head.offset,
        incomingBytes: head.bytes.length,
      })
      if (decision === 'future') return
      this.parked.shift()
      if (decision === 'duplicate') continue
      const slice = watchPcmOverlapSlice(this.nextByte, head.offset, head.bytes)
      this.feed(slice, head.key)
    }
  }
}
