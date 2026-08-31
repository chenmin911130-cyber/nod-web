export interface NodAuthPlugin {
  google(opts: { url: string }): Promise<{ url?: string; token?: string }>
}
