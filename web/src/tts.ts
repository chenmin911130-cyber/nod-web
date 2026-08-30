import { apiUrl } from './native'
import { getToken } from './auth'

export type TtsVoice = 'male' | 'female'
export type TtsMode = 'tap' | 'live'

const VOICE_KEY = 'nod_tts_voice'
const MODE_KEY = 'nod_tts_mode'
const ON_KEY = 'nod_tts_on'

let current: HTMLAudioElement | null = null
let objectUrl = ''

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

export function readTtsMode(): TtsMode {
  try {
    if (localStorage.getItem(MODE_KEY) === 'live') return 'live'
    if (localStorage.getItem(ON_KEY) === '0') return 'tap'
    return localStorage.getItem(MODE_KEY) === 'tap' ? 'tap' : 'tap'
  } catch {
    return 'tap'
  }
}

export function writeTtsMode(mode: TtsMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

function haltAudio(): void {
  if (current) {
    current.pause()
    current = null
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}

export function stopSpeech(): void {
  jobs.length = 0
  haltAudio()
}

export function unlockSpeech(): void {
  const probe = new Audio()
  probe.muted = true
  void probe.play().catch(() => undefined)
}

async function playOnce(text: string, voice: TtsVoice): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ text: clean, voice }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(typeof detail.detail === 'string' ? detail.detail : `Speech failed (${res.status})`)
  }
  const blob = await res.blob()
  haltAudio()
  objectUrl = URL.createObjectURL(blob)
  const audio = new Audio(objectUrl)
  current = audio
  await new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      if (current === audio) haltAudio()
      resolve()
    }
    audio.onerror = () => reject(new Error('Could not play translation'))
    void audio.play().catch(reject)
  })
}

const jobs: Array<{ text: string; voice: TtsVoice; fail: (err: unknown) => void }> = []
let draining = false

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (jobs.length) {
      const job = jobs.shift()
      if (!job) break
      try {
        await playOnce(job.text, job.voice)
      } catch (err) {
        job.fail(err)
      }
    }
  } finally {
    draining = false
  }
}

export function speakTranslation(text: string, voice: TtsVoice): Promise<void> {
  return new Promise((resolve, reject) => {
    jobs.push({
      text,
      voice,
      fail: reject,
    })
    void drain().then(resolve)
  })
}
