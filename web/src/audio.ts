import { isNativeApp } from './native'
import { isWatchMicPreferred } from './watch'
import type { PluginListenerHandle } from '@capacitor/core'

const TARGET_SR = 16000
const NATIVE_SILENCE_MS = 1600

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

/** Web ScriptProcessor delivers 4096-sample blocks. State must survive each block. */
export class PcmDownsampler {
  private y = 0
  private leftover = new Float32Array(0)
  private phase = 0

  reset(): void {
    this.y = 0
    this.leftover = new Float32Array(0)
    this.phase = 0
  }

  push(input: Float32Array, fromSr: number): ArrayBuffer {
    if (!fromSr || Math.abs(fromSr - TARGET_SR) < 1) {
      this.reset()
      return floatToPcm16(input)
    }
    const ratio = fromSr / TARGET_SR
    const dt = 1 / fromSr
    const alpha = dt / (1 / (2 * Math.PI * 7000) + dt)
    const incoming = new Float32Array(input.length)
    let y = this.y
    for (let i = 0; i < input.length; i++) {
      y += alpha * (input[i] - y)
      incoming[i] = y
    }
    this.y = y

    const src = new Float32Array(this.leftover.length + incoming.length)
    src.set(this.leftover)
    src.set(incoming, this.leftover.length)

    const out: number[] = []
    let pos = this.phase
    while (pos + 1 < src.length) {
      const i0 = Math.floor(pos)
      const frac = pos - i0
      out.push(src[i0] * (1 - frac) + src[i0 + 1] * frac)
      pos += ratio
    }
    const keep = Math.min(src.length, Math.floor(pos))
    this.phase = pos - keep
    this.leftover = src.slice(keep)
    return floatToPcm16(Float32Array.from(out))
  }
}

function base64ToPcm(data: string): ArrayBuffer {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** Watch-only dummy start left `running` true with no capture. Phone Start must reopen. */
export function shouldReacquirePhoneMic(opts: {
  nativeApp: boolean
  running: boolean
  watchPreferred: boolean
  hasNativeHandle: boolean
  hasStream: boolean
}): boolean {
  return opts.nativeApp && opts.running && !opts.watchPreferred && !opts.hasNativeHandle && !opts.hasStream
}

/** Watch Translate / Live Q&A Start must drop the phone mic so the wrist is the only capture. */
export function shouldReleasePhoneMicForWatch(opts: {
  running: boolean
  watchPreferred: boolean
  hasPhoneCapture: boolean
}): boolean {
  return opts.running && opts.watchPreferred && opts.hasPhoneCapture
}

/** Watch-mic sessions keep the phone process alive without opening the phone mic. */
export function keepAliveShouldRun(opts: { nativeApp: boolean; watchPreferred: boolean }): boolean {
  return opts.nativeApp && opts.watchPreferred
}

/** Lock screen must not tear down native capture just because JS missed PCM. */
export function nativeFallbackShouldSwitch(opts: {
  hidden: boolean
  appActive?: boolean
  running: boolean
  hasStream: boolean
  uplinkActive?: boolean
}): boolean {
  if (opts.uplinkActive) return false
  if (opts.hidden) return false
  if (opts.appActive === false) return false
  return opts.running && !opts.hasStream
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private proc: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private gain: GainNode | null = null
  private nativeHandle: PluginListenerHandle | null = null
  private running = false
  private starting: Promise<void> | null = null
  // Bumped by stop() so an in-flight start() knows to release what it took
  // instead of leaving a live MediaStream with no reference to it.
  private stopSeq = 0
  private silenceTimer = 0
  private keepAlive = false
  private nativeTeardown: Promise<void> = Promise.resolve()
  private appActive = true
  private appStateBound = false
  private uplinkActive = false
  private resampler = new PcmDownsampler()
  onPcm: (buf: ArrayBuffer) => void = () => undefined
  onFallbackFailed: () => void = () => undefined

  // Counts as active while acquiring too, otherwise a second caller sees an
  // idle mic and opens a competing getUserMedia.
  get active(): boolean {
    return this.running || this.starting !== null
  }

  setUplinkActive(on: boolean): void {
    this.uplinkActive = on
    if (on) this.clearSilenceTimer()
  }

  start(): Promise<void> {
    const watchPreferred = isWatchMicPreferred()
    if (
      shouldReacquirePhoneMic({
        nativeApp: isNativeApp(),
        running: this.running,
        watchPreferred,
        hasNativeHandle: this.nativeHandle !== null,
        hasStream: this.stream !== null,
      }) ||
      shouldReleasePhoneMicForWatch({
        running: this.running,
        watchPreferred,
        hasPhoneCapture: this.nativeHandle !== null || this.stream !== null,
      })
    ) {
      this.release()
    }
    if (this.running) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.acquire().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async acquire(): Promise<void> {
    await this.nativeTeardown
    const seq = this.stopSeq
    try {
      if (isNativeApp()) {
        if (isWatchMicPreferred()) {
          if (keepAliveShouldRun({ nativeApp: true, watchPreferred: true })) {
            const { NodMic } = await import('nod-mic')
            await NodMic.startKeepAlive().catch(() => undefined)
            this.keepAlive = true
          }
          this.running = true
          return
        }
        try {
          await this.acquireNative(seq)
          return
        } catch {
          await this.acquireWeb(seq)
          return
        }
      }
      await this.acquireWeb(seq)
    } catch (err) {
      this.release()
      throw err
    }
  }

  private async acquireNative(seq: number): Promise<void> {
    await this.bindAppState()
    const { NodMic } = await import('nod-mic')
    const handle = await NodMic.addListener('pcm', (ev) => {
      const pcm = base64ToPcm(ev.data || '')
      if (!pcm.byteLength) return
      this.clearSilenceTimer()
      this.onPcm(pcm)
    })
    this.nativeHandle = handle
    try {
      await NodMic.start()
    } catch (err) {
      await handle.remove().catch(() => undefined)
      this.nativeHandle = null
      throw err
    }
    if (seq !== this.stopSeq) {
      this.release()
      return
    }
    this.running = true
    this.armSilenceFallback(seq)
  }

  private async acquireWeb(seq: number): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    if (seq !== this.stopSeq) {
      this.release()
      return
    }
    const source = ctx.createMediaStreamSource(this.stream)
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    const gain = ctx.createGain()
    gain.gain.value = 0
    proc.onaudioprocess = (ev) => {
      if (!this.running) return
      const input = ev.inputBuffer.getChannelData(0)
      const pcm = this.resampler.push(input, ctx.sampleRate)
      if (pcm.byteLength) this.onPcm(pcm)
    }
    source.connect(proc)
    proc.connect(gain)
    gain.connect(ctx.destination)
    this.source = source
    this.proc = proc
    this.gain = gain
    this.running = true
  }

  private async bindAppState(): Promise<void> {
    if (this.appStateBound || !isNativeApp()) return
    this.appStateBound = true
    try {
      const { App } = await import('@capacitor/app')
      const state = await App.getState()
      this.appActive = state.isActive
      await App.addListener('appStateChange', ({ isActive }) => {
        this.appActive = isActive
        if (isActive) void this.resumeNative()
      })
    } catch {
      this.appActive = true
    }
  }

  private async refreshAppState(): Promise<void> {
    if (!isNativeApp()) return
    try {
      const { App } = await import('@capacitor/app')
      this.appActive = (await App.getState()).isActive
    } catch {
      /* keep last known */
    }
  }

  private async resumeNative(): Promise<void> {
    if (!this.running) return
    try {
      const { NodMic } = await import('nod-mic')
      await NodMic.resume().catch(() => undefined)
    } catch {
      /* keep current capture */
    }
  }

  private pageIsBackground(): boolean {
    if (typeof document !== 'undefined' && document.hidden) return true
    return this.appActive === false
  }

  private armSilenceFallback(seq: number): void {
    if (this.uplinkActive) {
      this.clearSilenceTimer()
      return
    }
    this.clearSilenceTimer()
    this.silenceTimer = window.setTimeout(() => {
      void this.onNativeSilence(seq)
    }, NATIVE_SILENCE_MS)
  }

  private async onNativeSilence(seq: number): Promise<void> {
    if (seq !== this.stopSeq || !this.running || this.stream) return
    if (this.uplinkActive) return
    await this.refreshAppState()
    if (
      !nativeFallbackShouldSwitch({
        hidden: typeof document !== 'undefined' && document.hidden,
        appActive: this.appActive,
        running: this.running,
        hasStream: this.stream !== null,
        uplinkActive: this.uplinkActive,
      })
    ) {
      this.armSilenceFallback(seq)
      return
    }
    void this.switchNativeToWeb(seq)
  }

  private async switchNativeToWeb(seq: number): Promise<void> {
    if (this.uplinkActive) return
    await this.refreshAppState()
    if (this.pageIsBackground()) return
    const handle = this.nativeHandle
    this.nativeHandle = null
    if (handle) {
      await handle.remove().catch(() => undefined)
      const { NodMic } = await import('nod-mic')
      await NodMic.stop().catch(() => undefined)
    }
    if (seq !== this.stopSeq) return
    try {
      await this.acquireWeb(seq)
    } catch {
      this.release()
      this.onFallbackFailed()
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      window.clearTimeout(this.silenceTimer)
      this.silenceTimer = 0
    }
  }

  private release(): void {
    this.clearSilenceTimer()
    this.resampler.reset()
    this.running = false
    const jobs: Promise<void>[] = []
    if (this.keepAlive) {
      this.keepAlive = false
      jobs.push(import('nod-mic').then(({ NodMic }) => NodMic.stopKeepAlive()).then(() => undefined).catch(() => undefined))
    }
    const handle = this.nativeHandle
    this.nativeHandle = null
    if (handle) {
      jobs.push(
        handle
          .remove()
          .then(() => import('nod-mic'))
          .then(({ NodMic }) => NodMic.stop())
          .then(() => undefined)
          .catch(() => undefined),
      )
    }
    if (jobs.length) this.nativeTeardown = Promise.all(jobs).then(() => undefined)
    try {
      this.proc?.disconnect()
      this.source?.disconnect()
      this.gain?.disconnect()
    } catch {
      /* ignore */
    }
    this.proc = null
    this.source = null
    this.gain = null
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
  }

  stop(): void {
    this.stopSeq += 1
    this.release()
  }
}
