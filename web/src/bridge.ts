import type { Api, AppConfig, EngineEvent, EngineMsg } from './types'
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

  const sendJson = (msg: EngineMsg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const syncMic = async (run?: string) => {
    const need = run === 'listen' || run === 'record'
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
      mic.stop()
    }
  }

  const connect = () => {
    const socket = new WebSocket(wsUrl())
    ws = socket
    socket.binaryType = 'arraybuffer'
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
    socket.onclose = () => {
      ws = null
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(connect, 1200)
    }
    socket.onerror = () => {
      /* onclose reconnects */
    }
  }

  mic.onPcm = (buf) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf)
  }

  const api: Api = {
    send: (msg) => sendJson(msg),
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
    exportPdf: async ({ html, title }) => {
      const w = window.open('', '_blank', 'noopener')
      if (!w) return ''
      w.document.open()
      w.document.write(html)
      w.document.title = title || 'Nod Export'
      w.document.close()
      w.focus()
      w.print()
      return 'print'
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
