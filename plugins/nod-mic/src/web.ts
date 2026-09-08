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
}
