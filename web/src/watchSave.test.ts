import {
  watchDiscardCommand,
  watchSaveCommand,
  watchSavedAckMs,
  watchStopShouldAutoKeepHistory,
  watchStopShouldOpenPhoneSave,
} from './watchSave'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(watchStopShouldAutoKeepHistory(), false, 'Watch Stop must not silently keep History')
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
eq(watchSavedAckMs(), 2000, 'saved ack returns to Ready by itself')
