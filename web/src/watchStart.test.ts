import { watchBlockedReason, watchStartOutcome } from './watch'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(watchStartOutcome({ capture: 'listening', blocked: '', waitedMs: 0 }), 'started', 'listening is started')
eq(watchStartOutcome({ capture: 'recording', blocked: 'signin', waitedMs: 8000 }), 'started', 'real capture beats blocked and timeout')
eq(watchStartOutcome({ capture: 'off', blocked: 'signin', waitedMs: 200 }), 'blocked:signin', 'signin blocks start')
eq(watchStartOutcome({ capture: 'off', blocked: 'quota', waitedMs: 9000 }), 'blocked:quota', 'blocked beats timeout')
eq(watchStartOutcome({ capture: 'off', blocked: '', waitedMs: 8000 }), 'timeout', '8s without capture is timeout')
eq(watchStartOutcome({ capture: 'paused', blocked: '', waitedMs: 1000 }), 'waiting', 'paused is not a start confirm')
eq(watchStartOutcome({ capture: 'off', blocked: '', waitedMs: 7999 }), 'waiting', 'under 8s still waiting')
eq(
  watchStartOutcome({ capture: 'off', blocked: '', waitedMs: 8000, recorderRunning: true }),
  'waiting',
  'wrist already recording waits past 8s for phone listening',
)
eq(
  watchStartOutcome({ capture: 'off', blocked: '', waitedMs: 20_000, recorderRunning: true }),
  'timeout',
  'watch-mic Start still times out at 20s',
)

eq(watchBlockedReason({ signIn: true, consentOpen: true, quotaOk: false }), 'signin', 'signin wins over consent and quota')
eq(watchBlockedReason({ signIn: false, consentOpen: true, quotaOk: false }), 'consent', 'consent wins over quota')
eq(watchBlockedReason({ signIn: false, consentOpen: false, quotaOk: false }), 'quota', 'quota when nothing else')
eq(watchBlockedReason({ signIn: false, consentOpen: false, quotaOk: true }), '', 'clear when signed in and under quota')
