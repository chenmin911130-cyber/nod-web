import {
  isWatchMicPreferred,
  setPreferWatchMic,
  takePhoneMic,
  watchFileShouldStartListen,
  watchCommandShouldSendMode,
  watchPhoneListenSync,
  watchPhoneModeShouldApply,
  watchHardwareAction,
  watchListenControlShouldApplyMode,
  watchListenMode,
  watchPcmShouldClaimMic,
  watchQueuedCommandShouldRun,
  watchShouldApplyMode,
  watchStartShouldAttachMode,
  watchStartShouldClearPhoneListenLatch,
  watchStartShouldPreferWatchMic,
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
if (
  watchListenControlShouldApplyMode({ action: 'save', sessionPaused: false, run: 'idle' })
  || watchListenControlShouldApplyMode({ action: 'discard', sessionPaused: false, run: 'idle' })
) {
  throw new Error('Watch Save / Don\'t save must not switch Meeting / Interview / Translate')
}

if (watchStartShouldPreferWatchMic('meeting') || watchStartShouldPreferWatchMic('lecture')) {
  throw new Error('Meeting / Lecture Watch Start must keep the phone mic')
}
if (!watchStartShouldPreferWatchMic('interview') || !watchStartShouldPreferWatchMic('translate')) {
  throw new Error('Live Q&A / Translate Watch Start may use the watch mic')
}

const idle = { listening: false, paused: false, offeringSave: false, saved: false }
const live = { listening: true, paused: false, offeringSave: false, saved: false }
const held = { listening: false, paused: true, offeringSave: false, saved: false }
const saving = { listening: false, paused: false, offeringSave: true, saved: false }

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
  throw new Error('hardware keys must not fire on the Save prompt')
}

if (watchPhoneListenSync({
  phoneListening: false,
  phonePaused: false,
  watchListening: true,
  watchPaused: false,
  sawPhoneListening: true,
}) !== 'stop') {
  throw new Error('iPhone Stop must stop a Watch that is still listening')
}

if (watchPhoneListenSync({
  phoneListening: false,
  phonePaused: false,
  watchListening: false,
  watchPaused: true,
  sawPhoneListening: true,
}) !== 'stop') {
  throw new Error('iPhone Stop must stop a paused Watch')
}

if (watchPhoneListenSync({
  phoneListening: false,
  phonePaused: true,
  watchListening: true,
  watchPaused: false,
  sawPhoneListening: true,
}) !== 'pause') {
  throw new Error('iPhone Pause must pause the Watch, not leave it listening')
}

if (watchPhoneListenSync({
  phoneListening: false,
  phonePaused: false,
  watchListening: true,
  watchPaused: false,
  sawPhoneListening: false,
}) !== 'ignore') {
  throw new Error('a stale phone idle after Watch Start must not stop Translate')
}

if (watchPhoneListenSync({
  phoneListening: true,
  phonePaused: false,
  watchListening: false,
  watchPaused: false,
}) !== 'ignore') {
  throw new Error('leftover phone listening=true must not start_listen on the Watch')
}

if (watchPhoneListenSync({
  phoneListening: false,
  phonePaused: false,
  watchListening: false,
  watchPaused: false,
}) !== 'ignore') {
  throw new Error('an idle Watch must stay idle when the phone is idle')
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
if (!watchStartShouldClearPhoneListenLatch('start') || !watchStartShouldClearPhoneListenLatch('record')) {
  throw new Error('Watch Start / Record must drop the leftover phone-listen latch')
}
if (watchStartShouldClearPhoneListenLatch('stop') || watchStartShouldClearPhoneListenLatch('pause')) {
  throw new Error('Pause / Stop must keep the phone-listen latch so iPhone Stop still moves the Watch')
}

// --- Exhaustive state matrix for watchPhoneListenSync ---
// The bug that bit translate → Live Q&A: the phone reports listening=false while it is
// merely busy (think). Enumerate every branch so a future change cannot regress one cell.
function eqSync(input: {
  phoneListening: boolean
  phonePaused: boolean
  watchListening: boolean
  watchPaused: boolean
  watchRecording?: boolean
  sawPhoneListening: boolean
}, expected: string, msg: string): void {
  const got = watchPhoneListenSync({
    phoneListening: input.phoneListening,
    phonePaused: input.phonePaused,
    watchListening: input.watchListening,
    watchPaused: input.watchPaused,
    watchRecording: input.watchRecording ?? false,
    sawPhoneListening: input.sawPhoneListening,
  })
  if (got !== expected) throw new Error(`${msg}: expected ${expected}, got ${got}`)
}

// Group A — phone is actively listening: never move the Watch.
eqSync({ phoneListening: true, phonePaused: false, watchListening: true, watchPaused: false, sawPhoneListening: true }, 'ignore', 'phone listening=true must always ignore')
eqSync({ phoneListening: true, phonePaused: true, watchListening: false, watchPaused: true, watchRecording: true, sawPhoneListening: false }, 'ignore', 'phone listening=true ignores even a whacky Watch state')

// Group B — we never saw the phone listening: a false push is stale, ignore.
eqSync({ phoneListening: false, phonePaused: false, watchListening: true, watchPaused: false, sawPhoneListening: false }, 'ignore', 'no phone-listen latch must ignore a stop')
eqSync({ phoneListening: false, phonePaused: false, watchListening: false, watchPaused: true, sawPhoneListening: false }, 'ignore', 'no latch + paused watch must ignore')
eqSync({ phoneListening: false, phonePaused: false, watchListening: false, watchPaused: false, watchRecording: true, sawPhoneListening: false }, 'ignore', 'no latch + recording watch must ignore')

// Group C — phone not listening, not paused, latch set = real phone Stop.
eqSync({ phoneListening: false, phonePaused: false, watchListening: true, watchPaused: false, sawPhoneListening: true }, 'stop', 'phone stop must stop a listening Watch')
eqSync({ phoneListening: false, phonePaused: false, watchListening: false, watchPaused: true, sawPhoneListening: true }, 'stop', 'phone stop must stop a paused Watch')
eqSync({ phoneListening: false, phonePaused: false, watchListening: false, watchPaused: false, watchRecording: true, sawPhoneListening: true }, 'stop', 'phone stop must stop a recording Watch')
eqSync({ phoneListening: false, phonePaused: false, watchListening: false, watchPaused: false, sawPhoneListening: true }, 'ignore', 'phone stop must ignore an already-stopped Watch')

// Group D — phone paused, latch set = real phone Pause.
eqSync({ phoneListening: false, phonePaused: true, watchListening: true, watchPaused: false, sawPhoneListening: true }, 'pause', 'phone pause must pause a listening Watch')
eqSync({ phoneListening: false, phonePaused: true, watchListening: false, watchPaused: false, watchRecording: true, sawPhoneListening: true }, 'pause', 'phone pause must pause a recording Watch')
eqSync({ phoneListening: false, phonePaused: true, watchListening: true, watchPaused: true, sawPhoneListening: true }, 'pause', 'phone pause must pause a Watch that is listening and paused')
eqSync({ phoneListening: false, phonePaused: true, watchListening: false, watchPaused: true, sawPhoneListening: true }, 'ignore', 'phone pause must not double-pause an already-paused Watch')
eqSync({ phoneListening: false, phonePaused: true, watchListening: false, watchPaused: false, sawPhoneListening: true }, 'ignore', 'phone pause must ignore an idle Watch')
