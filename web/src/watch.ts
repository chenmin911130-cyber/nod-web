import { App } from '@capacitor/app'
import { registerPlugin } from '@capacitor/core'
import { getToken } from './auth'
import { isNativeApp, NATIVE_API_ORIGIN } from './native'

type WatchCommand = { action?: string; mode?: string; sessionId?: string }
type WatchPcm = { data?: string }

type WatchHistItem = { id: string; title: string; text: string }

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
    save?: string
    sessionId?: string
    pcmDrained?: boolean
    pcmDrainedCaptureId?: string
    pcmDrainedSessionId?: string
    pcmDrainedByte?: number
    copySeq?: number
    copyId?: string
    copyFailed?: boolean
  }): Promise<void>
  shareFile(opts: { data: string; name: string }): Promise<void>
  saveToFiles(opts: {
    files: Array<{ data: string; name: string }>
    remotes?: Array<{ url: string; name: string; token?: string }>
  }): Promise<void>
  playSpeech(opts: { data: string; dest?: 'phone' | 'watch' }): Promise<void>
  stopSpeech(): Promise<void>
  storeAccount(opts: { token: string; origin: string }): Promise<void>
  listSaves(): Promise<{ saves: Array<{ sessionId: string; captureId: string; save: string; error?: string }> }>
  retrySave(opts: { sessionId: string }): Promise<void>
  resumeKeeps(): Promise<void>
  addListener(event: 'command', cb: (ev: WatchCommand) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'pcm', cb: (ev: WatchPcm) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'saveResult', cb: (ev: { save?: string; sessionId?: string }) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'watchCopy', cb: (ev: { id?: string; original?: string; translation?: string; seq?: number; done?: boolean; failed?: boolean; sessionId?: string }) => void): Promise<{ remove: () => Promise<void> }>
}

const NodWatch = registerPlugin<WatchPlugin>('NodWatch')

// Last copy version the phone has seen from the server. The native bridge owns
// the order within the Watch; this is what the JS face push reports so a stale
// face (the webview was suspended while the phone was locked) cannot overwrite a
// newer native copy.
let watchCopySeq = 0

export function currentWatchCopySeq(): number {
  return watchCopySeq
}

function storeWatchAccount(): void {
  if (!isNativeApp()) return
  const token = getToken()
  void NodWatch.storeAccount({ token, origin: NATIVE_API_ORIGIN }).catch(() => undefined)
}

export function retryWatchSave(sessionId: string): void {
  if (!isNativeApp() || !sessionId) return
  void NodWatch.retrySave({ sessionId }).catch(() => undefined)
}

export function resumeWatchKeeps(): void {
  if (!isNativeApp()) return
  void NodWatch.resumeKeeps().catch(() => undefined)
}

export async function listWatchSaves(): Promise<{
  saves: Array<{ sessionId: string; captureId: string; save: string; error?: string }>
}> {
  if (!isNativeApp()) return { saves: [] }
  return NodWatch.listSaves().catch(() => ({ saves: [] }))
}

let preferWatchMic = false
let pcmSink: ((buf: ArrayBuffer) => void) | null = null
const preRoll: ArrayBuffer[] = []

export function watchAction(raw: unknown): 'start' | 'stop' | 'record' | 'pause' | 'resume' | 'speak' | 'tts_live' | 'tts_tap' | 'tts_female' | 'tts_male' | 'save' | 'discard' | '' {
  return raw === 'start' || raw === 'stop' || raw === 'record' || raw === 'pause' || raw === 'resume' || raw === 'speak' || raw === 'tts_live' || raw === 'tts_tap' || raw === 'tts_female' || raw === 'tts_male' || raw === 'save' || raw === 'discard' ? raw : ''
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

/** Watch Start / Record uses the watch mic. Phone Start does not. */
export function watchStartShouldPreferWatchMic(fromWatch: boolean): boolean {
  return fromWatch
}

/** Pause / Resume inherit the mic chosen at Start. Do not reassign. */
export function watchResumeShouldChangeMic(): boolean {
  return false
}

export type WatchHardwareKey = 'crown' | 'side'

/** Crown is Start/Stop. Side is Pause/Resume. Never bind the crown to toggle(). */
export function watchHardwareAction(
  key: WatchHardwareKey,
  state: { listening: boolean; paused: boolean; offeringSave: boolean; saved: boolean; pendingSync?: boolean },
): 'start' | 'stop' | 'pause' | 'resume' | '' {
  if (state.offeringSave || state.saved || state.pendingSync) return ''
  if (key === 'crown') {
    if (state.listening || state.paused) return 'stop'
    return 'start'
  }
  if (state.paused) return 'resume'
  if (state.listening) return 'pause'
  return ''
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

/** WatchConnectivity command as JS receives it. Missing sessionId stays empty. */
export function watchCommandFromBridge(ev: {
  action?: string
  sessionId?: string
}): { action: ReturnType<typeof watchAction>; sessionId: string } {
  return {
    action: watchAction(ev.action),
    sessionId: typeof ev.sessionId === 'string' ? ev.sessionId : '',
  }
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
  onSave: (sessionId: string) => void
  onSaveResult: (ev: { save: string; sessionId: string }) => void
  onDiscard: () => void
  onTtsLive: () => void
  onTtsTap: () => void
  onTtsVoice: (voice: 'male' | 'female') => void
  onWatchCopy: (ev: { id: string; original: string; translation: string; seq: number; failed: boolean; session: string }) => void
}): () => void {
  if (!isNativeApp()) return () => undefined
  let gone = false
  const handles: Array<{ remove: () => Promise<void> }> = []
  let onVis: (() => void) | null = null
  void (async () => {
    await NodWatch.ready()
    storeWatchAccount()
    const replaySaves = async () => {
      const listed = await NodWatch.listSaves().catch(() => ({ saves: [] as Array<{ sessionId: string; save: string }> }))
      if (gone) return
      for (const row of listed.saves || []) {
        handlers.onSaveResult({ save: row.save || '', sessionId: row.sessionId || '' })
      }
    }
    const saveResult = await NodWatch.addListener('saveResult', (ev) => {
      if (gone) return
      handlers.onSaveResult({ save: ev.save || '', sessionId: ev.sessionId || '' })
    })
    handles.push(saveResult)
    await replaySaves()
    if (gone) return
    onVis = () => {
      if (document.visibilityState === 'visible') {
        void replaySaves()
        resumeWatchKeeps()
        void NodWatch.ready()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    try {
      const appState = await App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive || gone) return
        void replaySaves()
        resumeWatchKeeps()
        void NodWatch.ready()
      })
      handles.push(appState)
    } catch {
      /* web / missing plugin */
    }
    const command = await NodWatch.addListener('command', (ev) => {
      if (gone) return
      const { action, sessionId } = watchCommandFromBridge(ev)
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
      if (action === 'save') handlers.onSave(sessionId)
      if (action === 'discard') handlers.onDiscard()
      if (action === 'tts_live') handlers.onTtsLive()
      if (action === 'tts_tap') handlers.onTtsTap()
      if (action === 'tts_female') handlers.onTtsVoice('female')
      if (action === 'tts_male') handlers.onTtsVoice('male')
    })
    const pcm = await NodWatch.addListener('pcm', (ev) => {
      if (gone) return
      if (watchPcmShouldClaimMic()) setPreferWatchMic(true)
      deliverPcm(ev.data || '')
    })
    const watchCopy = await NodWatch.addListener('watchCopy', (ev) => {
      if (gone) return
      const seq = typeof ev.seq === 'number' ? ev.seq : Number(ev.seq || 0)
      if (seq > watchCopySeq) watchCopySeq = seq
      const id = String(ev.id || '')
      if (!id) return
      handlers.onWatchCopy({
        id,
        original: ev.original || '',
        translation: ev.translation || '',
        seq,
        failed: Boolean(ev.failed),
        session: String(ev.sessionId || ''),
      })
    })
    handles.push(command, pcm, watchCopy)
    void NodWatch.ready()
  })().catch(() => undefined)
  return () => {
    gone = true
    if (onVis) document.removeEventListener('visibilitychange', onVis)
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
  save?: string
  sessionId?: string
  pcmDrained?: boolean
  pcmDrainedCaptureId?: string
  pcmDrainedSessionId?: string
  pcmDrainedByte?: number
  // Only a push that carries the live face sends the copy version + id. A
  // control-only push (save state, pcm_drained) must leave the Watch copy alone.
  copySeq?: number
  copyId?: string
  copyFailed?: boolean
}): void {
  if (!isNativeApp()) return
  void NodWatch.setStatus({
    capture: face.capture,
    hint: (face.hint || '').slice(0, 140),
    original: (face.original || '').slice(0, 800),
    translation: (face.translation || '').slice(0, 800),
    previous: (face.previous || '').slice(0, 72),
    history: (face.history || []).slice(0, 8),
    copySeq: face.copySeq,
    copyId: face.copyId,
    copyFailed: face.copyFailed,
    mode: face.mode,
    langPair: face.langPair,
    save: face.save,
    sessionId: face.sessionId,
    pcmDrained: face.pcmDrained,
    pcmDrainedCaptureId: face.pcmDrainedCaptureId,
    pcmDrainedSessionId: face.pcmDrainedSessionId,
    pcmDrainedByte: face.pcmDrainedByte,
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
