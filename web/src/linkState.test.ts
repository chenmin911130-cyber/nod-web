import { applyLinkEvent, listenChromeLinkLabel } from './linkState'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const copy = {
  linkReconnecting: 'Connection lost — reconnecting. Speech during this gap may not be captured.',
  linkWaitingForNotes: 'Waiting for network to generate notes',
}

eq(applyLinkEvent('online', { type: 'disconnected' }), 'reconnecting', 'disconnected → reconnecting')
eq(applyLinkEvent('reconnecting', { type: 'ready' }), 'online', 'ready → online')
eq(applyLinkEvent('reconnecting', { type: 'phase' }), 'online', 'phase → online')
eq(applyLinkEvent('reconnecting', { type: 'status' }), 'reconnecting', 'status stays reconnecting')
eq(applyLinkEvent('reconnecting', { type: 'question' }), 'reconnecting', 'question stays reconnecting')
eq(applyLinkEvent('reconnecting', { type: 'disconnected' }), 'reconnecting', 'double disconnected')

eq(
  listenChromeLinkLabel({ link: 'online', capture: 'listening', ended: false, ...copy }),
  '',
  'online → empty',
)
eq(
  listenChromeLinkLabel({ link: 'reconnecting', capture: 'listening', ended: false, ...copy }),
  copy.linkReconnecting,
  'reconnecting + listening',
)
eq(
  listenChromeLinkLabel({ link: 'reconnecting', capture: 'paused', ended: false, ...copy }),
  copy.linkReconnecting,
  'reconnecting + paused',
)
eq(
  listenChromeLinkLabel({ link: 'reconnecting', capture: 'off', ended: false, ...copy }),
  '',
  'reconnecting + off + !ended',
)
eq(
  listenChromeLinkLabel({ link: 'reconnecting', capture: 'listening', ended: true, ...copy }),
  copy.linkWaitingForNotes,
  'reconnecting + ended → wait notes',
)

console.log('linkState.test.ts: ok')
