import { watchFailStartShouldSendStop, watchOffShouldStopRecorder, watchShouldEnsureMic } from './watch'

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

eq(
  watchShouldEnsureMic({
    capture: 'listening',
    paused: false,
    localMic: true,
    recorderRunning: false,
  }),
  true,
  'Watch-mic session must reopen the recorder when listening and the mic is down',
)
eq(
  watchShouldEnsureMic({
    capture: 'listening',
    paused: false,
    localMic: false,
    recorderRunning: false,
  }),
  false,
  'phone-mic listening must not open the Watch recorder',
)
eq(
  watchShouldEnsureMic({
    capture: 'listening',
    paused: true,
    localMic: true,
    recorderRunning: false,
  }),
  false,
  'paused Watch-mic session stays off the recorder',
)
eq(
  watchShouldEnsureMic({
    capture: 'listening',
    paused: false,
    localMic: true,
    recorderRunning: true,
  }),
  false,
  'already recording is a no-op',
)
eq(watchFailStartShouldSendStop(true), true, 'failed Start must stop the in-flight phone listen')
eq(watchFailStartShouldSendStop(false), false, 'do not send stop if Start never went out')
