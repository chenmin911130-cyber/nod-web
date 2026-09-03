import { isRiffWav, nativeAudioHref } from './sessionExport'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

const wav = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
])
eq(isRiffWav(wav), true, 'real WAV starts with RIFF/WAVE')
eq(isRiffWav(new Uint8Array([0x3c, 0x45, 0x72, 0x72, 0x6f, 0x72])), false, 'R2 XML is not a WAV')
eq(isRiffWav(new Uint8Array([0x52, 0x49, 0x46, 0x46])), false, 'truncated RIFF is not a WAV')
eq(isRiffWav(new Uint8Array()), false, 'empty bytes are not a WAV')

eq(
  nativeAudioHref('/api/account/files/s1/audio?filename=a.wav'),
  '/api/account/files/s1/audio?filename=a.wav&proxy=1',
  'native download stays on our API instead of following the R2 redirect',
)
eq(
  nativeAudioHref('/api/account/files/s1/audio?filename=a.wav&proxy=1'),
  '/api/account/files/s1/audio?filename=a.wav&proxy=1',
  'do not add proxy twice',
)
eq(nativeAudioHref(''), '', 'empty href stays empty')
eq(
  nativeAudioHref('/api/account/files/s1/audio?filename=meet.wav'),
  '/api/account/files/s1/audio?filename=meet.wav&proxy=1',
  'web download also stays on our API so the browser is not sent to R2',
)
