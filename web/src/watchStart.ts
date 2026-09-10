export type WatchStartOutcome = 'started' | 'waiting' | 'timeout'

const START_WAIT_MS = 8000

/** Mirror of WatchPhoneSession.startOutcome. Phone capture wins until 8s. */
export function watchStartOutcome(capture: string, waitedMs: number, pcmReady = true): WatchStartOutcome {
  if ((capture === 'listening' || capture === 'recording') && pcmReady) return 'started'
  if (waitedMs >= START_WAIT_MS) return 'timeout'
  return 'waiting'
}
