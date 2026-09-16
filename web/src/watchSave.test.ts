import { keepShouldWaitForNotes } from './recordReport'
import { applyKeepAck, applyKeepFailed, beginSave, bindLiveId, emptySaveBook } from './sessionSave'
import { watchCommandFromBridge } from './watch'
import {
  flushPendingKeepMessage,
  keepHistoryMessage,
  watchApplySavePayload,
  watchDiscardCommand,
  watchKeepNotesWait,
  watchSaveAckApplies,
  watchSaveCommand,
  watchSaveKeepTarget,
  watchSavePinIncoming,
  watchSavePinnedId,
  watchSaveRepeatAction,
  watchSaveShouldWaitForNotes,
  watchSaveShouldSendKeepHistory,
  watchJsFailMayApply,
  watchFailKeepNativeFace,
  watchPhoneStatusMayPush,
  watchKeepHttpFace,
  watchNativeSaveReduce,
  watchSaveStatusPayload,
  watchSaveWireMessage,
  watchSavedAckMs,
  watchSaveTimeoutMs,
  watchStopShouldAutoKeepHistory,
  watchStopShouldOpenPhoneSave,
} from './watchSave'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(watchStopShouldAutoKeepHistory(), false, 'Watch Stop must not silently keep History')
eq(watchStopShouldAutoKeepHistory(true), true, 'AutoNotes auto-keeps History on save_prompt')
eq(watchStopShouldOpenPhoneSave(), false, 'Watch Stop must not open the iPhone Save dialog')

eq(
  watchSaveCommand('live-a'),
  { type: 'keep_history', content: true, audio: true, id: 'live-a' },
  'Watch Save must name the bound session id',
)
eq(
  keepHistoryMessage({ content: true, audio: true, id: 'live-a' }),
  { type: 'keep_history', content: true, audio: true, id: 'live-a' },
  'keep_history on the wire carries the bound id',
)
if ('keepRecording' in watchSaveCommand('live-a')) {
  throw new Error('Watch Save must not send a Keep recording checkbox')
}
eq(watchSaveShouldWaitForNotes(), false, 'Watch Save does not wait for Notes')
eq(watchSaveShouldSendKeepHistory(), false, 'Watch Save does not send JS keep_history')
eq(watchJsFailMayApply('saved'), false, 'JS timeout must not fail a native History success')
eq(watchJsFailMayApply('local'), false, 'JS timeout must not fail a native local persist')
eq(watchJsFailMayApply('failed'), true, 'JS may surface a native failure')
eq(watchJsFailMayApply(''), true, 'JS may fail when native has no result')
eq(
  watchPhoneStatusMayPush({
    nativeSave: 'saved',
    incomingSave: 'failed',
    nativeSessionId: 'live-a',
    incomingSessionId: 'live-a',
  }),
  false,
  'phone Retry save must not push failed over native saved',
)
eq(
  watchPhoneStatusMayPush({
    nativeSave: 'saved',
    incomingSave: 'failed',
    nativeSessionId: 'live-a',
    incomingSessionId: 'live-b',
  }),
  true,
  'session B may still show failed',
)
eq(
  watchPhoneStatusMayPush({
    nativeSave: 'local',
    incomingSave: 'failed',
    nativeSessionId: 'live-a',
    incomingSessionId: 'live-a',
  }),
  false,
  'JS timeout must not push failed over native local persist',
)
eq(watchKeepHttpFace({ status: 200, body: { ok: true, id: 'live-a' }, sessionId: 'live-a' }), 'saved', 'HTTP 200 ok+id is History')
eq(watchKeepHttpFace({ status: 200, body: { ok: true, id: 'live-b' }, sessionId: 'live-a' }), 'failed', 'HTTP 200 with the wrong id is not saved')
eq(watchKeepHttpFace({ status: 200, body: { ok: true }, sessionId: 'live-a' }), 'failed', 'HTTP 200 ok without id is not saved')
eq(watchKeepHttpFace({ status: 200, body: { ok: true, id: '' }, sessionId: 'live-a' }), 'failed', 'HTTP 200 ok with empty id is not saved')
eq(watchKeepHttpFace({ status: 200, body: { ok: false, id: 'live-a' }, sessionId: 'live-a' }), 'failed', 'HTTP 200 ok=false is failed')
eq(watchKeepHttpFace({ status: 405, body: { ok: true, id: 'live-a' }, sessionId: 'live-a' }), 'failed', '405 is failed')
eq(watchKeepHttpFace({ status: 401, body: null, sessionId: 'live-a' }), 'failed', '401 is failed')
eq(watchKeepHttpFace({ status: 404, body: null, sessionId: 'live-a' }), 'failed', '404 is failed')
eq(watchKeepHttpFace({ status: 500, body: null, sessionId: 'live-a' }), 'failed', '500 is failed')
eq(watchNativeSaveReduce({ current: 'saved', incoming: 'failed' }), 'saved', 'saved does not roll back to failed')
eq(watchNativeSaveReduce({ current: 'saved', incoming: 'local' }), 'saved', 'saved does not roll back to local')
eq(watchNativeSaveReduce({ current: 'local', incoming: 'saved' }), 'saved', 'local upgrades to saved')
eq(watchSaveTimeoutMs(), 15_000, 'Watch Save times out at 15s')
eq(watchSaveStatusPayload({ status: 'undecided', liveId: 'live-a' }).save, 'none', 'undecided is not a Watch save face')
eq(watchSaveStatusPayload({ status: 'undecided', liveId: 'live-a', localHeld: true }).save, 'local', 'phone persist is local, not History')
eq(watchSaveStatusPayload({ status: 'saved', liveId: 'live-a', localHeld: true }).save, 'saved', 'matching history_kept is History')
eq(watchSaveStatusPayload({ status: 'saving', liveId: 'live-a' }).save, 'saving', 'saving is pushed to the Watch')
eq(watchSaveStatusPayload({ status: 'saving', liveId: 'live-a' }).sessionId, 'live-a', 'sessionId rides with save')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'saved', incomingSessionId: 'live-a' }), 'saved', 'matching ack is saved')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'saved', incomingSessionId: 'live-b' }), 'ignore', 'old session id must not save the current request')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'saved', incomingSessionId: '' }), 'ignore', 'empty sessionId is not a wildcard')
eq(watchSaveAckApplies({ requestedId: '', incomingSave: 'saved', incomingSessionId: 'live-a' }), 'ignore', 'empty request id is not a wildcard')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'failed', incomingSessionId: 'live-a' }), 'failed', 'matching failed is Couldn\'t save')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'local', incomingSessionId: 'live-a' }), 'local', 'phone persist while saving is local, not History')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'local', incomingSessionId: 'live-b' }), 'ignore', 'local for another session is ignored')
eq(watchSaveRepeatAction({ kept: false, status: 'undecided' }), 'start', 'first Watch Save starts keep_history')
eq(watchSaveRepeatAction({ kept: false, status: 'saving' }), 'ignore', 'saving Watch Save is not sent twice')
eq(watchSaveRepeatAction({ kept: true, status: 'saved' }), 'echoSaved', 'already kept session echoes saved')
eq(watchSaveRepeatAction({ kept: false, status: 'failed' }), 'start', 'failed Watch Save may Retry')

eq(watchDiscardCommand(), { type: 'discard_history' }, 'Don\'t save discards on the server')
eq(watchDiscardCommand('sess-a'), { type: 'discard_history', id: 'sess-a' }, 'Don\'t save pins this session, not the next live one')
eq(watchSaveCommand('live-a').type, 'keep_history', 'Save is not start_listen')
eq(watchDiscardCommand().type, 'discard_history', 'Discard is not start_listen')
eq(watchSavedAckMs(), 2000, 'saved ack returns to Ready by itself')

eq(keepShouldWaitForNotes('ask-1'), true, 'phone Save still waits for in-flight Notes')
eq(watchKeepNotesWait(true, 'ask-1'), false, 'Watch Save with Notes in flight does not wait')
eq(watchKeepNotesWait(false, 'ask-1'), true, 'phone Save with Notes in flight still waits')

{
  const book = beginSave(emptySaveBook(), 'live-a')
  const pending = { content: true, audio: true, waitNotes: watchKeepNotesWait(false, 'ask-1') }
  eq(pending.waitNotes, true, 'phone pending keep waits Notes')
  const { send, parkNotes } = flushPendingKeepMessage({
    pending,
    liveId: book.liveId,
    status: book.status,
    notesAskId: 'ask-1',
  })
  eq(parkNotes, true, 'phone keep is parked for Notes')
  eq(send, null, 'phone keep_history is not sent while Notes run')
}

{
  const book = beginSave(emptySaveBook(), 'live-a')
  const pending = { content: true, audio: true, waitNotes: watchKeepNotesWait(true, 'ask-1') }
  eq(pending.waitNotes, false, 'Watch pending keep does not set waitNotes')
  const { send, parkNotes } = flushPendingKeepMessage({
    pending,
    liveId: book.liveId,
    status: book.status,
    notesAskId: 'ask-1',
  })
  eq(parkNotes, false, 'Watch keep is not parked for Notes')
  eq(send, { type: 'keep_history', content: true, audio: true, id: 'live-a' }, 'Watch keep_history is sent with the bound id while Notes run')
  eq(watchSaveStatusPayload({ status: book.status, liveId: book.liveId }).save, 'saving', 'sending keep is not Saved')
}

{
  const book = beginSave(emptySaveBook(), '')
  const pending = { content: true, audio: true, waitNotes: watchKeepNotesWait(true, 'ask-1') }
  const before = flushPendingKeepMessage({
    pending,
    liveId: book.liveId,
    status: book.status,
    notesAskId: 'ask-1',
  })
  eq(before.send, null, 'Watch keep waits for liveId, not Notes')
  const bound = bindLiveId(book, 'live-a')
  const after = flushPendingKeepMessage({
    pending,
    liveId: bound.liveId,
    status: bound.status,
    notesAskId: 'ask-1',
  })
  eq(after.send, { type: 'keep_history', content: true, audio: true, id: 'live-a' }, 'delayed liveId still sends keep_history with id and no Notes wait')
}

{
  let book = beginSave(emptySaveBook(), 'live-a')
  const push = watchSaveStatusPayload({ status: book.status, liveId: book.liveId })
  eq(push, { save: 'saving', sessionId: 'live-a' }, 'status chain carries saving + sessionId')
  const stale = applyKeepAck(book, 'live-b', book.liveId, book.generation)
  eq(stale.book.status, 'saving', 'stale history_kept does not mark saved')
  eq(watchApplySavePayload({
    saving: true,
    requestId: 'live-a',
    payload: { save: 'saved', sessionId: 'live-b' },
  }).ack, 'ignore', 'old session status must not Saved the current request')
  const { book: saved } = applyKeepAck(book, 'live-a', book.liveId, book.generation)
  eq(saved.status, 'saved', 'matching history_kept marks saved')
  const face = watchSaveStatusPayload({ status: saved.status, liveId: saved.liveId })
  eq(face, { save: 'saved', sessionId: 'live-a' }, 'status chain carries saved + sessionId')
  eq(watchApplySavePayload({
    saving: true,
    requestId: 'live-a',
    payload: { ok: true, save: 'local', sessionId: 'live-a' },
  }).ack, 'local', 'WatchBridge ok-reply applies matching local without WKWebView')
}

{
  eq(watchSaveWireMessage(''), null, 'Save without sessionId must not go on the wire')
  eq(
  watchSaveWireMessage('live-a'),
  { action: 'save', sessionId: 'live-a' },
  'Save message carries the pinned sessionId',
)
eq(
  watchSaveWireMessage('live-a', 'cap-a'),
  { action: 'save', sessionId: 'live-a', captureId: 'cap-a' },
  'Save message pins captureId with sessionId',
)
  eq(watchCommandFromBridge({ action: 'save' }), { action: 'save', sessionId: '' }, 'Bridge command with no sessionId stays empty')
  eq(
    watchCommandFromBridge(watchSaveWireMessage('live-a')!),
    { action: 'save', sessionId: 'live-a' },
    'Watch send → Bridge command keeps the same sessionId',
  )
  eq(
    watchSaveKeepTarget({
      requestedId: watchCommandFromBridge({ action: 'save' }).sessionId,
      liveId: 'live-b',
    }).keepId,
    null,
    'missing sessionId must not save the current phone session',
  )
}

{
  const pinned = watchSavePinnedId({ pinnedId: '', phoneSessionId: 'live-a' })
  eq(pinned, 'live-a', 'first Save pins the phone session id')
  eq(watchSavePinnedId({ pinnedId: pinned, phoneSessionId: 'live-b' }), 'live-a', 'Retry keeps the first pin, not the current phone session')
  const late = watchSavePinIncoming({ saving: true, pinnedId: '', incomingSessionId: 'live-a' })
  eq(late, { pinnedId: 'live-a', send: true }, 'empty first Save waits, then sends once the id arrives')
  eq(
    watchSavePinIncoming({ saving: true, pinnedId: 'live-a', incomingSessionId: 'live-b' }),
    { pinnedId: 'live-a', send: false },
    'a later phone sessionId must not replace the pin or send a second Save',
  )
  eq(
    watchApplySavePayload({
      saving: true,
      requestId: '',
      payload: { ok: true, save: 'saved', sessionId: 'live-a' },
    }).ack,
    'ignore',
    'unpinned Save must not complete Saved from a late status id',
  )
}

{
  const pinned = watchSavePinnedId({ pinnedId: '', phoneSessionId: 'live-a' })
  const delayed = watchCommandFromBridge(watchSaveWireMessage(pinned)!)
  const phoneNow = 'live-b'
  const target = watchSaveKeepTarget({ requestedId: delayed.sessionId, liveId: phoneNow })
  eq(target, { keepId: 'live-a', adopt: false }, 'delayed Save after the phone switched still targets the original id')
  const keep = keepHistoryMessage({ content: true, audio: true, id: target.keepId || undefined })
  eq(keep.id, 'live-a', 'phone keep_history uses the Watch id, not the current session')
  eq(keep.id === phoneNow, false, 'switched session is not kept')
  const retryPin = watchSavePinnedId({ pinnedId: pinned, phoneSessionId: phoneNow })
  const retry = watchCommandFromBridge(watchSaveWireMessage(retryPin)!)
  eq(retry.sessionId, 'live-a', 'Retry wire still names the original id')
  eq(
    watchSaveKeepTarget({ requestedId: retry.sessionId, liveId: phoneNow }),
    { keepId: 'live-a', adopt: false },
    'Retry after a switch still keeps the original id',
  )
}

{
  let book = beginSave(emptySaveBook(), 'live-a')
  eq(watchSaveRepeatAction({ kept: false, status: book.status }), 'ignore', 'saving Watch Save is not sent twice')
  book = applyKeepFailed(book, 'timeout')
  const failFace = watchSaveStatusPayload({ status: book.status, liveId: book.liveId })
  eq(failFace.save, 'failed', 'timeout pushes failed on the status chain')
  eq(watchApplySavePayload({
    saving: true,
    requestId: 'live-a',
    payload: failFace,
  }).ack, 'failed', 'Watch maps matching failed to Couldn\'t save')
  eq(watchSaveRepeatAction({ kept: false, status: book.status }), 'start', 'failed Watch Save may Retry')
  const retryId = watchSavePinnedId({ pinnedId: 'live-a', phoneSessionId: book.liveId || '' })
  book = beginSave(book, retryId)
  const retried = keepHistoryMessage({ content: true, audio: true, id: retryId })
  eq(retried.id, 'live-a', 'Retry keep_history stays on the pinned id')
}

{
  const book = { ...beginSave(emptySaveBook(), 'live-a'), status: 'saved' as const }
  eq(watchSaveRepeatAction({ kept: true, status: book.status }), 'echoSaved', 'already kept session echoes saved')
  eq(watchSaveStatusPayload({ status: 'saved', liveId: book.liveId }), { save: 'saved', sessionId: 'live-a' }, 'echo pushes real saved, not a tap')
  eq(watchSaveStatusPayload({ status: 'undecided', liveId: 'live-a' }).save, 'none', 'historyKept alone must not forge a saved status face')
}

{
  const nativeSaves: Record<string, 'local' | 'saved' | 'failed'> = { 'live-a': 'saved' }
  let book = beginSave(emptySaveBook(), 'live-b')
  const native = watchFailKeepNativeFace({ failingSessionId: book.liveId || '', nativeSaves })
  eq(native, '', 'B timeout does not read A native saved')
  eq(watchJsFailMayApply(native), true, 'B phone Save timeout is not swallowed by A saved')
  book = applyKeepFailed(book, 'timeout')
  eq(book.status, 'failed', 'B phone Save timeout surfaces failed')
  eq(
    watchFailKeepNativeFace({ failingSessionId: 'live-b', nativeSaves: { 'live-b': 'local' } }),
    'local',
    'B failKeep looks up B only',
  )
}

console.log('watchSave.test.ts ok')
