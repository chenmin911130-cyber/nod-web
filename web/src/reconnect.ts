export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
export const RECONNECT_MAX_TRIES = 12
export const RECONNECT_KEEP_CAP_MS = 10_000

export function reconnectStep(opts: {
  retries: number
  authExpired: boolean
  keepTrying: boolean
  random: number
}): { giveUp: boolean; delayMs: number } {
  const { retries, authExpired, keepTrying, random } = opts
  if (!keepTrying && retries >= RECONNECT_MAX_TRIES) {
    return { giveUp: true, delayMs: 0 }
  }
  if (authExpired) {
    return { giveUp: false, delayMs: 2_000 }
  }
  const step = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retries)
  let delayMs = Math.round(step * (0.7 + random * 0.6))
  if (keepTrying) {
    delayMs = Math.min(delayMs, RECONNECT_KEEP_CAP_MS)
  }
  return { giveUp: false, delayMs }
}
