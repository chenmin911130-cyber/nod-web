export type WatchHistItem = { id: string; title: string; text: string }

export interface NodWatchPlugin {
  ready(): Promise<void>
  setStatus(opts: {
    listening: boolean
    hint?: string
    original?: string
    translation?: string
    history?: WatchHistItem[]
  }): Promise<void>
  shareFile(opts: { data: string; name: string }): Promise<void>
  playSpeech(opts: { data: string }): Promise<void>
}
