import type { Api, AppConfig, EngineEvent, EngineMsg } from './types'
import { getToken } from './auth'
import { MicCapture } from './audio'

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

export function installWebApi(): void {
  document.documentElement.classList.add('nod-web')
  const eventListeners = new Set<(e: EngineEvent) => void>()
  const shortcutListeners = new Set<(k: 'f2' | 'f3' | 'f4' | 'f8' | 'f9') => void>()
  const emit = (e: EngineEvent) => eventListeners.forEach((cb) => cb(e))
  const mic = new MicCapture()
  let ws: WebSocket | null = null
  let reconnectTimer = 0
  let pingTimer = 0
  let lastRun = 'idle'
  let micStopTimer = 0

  const pending: EngineMsg[] = []
  let micMuted = false
  const sendJson = (msg: EngineMsg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
      return
    }
    pending.push(msg)
    emit({ type: 'status', text: 'Connecting to Nod…' })
  }

  const syncMic = async (run?: string) => {
    if (run) lastRun = run
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

  const connect = () => {
    const socket = new WebSocket(wsUrl())
    ws = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      const token = getToken()
      if (token) socket.send(JSON.stringify({ type: 'auth', token }))
      while (pending.length) {
        const msg = pending.shift()
        if (msg) socket.send(JSON.stringify(msg))
      }
      window.clearInterval(pingTimer)
      pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, 25000)
    }
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const payload = JSON.parse(ev.data) as EngineEvent
        if (payload.type === 'state') void syncMic(payload.state)
        emit(payload)
      } catch {
        /* ignore */
      }
    }
    socket.onclose = (ev) => {
      ws = null
      window.clearInterval(pingTimer)
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(() => {
        void (async () => {
          if (ev.code === 4401) {
            const { ensureLocalGuest } = await import('./auth')
            await ensureLocalGuest()
          }
          connect()
        })()
      }, ev.code === 4401 ? 2000 : 1200)
    }
    socket.onerror = () => {
      /* onclose reconnects */
    }
  }

  mic.onPcm = (buf) => {
    if (micMuted) return
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf)
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
      const res = await fetch('/api/config')
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
    exportPdf: async ({ title, blocks }) => {
      const { downloadPdf } = await import('./pdf')
      return downloadPdf(title || 'Nod', blocks || [{ kind: 'p', text: 'Empty export.' }])
    },
  }

  window.api = api
  connect()

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
