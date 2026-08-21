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
  const sampled = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    sampled[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))]
  }
  return floatToPcm16(sampled)
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private proc: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private gain: GainNode | null = null
  private running = false
  onPcm: (buf: ArrayBuffer) => void = () => undefined

  get active(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    if (this.running) return
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
  }

  stop(): void {
    this.running = false
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
}
