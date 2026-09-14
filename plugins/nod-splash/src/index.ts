import { registerPlugin } from '@capacitor/core'
import type { NodSplashPlugin } from './definitions'

const NodSplash = registerPlugin<NodSplashPlugin>('NodSplash', {
  web: () => import('./web').then((m) => new m.NodSplashWeb()),
})

export * from './definitions'
export { NodSplash }
