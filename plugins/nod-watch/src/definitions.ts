export type WatchHistItem = { id: string; title: string; text: string }

export interface NodWatchPlugin {
  ready(): Promise<void>
  setStatus(opts: {
    listening: boolean
    paused?: boolean
    capture?: string
    hint?: string
    original?: string
    translation?: string
    previous?: string
    history?: WatchHistItem[]
    mode?: string
    langPair?: string
    ended?: boolean
    elapsedMs?: number
    save?: string
    sessionId?: string
    engine?: string
  }): Promise<void>
  shareFile(opts: { data: string; name: string }): Promise<void>
  saveToFiles(opts: {
    files: Array<{ data: string; name: string }>
    remotes?: Array<{ url: string; name: string; token?: string }>
  }): Promise<void>
  playSpeech(opts: { data: string; dest?: 'phone' | 'watch' }): Promise<void>
  stopSpeech(): Promise<void>
}
