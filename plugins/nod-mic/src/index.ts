import { registerPlugin } from '@capacitor/core'
import type { NodMicPlugin } from './definitions'

const NodMic = registerPlugin<NodMicPlugin>('NodMic', {
  web: () => import('./web').then((m) => new m.NodMicWeb()),
})

export * from './definitions'
export { NodMic }
