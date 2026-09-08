import { watchOffShouldStopRecorder } from './watch'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(
  watchOffShouldStopRecorder({
    starting: true,
    listening: false,
    paused: false,
    recorderRunning: true,
  }),
  false,
  'stale off during local Start must not stop the Watch recorder',
)
eq(
  watchOffShouldStopRecorder({
    starting: false,
    listening: true,
    paused: false,
    recorderRunning: false,
  }),
  true,
  'confirmed off while listening stops the recorder',
)
eq(
  watchOffShouldStopRecorder({
    starting: false,
    listening: false,
    paused: false,
    recorderRunning: false,
  }),
  false,
  'idle off is a no-op',
)
