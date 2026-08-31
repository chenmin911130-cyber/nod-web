import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './native'

type WatchCommand = { action?: string }
type WatchPcm = { data?: string }

type WatchHistItem = { id: string; title: string; text: string }

type WatchPlugin = {
  ready(): Promise<void>
  setStatus(opts: {
    listening: boolean
    hint?: string
    original?: string
    translation?: string
    history?: WatchHistItem[]
  }): Promise<void>
  shareFile(opts: { data: string; name: string }): Promise<void>
  playSpeech(opts: { data: string }): Promise<void>
  addListener(event: 'command', cb: (ev: WatchCommand) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'pcm', cb: (ev: WatchPcm) => void): Promise<{ remove: () => Promise<void> }>
}

const NodWatch = registerPlugin<WatchPlugin>('NodWatch')

let preferWatchMic = false
let pcmSink: ((buf: ArrayBuffer) => void) | null = null
const preRoll: ArrayBuffer[] = []

export function watchAction(raw: unknown): 'start' | 'stop' | 'record' | 'pause' | 'resume' | 'speak' | 'tts_live' | 'tts_tap' | 'tts_female' | 'tts_male' | '' {
  return raw === 'start' || raw === 'stop' || raw === 'record' || raw === 'pause' || raw === 'resume' || raw === 'speak' || raw === 'tts_live' || raw === 'tts_tap' || raw === 'tts_female' || raw === 'tts_male' ? raw : ''
}

export function isWatchMicPreferred(): boolean {
  return preferWatchMic
}

export function setPreferWatchMic(on: boolean): void {
  preferWatchMic = on
  if (!on) preRoll.length = 0
}

export function setWatchPcmSink(fn: ((buf: ArrayBuffer) => void) | null): void {
  pcmSink = fn
  if (!fn) return
  while (preRoll.length) {
    const next = preRoll.shift()
    if (next) fn(next)
  }
}

function base64ToPcm(data: string): ArrayBuffer {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function deliverPcm(data: string): void {
  if (!data) return
  const pcm = base64ToPcm(data)
  if (!pcm.byteLength) return
  if (pcmSink) {
    pcmSink(pcm)
    return
  }
  if (preferWatchMic) {
    preRoll.push(pcm)
    if (preRoll.length > 24) preRoll.shift()
  }
}

export function installWatchRemote(handlers: {
  onStart: () => void
  onStop: () => void
  onRecord: () => void
  onPause: () => void
  onResume: () => void
  onSpeak: () => void
  onTtsLive: () => void
  onTtsTap: () => void
  onTtsVoice: (voice: 'male' | 'female') => void
}): () => void {
  if (!isNativeApp()) return () => undefined
  let gone = false
  const handles: Array<{ remove: () => Promise<void> }> = []
  void (async () => {
    await NodWatch.ready()
    const command = await NodWatch.addListener('command', (ev) => {
      if (gone) return
      const action = watchAction(ev.action)
      if (action === 'start') {
        setPreferWatchMic(true)
        handlers.onStart()
      }
      if (action === 'record') {
        setPreferWatchMic(true)
        handlers.onRecord()
      }
      if (action === 'pause') {
        handlers.onPause()
      }
      if (action === 'resume') {
        setPreferWatchMic(true)
        handlers.onResume()
      }
      if (action === 'stop') {
        handlers.onStop()
        setPreferWatchMic(false)
      }
      if (action === 'speak') handlers.onSpeak()
      if (action === 'tts_live') handlers.onTtsLive()
      if (action === 'tts_tap') handlers.onTtsTap()
      if (action === 'tts_female') handlers.onTtsVoice('female')
      if (action === 'tts_male') handlers.onTtsVoice('male')
    })
    const pcm = await NodWatch.addListener('pcm', (ev) => {
      if (gone) return
      setPreferWatchMic(true)
      deliverPcm(ev.data || '')
    })
    handles.push(command, pcm)
  })().catch(() => undefined)
  return () => {
    gone = true
    handles.forEach((h) => {
      void h.remove()
    })
  }
}

export function pushWatchStatus(face: {
  listening: boolean
  hint?: string
  original?: string
  translation?: string
  history?: WatchHistItem[]
}): void {
  if (!isNativeApp()) return
  void NodWatch.setStatus({
    listening: face.listening,
    hint: (face.hint || '').slice(0, 140),
    original: (face.original || '').slice(0, 400),
    translation: (face.translation || '').slice(0, 400),
    history: (face.history || []).slice(0, 8),
  }).catch(() => undefined)
}

export async function playWatchSpeech(bytes: Uint8Array): Promise<void> {
  if (!isNativeApp() || !bytes.byteLength) return
  const chunks: string[] = []
  const step = 8192
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)))
  }
  await NodWatch.playSpeech({ data: btoa(chunks.join('')) })
}

export async function shareNativeFile(bytes: Uint8Array, name: string): Promise<void> {
  if (!isNativeApp()) throw new Error('Share is only available in the iPhone app')
  const chunks: string[] = []
  const step = 8192
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)))
  }
  await NodWatch.shareFile({ data: btoa(chunks.join('')), name })
}
