export type LinkState = 'online' | 'reconnecting'

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
