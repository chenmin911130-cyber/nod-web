import {
  isWatchMicPreferred,
  setPreferWatchMic,
  takePhoneMic,
  watchFileShouldStartListen,
  watchListenControlShouldApplyMode,
  watchListenMode,
  watchPcmShouldClaimMic,
  watchQueuedCommandShouldRun,
  watchShouldApplyMode,
  watchFlushShouldSend,
  watchLiveStreamShouldReset,
  watchPcmShouldBuffer,
  watchSpeechShouldPlay,
  watchWorkspaceForMode,
} from './watch'

if (watchPcmShouldClaimMic()) {
  throw new Error('watch PCM must not steal the phone microphone')
}

if (watchFileShouldStartListen()) {
  throw new Error('a leftover Watch file must not start_listen')
}

if (watchSpeechShouldPlay('file') || watchSpeechShouldPlay('context') || watchSpeechShouldPlay('queued')) {
  throw new Error('opening the Watch app must not auto-play leftover speech')
}

if (!watchSpeechShouldPlay('live')) {
  throw new Error('a live Watch speech push while the app is open may still play')
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

if (watchListenMode('start') || watchListenMode('') || watchListenMode({})) {
  throw new Error('a leftover Watch payload must not be treated as a listen mode')
}

if (watchListenMode('Lecture') !== 'lecture' || watchListenMode('translate') !== 'translate') {
  throw new Error('Watch mode chips must map to meeting / lecture / interview / translate')
}

const lecture = watchWorkspaceForMode('lecture')
if (lecture.workspace !== 'meeting' || lecture.scene !== 'lecture') {
  throw new Error('Lecture on the Watch must open the phone Meeting workspace on the lecture scene')
}

const interview = watchWorkspaceForMode('interview')
if (interview.workspace !== 'interview' || interview.scene !== 'interview') {
  throw new Error('Interview on the Watch must open the phone Q&A workspace')
}

if (watchWorkspaceForMode('translate').workspace !== 'translate' || watchWorkspaceForMode('translate').scene) {
  throw new Error('Translate on the Watch must not overwrite the phone listen scene')
}

if (watchShouldApplyMode('', { workspaceMode: 'meeting', listenScene: 'meeting' })) {
  throw new Error('Listen without a mode must keep the phone workspace')
}

if (watchShouldApplyMode('meeting', { workspaceMode: 'meeting', listenScene: 'meeting' })) {
  throw new Error('the same Watch mode must not re-apply workspace')
}

const toInterview = watchShouldApplyMode('interview', { workspaceMode: 'meeting', listenScene: 'lecture' })
if (!toInterview || toInterview.workspace !== 'interview' || toInterview.scene !== 'interview') {
  throw new Error('Watch Interview + Listen must switch the phone to Q&A before start_listen')
}

const toLecture = watchShouldApplyMode('lecture', { workspaceMode: 'meeting', listenScene: 'meeting' })
if (!toLecture || toLecture.workspace !== 'meeting' || toLecture.scene !== 'lecture') {
  throw new Error('Watch Lecture + Listen must switch the phone Meeting scene before start_listen')
}

if (
  watchListenControlShouldApplyMode({ action: 'pause', sessionPaused: false, run: 'listen' })
  || watchListenControlShouldApplyMode({ action: 'resume', sessionPaused: true, run: 'idle' })
  || watchListenControlShouldApplyMode({ action: 'stop', sessionPaused: false, run: 'listen' })
) {
  throw new Error('Pause / Resume / Done must not switch Meeting / Interview / Translate')
}

if (watchListenControlShouldApplyMode({ action: 'start', sessionPaused: true, run: 'idle' })) {
  throw new Error('Watch resume after Pause must keep the phone workspace')
}

if (watchListenControlShouldApplyMode({ action: 'record', sessionPaused: false, run: 'listen' })) {
  throw new Error('Watch Record while already listening must stop, not switch mode')
}

if (watchFileShouldStartListen() || watchListenControlShouldApplyMode({ action: '', sessionPaused: false, run: 'idle' })) {
  throw new Error('a leftover Watch file or empty action must not apply a mode or start_listen')
}

if (
  !watchListenControlShouldApplyMode({ action: 'start', sessionPaused: false, run: 'idle' })
  || !watchListenControlShouldApplyMode({ action: 'record', sessionPaused: false, run: 'idle' })
) {
  throw new Error('Watch Listen / Record from idle must still apply the selected mode then start_listen')
}

if (watchQueuedCommandShouldRun('start', Date.now() / 1000 - 120, Date.now() / 1000)) {
  throw new Error('a stale queued Watch start must not start_listen or apply Interview / Translate')
}

if (watchPcmShouldBuffer(true)) {
  throw new Error('reachable Watch PCM must go live, not sit in the unsent buffer')
}

if (!watchPcmShouldBuffer(false)) {
  throw new Error('unreachable Watch PCM must buffer for transferFile')
}

if (!watchLiveStreamShouldReset(true, false)) {
  throw new Error('a drop during Listen must reset liveStreamed so the tail can flush')
}

if (watchLiveStreamShouldReset(false, false) || watchLiveStreamShouldReset(true, true)) {
  throw new Error('liveStreamed must stay put when idle or still reachable')
}

if (!watchFlushShouldSend(3200) || watchFlushShouldSend(0)) {
  throw new Error('Done must flush leftover PCM and skip an empty buffer')
}

if (watchFileShouldStartListen()) {
  throw new Error('a disconnect flush file must stay PCM-only and must not start_listen')
}
