import type { PluginListenerHandle } from '@capacitor/core'

export type PcmEvent = { data: string }

/** Typecheck-only stub. Vite resolves the real `nod-mic` package at build time. */
export const NodMic = {
  start(): Promise<void> {
    return Promise.resolve()
  },
  stop(): Promise<void> {
    return Promise.resolve()
  },
  addListener(_event: 'pcm', _cb: (ev: PcmEvent) => void): Promise<PluginListenerHandle> {
    return Promise.resolve({ remove: () => Promise.resolve() })
  },
  startKeepAlive(): Promise<void> {
    return Promise.resolve()
  },
  stopKeepAlive(): Promise<void> {
    return Promise.resolve()
  },
}
