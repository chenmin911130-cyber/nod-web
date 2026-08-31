/** After native start, give NodMic + the web fallback time to produce PCM. */
export const MIC_SILENCE_GRACE_MS = 4000

export function micSilenceShouldWarn(opts: {
  listening: boolean
  pcmBytes: number
  elapsedMs: number
  graceMs?: number
}): boolean {
  if (!opts.listening) return false
  if (opts.pcmBytes > 0) return false
  return opts.elapsedMs >= (opts.graceMs ?? MIC_SILENCE_GRACE_MS)
}
