/** JS must not also send PCM on the control socket while native uplink is live. */
export function uplinkShouldForwardPcmFromJs(opts: { nativeApp: boolean; hasToken: boolean }): boolean {
  return !opts.nativeApp || !opts.hasToken
}

/** Reconnect the control WS with `?attach=` so the server can reclaim a parked Session. */
export function controlWsUrl(base: string, attachToken: string): string {
  if (!attachToken) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}attach=${encodeURIComponent(attachToken)}`
}

/** Native PCM socket. Always derived from the bare `/ws` URL, never the attach URL. */
export function audioUplinkWsUrl(controlUrl: string, token: string): string {
  const path = controlUrl.replace(/\/ws(?:\?.*)?$/, '/ws/audio')
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}token=${encodeURIComponent(token)}`
}
