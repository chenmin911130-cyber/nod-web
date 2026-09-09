import { keepShouldWaitForNotes } from './recordReport'
import { applyKeepAck, applyKeepFailed, beginSave, bindLiveId, emptySaveBook } from './sessionSave'
import {
  flushPendingKeepMessage,
  keepHistoryMessage,
  watchApplySavePayload,
  watchDiscardCommand,
  watchKeepNotesWait,
  watchSaveAckApplies,
  watchSaveCommand,
  watchSaveRepeatAction,
  watchSaveRequestIdAfterSession,
  watchSaveShouldWaitForNotes,
  watchSaveStatusPayload,
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
  watchSaveCommand(),
  { type: 'keep_history', content: true, audio: true },
  'Save goes through the server keep_history command',
)
eq(
  watchSaveCommand('live-a'),
  { type: 'keep_history', content: true, audio: true, id: 'live-a' },
  'Watch Save names the bound session id',
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
eq(watchSaveTimeoutMs(), 15_000, 'Watch Save times out at 15s')
eq(watchSaveStatusPayload({ status: 'undecided', liveId: 'live-a' }).save, 'none', 'undecided is not a Watch save face')
eq(watchSaveStatusPayload({ status: 'saving', liveId: 'live-a' }).save, 'saving', 'saving is pushed to the Watch')
eq(watchSaveStatusPayload({ status: 'saving', liveId: 'live-a' }).sessionId, 'live-a', 'sessionId rides with save')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'saved', incomingSessionId: 'live-a' }), 'saved', 'matching ack is saved')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'saved', incomingSessionId: 'live-b' }), 'ignore', 'old session id must not save the current request')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'saved', incomingSessionId: '' }), 'ignore', 'empty sessionId is not a wildcard')
eq(watchSaveAckApplies({ requestedId: '', incomingSave: 'saved', incomingSessionId: 'live-a' }), 'ignore', 'empty request id is not a wildcard')
eq(watchSaveAckApplies({ requestedId: 'live-a', incomingSave: 'failed', incomingSessionId: 'live-a' }), 'failed', 'matching failed is Couldn\'t save')
eq(watchSaveRepeatAction({ kept: false, status: 'undecided' }), 'start', 'first Watch Save starts keep_history')
eq(watchSaveRepeatAction({ kept: false, status: 'saving' }), 'ignore', 'saving Watch Save is not sent twice')
eq(watchSaveRepeatAction({ kept: true, status: 'saved' }), 'echoSaved', 'already kept session echoes saved')
eq(watchSaveRepeatAction({ kept: false, status: 'failed' }), 'start', 'failed Watch Save may Retry')

eq(watchDiscardCommand(), { type: 'discard_history' }, 'Don\'t save discards on the server')
eq(watchSaveCommand().type, 'keep_history', 'Save is not start_listen')
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
    payload: { ok: true, save: face.save, sessionId: face.sessionId },
  }).ack, 'saved', 'WatchBridge ok-reply still applies matching saved')
}

{
  eq(watchSaveRequestIdAfterSession({ saving: true, requestId: '', incomingSessionId: 'live-a' }), 'live-a', 'in-flight Watch Save latches a late sessionId')
  eq(watchApplySavePayload({
    saving: true,
    requestId: '',
    payload: { ok: true, save: 'saved', sessionId: 'live-a' },
  }).ack, 'saved', 'late sessionId on an ok-reply can complete Saved')
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
  book = beginSave(book, 'live-a')
  const retried = keepHistoryMessage({ content: true, audio: true, id: book.liveId || undefined })
  eq(retried.id, 'live-a', 'Retry keep_history stays on the same id')
}

{
  const book = { ...beginSave(emptySaveBook(), 'live-a'), status: 'saved' as const }
  eq(watchSaveRepeatAction({ kept: true, status: book.status }), 'echoSaved', 'already kept session echoes saved')
  eq(watchSaveStatusPayload({ status: 'saved', liveId: book.liveId }), { save: 'saved', sessionId: 'live-a' }, 'echo pushes real saved, not a tap')
  eq(watchSaveStatusPayload({ status: 'undecided', liveId: 'live-a' }).save, 'none', 'historyKept alone must not forge a saved status face')
}

console.log('watchSave.test.ts ok')
