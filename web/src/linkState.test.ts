import { applyLinkEvent, listenChromeLinkLabel, listenLinkBanner } from './linkState'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const copy = {
  linkReconnecting: 'Connection lost — reconnecting. Speech during this gap may not be captured.',
  linkWaitingForNotes: 'Waiting for network to generate notes',
}

const bannerCopy = {
  ...copy,
  linkLiveOnlyDown: 'Live view interrupted — recording is still uploading.',
  linkBothDown:
    'Network lost — recording is kept on the phone (up to about 5 min) and uploads when back online.',
  linkUplinkDown: 'Recording upload interrupted — reconnecting…',
  linkBackfilling: 'Uploading offline recording (about {secs} s left)',
}

const zhBannerCopy = {
  linkReconnecting: '连接中断，正在重连… 这段时间的语音可能没有被记录',
  linkWaitingForNotes: '等待网络恢复后生成笔记',
  linkLiveOnlyDown: '实时显示中断，录音仍在上传',
  linkBothDown: '网络中断，录音暂存在手机（最多约 5 分钟），恢复后自动补传',
  linkUplinkDown: '录音上传中断，正在重连…',
  linkBackfilling: '正在补传离线录音（剩余约 {secs} 秒）',
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

// Truth table (uplink enabled)
eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: true, connected: true, pendingMs: 0 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  bannerCopy.linkLiveOnlyDown,
  'reconnecting + uplink connected → live only down',
)
eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  bannerCopy.linkBothDown,
  'reconnecting + uplink disconnected → both down',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  bannerCopy.linkUplinkDown,
  'online + uplink disconnected → uplink down',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: true, pendingMs: 5000 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  '',
  'online + connected + pending 5000 → empty',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: true, pendingMs: 5001 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  'Uploading offline recording (about 6 s left)',
  'online + connected + pending 5001 → backfill secs 6',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: true, pendingMs: 12345 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  'Uploading offline recording (about 13 s left)',
  'online + connected + pending 12345 → backfill secs 13',
)

// uplink null → same as listenChromeLinkLabel
for (const link of ['online', 'reconnecting'] as const) {
  for (const capture of ['listening', 'off'] as const) {
    for (const ended of [false, true] as const) {
      const want = listenChromeLinkLabel({ link, capture, ended, ...copy })
      eq(
        listenLinkBanner({ link, uplink: null, capture, ended, copy: bannerCopy }),
        want,
        `uplink null ${link} ${capture} ended=${ended}`,
      )
    }
  }
}

eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: false, connected: false, pendingMs: 0 },
    capture: 'listening',
    ended: false,
    copy: bannerCopy,
  }),
  copy.linkReconnecting,
  'uplink disabled → chrome label',
)

eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: true, connected: true, pendingMs: 0 },
    capture: 'listening',
    ended: true,
    copy: bannerCopy,
  }),
  copy.linkWaitingForNotes,
  'ended wins over live-only down',
)

eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: false, pendingMs: 99999 },
    capture: 'off',
    ended: false,
    copy: bannerCopy,
  }),
  '',
  'capture off → empty',
)

eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: true, pendingMs: 6000 },
    capture: 'listening',
    ended: false,
    copy: zhBannerCopy,
  }),
  '正在补传离线录音（剩余约 6 秒）',
  'zh backfill placeholder',
)

// v2 F1 / F3 / F6
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: 'listening',
    ended: true,
    copy: bannerCopy,
  }),
  '',
  'v2: ended × online × uplink down → empty',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: true, pendingMs: 30000 },
    capture: 'listening',
    ended: true,
    copy: bannerCopy,
  }),
  '',
  'v2: ended × online × backfill pending → empty',
)
eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: 'listening',
    ended: true,
    copy: bannerCopy,
  }),
  copy.linkWaitingForNotes,
  'v2: ended × reconnecting × both down → wait notes',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: 'paused',
    ended: false,
    copy: bannerCopy,
  }),
  '',
  'v2: paused × online × uplink down → empty',
)
eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: true, connected: true, pendingMs: 0 },
    capture: 'paused',
    ended: false,
    copy: bannerCopy,
  }),
  copy.linkReconnecting,
  'v2: paused × reconnecting × uplink up → chrome reconnecting',
)
eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: '',
    ended: false,
    copy: bannerCopy,
  }),
  '',
  'v2: empty capture × online × uplink down → empty',
)

const offUplinkVariants = [
  null,
  { enabled: true, connected: true, pendingMs: 0 },
  { enabled: true, connected: false, pendingMs: 0 },
  { enabled: true, connected: true, pendingMs: 30000 },
] as const
for (const link of ['online', 'reconnecting'] as const) {
  for (const uplink of offUplinkVariants) {
    eq(
      listenLinkBanner({ link, uplink, capture: 'off', ended: false, copy: bannerCopy }),
      '',
      `v2: capture off ${link} uplink=${uplink == null ? 'null' : 'set'}`,
    )
  }
}

for (const capture of ['listening', 'recording', 'off', 'paused'] as const) {
  const want = listenChromeLinkLabel({ link: 'reconnecting', capture, ended: false, ...copy })
  eq(
    listenLinkBanner({
      link: 'reconnecting',
      uplink: { enabled: false, connected: false, pendingMs: 0 },
      capture,
      ended: false,
      copy: bannerCopy,
    }),
    want,
    `v2: uplink disabled reconnecting capture=${capture}`,
  )
}

eq(
  listenLinkBanner({
    link: 'online',
    uplink: { enabled: true, connected: false, pendingMs: 0 },
    capture: 'recording',
    ended: false,
    copy: bannerCopy,
  }),
  bannerCopy.linkUplinkDown,
  'v2: recording is active → uplink down',
)
eq(
  listenLinkBanner({
    link: 'reconnecting',
    uplink: { enabled: true, connected: true, pendingMs: 0 },
    capture: 'recording',
    ended: false,
    copy: bannerCopy,
  }),
  bannerCopy.linkLiveOnlyDown,
  'v2: recording is active → live only down',
)

console.log('linkState.test.ts: ok')
