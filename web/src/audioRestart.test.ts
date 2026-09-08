import { phoneShouldKeepAlive, shouldReacquirePhoneMic, shouldReleasePhoneMicForWatch } from './audio'

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

if (
  !shouldReleasePhoneMicForWatch({
    running: true,
    watchPreferred: true,
    hasPhoneCapture: true,
  })
) {
  throw new Error('Watch Translate Start must release an already-open phone mic')
}

if (
  shouldReleasePhoneMicForWatch({
    running: true,
    watchPreferred: true,
    hasPhoneCapture: false,
  })
) {
  throw new Error('a Watch dummy session has no phone capture to release')
}

if (
  shouldReleasePhoneMicForWatch({
    running: true,
    watchPreferred: false,
    hasPhoneCapture: true,
  })
) {
  throw new Error('phone Start must keep the phone mic')
}

if (!phoneShouldKeepAlive({ nativeApp: true, watchPreferred: true })) {
  throw new Error('Watch-mic native listen must start phone keep-alive')
}
if (phoneShouldKeepAlive({ nativeApp: false, watchPreferred: true })) {
  throw new Error('web listen must not start native keep-alive')
}
if (phoneShouldKeepAlive({ nativeApp: true, watchPreferred: false })) {
  throw new Error('phone mic keep-alive is owned by beginCapture, not startKeepAlive')
}
