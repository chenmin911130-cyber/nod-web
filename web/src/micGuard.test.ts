import { MIC_SILENCE_GRACE_MS, micSilenceShouldWarn, pcmChunkHasVoice } from './micGuard'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`)
}

if (micSilenceShouldWarn({ listening: true, pcmBytes: 0, elapsedMs: 500 })) {
  throw new Error('must not warn during the native-mic grace period')
}

if (
  !micSilenceShouldWarn({
    listening: true,
    pcmBytes: 0,
    elapsedMs: MIC_SILENCE_GRACE_MS,
  })
) {
  throw new Error('listening with zero PCM after grace must warn so the UI cannot stay silent')
}

if (
  !micSilenceShouldWarn({
    listening: true,
    pcmBytes: 3200,
    sawVoice: false,
    elapsedMs: MIC_SILENCE_GRACE_MS,
  })
) {
  throw new Error('silent PCM bytes after grace must warn')
}

if (micSilenceShouldWarn({ listening: true, pcmBytes: 3200, sawVoice: true, elapsedMs: 8000 })) {
  throw new Error('voice in the stream must not warn')
}

if (micSilenceShouldWarn({ listening: false, pcmBytes: 0, elapsedMs: 8000 })) {
  throw new Error('idle must not warn about a silent microphone')
}

if (micSilenceShouldWarn({ listening: true, pcmBytes: 0, elapsedMs: 8000, watchPreferred: true })) {
  throw new Error('Watch-mic listen must not trip the iPhone silent-mic warning')
}

if (micSilenceShouldWarn({ listening: true, pcmBytes: 0, elapsedMs: 8000, uplinkActive: true })) {
  throw new Error('native uplink listen must not trip the JS silent-mic warning')
}

if (micSilenceShouldWarn({ listening: true, pcmBytes: 0, elapsedMs: MIC_SILENCE_GRACE_MS - 1 })) {
  throw new Error('must not warn before grace elapses')
}

const silent = new Uint8Array(640)
eq(pcmChunkHasVoice(silent.buffer), false, 'all-zero chunk has no voice')

const loud = new Uint8Array(4)
loud[0] = 0x21
loud[1] = 0x04 // little-endian 0x0421 = 1057 > 800
eq(pcmChunkHasVoice(loud), true, 'peak above threshold counts as voice')

const atThreshold = new Uint8Array(4)
atThreshold[0] = 0x20
atThreshold[1] = 0x03 // 0x0320 = 800
eq(pcmChunkHasVoice(atThreshold), false, 'peak 800 is not voice')

const lateVoice = new Uint8Array(3300)
lateVoice[3202] = 0xff
lateVoice[3203] = 0x07
eq(pcmChunkHasVoice(lateVoice), false, 'voice after first 3200 bytes is ignored')

eq(pcmChunkHasVoice(new Uint8Array(1)), false, 'odd single byte is not voice')

console.log('micGuard.test.ts ok')
