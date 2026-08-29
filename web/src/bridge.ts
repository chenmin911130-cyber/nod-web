import type { Api, AppConfig, EngineEvent, EngineMsg } from './types'
import { getToken } from './auth'
import { MicCapture } from './audio'
import { apiUrl, isNativeApp, wsUrl } from './native'

const EVENT_TYPES = new Set([
  'ready',
  'pong',
  'keys_status',
  'state',
  'status',
  'partial',
  'question',
  'chunk',
  'done',
  'error',
  'auth_required',
  'quota',
  'quota_exceeded',
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
    case 'state':
      return { type: 'state', state: asText(o.state) }
    case 'status':
      return { type: 'status', text: asText(o.text) }
    case 'error':
      return { type: 'error', text: asText(o.text) }
    case 'partial':
      return { ...o, type: 'partial', text: asText(o.text) } as EngineEvent
    case 'question':
    case 'chunk': {
      const id = asText(o.id)
      if (!id) return null
      return { ...o, type, id, text: asText(o.text) } as EngineEvent
    }
    case 'done': {
      const id = asText(o.id)
      if (!id) return null
      return { ...o, type: 'done', id } as EngineEvent
    }
    default:
      return { ...o, type } as EngineEvent
  }
}

// Replaying a stale start_listen after a long outage is how a reconnect turns
// into a surprise recording, so one-shot commands expire; state sync does not.
const TRANSIENT_MSGS = new Set(['manual', 'toggle_listen', 'start_listen', 'stop_listen', 'clear', 'cancel_generate', 'ask'])
const LAST_WINS_MSGS = new Set([
  'set_workspace',
  'set_llm',
  'set_lang',
  'set_source',
  'set_mic_muted',
  'set_translate_from',
  'set_translate_to',
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
  let lastRun = 'idle'
  let micStopTimer = 0
  let retries = 0
  let closing = false
  let gapWarned = false

  const pending: Array<{ msg: EngineMsg; at: number }> = []
  let micMuted = false

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
    emit({ type: 'status', text: 'Connecting to Nod…' })
  }

  const syncMic = async (run?: string) => {
    // 'think' only says the model is generating; it carries no intent about the
    // mic. Treating it as a run state used to tear the mic down mid-sentence
    // and drop everything said while an answer streamed.
    if (run && run !== 'think') lastRun = run
    window.clearTimeout(micStopTimer)
    const need = lastRun === 'listen' || lastRun === 'record'
    if (need && !mic.active) {
      try {
        await mic.start()
      } catch (err) {
        emit({
          type: 'error',
          text: `Microphone permission denied: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    } else if (!need && mic.active) {
      micStopTimer = window.setTimeout(() => {
        if (lastRun !== 'listen' && lastRun !== 'record' && mic.active) mic.stop()
      }, 500)
    }
  }

  const scheduleReconnect = (authExpired: boolean) => {
    if (closing) return
    if (retries >= RECONNECT_MAX_TRIES) {
      emit({ type: 'error', text: 'Lost connection to Nod. Reload the page to reconnect.' })
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
    const socket = new WebSocket(wsUrl())
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
      const payload = normalizeEvent(raw)
      if (!payload) return
      if (payload.type === 'state') void syncMic(payload.state)
      emit(payload)
    }
    socket.onclose = (ev) => {
      ws = null
      window.clearInterval(pingTimer)
      window.clearTimeout(reconnectTimer)
      scheduleReconnect(ev.code === 4401)
    }
    socket.onerror = () => {
      /* onclose reconnects */
    }
  }

  mic.onPcm = (buf) => {
    if (micMuted) return
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
      return downloadPdf(title || 'Nod', blocks || [{ kind: 'p', text: 'Empty export.' }], { theme, subtitle, meta, doc })
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
