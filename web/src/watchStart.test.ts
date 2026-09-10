import { watchStartOutcome } from './watchStart'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(watchStartOutcome('off', 0), 'waiting', 'off/0 → waiting')
eq(watchStartOutcome('listening', 500), 'started', 'listening/500 → started')
eq(watchStartOutcome('listening', 500, false), 'waiting', 'listening without persist-ready still waits')
eq(watchStartOutcome('off', 8000), 'timeout', 'off/8000 → timeout')
eq(watchStartOutcome('recording', 7999), 'started', 'recording/7999 → started')
