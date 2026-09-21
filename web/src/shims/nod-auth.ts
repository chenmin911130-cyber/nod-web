import { registerPlugin } from '@capacitor/core'

export type NodAuthAppleResult = {
  identityToken: string
  authorizationCode?: string
  user: string
  email?: string
  givenName?: string
  familyName?: string
}

export interface NodAuthPlugin {
  google(opts: { url: string }): Promise<{ url?: string; token?: string }>
  apple(opts: { nonce: string }): Promise<NodAuthAppleResult>
}

/** Web/Railway build stub; native iOS resolves the real NodAuth Capacitor plugin by name. */
export const NodAuth = registerPlugin<NodAuthPlugin>('NodAuth', {
  web: () =>
    Promise.resolve({
      google: async () => {
        throw new Error('NodAuth is iOS-only.')
      },
      apple: async () => {
        throw new Error('NodAuth is iOS-only.')
      },
    }),
})
