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
    save?: string
    sessionId?: string
    pcmDrained?: boolean
    pcmDrainedCaptureId?: string
    pcmDrainedSessionId?: string
    pcmDrainedByte?: number
    pcmAckCaptureId?: string
    pcmAckSessionId?: string
  }): Promise<void>
  shareFile(opts: { data: string; name: string }): Promise<void>
  saveToFiles(opts: {
    files: Array<{ data: string; name: string }>
    remotes?: Array<{ url: string; name: string; token?: string }>
  }): Promise<void>
  playSpeech(opts: { data: string; dest?: 'phone' | 'watch' }): Promise<void>
  stopSpeech(): Promise<void>
  storeAccount(opts: { token: string; origin: string }): Promise<void>
  listSaves(): Promise<{ saves: Array<{ sessionId: string; captureId: string; save: string; error?: string }> }>
  retrySave(opts: { sessionId: string }): Promise<void>
  resumeKeeps(): Promise<void>
}
