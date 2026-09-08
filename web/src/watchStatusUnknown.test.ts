import { watchStatusUnknown } from './watch'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(
  watchStatusUnknown({
    reachable: false,
    recorderRunning: true,
    listening: true,
    paused: false,
    ended: false,
    staleSec: 30,
  }),
  false,
  'Watch mic recording while unreachable is not unknown',
)
eq(
  watchStatusUnknown({
    reachable: false,
    recorderRunning: false,
    listening: true,
    paused: false,
    ended: false,
    staleSec: 2,
  }),
  true,
  'Meeting listening while unreachable is unknown',
)
eq(
  watchStatusUnknown({
    reachable: true,
    recorderRunning: false,
    listening: true,
    paused: false,
    ended: false,
    staleSec: 25,
  }),
  false,
  'Meeting listening + reachable + 25s stale is not unknown until probe fails',
)
eq(
  watchStatusUnknown({
    reachable: true,
    recorderRunning: false,
    listening: true,
    paused: false,
    ended: false,
    staleSec: 25,
    reconnectFailed: true,
  }),
  true,
  'Meeting listening + reachable + 25s stale + reconnectFailed is unknown',
)
eq(
  watchStatusUnknown({
    reachable: false,
    recorderRunning: false,
    listening: false,
    paused: false,
    ended: false,
    staleSec: 40,
  }),
  false,
  'Ready is never unknown',
)
eq(
  watchStatusUnknown({
    reachable: false,
    recorderRunning: false,
    listening: false,
    paused: false,
    ended: true,
    staleSec: 1,
  }),
  true,
  'ended while unreachable is unknown',
)
