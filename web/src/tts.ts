import { apiUrl, isNativeApp } from './native'
import { getToken } from './auth'
import { playWatchSpeech, stopWatchSpeech } from './watch'

export type TtsVoice = 'male' | 'female'
export type TtsMode = 'tap' | 'live'

const VOICE_KEY = 'nod_tts_voice'
const MODE_KEY = 'nod_tts_mode'
const ON_KEY = 'nod_tts_on'

let current: HTMLAudioElement | null = null
let objectUrl = ''
let settlePlay: (() => void) | null = null
let playGen = 0
let playAbort: AbortController | null = null
let speaking = false
const speechListeners = new Set<(on: boolean) => void>()

function setSpeaking(on: boolean): void {
  if (speaking === on) return
  speaking = on
  speechListeners.forEach((cb) => cb(on))
}

export function isSpeaking(): boolean {
  return speaking
}

export function onSpeakingChange(cb: (on: boolean) => void): () => void {
  speechListeners.add(cb)
  return () => speechListeners.delete(cb)
}

/** A second Play while audio is running must stop, not queue another clip. */
export function speechTapShouldStop(playing: boolean): boolean {
  return playing
}

export function readTtsVoice(): TtsVoice {
  try {
    return localStorage.getItem(VOICE_KEY) === 'male' ? 'male' : 'female'
  } catch {
    return 'female'
  }
}

export function writeTtsVoice(voice: TtsVoice): void {
  try {
    localStorage.setItem(VOICE_KEY, voice)
  } catch {
    /* ignore */
  }
}

export function defaultTtsMode(_native: boolean, stored: string | null): TtsMode {
  if (stored === 'live') return 'live'
  return 'tap'
}

export function readTtsMode(): TtsMode {
  try {
    const stored = localStorage.getItem(MODE_KEY) || (localStorage.getItem(ON_KEY) === '0' ? '0' : null)
    return defaultTtsMode(isNativeApp(), stored)
  } catch {
    return defaultTtsMode(isNativeApp(), null)
  }
}

/** Auto speech is Translate-only. Meeting / Interview must stay silent. */
export function listenSessionShouldAutoSpeak(workspaceMode: string, _run?: string): boolean {
  return workspaceMode === 'translate'
}

export function nextLiveUtterances(input: {
  live: boolean
  workspaceMode: string
  run?: string
  translateOn: boolean
  bindId: string
  spoken: Iterable<string>
  pairs: Array<{ id: string; translation?: string; passthrough?: boolean; failed?: boolean }>
  lines: Array<{ id: string; translation?: string }>
}): Array<{ id: string; text: string }> {
  if (!input.live) return []
  if (!listenSessionShouldAutoSpeak(input.workspaceMode, input.run || 'idle')) return []
  const spoken = new Set(input.spoken)
  const out: Array<{ id: string; text: string }> = []
  if (input.workspaceMode === 'translate') {
    for (const pair of input.pairs) {
      if (pair.passthrough || pair.failed || pair.id === input.bindId || spoken.has(pair.id)) continue
      const text = (pair.translation || '').trim()
      if (!text) continue
      out.push({ id: pair.id, text })
    }
  }
  if (input.workspaceMode === 'meeting' && input.translateOn) {
    for (const line of input.lines) {
      const id = `meet:${line.id}`
      if (spoken.has(id)) continue
      const text = (line.translation || '').trim()
      if (!text) continue
      out.push({ id, text })
    }
  }
  return out
}

export function writeTtsMode(mode: TtsMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

function haltAudio(): void {
  const settle = settlePlay
  settlePlay = null
  if (current) {
    current.onended = null
    current.onerror = null
    current.pause()
    current.src = ''
    current = null
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
  settle?.()
}

export function stopSpeech(): void {
  playGen += 1
  playAbort?.abort()
  playAbort = null
  jobs.length = 0
  haltAudio()
  void stopWatchSpeech()
  setSpeaking(false)
}

/** Restart drain if work arrived while the previous pass was closing. */
export function shouldKickDrain(draining: boolean, pending: number): boolean {
  return !draining && pending > 0
}

export function unlockSpeech(): void {
  const probe = new Audio()
  probe.muted = true
  void probe.play().catch(() => undefined)
}

async function playOnce(text: string, voice: TtsVoice): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  const gen = playGen
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const ac = new AbortController()
  playAbort = ac
  const timer = window.setTimeout(() => ac.abort(), 20_000)
  let res: Response
  try {
    res = await fetch(apiUrl('/api/tts'), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ text: clean, voice }),
      signal: ac.signal,
    })
  } catch (err) {
    if (gen !== playGen) return
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Speech timed out')
    }
    throw err
  } finally {
    window.clearTimeout(timer)
    if (playAbort === ac) playAbort = null
  }
  if (gen !== playGen) return
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(typeof detail.detail === 'string' ? detail.detail : `Speech failed (${res.status})`)
  }
  const blob = await res.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!bytes.byteLength) throw new Error('Speech returned empty audio')
  if (gen !== playGen) return
  if (isNativeApp()) {
    try {
      await Promise.race([
        playWatchSpeech(bytes),
        new Promise<void>((_, reject) => {
          window.setTimeout(() => reject(new Error('Speech timed out')), 45_000)
        }),
      ])
      return
    } catch (err) {
      if (err instanceof Error && err.message === 'Speech timed out') throw err
      /* WKWebView fallback after a failed native player */
    }
  }
  haltAudio()
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
  const audio = new Audio(objectUrl)
  audio.volume = 1
  current = audio
  await new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      if (settlePlay !== finishOk) return
      settlePlay = null
      if (current === audio) {
        audio.onended = null
        audio.onerror = null
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
          objectUrl = ''
        }
        current = null
      }
      if (err) reject(err)
      else resolve()
    }
    const finishOk = () => finish()
    settlePlay = finishOk
    audio.onended = finishOk
    audio.onerror = () => finish(new Error('Could not play translation'))
    void audio.play().catch((err) => finish(err instanceof Error ? err : new Error('Could not play translation')))
  })
}

type SpeechJob = { text: string; voice: TtsVoice; ok: () => void; fail: (err: unknown) => void }

const jobs: SpeechJob[] = []
let draining = false

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  setSpeaking(true)
  try {
    while (jobs.length) {
      const job = jobs.shift()
      if (!job) break
      try {
        await playOnce(job.text, job.voice)
        job.ok()
      } catch (err) {
        job.fail(err)
      }
    }
  } finally {
    draining = false
    if (shouldKickDrain(draining, jobs.length)) void drain()
    else setSpeaking(false)
  }
}

export function speakTranslation(text: string, voice: TtsVoice): Promise<void> {
  return new Promise((resolve, reject) => {
    jobs.push({
      text,
      voice,
      ok: resolve,
      fail: reject,
    })
    void drain()
  })
}
