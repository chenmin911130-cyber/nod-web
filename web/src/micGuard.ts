/** After native start, give NodMic + the web fallback time to produce PCM. */
export const MIC_SILENCE_GRACE_MS = 4000

/** Mirrors server `_pcm_has_voice` (server/app.py) for 16 kHz PCM16 LE chunks. */
export function pcmChunkHasVoice(pcm: ArrayBuffer | Uint8Array): boolean {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const len = bytes.length
  if (len < 2) return false
  const limit = Math.min(len - 1, 3200)
  let peak = 0
  for (let i = 0; i < limit; i += 2) {
    const sample = bytes[i] | (bytes[i + 1] << 8)
    const signed = sample > 0x7fff ? sample - 0x10000 : sample
    const amp = signed >= 0 ? signed : -signed
    if (amp > peak) peak = amp
    if (peak > 800) return true
  }
  return false
}

export function micSilenceShouldWarn(opts: {
  listening: boolean
  pcmBytes: number
  elapsedMs: number
  graceMs?: number
  watchPreferred?: boolean
  uplinkActive?: boolean
  sawVoice?: boolean
}): boolean {
  if (!opts.listening) return false
  if (opts.watchPreferred) return false
  if (opts.uplinkActive) return false
  if (opts.sawVoice) return false
  return opts.elapsedMs >= (opts.graceMs ?? MIC_SILENCE_GRACE_MS)
}
