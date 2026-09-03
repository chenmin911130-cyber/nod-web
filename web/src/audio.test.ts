import { PcmDownsampler } from './audio'

function pcm16(buf: ArrayBuffer): Int16Array {
  return new Int16Array(buf)
}

function sine(sr: number, hz: number, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr)
  return out
}

function concat(parts: Int16Array[]): Int16Array {
  const n = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Int16Array(n)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const fromSr = 48000
const chunk = 4096
const src = sine(fromSr, 440, chunk * 4)

const continuous = new PcmDownsampler()
const one = pcm16(continuous.push(src, fromSr))

const stream = new PcmDownsampler()
const parts: Int16Array[] = []
for (let i = 0; i < src.length; i += chunk) {
  parts.push(pcm16(stream.push(src.subarray(i, i + chunk), fromSr)))
}
const chunked = concat(parts)

if (Math.abs(chunked.length - one.length) > 2) {
  throw new Error(`chunked 48kHz downsample must keep leftover samples, got ${chunked.length} vs ${one.length}`)
}

const splice = parts[0].length
const jumpOne = Math.abs(one[splice] - one[splice - 1])
const jumpChunk = Math.abs(chunked[splice] - chunked[splice - 1])
if (jumpChunk > jumpOne + 80) {
  throw new Error(`ScriptProcessor chunk boundary must not click (jump ${jumpChunk} vs continuous ${jumpOne})`)
}

let maxDiff = 0
const n = Math.min(one.length, chunked.length)
for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(one[i] - chunked[i]))
if (maxDiff > 40) {
  throw new Error(`chunked downsample must match a continuous stream, maxDiff=${maxDiff}`)
}

const fresh = new PcmDownsampler()
const first = pcm16(fresh.push(src.subarray(0, chunk), fromSr))
const other = new PcmDownsampler()
const reset = pcm16(other.push(src.subarray(chunk, chunk * 2), fromSr))
if (parts[1].length && reset.length && Math.abs(parts[1][0] - reset[0]) < 20) {
  throw new Error('a new downsampler must not reuse the previous filter state')
}

if (first.length < 1000) {
  throw new Error('a 4096-sample 48kHz callback must still emit speech-rate PCM')
}
