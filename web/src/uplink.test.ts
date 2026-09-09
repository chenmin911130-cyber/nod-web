import { nativeFallbackShouldSwitch } from './audio'
import { audioUplinkWsUrl, controlWsUrl, uplinkShouldForwardPcmFromJs, uplinkTokenAfterNativeStart } from './uplink'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(uplinkShouldForwardPcmFromJs({ nativeApp: false, hasToken: false }), true, 'web without token still sends PCM on JS WS')
eq(uplinkShouldForwardPcmFromJs({ nativeApp: false, hasToken: true }), true, 'web ignores native token and still sends PCM on JS WS')
eq(uplinkShouldForwardPcmFromJs({ nativeApp: true, hasToken: false }), true, 'native without a successful uplink start still forwards PCM from JS')
eq(uplinkShouldForwardPcmFromJs({ nativeApp: true, hasToken: true }), false, 'native only stops JS PCM after startUplink resolves')
eq(uplinkTokenAfterNativeStart(false, 'tok-1'), '', 'failed startUplink must not arm the JS token')
eq(uplinkTokenAfterNativeStart(true, 'tok-1'), 'tok-1', 'successful startUplink arms the JS token')

eq(
  nativeFallbackShouldSwitch({
    hidden: false,
    running: true,
    hasStream: false,
    uplinkActive: true,
  }),
  false,
  'uplink mode must not switch native mic to web when JS has no pcm events',
)

eq(controlWsUrl('wss://nodpilot.com/ws', ''), 'wss://nodpilot.com/ws', 'empty token keeps the bare control URL')
eq(
  controlWsUrl('wss://nodpilot.com/ws', 'tok-1'),
  'wss://nodpilot.com/ws?attach=tok-1',
  'reconnect URL carries attach',
)
eq(
  audioUplinkWsUrl('wss://nodpilot.com/ws', 'tok-1'),
  'wss://nodpilot.com/ws/audio?token=tok-1',
  'native uplink URL is /ws/audio?token=',
)
eq(
  audioUplinkWsUrl('wss://nodpilot.com/ws?attach=old', 'tok-1'),
  'wss://nodpilot.com/ws/audio?token=tok-1',
  'audio URL is never built from the attach query',
)

console.log('uplink.test.ts: ok')
