import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './native'

type WatchCommand = { action?: string }
type WatchPcm = { data?: string }

type WatchPlugin = {
  ready(): Promise<void>
  setStatus(opts: { listening: boolean; hint?: string }): Promise<void>
  addListener(event: 'command', cb: (ev: WatchCommand) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'pcm', cb: (ev: WatchPcm) => void): Promise<{ remove: () => Promise<void> }>
}

const NodWatch = registerPlugin<WatchPlugin>('NodWatch')

let preferWatchMic = false
let pcmSink: ((buf: ArrayBuffer) => void) | null = null
const preRoll: ArrayBuffer[] = []

export function watchAction(raw: unknown): 'start' | 'stop' | '' {
  return raw === 'start' || raw === 'stop' ? raw : ''
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

export function installWatchRemote(handlers: { onStart: () => void; onStop: () => void }): () => void {
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
      if (action === 'stop') {
        handlers.onStop()
        setPreferWatchMic(false)
      }
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

export function pushWatchStatus(listening: boolean, hint = ''): void {
  if (!isNativeApp()) return
  void NodWatch.setStatus({ listening, hint: hint.slice(0, 140) }).catch(() => undefined)
}
