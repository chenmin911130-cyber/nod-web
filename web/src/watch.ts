import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './native'

type WatchCommand = { action?: string; mode?: string; id?: string }
type WatchPcm = { data?: string }

type WatchHistItem = { id: string; title: string; text: string; failed?: boolean }

type WatchPlugin = {
  ready(): Promise<void>
  setStatus(opts: {
    capture?: string
    hint?: string
    original?: string
    translation?: string
    previous?: string
    history?: WatchHistItem[]
    mode?: string
    langPair?: string
    ended?: boolean
    elapsedMs?: number
    save?: string
    sessionId?: string
    engine?: string
    blocked?: string
    failed?: boolean
  }): Promise<void>
  shareFile(opts: { data: string; name: string }): Promise<void>
  saveToFiles(opts: {
    files: Array<{ data: string; name: string }>
    remotes?: Array<{ url: string; name: string; token?: string }>
  }): Promise<void>
  playSpeech(opts: { data: string; dest?: 'phone' | 'watch' }): Promise<void>
  stopSpeech(): Promise<void>
  addListener(event: 'command', cb: (ev: WatchCommand) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'pcm', cb: (ev: WatchPcm) => void): Promise<{ remove: () => Promise<void> }>
}

const NodWatch = registerPlugin<WatchPlugin>('NodWatch')

let preferWatchMic = false
let pcmSink: ((buf: ArrayBuffer) => void) | null = null
const preRoll: ArrayBuffer[] = []

export function watchAction(raw: unknown): 'start' | 'stop' | 'record' | 'pause' | 'resume' | 'speak' | 'tts_live' | 'tts_tap' | 'tts_female' | 'tts_male' | 'save' | 'discard' | 'retry' | '' {
  return raw === 'start' || raw === 'stop' || raw === 'record' || raw === 'pause' || raw === 'resume' || raw === 'speak' || raw === 'tts_live' || raw === 'tts_tap' || raw === 'tts_female' || raw === 'tts_male' || raw === 'save' || raw === 'discard' || raw === 'retry' ? raw : ''
}

export type WatchListenMode = 'meeting' | 'lecture' | 'interview' | 'translate'

/** Watch picker values. Unknown leftovers must not change the phone workspace. */
export function watchListenMode(raw: unknown): WatchListenMode | '' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return value === 'meeting' || value === 'lecture' || value === 'interview' || value === 'translate' ? value : ''
}

export function watchWorkspaceForMode(mode: WatchListenMode): {
  workspace: 'interview' | 'meeting' | 'translate'
  scene?: 'meeting' | 'lecture' | 'interview'
} {
  if (mode === 'translate') return { workspace: 'translate' }
  if (mode === 'interview') return { workspace: 'interview', scene: 'interview' }
  if (mode === 'lecture') return { workspace: 'meeting', scene: 'lecture' }
  return { workspace: 'meeting', scene: 'meeting' }
}

/**
 * Mode chips travel with Listen/Record only.
 * Pause / Resume / Done / leftover file must not switch Meeting / Interview / Translate.
 */
export function watchListenControlShouldApplyMode(input: {
  action: string
  paused: boolean
  capture: string
}): boolean {
  if (input.action !== 'start' && input.action !== 'record') return false
  if (input.paused) return false
  if (input.action === 'record' && (input.capture === 'listening' || input.capture === 'recording')) return false
  return true
}

/** Apply Watch mode only when it differs from the phone. Empty/unknown = keep phone mode. */
export function watchShouldApplyMode(
  raw: unknown,
  current: { workspaceMode: string; listenScene: string },
): { workspace: 'interview' | 'meeting' | 'translate'; scene?: 'meeting' | 'lecture' | 'interview' } | null {
  const mode = watchListenMode(raw)
  if (!mode) return null
  const next = watchWorkspaceForMode(mode)
  if (next.workspace !== current.workspaceMode) return next
  if (next.scene && next.scene !== current.listenScene) return next
  return null
}

export function isWatchMicPreferred(): boolean {
  return preferWatchMic
}

export function setPreferWatchMic(on: boolean): void {
  preferWatchMic = on
  if (!on) preRoll.length = 0
}

/** Phone Start Listening must win over a stale Watch claim. */
export function takePhoneMic(): void {
  setPreferWatchMic(false)
}

/** Incoming Watch audio must not claim the phone mic by itself. */
export function watchPcmShouldClaimMic(): boolean {
  return false
}

/** Watch Start uses the watch mic. Phone Start keeps the phone mic. Mode does not matter. */
export function watchStartShouldPreferWatchMic(input: { fromWatch: boolean }): boolean {
  return input.fromWatch
}

/** Pause / Resume inherit Start / Record mic ownership. Never flip preferWatchMic. */
export function watchResumeShouldChangeMic(): boolean {
  return false
}

export type WatchHardwareKey = 'crown' | 'side'

/** Crown is Start/Stop. Side is Pause/Resume. Never bind the crown to toggle(). */
export function watchHardwareAction(
  key: WatchHardwareKey,
  state: {
    listening: boolean
    paused: boolean
    ended?: boolean
    saving?: boolean
    saved?: boolean
    starting?: boolean
    pending?: string | null
  },
): 'start' | 'stop' | 'pause' | 'resume' | '' {
  if (state.ended || state.saving || state.saved) return ''
  if (state.starting || state.pending) return ''
  if (key === 'crown') {
    if (state.listening || state.paused) return 'stop'
    return 'start'
  }
  if (state.paused) return 'resume'
  if (state.listening) return 'pause'
  return ''
}

/** Phone → Watch `blocked`. signin > consent > quota. */
export function watchBlockedReason(input: {
  signIn: boolean
  consentOpen: boolean
  quotaOk: boolean
}): string {
  if (input.signIn) return 'signin'
  if (input.consentOpen) return 'consent'
  if (!input.quotaOk) return 'quota'
  return ''
}

/** Watch Start wait: capture confirm wins, then blocked, then 8s timeout. */
export function watchStartOutcome(input: {
  capture: string
  blocked: string
  waitedMs: number
}): string {
  if (input.capture === 'listening' || input.capture === 'recording') return 'started'
  if (input.blocked) return `blocked:${input.blocked}`
  if (input.waitedMs >= 8000) return 'timeout'
  return 'waiting'
}

/** Stale phone `capture:off` during local Start must not kill the Watch recorder. */
export function watchOffShouldStopRecorder(input: {
  starting: boolean
  listening: boolean
  paused: boolean
  recorderRunning: boolean
}): boolean {
  return !input.starting && (input.listening || input.paused || input.recorderRunning)
}

/** Connection lost only when we cannot confirm phone capture. Watch mic recording is known. */
export function watchStatusUnknown(input: {
  reachable: boolean
  recorderRunning: boolean
  listening: boolean
  paused: boolean
  ended: boolean
  staleSec: number
  reconnectFailed?: boolean
}): boolean {
  if (input.recorderRunning) return false
  if (!input.listening && !input.paused && !input.ended) return false
  return !input.reachable || (input.staleSec > 20 && !!input.reconnectFailed)
}

/** A leftover Watch file transfer is PCM only. It must not start_listen. */
export function watchFileShouldStartListen(): boolean {
  return false
}

/** Opening the Watch app delivers leftover speech files/context. Those must not play. */
export function watchSpeechShouldPlay(source: 'live' | 'file' | 'context' | 'queued'): boolean {
  return source === 'live'
}

/** A speech file is a live Play tap only when it arrived with a fresh timestamp. */
export function watchSpeechFileShouldPlay(at: number | undefined, now: number): boolean {
  if (at == null || !Number.isFinite(at)) return false
  return now - at <= 30
}

/** Screen-off recording: only buffer PCM that did not go out live. */
export function watchPcmShouldBuffer(reachable: boolean): boolean {
  return !reachable
}

/** A drop while Listen is running must allow the unsent tail to transferFile. */
export function watchLiveStreamShouldReset(listening: boolean, reachable: boolean): boolean {
  return listening && !reachable
}

/** Start / Record carry the Watch chip. Pause / Stop / leftovers must not. */
export function watchCommandShouldSendMode(action: string): boolean {
  return action === 'start' || action === 'record'
}

/** Leftover default Meeting must not ride on Start and kick the phone off Translate. */
export function watchStartShouldAttachMode(modeKnown: boolean): boolean {
  return modeKnown
}

/** A held Watch mode stays until the phone reports the same workspace. */
export function watchPhoneModeShouldApply(input: {
  localModeHeld: boolean
  watchListening: boolean
  watchPaused: boolean
}): boolean {
  if (input.localModeHeld) return false
  return true
}

/** Done must send leftover PCM even if some chunks already went live. */
export function watchFlushShouldSend(pendingBytes: number): boolean {
  return pendingBytes > 0
}

/** Unsent Watch PCM flushes when the phone is reachable, or every 20s in the background. */
export function backlogShouldFlush(input: {
  unsentBytes: number
  reachable: boolean
  sinceLastFlushSec: number
}): boolean {
  return input.unsentBytes > 0 && (input.reachable || input.sinceLastFlushSec >= 20)
}

/** Watch Start tells the server this session's mic is the wrist, so zero-PCM waits. */
export function watchStartListenPayload(fromWatch: boolean): { type: 'start_listen'; mic?: 'watch' } {
  if (fromWatch) return { type: 'start_listen', mic: 'watch' }
  return { type: 'start_listen' }
}

/**
 * File-recorder fallback may only read leftover WAV bytes while still running.
 * Stop must pump those bytes before clearing `running`, or the last ~200ms is lost.
 */
export function watchFallbackStopSequence(): Array<'pump' | 'stopRecorder' | 'clearRunning'> {
  return ['pump', 'stopRecorder', 'clearRunning']
}

const LISTEN_CMDS = new Set(['start', 'stop', 'record', 'pause', 'resume'])
const QUEUED_START_MAX_AGE_SEC = 30

/** Live sendMessage from the Watch is a real tap. Queued leftovers need a fresh timestamp. */
export function watchQueuedCommandShouldRun(action: string, at: number | undefined, now: number): boolean {
  if (!LISTEN_CMDS.has(action)) return true
  if (at == null || !Number.isFinite(at)) return false
  return now - at <= QUEUED_START_MAX_AGE_SEC
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
  onStart: (mode?: string) => void
  onStop: () => void
  onRecord: (mode?: string) => void
  onPause: () => void
  onResume: () => void
  onSpeak: () => void
  onSave: () => void
  onDiscard: () => void
  onTtsLive: () => void
  onTtsTap: () => void
  onTtsVoice: (voice: 'male' | 'female') => void
  onRetry: (id: string) => void
}): () => void {
  if (!isNativeApp()) return () => undefined
  let gone = false
  const handles: Array<{ remove: () => Promise<void> }> = []
  void (async () => {
    await NodWatch.ready()
    const command = await NodWatch.addListener('command', (ev) => {
      if (gone) return
      const action = watchAction(ev.action)
      const mode = watchListenMode(ev.mode)
      if (action === 'start') {
        handlers.onStart(mode || undefined)
      }
      if (action === 'record') {
        handlers.onRecord(mode || undefined)
      }
      if (action === 'pause') {
        handlers.onPause()
      }
      if (action === 'resume') {
        handlers.onResume()
      }
      if (action === 'stop') {
        handlers.onStop()
        setPreferWatchMic(false)
      }
      if (action === 'speak') handlers.onSpeak()
      if (action === 'save') handlers.onSave()
      if (action === 'discard') handlers.onDiscard()
      if (action === 'tts_live') handlers.onTtsLive()
      if (action === 'tts_tap') handlers.onTtsTap()
      if (action === 'tts_female') handlers.onTtsVoice('female')
      if (action === 'tts_male') handlers.onTtsVoice('male')
      if (action === 'retry') handlers.onRetry(typeof ev.id === 'string' ? ev.id : '')
    })
    const pcm = await NodWatch.addListener('pcm', (ev) => {
      if (gone) return
      if (watchPcmShouldClaimMic()) setPreferWatchMic(true)
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
  capture: string
  hint?: string
  original?: string
  translation?: string
  previous?: string
  history?: WatchHistItem[]
  mode?: string
  langPair?: string
  ended?: boolean
  elapsedMs?: number
  save?: string
  sessionId?: string
  engine?: string
  blocked?: string
  failed?: boolean
}): void {
  if (!isNativeApp()) return
  void NodWatch.setStatus({
    capture: face.capture,
    hint: (face.hint || '').slice(0, 140),
    original: (face.original || '').slice(0, 800),
    translation: (face.translation || '').slice(0, 800),
    previous: (face.previous || '').slice(0, 72),
    history: (face.history || []).slice(0, 8),
    mode: face.mode,
    langPair: face.langPair,
    ended: face.ended === true,
    elapsedMs: face.elapsedMs || 0,
    save: face.save || 'none',
    sessionId: face.sessionId || '',
    engine: face.engine,
    blocked: face.blocked || '',
    failed: face.failed === true,
  }).catch(() => undefined)
}

export async function stopWatchSpeech(): Promise<void> {
  if (!isNativeApp()) return
  await NodWatch.stopSpeech().catch(() => undefined)
}

export async function playWatchSpeech(bytes: Uint8Array, dest: 'phone' | 'watch' = 'watch'): Promise<void> {
  if (!isNativeApp() || !bytes.byteLength) return
  const chunks: string[] = []
  const step = 8192
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)))
  }
  await NodWatch.playSpeech({ data: btoa(chunks.join('')), dest })
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const step = 8192
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)))
  }
  return btoa(chunks.join(''))
}

export async function shareNativeFile(bytes: Uint8Array, name: string): Promise<void> {
  await saveNativeFiles([{ bytes, name }])
}

export async function saveNativeFiles(
  files: Array<{ bytes: Uint8Array; name: string }>,
  remotes: Array<{ url: string; name: string; token?: string }> = [],
): Promise<void> {
  if (!files.length && !remotes.length) return
  if (!isNativeApp()) {
    for (const [index, file] of files.entries()) {
      const url = URL.createObjectURL(new Blob([file.bytes.slice().buffer]))
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 4_000)
      if (index < files.length - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 350))
      }
    }
    return
  }
  await NodWatch.saveToFiles({
    files: files.map((file) => ({ data: bytesToBase64(file.bytes), name: file.name })),
    remotes,
  })
}
