import { WebPlugin } from '@capacitor/core'
import type { NodWatchPlugin } from './definitions'

export class NodWatchWeb extends WebPlugin implements NodWatchPlugin {
  async ready(): Promise<void> {
    return
  }

  async setStatus(): Promise<void> {
    return
  }

  async shareFile(): Promise<void> {
    return
  }

  async playSpeech(): Promise<void> {
    return
  }
}
