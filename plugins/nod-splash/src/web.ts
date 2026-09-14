import { WebPlugin } from '@capacitor/core'
import type { NodSplashPlugin } from './definitions'

/** A browser has no native mask to lift; the handshake must still resolve. */
export class NodSplashWeb extends WebPlugin implements NodSplashPlugin {
  async splashReady(): Promise<void> {
    return
  }
}
