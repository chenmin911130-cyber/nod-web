import { registerPlugin } from '@capacitor/core'
import type { NodWatchPlugin } from './definitions'

const NodWatch = registerPlugin<NodWatchPlugin>('NodWatch', {
  web: () => import('./web').then((m) => new m.NodWatchWeb()),
})

export * from './definitions'
export { NodWatch }
