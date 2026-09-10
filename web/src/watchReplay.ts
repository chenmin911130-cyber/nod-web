/** Watch → phone PCM (#181).

Watch is capture + bounded memory retry only. iPhone native persists the
contiguous prefix, acks that prefix, uploads from the file, and owns Save.
Socket send and STT drain are not Watch End completion.

Caps: Watch send buffer 128 KiB (4s). Phone disk 256 MiB. Uplink RAM 2 MiB
with backpressure; never drop-oldest.
*/

export const WATCH_PCM_BYTES_PER_SEC = 16_000 * 2
export const WATCH_PCM_FRAME_BYTES = 3200
export const WATCH_PCM_MIN_CHUNK_BYTES = 1600
export const WATCH_SHARD_BYTES = 160_000
export const WATCH_DISK_LIMIT_BYTES = 32 * 1024 * 1024
export const PHONE_DISK_LIMIT_BYTES = 256 * 1024 * 1024
export const WATCH_SEND_LIMIT_BYTES = 128_000
export const UPLINK_MAX_PENDING_BYTES = 2 * 1024 * 1024
export const WATCH_END_ACK_TIMEOUT_SEC = 20
export const WATCH_DRAIN_SLACK_SEC = WATCH_END_ACK_TIMEOUT_SEC

export type WatchStartListenMsg = { type: 'start_listen'; mic?: 'watch' }

export type WatchPcmDecision =
  | 'accept'
  | 'duplicate'
  | 'overlap'
  | 'future'
  | 'stale-session'
  | 'stale-capture'
  | 'persist-failed'

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

export function watchPhoneDiskWouldExceed(used: number, incoming: number, limit = PHONE_DISK_LIMIT_BYTES): boolean {
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
  heldByte: number
  ackCaptureId: string
  liveCaptureId: string
  ackSessionId: string
  liveSessionId: string
}): boolean {
  if (!opts.frozen) return false
  if (!watchPcmAckApplies({
    liveCaptureId: opts.liveCaptureId,
    liveSessionId: opts.liveSessionId,
    ackCaptureId: opts.ackCaptureId,
    ackSessionId: opts.ackSessionId,
  })) {
    return false
  }
  return opts.heldByte >= opts.lastByte
}

export function watchDisconnectShouldPause(listening: boolean, reachable: boolean): boolean {
  return listening && !reachable
}

export function watchSendWouldExceed(unacked: number, incoming: number, limit = WATCH_SEND_LIMIT_BYTES): boolean {
  return unacked + incoming > limit
}

export function watchStartMayRecord(capture: string, pcmReady: boolean): boolean {
  return (capture === 'listening' || capture === 'recording') && pcmReady
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

/** End freeze: tell the phone to seal the persist prefix. Not stop_listen. */
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

/** End waits a bounded persist-ack window, not whole-session cloud drain. */
export function watchDrainDeadlineSec(_lastByte: number): number {
  return WATCH_END_ACK_TIMEOUT_SEC
}

export function watchDrainTimedOut(opts: { freezeAt: number; now: number; lastByte: number }): boolean {
  return opts.now - opts.freezeAt >= watchDrainDeadlineSec(opts.lastByte)
}

/** Leftover Watch files are never auto-deleted. User deletes from storage UI. */
export function watchMayDeleteWatchCopy(_serverDrained: boolean): boolean {
  return false
}

/** Retry re-requests pcm_end confirmation. The server keeps the tail; the phone cursor does not rewind. */
export function watchIngestRewindForRetry(opts: {
  pcmEndSent: boolean
  nextByte: number
}): number {
  return opts.nextByte
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
  heldByte = 0
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
  private uplinkHeld: Parked[] = []
  private persistOk = true
  private watchKeys = new Set<string>()

  setPersistOk(ok: boolean): void {
    this.persistOk = ok
  }

  bind(captureId: string, sessionId: string): void {
    if (this.captureId && captureId && captureId !== this.captureId) {
      this.nextByte = 0
      this.heldByte = 0
      this.parked = []
      this.uplinkHeld = []
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
    if (!this.captureId && opts.captureId) this.captureId = opts.captureId
    if (!this.sessionId && opts.sessionId) this.sessionId = opts.sessionId
    const decision = watchPcmDecision({
      liveCaptureId: this.captureId,
      liveSessionId: this.sessionId,
      incomingCaptureId: opts.captureId,
      incomingSessionId: opts.sessionId,
      nextByte: this.heldByte,
      incomingOffset: opts.offset,
      incomingBytes: opts.bytes.length,
    })
    if (decision === 'stale-capture' || decision === 'stale-session' || decision === 'duplicate') {
      return decision
    }
    if (!this.persistOk) return 'persist-failed'
    this.phoneFiles.set(opts.key, opts.bytes)
    this.watchKeys.add(opts.key)

    if (decision === 'future') {
      this.parked.push({ offset: opts.offset, bytes: opts.bytes, key: opts.key })
      this.parked.sort((a, b) => a.offset - b.offset)
      return decision
    }

    const slice = watchPcmOverlapSlice(this.heldByte, opts.offset, opts.bytes)
    this.heldByte += slice.length
    this.enqueueUplink(slice, opts.key)
    this.flushParked()
    return decision === 'overlap' ? 'overlap' : 'accept'
  }

  /** Simulate AudioUplink sending the next `n` queued bytes (1× realtime). */
  consume(n: number): void {
    const take = Math.min(n, this.uplinkQueued)
    this.uplinkQueued -= take
    this.uplinkSent += take
    this.flushUplink()
    this.flushParked()
    for (const [key, bytes] of this.phoneFiles) {
      if (this.uplinkSent >= this.endOf(key, bytes) && watchMayDeletePhoneCopy(true)) {
        this.phoneFiles.delete(key)
        this.phoneDeleted.add(key)
      }
    }
  }

  ackByte(): number {
    return this.heldByte
  }

  markServerDrained(): void {
    for (const key of this.watchKeys) {
      if (watchMayDeleteWatchCopy(true)) this.watchDeleted.add(key)
    }
  }

  rewindForRetry(): void {
    this.nextByte = watchIngestRewindForRetry({
      pcmEndSent: true,
      nextByte: this.nextByte,
    })
    this.pcmEndSent = false
  }

  private endOf(key: string, bytes: Uint8Array): number {
    const parts = key.split(':')
    const offset = Number(parts[1] || 0)
    return offset + bytes.length
  }

  private enqueueUplink(bytes: Uint8Array, key: string): void {
    if (!bytes.length) return
    this.uplinkHeld.push({ offset: this.nextByte, bytes, key })
    this.flushUplink()
  }

  private flushUplink(): void {
    while (this.uplinkHeld.length) {
      const head = this.uplinkHeld[0]!
      const frame = Math.min(WATCH_PCM_FRAME_BYTES, head.bytes.length)
      const take = watchUplinkTakeBytes(this.uplinkQueued, frame)
      if (take <= 0) return
      const chunk = head.bytes.subarray(0, take)
      this.uplinkQueued += take
      this.nextByte += take
      for (let b = 0; b < take; b++) this.delivered.push(chunk[b]!)
      if (take === head.bytes.length) this.uplinkHeld.shift()
      else {
        this.uplinkHeld[0] = {
          offset: head.offset + take,
          bytes: head.bytes.subarray(take),
          key: head.key,
        }
      }
      if (this.phoneFiles.has(head.key) && this.nextByte >= this.endOf(head.key, this.phoneFiles.get(head.key)!)) {
        if (watchMayDeleteWatchCopy(false)) this.watchDeleted.add(head.key)
      }
    }
  }

  private flushParked(): void {
    while (this.parked.length) {
      const head = this.parked[0]!
      const decision = watchPcmDecision({
        liveCaptureId: this.captureId,
        liveSessionId: this.sessionId,
        incomingCaptureId: this.captureId,
        incomingSessionId: this.sessionId,
        nextByte: this.heldByte,
        incomingOffset: head.offset,
        incomingBytes: head.bytes.length,
      })
      if (decision === 'future') return
      this.parked.shift()
      if (decision === 'duplicate') continue
      const slice = watchPcmOverlapSlice(this.heldByte, head.offset, head.bytes)
      this.heldByte += slice.length
      this.enqueueUplink(slice, head.key)
    }
  }
}
