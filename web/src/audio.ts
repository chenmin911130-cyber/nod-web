import { isNativeApp } from './native'
import { isWatchMicPreferred } from './watch'
import type { PluginListenerHandle } from '@capacitor/core'

const TARGET_SR = 16000

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

function downsample(input: Float32Array, fromSr: number): ArrayBuffer {
  if (!fromSr || Math.abs(fromSr - TARGET_SR) < 1) return floatToPcm16(input)
  const ratio = fromSr / TARGET_SR
  const outLen = Math.floor(input.length / ratio)
  if (outLen <= 0) return new ArrayBuffer(0)
  // 一阶低通（-3dB @ ~7kHz），防止降采样把 8kHz+ 高频折叠（混叠）进语音频段
  const dt = 1 / fromSr
  const alpha = dt / (1 / (2 * Math.PI * 7000) + dt)
  const filtered = new Float32Array(input.length)
  let y = 0
  for (let i = 0; i < input.length; i++) {
    y += alpha * (input[i] - y)
    filtered[i] = y
  }
  const sampled = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    sampled[i] = filtered[Math.min(input.length - 1, Math.floor(i * ratio))]
  }
  return floatToPcm16(sampled)
}

function base64ToPcm(data: string): ArrayBuffer {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
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
  onPcm: (buf: ArrayBuffer) => void = () => undefined

  // Counts as active while acquiring too, otherwise a second caller sees an
  // idle mic and opens a competing getUserMedia.
  get active(): boolean {
    return this.running || this.starting !== null
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.acquire().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async acquire(): Promise<void> {
    const seq = this.stopSeq
    try {
      if (isNativeApp()) {
        if (isWatchMicPreferred()) {
          this.running = true
          return
        }
        await this.acquireNative(seq)
        return
      }
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
        const pcm = downsample(input, ctx.sampleRate)
        if (pcm.byteLength) this.onPcm(pcm)
      }
      source.connect(proc)
      proc.connect(gain)
      gain.connect(ctx.destination)
      this.source = source
      this.proc = proc
      this.gain = gain
      this.running = true
    } catch (err) {
      this.release()
      throw err
    }
  }

  private async acquireNative(seq: number): Promise<void> {
    const { NodMic } = await import('nod-mic')
    this.nativeHandle = await NodMic.addListener('pcm', (ev) => {
      if (!this.running) return
      const pcm = base64ToPcm(ev.data || '')
      if (pcm.byteLength) this.onPcm(pcm)
    })
    await NodMic.start()
    if (seq !== this.stopSeq) {
      this.release()
      return
    }
    this.running = true
  }

  private release(): void {
    this.running = false
    const handle = this.nativeHandle
    this.nativeHandle = null
    if (handle) {
      void handle.remove()
      void import('nod-mic').then(({ NodMic }) => NodMic.stop()).catch(() => undefined)
    }
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
