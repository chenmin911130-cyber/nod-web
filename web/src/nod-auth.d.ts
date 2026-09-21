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

export const NodAuth: NodAuthPlugin
