import { keepAliveShouldRun, nativeFallbackShouldSwitch } from './audio'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(keepAliveShouldRun({ nativeApp: true, watchPreferred: true }), true, 'native + watch mic → keep-alive')
eq(keepAliveShouldRun({ nativeApp: true, watchPreferred: false }), false, 'native + phone mic → no keep-alive')
eq(keepAliveShouldRun({ nativeApp: false, watchPreferred: true }), false, 'web + watch preferred → no keep-alive')
eq(keepAliveShouldRun({ nativeApp: false, watchPreferred: false }), false, 'web + phone mic → no keep-alive')

eq(
  nativeFallbackShouldSwitch({ hidden: true, running: true, hasStream: false }),
  false,
  'lock screen must not switch native mic to web',
)
eq(
  nativeFallbackShouldSwitch({ hidden: false, appActive: false, running: true, hasStream: false }),
  false,
  'iOS lock often leaves document.hidden false; Capacitor isActive=false must still block the switch',
)
eq(
  nativeFallbackShouldSwitch({ hidden: false, running: true, hasStream: false }),
  true,
  'foreground native silence may fall back to web',
)
eq(
  nativeFallbackShouldSwitch({ hidden: false, running: true, hasStream: true }),
  false,
  'web stream already open must not switch',
)
eq(
  nativeFallbackShouldSwitch({ hidden: false, running: false, hasStream: false }),
  false,
  'idle mic must not switch',
)
