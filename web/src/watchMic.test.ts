import {
  isWatchMicPreferred,
  setPreferWatchMic,
  takePhoneMic,
  watchFileShouldStartListen,
  watchCommandShouldSendMode,
  watchPhoneModeShouldApply,
  watchHardwareAction,
  watchListenControlShouldApplyMode,
  watchListenMode,
  watchPcmShouldClaimMic,
  watchQueuedCommandShouldRun,
  watchShouldApplyMode,
  watchStartShouldAttachMode,
  watchStartShouldPreferWatchMic,
  watchResumeShouldChangeMic,
  watchStartListenPayload,
  backlogShouldFlush,
  watchFallbackStopSequence,
  watchFlushShouldSend,
  watchLiveStreamShouldReset,
  watchPcmShouldBuffer,
  watchSpeechShouldPlay,
  watchSpeechFileShouldPlay,
  watchWorkspaceForMode,
  watchAction,
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

if (watchSpeechFileShouldPlay(undefined, 1_000) || watchSpeechFileShouldPlay(880, 1_000)) {
  throw new Error('a leftover Watch speech file must not play when the Watch app opens')
}
if (!watchSpeechFileShouldPlay(995, 1_000)) {
  throw new Error('a just-tapped Watch play file may still play on the wrist')
}
if (!watchSpeechFileShouldPlay(1_000 - 20, 1_000)) {
  throw new Error('a Play tap may take more than 8s to transferFile and must still speak')
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
  watchListenControlShouldApplyMode({ action: 'pause', paused: false, capture: 'listening' })
  || watchListenControlShouldApplyMode({ action: 'resume', paused: true, capture: 'off' })
  || watchListenControlShouldApplyMode({ action: 'stop', paused: false, capture: 'listening' })
) {
  throw new Error('Pause / Resume / Done must not switch Meeting / Interview / Translate')
}

if (watchListenControlShouldApplyMode({ action: 'start', paused: true, capture: 'off' })) {
  throw new Error('Watch resume after Pause must keep the phone workspace')
}

if (watchListenControlShouldApplyMode({ action: 'record', paused: false, capture: 'listening' })) {
  throw new Error('Watch Record while already listening must stop, not switch mode')
}

if (watchFileShouldStartListen() || watchListenControlShouldApplyMode({ action: '', paused: false, capture: 'off' })) {
  throw new Error('a leftover Watch file or empty action must not apply a mode or start_listen')
}

if (
  !watchListenControlShouldApplyMode({ action: 'start', paused: false, capture: 'off' })
  || !watchListenControlShouldApplyMode({ action: 'record', paused: false, capture: 'off' })
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

if (backlogShouldFlush({ unsentBytes: 3200, reachable: false, sinceLastFlushSec: 5 })) {
  throw new Error('unreachable Watch PCM must wait 20s before a background flush')
}
if (!backlogShouldFlush({ unsentBytes: 3200, reachable: false, sinceLastFlushSec: 20 })) {
  throw new Error('unreachable Watch PCM must flush after 20s')
}
if (!backlogShouldFlush({ unsentBytes: 3200, reachable: true, sinceLastFlushSec: 1 })) {
  throw new Error('reachable Watch PCM with a backlog must flush immediately')
}
if (backlogShouldFlush({ unsentBytes: 0, reachable: true, sinceLastFlushSec: 30 })) {
  throw new Error('an empty Watch backlog must not flush')
}

if (watchStartListenPayload(false).mic) {
  throw new Error('phone Start must not mark the listen session as watch mic')
}
if (watchStartListenPayload(true).mic !== 'watch') {
  throw new Error('Watch Start must send start_listen with mic=watch')
}

const fallbackStop = watchFallbackStopSequence()
if (fallbackStop[0] !== 'pump' || fallbackStop.indexOf('pump') > fallbackStop.indexOf('clearRunning')) {
  throw new Error('Watch fallback stop must pump leftover WAV bytes before clearing running')
}
if (fallbackStop.indexOf('stopRecorder') < 0 || fallbackStop.indexOf('stopRecorder') < fallbackStop.indexOf('pump')) {
  throw new Error('Watch fallback stop must pump before stopping the file recorder')
}

if (watchFileShouldStartListen()) {
  throw new Error('a disconnect flush file must stay PCM-only and must not start_listen')
}

if (watchAction('save') !== 'save' || watchAction('discard') !== 'discard') {
  throw new Error('Watch Save / Don\'t save must be session actions, not start_listen')
}
if (watchAction('retry') !== 'retry') {
  throw new Error('Watch Translate Retry must be a session action')
}
if (
  watchListenControlShouldApplyMode({ action: 'save', paused: false, capture: 'off' })
  || watchListenControlShouldApplyMode({ action: 'discard', paused: false, capture: 'off' })
) {
  throw new Error('Watch Save / Don\'t save must not switch Meeting / Interview / Translate')
}

for (const mode of ['meeting', 'lecture', 'interview', 'translate']) {
  if (!watchStartShouldPreferWatchMic({ fromWatch: true })) {
    throw new Error(`Watch Start must prefer the watch mic (mode ${mode} is irrelevant)`)
  }
  if (watchStartShouldPreferWatchMic({ fromWatch: false })) {
    throw new Error(`phone Start must keep the phone mic (mode ${mode} is irrelevant)`)
  }
}

setPreferWatchMic(false)
if (watchResumeShouldChangeMic()) {
  throw new Error('Watch Resume must not flip preferWatchMic; a phone-started Meeting would lose the phone mic')
}
if (watchResumeShouldChangeMic()) setPreferWatchMic(true)
if (isWatchMicPreferred()) {
  throw new Error('Watch Resume must leave a phone-mic session on the phone mic')
}

const idle = { listening: false, paused: false }
const live = { listening: true, paused: false }
const held = { listening: false, paused: true }
const saving = { listening: false, paused: false, ended: true, saving: true }

if (watchHardwareAction('crown', live) !== 'stop') {
  throw new Error('Digital Crown while listening must Stop, not Pause')
}
if (watchHardwareAction('crown', idle) !== 'start') {
  throw new Error('Digital Crown on Ready must Start')
}
if (watchHardwareAction('crown', held) !== 'stop') {
  throw new Error('Digital Crown while paused must Stop, not Resume')
}
if (watchHardwareAction('side', live) !== 'pause' || watchHardwareAction('side', held) !== 'resume') {
  throw new Error('Side button is Pause / Resume only')
}
if (watchHardwareAction('crown', saving) || watchHardwareAction('side', saving)) {
  throw new Error('hardware keys must not fire on Ended / Saving / Saved')
}
if (watchHardwareAction('crown', { listening: false, paused: false, ended: true }) || watchHardwareAction('side', { listening: false, paused: false, saved: true })) {
  throw new Error('hardware keys must not fire on Ended or Saved')
}
if (watchHardwareAction('crown', { listening: false, paused: false, starting: true }) || watchHardwareAction('side', { listening: true, paused: false, pending: 'pause' })) {
  throw new Error('hardware keys must not fire while Starting or Pause/Resume is pending')
}

if (!watchCommandShouldSendMode('start') || !watchCommandShouldSendMode('record')) {
  throw new Error('Watch Start / Record must send the selected mode so Translate can open')
}
if (watchStartShouldAttachMode(false)) {
  throw new Error('Watch Start must not send leftover Meeting before it has the phone workspace')
}
if (!watchStartShouldAttachMode(true)) {
  throw new Error('once the Watch has the phone workspace, Start may send Translate')
}
if (watchCommandShouldSendMode('stop') || watchCommandShouldSendMode('pause') || watchCommandShouldSendMode('resume')) {
  throw new Error('Pause / Resume / Stop must not switch Meeting / Interview / Translate')
}

if (watchPhoneModeShouldApply({ localModeHeld: true, watchListening: false, watchPaused: false })) {
  throw new Error('a Ready mode chip must not be overwritten by leftover phone mode')
}
if (!watchPhoneModeShouldApply({ localModeHeld: false, watchListening: false, watchPaused: false })) {
  throw new Error('opening the Watch may follow the phone workspace when the user has not picked')
}
if (watchPhoneModeShouldApply({ localModeHeld: true, watchListening: true, watchPaused: false })) {
  throw new Error('Watch Translate Start must not be overwritten by leftover phone Meeting')
}
