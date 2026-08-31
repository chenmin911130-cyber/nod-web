import { shouldReacquirePhoneMic } from './audio'

if (
  !shouldReacquirePhoneMic({
    nativeApp: true,
    running: true,
    watchPreferred: false,
    hasNativeHandle: false,
    hasStream: false,
  })
) {
  throw new Error('phone Start after a Watch dummy session must reopen the phone mic')
}

if (
  shouldReacquirePhoneMic({
    nativeApp: true,
    running: true,
    watchPreferred: true,
    hasNativeHandle: false,
    hasStream: false,
  })
) {
  throw new Error('Watch-preferred listen must keep skipping the phone mic')
}

if (
  shouldReacquirePhoneMic({
    nativeApp: true,
    running: true,
    watchPreferred: false,
    hasNativeHandle: true,
    hasStream: false,
  })
) {
  throw new Error('an already-open NodMic session must not restart')
}

if (
  shouldReacquirePhoneMic({
    nativeApp: false,
    running: true,
    watchPreferred: false,
    hasNativeHandle: false,
    hasStream: false,
  })
) {
  throw new Error('web listen must not use the native reacquire path')
}
