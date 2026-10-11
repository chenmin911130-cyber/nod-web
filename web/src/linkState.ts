export type LinkState = 'online' | 'reconnecting'

export type UplinkLinkState = { enabled: boolean; connected: boolean; pendingMs: number }

export function applyLinkEvent(prev: LinkState, ev: { type: string }): LinkState {
  if (ev.type === 'disconnected') return 'reconnecting'
  if (ev.type === 'ready' || ev.type === 'phase') return 'online'
  return prev
}

export function listenChromeLinkLabel(input: {
  link: LinkState
  capture: string
  ended: boolean
  linkReconnecting: string
  linkWaitingForNotes: string
}): string {
  if (input.link !== 'reconnecting') return ''
  if (input.ended) return input.linkWaitingForNotes
  if (input.capture === 'off') return ''
  return input.linkReconnecting
}

export function listenLinkBanner(input: {
  link: LinkState
  uplink: UplinkLinkState | null
  capture: string
  ended: boolean
  copy: {
    linkReconnecting: string
    linkWaitingForNotes: string
    linkLiveOnlyDown: string
    linkBothDown: string
    linkUplinkDown: string
    linkBackfilling: string
  }
}): string {
  const active = input.capture === 'listening' || input.capture === 'recording'
  if (input.uplink == null || !input.uplink.enabled || input.ended || !active) {
    return listenChromeLinkLabel({
      link: input.link,
      capture: input.capture,
      ended: input.ended,
      linkReconnecting: input.copy.linkReconnecting,
      linkWaitingForNotes: input.copy.linkWaitingForNotes,
    })
  }
  const { connected, pendingMs } = input.uplink
  if (input.link === 'reconnecting') {
    return connected ? input.copy.linkLiveOnlyDown : input.copy.linkBothDown
  }
  if (!connected) {
    return input.copy.linkUplinkDown
  }
  if (pendingMs > 5000) {
    const secs = Math.ceil(pendingMs / 1000)
    return input.copy.linkBackfilling.replace('{secs}', String(secs))
  }
  return ''
}
