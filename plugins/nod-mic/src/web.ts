import { WebPlugin } from '@capacitor/core'
import type { NodMicPlugin } from './definitions'

export class NodMicWeb extends WebPlugin implements NodMicPlugin {
  async start(): Promise<void> {
    throw this.unimplemented('NodMic is iOS-only; the browser uses getUserMedia.')
  }

  async stop(): Promise<void> {
    return
  }

  async isActive(): Promise<{ active: boolean }> {
    return { active: false }
  }

  async startKeepAlive(): Promise<void> {
    return
  }

  async stopKeepAlive(): Promise<void> {
    return
  }

  async resume(): Promise<void> {
    return
  }

  async startUplink(_options: { url: string }): Promise<void> {
    throw this.unimplemented('Audio uplink is iOS-only')
  }

  async stopUplink(): Promise<void> {
    return
  }

  async listPendingCaptures(): Promise<{ captures: [] }> {
    return { captures: [] }
  }

  async deletePendingCapture(_options: { captureId: string }): Promise<{ freed: number }> {
    return { freed: 0 }
  }
}
