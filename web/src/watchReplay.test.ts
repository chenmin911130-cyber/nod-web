import {
  UPLINK_MAX_PENDING_BYTES,
  WATCH_DISK_LIMIT_BYTES,
  WATCH_PCM_FRAME_BYTES,
  WATCH_PCM_MIN_CHUNK_BYTES,
  WatchReplayIngest,
  watchAttachedShouldStartListen,
  watchDiskWouldExceed,
  watchDrainTimedOut,
  watchEndShouldSendStop,
  watchFailedPersistMayDelete,
  watchFileShouldStartListenReplay,
  watchMinFramePad,
  watchPcmDecision,
  watchReadyResendListen,
  watchSaveTimerMayStart,
  watchStartListenCommand,
  watchUplinkCanTake,
  watchPcmAckApplies,
  watchFilePumpStep,
  watchPersistDelayBytes,
  watchEnqueueWaitsForConsume,
  watchPcmEndMessage,
  watchDrainMessage,
} from './watchReplay'

function eq<T>(got: T, want: T, label: string) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) throw new Error(`${label}: got ${a}, want ${b}`)
}

function bytes(n: number, start = 0): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (start + i) & 0xff
  return out
}

eq(watchStartListenCommand(true), { type: 'start_listen', mic: 'watch' }, 'Watch Start sends mic=watch')
eq(watchStartListenCommand(false), { type: 'start_listen' }, 'phone Start does not send watch mic')
eq(
  watchReadyResendListen({ listenWanted: true, watchMic: true }),
  { type: 'start_listen', mic: 'watch' },
  'ready resend keeps watch mic',
)
eq(
  watchReadyResendListen({ listenWanted: true, watchMic: false }),
  { type: 'start_listen' },
  'ready resend keeps phone mic',
)
eq(watchReadyResendListen({ listenWanted: false, watchMic: true }), null, 'idle ready does not start_listen')
eq(watchAttachedShouldStartListen(), false, 'attached must not replay start_listen')
eq(watchFileShouldStartListenReplay(), false, 'a leftover Watch file must not start_listen')

const live = { liveCaptureId: 'cap-a', liveSessionId: 'sess-1', nextByte: 3200 }
eq(
  watchPcmDecision({ ...live, incomingCaptureId: 'cap-a', incomingSessionId: 'sess-1', incomingOffset: 3200, incomingBytes: 3200 }),
  'accept',
  'in-order shard is accepted',
)
eq(
  watchPcmDecision({ ...live, incomingCaptureId: 'cap-a', incomingSessionId: 'sess-1', incomingOffset: 0, incomingBytes: 3200 }),
  'duplicate',
  'live/file overlap of an already-taken seq is duplicate',
)
eq(
  watchPcmDecision({ ...live, incomingCaptureId: 'cap-a', incomingSessionId: 'sess-1', incomingOffset: 1600, incomingBytes: 3200 }),
  'overlap',
  'partial overlap keeps the unseen tail',
)
eq(
  watchPcmDecision({ ...live, incomingCaptureId: 'cap-a', incomingSessionId: 'sess-1', incomingOffset: 9600, incomingBytes: 3200 }),
  'future',
  'reorder parks a future seq',
)
eq(
  watchPcmDecision({ ...live, incomingCaptureId: 'cap-b', incomingSessionId: 'sess-1', incomingOffset: 3200, incomingBytes: 3200 }),
  'stale-capture',
  'old capture must not join the live session',
)
eq(
  watchPcmDecision({ ...live, incomingCaptureId: 'cap-a', incomingSessionId: 'sess-2', incomingOffset: 3200, incomingBytes: 3200 }),
  'stale-session',
  'old session id must not join the live session',
)
eq(
  watchPcmDecision({
    liveCaptureId: '',
    liveSessionId: '',
    incomingCaptureId: 'cap-old',
    incomingSessionId: 'sess-old',
    nextByte: 0,
    incomingOffset: 0,
    incomingBytes: 3200,
  }),
  'accept',
  'first packet of a live capture may bind identity',
)
eq(
  watchPcmDecision({
    liveCaptureId: 'cap-a',
    liveSessionId: 'sess-1',
    incomingCaptureId: '',
    incomingSessionId: '',
    nextByte: 0,
    incomingOffset: 0,
    incomingBytes: 3200,
  }),
  'stale-capture',
  'anonymous leftover PCM is rejected',
)

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-a', 'sess-1')
  eq(pipe.ingest({ captureId: 'cap-a', sessionId: 'sess-1', offset: 3200, bytes: bytes(3200, 1), key: 'a:3200' }), 'future', 'gap parks later seq')
  eq(pipe.nextByte, 0, 'future seq does not advance')
  eq(pipe.ingest({ captureId: 'cap-a', sessionId: 'sess-1', offset: 0, bytes: bytes(3200, 0), key: 'a:0' }), 'accept', 'missing earlier seq then plays')
  eq(pipe.nextByte, 6400, 'parked later seq drains in order')
  eq(pipe.delivered[0], 0, 'byte 0 is from the earlier shard')
  eq(pipe.delivered[3200], 1, 'byte 3200 is from the parked shard')
  eq(pipe.startListenCalls, 0, 'reorder must not start_listen')
}

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-a', 'sess-1')
  const chunk = bytes(3200, 9)
  eq(pipe.ingest({ captureId: 'cap-a', sessionId: 'sess-1', offset: 0, bytes: chunk, key: 'live:0' }), 'accept', 'live chunk accepted')
  eq(
    pipe.ingest({ captureId: 'cap-a', sessionId: 'sess-1', offset: 0, bytes: chunk, key: 'file:0', fromFile: true }),
    'duplicate',
    'file retry of the live chunk is dropped',
  )
  eq(pipe.nextByte, 3200, 'overlap does not double-count')
  eq(pipe.delivered.length, 3200, 'duplicate file does not append PCM')
}

{
  const idle = new WatchReplayIngest()
  eq(
    idle.ingest({ captureId: 'cap-old', sessionId: 'sess-old', offset: 0, bytes: bytes(3200), key: 'orphan:0', fromFile: true }),
    'stale-capture',
    'a leftover file with no live capture must not bind or Start',
  )
  eq(idle.nextByte, 0, 'idle leftover does not ingest')
  eq(idle.startListenCalls, 0, 'idle leftover must not start_listen')
}

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-new', 'sess-new')
  eq(
    pipe.ingest({ captureId: 'cap-old', sessionId: 'sess-old', offset: 0, bytes: bytes(3200), key: 'old:0', fromFile: true }),
    'stale-capture',
    'old file is not the current capture',
  )
  eq(pipe.nextByte, 0, 'old file does not move the cursor')
  eq(pipe.startListenCalls, 0, 'old file must not start_listen')
  eq(watchFileShouldStartListenReplay(), false, 'file arrival is never Start')
}

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-a', 'sess-1')
  const file = bytes(UPLINK_MAX_PENDING_BYTES + WATCH_PCM_FRAME_BYTES * 4, 3)
  const first = pipe.ingest({
    captureId: 'cap-a',
    sessionId: 'sess-1',
    offset: 0,
    bytes: file,
    key: 'big:0',
    fromFile: true,
  })
  eq(first, 'accept', 'large file starts ingest')
  eq(watchUplinkCanTake(pipe.uplinkQueued, WATCH_PCM_FRAME_BYTES), false, '2 MiB uplink is full')
  eq(pipe.uplinkQueued <= UPLINK_MAX_PENDING_BYTES, true, 'queue never grows past 2 MiB')
  eq(pipe.droppedOldest, 0, 'backpressure does not drop-oldest')
  while (pipe.nextByte < file.length) {
    pipe.consume(WATCH_PCM_FRAME_BYTES)
  }
  eq(pipe.nextByte, file.length, 'file larger than 2 MiB is sent in full')
  eq(pipe.delivered.length, file.length, 'every byte is delivered once')
  eq(pipe.droppedOldest, 0, 'complete send still never drops old frames')
  eq(pipe.watchDeleted.has('big:0'), true, 'Watch copy deletes only after phone persist+consume')
}

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-a', 'sess-1')
  pipe.setPersistOk(false)
  pipe.ingest({
    captureId: 'cap-a',
    sessionId: 'sess-1',
    offset: 0,
    bytes: bytes(3200),
    key: 'fail:0',
    fromFile: true,
  })
  eq(pipe.phoneFiles.has('fail:0'), false, 'failed persist does not claim a phone copy')
  eq(pipe.watchDeleted.has('fail:0'), false, 'failed file must not delete the Watch original')
  eq(watchFailedPersistMayDelete(), false, 'delete is forbidden until persist succeeds')
}

{
  const lastByte = 64_000
  const ids = { ackCaptureId: 'cap-a', liveCaptureId: 'cap-a', ackSessionId: 'sess-1', liveSessionId: 'sess-1' }
  eq(
    watchEndShouldSendStop({ frozen: true, lastByte, nextByte: 32_000, uplinkQueued: 0, serverDrained: true, ...ids }),
    false,
    'End must not stop while backlog remains',
  )
  eq(
    watchEndShouldSendStop({ frozen: true, lastByte, nextByte: lastByte, uplinkQueued: 3200, serverDrained: true, ...ids }),
    false,
    'End must not stop while uplink still holds frames',
  )
  eq(
    watchEndShouldSendStop({ frozen: true, lastByte, nextByte: lastByte, uplinkQueued: 0, serverDrained: false, ...ids }),
    false,
    'socket send is not enough; wait for pcm_drained',
  )
  eq(
    watchEndShouldSendStop({ frozen: true, lastByte, nextByte: lastByte, uplinkQueued: 0, serverDrained: true, ...ids, ackCaptureId: 'cap-old' }),
    false,
    'old ack must not complete a new capture',
  )
  eq(
    watchEndShouldSendStop({ frozen: true, lastByte, nextByte: lastByte, uplinkQueued: 0, serverDrained: true, ...ids }),
    true,
    'stop_listen only after server drain of this session',
  )
  eq(watchSaveTimerMayStart({ draining: true, stopSent: false }), false, '#164 15s timer does not cover replay')
  eq(watchSaveTimerMayStart({ draining: false, stopSent: true }), true, 'Save timer starts once keep_history can send')
  eq(watchMinFramePad(800), WATCH_PCM_MIN_CHUNK_BYTES, 'drain tail is padded to the 50 ms floor')
  eq(watchMinFramePad(1600), 1600, 'already-legal tail is unchanged')
}

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-a', 'sess-1')
  const body = bytes(6400, 5)
  pipe.ingest({ captureId: 'cap-a', sessionId: 'sess-1', offset: 0, bytes: body, key: 'end:0', fromFile: true })
  let stopSent = false
  let saveArmed = false
  const frozen = true
  const lastByte = 6400
  const ids = { ackCaptureId: 'cap-a', liveCaptureId: 'cap-a', ackSessionId: 'sess-1', liveSessionId: 'sess-1' }
  let serverDrained = false
  while (!watchEndShouldSendStop({ frozen, lastByte, nextByte: pipe.nextByte, uplinkQueued: pipe.uplinkQueued, serverDrained, ...ids })) {
    eq(stopSent, false, 'stop is held while draining')
    if (pipe.uplinkQueued > 0) pipe.consume(WATCH_PCM_FRAME_BYTES)
    else serverDrained = true
  }
  stopSent = true
  if (watchSaveTimerMayStart({ draining: false, stopSent })) saveArmed = true
  eq(stopSent, true, 'stop fires after the last byte')
  eq(saveArmed, true, 'Save may arm only after stop')
  eq(pipe.nextByte, lastByte, 'same seq continues across the drain')
}

eq(
  watchDrainTimedOut({ freezeAt: 0, now: 10, lastByte: 32_000 * 60 }),
  false,
  'a 1-minute backlog plus slack has not expired at 10s',
)
eq(
  watchDrainTimedOut({ freezeAt: 0, now: 32_000 * 60 / 32_000 + 90, lastByte: 32_000 * 60 }),
  true,
  'past audio-duration + slack is an explicit drain failure',
)

eq(watchDiskWouldExceed(WATCH_DISK_LIMIT_BYTES, 1), true, 'disk cap refuses new capture bytes')
eq(watchDiskWouldExceed(0, 3200), false, 'under the cap still records')

eq(watchPcmAckApplies({ liveCaptureId: 'cap-a', liveSessionId: 'sess-1', ackCaptureId: 'cap-a', ackSessionId: 'sess-1' }), true, 'matching ack applies')
eq(watchPcmAckApplies({ liveCaptureId: 'cap-a', liveSessionId: 'sess-1', ackCaptureId: 'cap-old', ackSessionId: 'sess-1' }), false, 'old capture ack is rejected')
eq(watchPcmAckApplies({ liveCaptureId: 'cap-a', liveSessionId: 'sess-1', ackCaptureId: 'cap-a', ackSessionId: 'sess-old' }), false, 'old session ack is rejected')
eq(watchPcmAckApplies({ liveCaptureId: 'cap-a', liveSessionId: 'sess-1', ackCaptureId: '', ackSessionId: 'sess-1' }), false, 'ack without capture is rejected')

eq(watchFilePumpStep({ queued: UPLINK_MAX_PENDING_BYTES, parked: 1 }), 'paused', 'full uplink pauses the file pump')
eq(watchFilePumpStep({ queued: 0, parked: 1 }), 'continue', 'room to send continues the file pump')
eq(watchFilePumpStep({ queued: 0, parked: 0 }), 'done', 'empty parked list is done')

{
  let steps = 0
  let queued = UPLINK_MAX_PENDING_BYTES
  let parked = 1
  while (watchFilePumpStep({ queued, parked }) === 'continue') steps++
  eq(watchFilePumpStep({ queued, parked }), 'paused', 'backpressure does not reread in a loop')
  eq(steps, 0, 'paused pump does not spin')
}

eq(watchPersistDelayBytes(), 0, 'every capture frame is durable; no 5s memory window')
eq(watchEnqueueWaitsForConsume(), false, 'enqueue must not wait on the consume callback')
eq(watchPcmEndMessage({ sessionId: 'sess-1', lastByte: 6400 }), { type: 'pcm_end', id: 'sess-1', byte_offset: 6400 }, 'pcm_end binds the usage session')
eq(watchPcmEndMessage({ sessionId: '', lastByte: 6400 }), null, 'pcm_end without session id is not sent')
eq(
  watchDrainMessage({ lastByte: 6400, captureId: 'cap-a', sessionId: 'sess-1' }),
  { action: 'drain', lastByte: 6400, captureId: 'cap-a', sessionId: 'sess-1' },
  'End freeze sends drain, not stop_listen',
)
eq(watchDrainMessage({ lastByte: 6400, captureId: '', sessionId: 'sess-1' }), null, 'drain without capture is not sent')
eq(watchMinFramePad(800), WATCH_PCM_MIN_CHUNK_BYTES, 'short End tail is padded before send')

{
  const pipe = new WatchReplayIngest()
  pipe.bind('cap-a', 'sess-1')
  pipe.ingest({ captureId: 'cap-a', sessionId: 'sess-1', offset: 0, bytes: bytes(3200), key: 'a:0' })
  pipe.bind('cap-b', 'sess-2')
  eq(pipe.nextByte, 0, 'new capture resets the cursor')
  eq(pipe.uplinkSent, 0, 'new capture resets sent bytes')
}
