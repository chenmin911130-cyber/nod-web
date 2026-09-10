import type { PluginListenerHandle } from '@capacitor/core'

export type PcmEvent = {
  /** Base64-encoded 16 kHz mono PCM16 little-endian. */
  data: string
}

export interface NodMicPlugin {
  start(): Promise<void>
  stop(): Promise<void>
  isActive(): Promise<{ active: boolean }>
  startKeepAlive(): Promise<void>
  stopKeepAlive(): Promise<void>
  resume(): Promise<void>
  startUplink(options: { url: string }): Promise<void>
  stopUplink(): Promise<void>
  listPendingCaptures(): Promise<{
    captures: Array<{
      captureId: string
      sessionId: string
      bytes: number
      sealed: boolean
      intent: string
      modifiedAt: string
    }>
  }>
  deletePendingCapture(options: { captureId: string }): Promise<{ freed: number }>
  addListener(eventName: 'pcm', listenerFunc: (event: PcmEvent) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}
