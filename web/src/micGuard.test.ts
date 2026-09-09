import { MIC_SILENCE_GRACE_MS, micSilenceShouldWarn } from './micGuard'

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

if (micSilenceShouldWarn({ listening: true, pcmBytes: 320, elapsedMs: 8000 })) {
  throw new Error('any PCM means the capture path is alive')
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
