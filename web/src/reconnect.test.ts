import { reconnectStep, shouldKeepReconnecting } from './reconnect'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(shouldKeepReconnecting({ hasUplinkToken: false, lastRun: 'off' }), false, 'idle without token')
eq(shouldKeepReconnecting({ hasUplinkToken: true, lastRun: 'off' }), true, 'token while idle')
eq(shouldKeepReconnecting({ hasUplinkToken: false, lastRun: 'listening' }), true, 'listening')
eq(shouldKeepReconnecting({ hasUplinkToken: false, lastRun: 'recording' }), true, 'recording')
eq(shouldKeepReconnecting({ hasUplinkToken: false, lastRun: 'paused' }), true, 'paused')

eq(
  reconnectStep({ retries: 12, authExpired: true, keepTrying: true, random: 0 }).giveUp,
  true,
  'authExpired gives up at 12 even when keepTrying',
)

for (let retries = 0; retries <= 50; retries += 1) {
  for (const random of [0, 1]) {
    const { giveUp, delayMs } = reconnectStep({ retries, authExpired: false, keepTrying: true, random })
    eq(giveUp, false, `keepTrying retries=${retries} random=${random} giveUp`)
    if (delayMs > 10_000) {
      throw new Error(`keepTrying retries=${retries} random=${random}: delayMs ${delayMs} > 10000`)
    }
  }
}

eq(reconnectStep({ retries: 12, authExpired: false, keepTrying: false, random: 0 }).giveUp, true, 'idle browser gives up at 12')

eq(reconnectStep({ retries: 0, authExpired: true, keepTrying: true, random: 0 }).delayMs, 2_000, 'authExpired delay')

const first = reconnectStep({ retries: 0, authExpired: false, keepTrying: false, random: 1 })
if (first.delayMs > 1_300) {
  throw new Error(`retries=0 delayMs ${first.delayMs} > 1300`)
}

console.log('ok')
