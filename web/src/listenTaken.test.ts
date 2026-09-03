import { LISTEN_TAKEN_TEXT, shouldReleaseListen } from './listenTaken'

if (!shouldReleaseListen({ type: 'listen_taken', text: LISTEN_TAKEN_TEXT })) {
  throw new Error('listen_taken must release the local listen latch')
}

if (!shouldReleaseListen({ type: 'quota_exceeded' })) {
  throw new Error('quota_exceeded must still release the listen latch')
}

if (!shouldReleaseListen({ type: 'error', text: 'Transcription connection lost. Tap Start Listening.' })) {
  throw new Error('a dropped STT socket must still release the listen latch')
}

if (shouldReleaseListen({ type: 'error', text: 'Generation failed: network error. Please try again.' })) {
  throw new Error('an LLM error must not stop listening')
}

if (shouldReleaseListen({ type: 'status', text: LISTEN_TAKEN_TEXT })) {
  throw new Error('status text alone must not release listen')
}

if (shouldReleaseListen({ type: 'state' })) {
  throw new Error('idle captions must not clear listenWanted or reconnect cannot resume')
}
