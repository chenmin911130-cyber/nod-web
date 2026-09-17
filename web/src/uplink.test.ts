import { nativeFallbackShouldSwitch } from './audio'
import { IPHONE_COPY } from './iphoneCopy'
import { audioUplinkWsUrl, controlWsUrl, shouldEmitUplinkNotice, uplinkFailureFromError, uplinkFailureLog, uplinkShouldForwardPcmFromJs, uplinkTokenAction, uplinkTokenAfterNativeStart } from './uplink'

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

eq(
  uplinkFailureFromError({ code: 'UNIMPLEMENTED', message: '"NodMic.startUplink()" is not implemented on ios' }).text,
  IPHONE_COPY.uplinkUnavailable,
  'missing native method becomes a short background-recording notice',
)
eq(
  uplinkFailureFromError({ code: 'UNIMPLEMENTED', message: '"NodMic.startUplink()" is not implemented on ios' }).text.includes('startUplink'),
  false,
  'user copy must not include the plugin method name',
)
eq(
  uplinkFailureFromError({ message: 'connection failed' }).text,
  IPHONE_COPY.uplinkFailed,
  'generic uplink failure still lets foreground recording continue',
)
{
  const logged = uplinkFailureLog({
    code: 'UNIMPLEMENTED',
    message: '"NodMic.startUplink()" is not implemented on ios token=secret-token-value',
  })
  eq(logged.code, 'UNIMPLEMENTED', 'diagnostic log keeps the Capacitor code')
  eq(logged.message.includes('startUplink'), true, 'diagnostic log keeps the method name')
  eq(logged.message.includes('secret-token-value'), false, 'diagnostic log strips token values')
}
eq(shouldEmitUplinkNotice('', IPHONE_COPY.uplinkUnavailable), true, 'first uplink failure is shown')
eq(shouldEmitUplinkNotice(IPHONE_COPY.uplinkUnavailable, IPHONE_COPY.uplinkUnavailable), false, 'duplicate uplink failure is not emitted again')
eq(shouldEmitUplinkNotice(IPHONE_COPY.uplinkUnavailable, IPHONE_COPY.uplinkFailed), true, 'a different uplink failure replaces the notice')

// #279: a control re-attach re-announcing the same token must never open a second
// /ws/audio; one native uplink socket at a time.
eq(
  uplinkTokenAction({ token: 'tok-1', activeToken: 'tok-1', startingToken: '' }),
  'ignore',
  'same token while uplink is live is ignored',
)
eq(
  uplinkTokenAction({ token: 'tok-1', activeToken: '', startingToken: 'tok-1' }),
  'ignore',
  'same token while a start is in flight is ignored',
)
eq(
  uplinkTokenAction({ token: 'tok-2', activeToken: '', startingToken: 'tok-1' }),
  'ignore',
  'a different token cannot stack a second start',
)
eq(
  uplinkTokenAction({ token: '', activeToken: 'tok-1', startingToken: '' }),
  'ignore',
  'an empty token is ignored',
)
eq(
  uplinkTokenAction({ token: 'tok-1', activeToken: '', startingToken: '' }),
  'start',
  'first token starts the uplink',
)
eq(
  uplinkTokenAction({ token: 'tok-2', activeToken: 'tok-1', startingToken: '' }),
  'replace',
  'a genuinely new token replaces the live uplink instead of running two',
)

console.log('uplink.test.ts: ok')
