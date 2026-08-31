import { registerPlugin } from '@capacitor/core'
import type { NodAuthPlugin } from './definitions'

const NodAuth = registerPlugin<NodAuthPlugin>('NodAuth', {
  web: () => import('./web').then((m) => new m.NodAuthWeb()),
})

export * from './definitions'
export { NodAuth }
