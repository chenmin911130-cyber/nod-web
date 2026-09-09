import {
  keepHistoryMessage,
  watchDiscardCommand,
  watchSaveAckApplies,
  watchSaveCommand,
  watchSaveRepeatAction,
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

console.log('watchSave.test.ts ok')
