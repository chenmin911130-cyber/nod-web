import {
  isWatchMicPreferred,
  setPreferWatchMic,
  takePhoneMic,
  watchFileShouldStartListen,
  watchPcmShouldClaimMic,
  watchQueuedCommandShouldRun,
} from './watch'

if (watchPcmShouldClaimMic()) {
  throw new Error('watch PCM must not steal the phone microphone')
}

if (watchFileShouldStartListen()) {
  throw new Error('a leftover Watch file must not start_listen')
}

if (watchQueuedCommandShouldRun('start', undefined, Date.now() / 1000)) {
  throw new Error('a queued Watch start without a timestamp must not start_listen')
}

if (watchQueuedCommandShouldRun('start', Date.now() / 1000 - 120, Date.now() / 1000)) {
  throw new Error('a Watch start queued two minutes ago must not start_listen')
}

if (!watchQueuedCommandShouldRun('start', Date.now() / 1000 - 2, Date.now() / 1000)) {
  throw new Error('a Watch start queued two seconds ago is a real tap and must run')
}

setPreferWatchMic(true)
takePhoneMic()
if (isWatchMicPreferred()) {
  throw new Error('Start Listening on the phone must take the phone mic back')
}

setPreferWatchMic(true)
if (!isWatchMicPreferred()) {
  throw new Error('Watch start/record must still be able to prefer the watch mic')
}
