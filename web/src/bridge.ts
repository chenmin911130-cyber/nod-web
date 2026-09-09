import type { Api, AppConfig, CaptureState, EngineEvent, EngineMsg, EngineState } from './types'
import { PRODUCT_NAME } from './brand'
import { getToken } from './auth'
import { MicCapture } from './audio'
import { apiUrl, isNativeApp, wsUrl } from './native'
import { micSilenceShouldWarn } from './micGuard'
import { audioUplinkWsUrl, controlWsUrl, shouldEmitUplinkNotice, uplinkFailureFromError, uplinkFailureLog, uplinkShouldForwardPcmFromJs, uplinkTokenAfterNativeStart } from './uplink'
import { isWatchMicPreferred, setWatchPcmSink } from './watch'

const EVENT_TYPES = new Set([
  'ready',
  'pong',
  'keys_status',
  'phase',
  'status',
  'partial',
  'question',
  'line_update',
  'chunk',
  'done',
  'error',
  'listen_taken',
  'auth_required',
  'quota',
  'quota_exceeded',
  'save_prompt',
  'history_kept',
  'history_keep_failed',
  'attached',
  'pcm_drained',
])

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * The only place server frames are trusted. Anything unrecognised is dropped,
 * and the string fields the reducer dereferences are guaranteed present so a
 * malformed frame cannot take down the whole listener chain.
 */
function normalizeEvent(raw: unknown): EngineEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type = o.type
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null
  switch (type) {
    case 'phase': {
      const capture = asText(o.capture)
      const engine = asText(o.engine)
      return {
        type: 'phase',
        capture: (['off', 'listening', 'recording', 'paused'].includes(capture) ? capture : 'off') as CaptureState,
        engine: (['idle', 'transcribing', 'generating'].includes(engine) ? engine : 'idle') as EngineState,
      }
    }
    case 'status':
      return { type: 'status', text: asText(o.text) }
    case 'error':
      return { type: 'error', text: asText(o.text) }
    case 'listen_taken':
      return { type: 'listen_taken', text: asText(o.text) }
    case 'partial':
      return { ...o, type: 'partial', text: asText(o.text) } as EngineEvent
    case 'question':
    case 'chunk': {
      const id = asText(o.id)
      if (!id) return null
      return { ...o, type, id, text: asText(o.text) } as EngineEvent
    }
    case 'line_update': {
      const id = asText(o.id)
      if (!id) return null
      const rev = typeof o.rev === 'number' ? o.rev : 0
      const language = asText(o.language)
      const speaker = asText(o.speaker)
      const ev: EngineEvent = { type: 'line_update', id, text: asText(o.text), rev }
      if (language) ev.language = language
      if (speaker) ev.speaker = speaker
      return ev
    }
    case 'done': {
      const id = asText(o.id)
      if (!id) return null
      return { ...o, type: 'done', id } as EngineEvent
    }
    case 'history_keep_failed':
      return {
        type: 'history_keep_failed',
        id: typeof o.id === 'string' ? o.id : undefined,
        reason: asText(o.reason) || undefined,
      }
    case 'attached':
      return { type: 'attached', usage_session_id: asText(o.usage_session_id) || undefined }
    case 'pcm_drained': {
      const id = asText(o.id)
      if (!id) return null
      const offset = typeof o.byte_offset === 'number' ? o.byte_offset : Number(o.byte_offset)
      if (!Number.isFinite(offset)) return null
      return { type: 'pcm_drained', id, byte_offset: offset }
    }
    default:
      return { ...o, type } as EngineEvent
  }
}

// Replaying a stale start_listen after a long outage is how a reconnect turns
// into a surprise recording, so one-shot commands expire; state sync does not.
const TRANSIENT_MSGS = new Set(['manual', 'toggle_listen', 'start_listen', 'stop_listen', 'pause_listen', 'resume_listen', 'clear', 'cancel_generate', 'ask'])
const LAST_WINS_MSGS = new Set([
  'set_workspace',
  'set_llm',
  'set_lang',
  'set_source',
  'set_mic_muted',
  'set_translate_from',
  'set_translate_to',
  // Reconnect can flush a queued start_listen and then ready sends another.
  // One in-flight start is enough; the server also serializes, but do not
  // stack three AssemblyAI sockets from one click.
  'start_listen',
  'stop_listen',
  'pause_listen',
  'resume_listen',
])
const PENDING_MAX = 32
const PENDING_STALE_MS = 10_000

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RECONNECT_MAX_TRIES = 12

export function installWebApi(): void {
  document.documentElement.classList.add('nod-web')
  const eventListeners = new Set<(e: EngineEvent) => void>()
  const shortcutListeners = new Set<(k: 'f2' | 'f3' | 'f4' | 'f8' | 'f9') => void>()
  const emit = (e: EngineEvent) => {
    eventListeners.forEach((cb) => {
      try {
        cb(e)
      } catch (err) {
        // One bad listener must not swallow the event for the others.
        console.error('[nod] event listener failed', err)
      }
    })
  }
  const mic = new MicCapture()
  let ws: WebSocket | null = null
  let reconnectTimer = 0
  let pingTimer = 0
  let lastRun = 'off'
  let micStopTimer = 0
  let retries = 0
  let closing = false
  let gapWarned = false

  const pending: Array<{ msg: EngineMsg; at: number }> = []
  let micMuted = false
  let pcmBytes = 0
  let listenSince = 0
  let silenceWatch = 0
  let uplinkToken = ''
  let uplinkStarting = ''
  let lastUplinkNotice = ''

  const queueMsg = (msg: EngineMsg) => {
    if (msg.type === 'ping') return
    if (LAST_WINS_MSGS.has(msg.type)) {
      const i = pending.findIndex((p) => p.msg.type === msg.type)
      if (i >= 0) pending.splice(i, 1)
    }
    pending.push({ msg, at: Date.now() })
    while (pending.length > PENDING_MAX) pending.shift()
  }

  const flushPending = (socket: WebSocket) => {
    const now = Date.now()
    const items = pending.splice(0, pending.length)
    for (const p of items) {
      if (TRANSIENT_MSGS.has(p.msg.type) && now - p.at > PENDING_STALE_MS) continue
      socket.send(JSON.stringify(p.msg))
    }
  }

  const sendJson = (msg: EngineMsg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
      return
    }
    queueMsg(msg)
    emit({ type: 'status', text: `Connecting to ${PRODUCT_NAME}…` })
  }

  const syncMic = async (capture?: string) => {
    // capture is the single source of truth for the mic (ADR 0001): it feeds
    // audio only while the session is actively listening/recording. A paused
    // session (capture='paused') stops feeding, and a generating model only
    // changes the engine axis — capture stays 'listening', so the mic is never
    // torn down mid-answer. 'think' was a workaround for exactly that; the two
    // axes remove the need for it.
    if (capture) lastRun = capture
    window.clearTimeout(micStopTimer)
    const need = lastRun === 'listening' || lastRun === 'recording'
    if (need) {
      try {
        await mic.start()
        if (!listenSince) {
          listenSince = Date.now()
          pcmBytes = 0
          window.clearInterval(silenceWatch)
          silenceWatch = window.setInterval(() => {
            if (
              micSilenceShouldWarn({
                listening: lastRun === 'listening' || lastRun === 'recording',
                pcmBytes,
                elapsedMs: Date.now() - listenSince,
                watchPreferred: isWatchMicPreferred(),
                uplinkActive: Boolean(uplinkToken) && isNativeApp(),
              })
            ) {
              window.clearInterval(silenceWatch)
              emit({
                type: 'error',
                text: 'Microphone is silent. Check iPhone Control Centre mic access, then Stop and Start again.',
              })
            }
          }, 500)
        }
      } catch (err) {
        emit({
          type: 'error',
          text: 'Microphone access needed. Allow it in Settings, then tap Start listening again.',
        })
      }
    } else if (mic.active) {
      listenSince = 0
      pcmBytes = 0
      window.clearInterval(silenceWatch)
      micStopTimer = window.setTimeout(() => {
        if (lastRun !== 'listening' && lastRun !== 'recording' && mic.active) mic.stop()
      }, 500)
    }
  }

  const applyUplinkToken = (token: string) => {
    if (!token || token === uplinkToken || token === uplinkStarting) return
    if (!isNativeApp()) {
      uplinkToken = uplinkTokenAfterNativeStart(true, token)
      return
    }
    uplinkStarting = token
    void import('nod-mic')
      .then(({ NodMic }) => NodMic.startUplink({ url: audioUplinkWsUrl(wsUrl(), token) }))
      .then(() => {
        if (uplinkStarting !== token) return
        uplinkStarting = ''
        uplinkToken = uplinkTokenAfterNativeStart(true, token)
        mic.setUplinkActive(true)
        if (lastUplinkNotice) {
          lastUplinkNotice = ''
          emit({ type: 'status', text: '' })
        }
      })
      .catch((err: unknown) => {
        if (uplinkStarting !== token) return
        uplinkStarting = ''
        uplinkToken = uplinkTokenAfterNativeStart(false, token)
        mic.setUplinkActive(false)
        const notice = uplinkFailureFromError(err)
        const logged = uplinkFailureLog(err)
        console.warn('nod uplink', { stage: 'startUplink', code: logged.code, message: logged.message })
        if (!shouldEmitUplinkNotice(lastUplinkNotice, notice.text)) return
        lastUplinkNotice = notice.text
        emit({ type: 'error', text: notice.text })
      })
  }

  const clearUplink = () => {
    uplinkStarting = ''
    if (!uplinkToken && !isNativeApp()) {
      mic.setUplinkActive(false)
      return
    }
    uplinkToken = ''
    mic.setUplinkActive(false)
    if (!isNativeApp()) return
    void import('nod-mic')
      .then(({ NodMic }) => NodMic.stopUplink())
      .catch(() => undefined)
  }

  const scheduleReconnect = (authExpired: boolean) => {
    if (closing) return
    if (retries >= RECONNECT_MAX_TRIES) {
      clearUplink()
      emit({ type: 'error', text: `Lost connection to ${PRODUCT_NAME}. Reload the page to reconnect.` })
      return
    }
    // Exponential backoff with jitter: a fixed retry meant every open tab
    // hammered the server in lockstep the moment it came back up.
    const step = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retries)
    const delay = authExpired ? 2_000 : Math.round(step * (0.7 + Math.random() * 0.6))
    retries += 1
    window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(() => {
      void (async () => {
        if (authExpired) {
          const { ensureLocalGuest } = await import('./auth')
          await ensureLocalGuest()
        }
        connect()
      })()
    }, delay)
  }

  const connect = () => {
    if (closing) return
    const socket = new WebSocket(controlWsUrl(wsUrl(), uplinkToken))
    ws = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      retries = 0
      gapWarned = false
      const token = getToken()
      if (token) socket.send(JSON.stringify({ type: 'auth', token }))
      flushPending(socket)
      window.clearInterval(pingTimer)
      pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, 25000)
    }
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(ev.data)
      } catch {
        return
      }
      if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'audio_uplink') {
        applyUplinkToken(asText((raw as { token?: unknown }).token))
      }
      const payload = normalizeEvent(raw)
      if (!payload) return
      if (payload.type === 'phase') void syncMic(payload.capture)
      emit(payload)
    }
    socket.onclose = (ev) => {
      ws = null
      window.clearInterval(pingTimer)
      window.clearTimeout(reconnectTimer)
      emit({ type: 'disconnected' })
      scheduleReconnect(ev.code === 4401)
    }
    socket.onerror = () => {
      /* onclose reconnects */
    }
  }

  setWatchPcmSink((buf) => {
    if (mic.active || isWatchMicPreferred()) mic.onPcm(buf)
  })

  mic.onFallbackFailed = () => {
    emit({
      type: 'error',
      text: 'Microphone is silent. Check iPhone Control Centre mic access, then Stop and Start again.',
    })
  }

  mic.onPcm = (buf) => {
    pcmBytes += buf.byteLength
    if (micMuted) return
    if (!uplinkShouldForwardPcmFromJs({ nativeApp: isNativeApp(), hasToken: Boolean(uplinkToken) })) {
      return
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buf)
      return
    }
    // Audio captured while the socket is down cannot be recovered — say so
    // once per gap instead of leaving a silent hole in the transcript.
    if (!gapWarned) {
      gapWarned = true
      emit({ type: 'status', text: 'Reconnecting — speech during this gap is not being captured.' })
    }
  }

  const api: Api = {
    send: (msg) => {
      if (msg.type === 'set_mic_muted') micMuted = Boolean(msg.muted)
      sendJson(msg)
    },
    onEvent: (cb) => {
      eventListeners.add(cb)
      return () => eventListeners.delete(cb)
    },
    onShortcut: (cb) => {
      shortcutListeners.add(cb)
      return () => shortcutListeners.delete(cb)
    },
    setOpacity: (n) => {
      const v = Math.min(100, Math.max(10, n))
      document.documentElement.style.setProperty('--bg', `rgba(8, 14, 28, ${v / 100})`)
    },
    setPinned: () => undefined,
    setStealth: () => undefined,
    setView: () => undefined,
    copy: (text) => {
      void navigator.clipboard?.writeText(text)
    },
    close: () => undefined,
    minimize: () => undefined,
    getConfig: async () => {
      const res = await fetch(apiUrl('/api/config'))
      if (!res.ok) {
        return {
          llm: { provider: 'deepseek', model: '' },
          stt: { language: null },
          audio: { source: 'mic' },
          ui: { opacity: 88 },
          models: [],
        } satisfies AppConfig
      }
      return (await res.json()) as AppConfig
    },
    openExternal: (url) => {
      window.open(url, '_blank', 'noopener')
    },
    exportPdf: async ({ title, blocks, theme, subtitle, meta, doc }) => {
      const { downloadPdf } = await import('./pdf')
      return downloadPdf(title || 'Nodpilot', blocks || [{ kind: 'p', text: 'Empty export.' }], { theme, subtitle, meta, doc })
    },
  }

  window.api = api
  connect()

  window.addEventListener('pagehide', () => {
    // Lock screen / background must keep the native mic session and the
    // Railway WebSocket alive. WKWebView getUserMedia would already be dead.
    if (isNativeApp()) return
    closing = true
    window.clearTimeout(reconnectTimer)
    window.clearInterval(pingTimer)
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel_generate' }))
        ws.send(JSON.stringify({ type: 'stop_listen' }))
      }
    } catch {
      /* tab is going away; session.close() still Terminates and aborts LLM */
    }
    mic.stop()
    ws?.close()
  })

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const k = e.key.toLowerCase()
    if (k === 'f2' || k === 'f3' || k === 'f4' || k === 'f8' || k === 'f9') {
      e.preventDefault()
      shortcutListeners.forEach((cb) => cb(k))
    }
  })
}
