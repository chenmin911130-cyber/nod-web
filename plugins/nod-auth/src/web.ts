import { WebPlugin } from '@capacitor/core'
import type { NodAuthPlugin } from './definitions'

export class NodAuthWeb extends WebPlugin implements NodAuthPlugin {
  async google(): Promise<{ url?: string; token?: string }> {
        throw this.unimplemented('NodAuth is native-only.')
  }
}
