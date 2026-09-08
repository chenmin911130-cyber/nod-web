import {
  watchDiscardCommand,
  watchSaveCommand,
  watchSaveView,
  watchSaveWireStatus,
  watchStopShouldAutoKeepHistory,
  watchStopShouldOpenPhoneSave,
} from './watchSave'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(watchStopShouldAutoKeepHistory(), false, 'Watch Stop must not silently keep History')
eq(watchStopShouldAutoKeepHistory(true), false, 'Watch-started sessions no longer auto-keep on save_prompt')
eq(watchStopShouldOpenPhoneSave(), false, 'Watch Stop must not open the iPhone Save dialog')

eq(
  watchSaveCommand(),
  { type: 'keep_history', content: true, audio: true },
  'Save goes through the server keep_history command',
)
if ('keepRecording' in watchSaveCommand()) {
  throw new Error('Watch Save must not send a Keep recording checkbox')
}

eq(watchDiscardCommand(), { type: 'discard_history' }, 'Don\'t save discards on the server')
eq(watchSaveCommand().type, 'keep_history', 'Save is not start_listen')
eq(watchDiscardCommand().type, 'discard_history', 'Discard is not start_listen')
eq(watchSaveWireStatus('undecided'), 'none', 'undecided is none on the Watch wire')
eq(watchSaveWireStatus('saving'), 'saving', 'saving stays saving')
eq(watchSaveWireStatus('saved'), 'saved', 'saved stays saved so an already-kept Watch Save can push saved')
eq(watchSaveWireStatus('failed'), 'failed', 'failed stays failed')

eq(
  watchSaveView({ save: 'saved', sessionId: 'old', requestedId: 'new', waitedMs: 0 }),
  'idle',
  'a leftover history_kept for another session must not confirm Save',
)
eq(
  watchSaveView({ save: 'saving', sessionId: 'a', requestedId: 'a', waitedMs: 15_000 }),
  'failed',
  '15s with no matching saved ack is failed',
)
eq(
  watchSaveView({ save: 'saving', sessionId: 'a', requestedId: 'a', waitedMs: 1_000 }),
  'saving',
  'in-flight keep is saving',
)
eq(
  watchSaveView({ save: 'failed', sessionId: 'a', requestedId: 'a', waitedMs: 16_000 }),
  'failed',
  'failed stays failed until another save',
)
eq(
  watchSaveView({ save: 'saving', sessionId: 'a', requestedId: 'a', waitedMs: 500 }),
  'saving',
  'retry save returns to saving',
)
eq(
  watchSaveView({ save: 'saved', sessionId: 'a', requestedId: 'a', waitedMs: 500 }),
  'saved',
  'matching sessionId + saved is Saved',
)
eq(
  watchSaveView({ save: 'saved', sessionId: 'live-1', requestedId: '', waitedMs: 0 }),
  'saved',
  'phone Save with no wrist request still confirms when sessionId is set',
)
