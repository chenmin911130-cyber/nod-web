import {
  IPHONE_COPY,
  speakerSuggestText,
  canSwitchWorkspace,
  isListenReadyView,
  listenChipLabel,
  listenChipParts,
  moreMenuEnabled,
  moreSaveRow,
  nativeListenChipOrder,
  notesPageTitle,
  notesChipLabel,
  notesChipParts,
  notesSettingsValue,
  listenClock,
  listenShowsRecClock,
  listenDetectChip,
  listenStatusDot,
  listenControlMode,
  sessionListening,
  notesInChip,
  recClock,
  sameSpokenLine,
  spokenSettingsValue,
  showLineTranslation,
  showLiveTranslation,
  translateFromChip,
  translateSourceName,
  translateSourceTag,
  translateSwapAffordance,
  translateTargetChip,
  translateToChip,
} from './iphoneCopy'
import { listenMetaLine } from './listen'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(IPHONE_COPY.startListening, 'Start listening', 'Listen ready CTA is Start listening')
eq(IPHONE_COPY.startTranslate, 'Start voice translation', 'Translate ready CTA is Start voice translation')
eq(IPHONE_COPY.recordingStatus, 'Recording', 'live status is Recording')
eq(IPHONE_COPY.stop, 'End', 'listen control stop label is End')
eq(IPHONE_COPY.translateStatus, 'Listening', 'Translate live status stays Listening')
eq(IPHONE_COPY.translateStop, 'Stop', 'Translate stop capsule stays Stop')
eq(IPHONE_COPY.resume, 'Resume', 'paused listen control is Resume')
eq(IPHONE_COPY.more, 'More', 'PDF/Save/History live in More')
eq(IPHONE_COPY.moreSession, 'This session', 'More sheet names this session')
eq(IPHONE_COPY.moreSaveHint, 'Available after recording ends', 'disabled Save explains when it unlocks')
eq(IPHONE_COPY.moreSaved, 'Saved', 'kept Save row says Saved')
eq(IPHONE_COPY.moreViewHistory, 'View in History', 'kept Save row points at History')
eq(IPHONE_COPY.meetingNotes, 'Meeting notes', 'Meeting notes page title')
eq(IPHONE_COPY.studyNotes, 'Study notes', 'Lecture notes page title')
eq(notesPageTitle('meeting'), 'Meeting notes', 'meeting notes heading')
eq(notesPageTitle('lecture'), 'Study notes', 'lecture notes heading')
eq(notesPageTitle('interview'), null, 'Live Q&A has no notes page title')
eq(IPHONE_COPY.saveTitle, 'Save to History?', 'Stop asks save only')
eq(IPHONE_COPY.saveBannerTitle, 'Save this session?', 'phone End banner title')
eq(IPHONE_COPY.saveNotNow, 'Not now', 'banner dismisses without discard')
eq(IPHONE_COPY.saveSaving, 'Saving…', 'in-flight keep copy')
eq(IPHONE_COPY.saveFailed, "Couldn't save.", 'keep failed copy')
eq(IPHONE_COPY.saveRetry, 'Retry save', 'failed banner retry')
eq(IPHONE_COPY.saveSavedLine, 'Saved to History', 'ack-only saved line')
eq(IPHONE_COPY.saveCancel, 'Cancel', 'non-native collect cancel')
eq(IPHONE_COPY.keepRecording, 'Keep recording', 'Save can keep the WAV')
eq(
  IPHONE_COPY.keepRecordingHelp.includes('30 days'),
  true,
  'Keep recording must say audio stays 30 days',
)
eq(listenDetectChip('auto'), 'Auto', 'speech chip is Auto')
eq(listenChipLabel('auto'), 'Auto', 'auto chip is just Auto')
eq(listenChipLabel('en'), 'English', 'pinned listen language')
eq(notesInChip('en'), 'Notes · English', 'notes chip uses Notes · name')
eq(notesChipLabel('en'), 'Notes · English', 'default notes chip is Notes · English')
eq(notesInChip('auto'), 'Notes · Auto', 'auto notes chip is Notes · Auto')
eq(listenChipParts('auto').title, 'Auto', 'listen chip title is just Auto')
eq(notesChipParts('en').title, 'Notes · English', 'notes chip title')
eq(listenChipLabel('auto').includes('听'), false, 'iPhone chrome stays English')
eq(notesChipLabel('en').includes('纪要'), false, 'notes chip stays English')
eq(notesInChip('zh').includes('中文'), false, 'notes chip uses the English language name')
eq(listenClock(8000), '00:08', 'Listen clock is mm:ss')
eq(listenShowsRecClock('listen'), true, 'Meeting / Lecture keep the recording clock')
eq(listenShowsRecClock('translate'), false, 'Translate is not a recording')
eq(listenShowsRecClock('interview'), false, 'Live Q&A is not a recording')
eq(nativeListenChipOrder('meeting').join(','), 'scene,speech,notes', 'meeting chips are Meeting, speech, notes')
eq(nativeListenChipOrder('lecture').join(','), 'scene,speech,notes', 'lecture chips are the same three')
eq(IPHONE_COPY.liveTab, 'Live', 'Live is the stage tab')
eq(IPHONE_COPY.transcriptTab, 'Transcript', 'Transcript keeps the words')
eq(IPHONE_COPY.summaryTab, 'Notes', 'Notes is the notes tab')
eq(IPHONE_COPY.listeningNowLabel, 'Listening now', 'Live content says Listening now')
eq(IPHONE_COPY.keyPoint, 'Key Point', 'Summary still names Key Point')
eq(IPHONE_COPY.actionItem, 'Action Item', 'Summary still names Action Item')
eq(translateTargetChip('en'), '→ English', 'Translate target follows notes')
eq(translateFromChip('auto'), 'Auto-detect', 'Translate from starts unlocked')
eq(translateFromChip('zh'), 'Chinese', 'pinned From uses the language name')
eq(translateToChip('en'), 'English', 'Translate to chip is the language only')
eq(IPHONE_COPY.emptyTranslateTitle, 'Ready to translate', 'Translate empty title is Ready to translate')
eq(IPHONE_COPY.emptyTranslateSub, 'Tap the mic below to speak, or type to translate.', 'Translate empty sub points at mic and typing')
eq(IPHONE_COPY.autoDetectFrom, 'Auto-detect', 'From chip auto label is Auto-detect')
eq(IPHONE_COPY.copyTranslation, 'Copy translation', 'card copy control names the translation')
eq(translateSourceTag({ from: 'en' }), 'EN', 'card badge uses the heard language')
eq(translateSourceTag({ locked: 'zh', heard: 'en' }), 'CH', 'locked From wins the badge')
eq(translateSourceTag({ heard: 'ja' }), 'JA', 'auto From falls back to what was heard')
eq(translateSourceTag({}), 'EN', 'unknown source still shows EN')
eq(translateSourceName({ from: 'en' }), 'English', 'phone card meta uses the language name')
eq(translateSourceName({ locked: 'zh', heard: 'en' }), 'Chinese', 'locked From wins the phone card name')
eq(translateSourceName({ heard: 'ja' }), 'Japanese', 'auto From names what was heard')
eq(translateSourceName({}), '', 'unidentified auto From omits the language name')
eq(translateSwapAffordance({ from: 'auto', heardFrom: null }), 'arrow', 'unlocked auto From is a static arrow')
eq(translateSwapAffordance({ from: 'auto', heardFrom: 'en' }), 'swap', 'heard language turns the arrow into swap')
eq(translateSwapAffordance({ from: 'en', heardFrom: null }), 'swap', 'locked From can swap')
eq(IPHONE_COPY.typeToTranslate, 'Type to translate', 'Translate prompt is Type to translate')
eq(recClock(724000), 'REC 00:12:04', 'REC is status, not a button')
eq(canSwitchWorkspace({ listening: false }), true, 'Ready can change mode')
eq(canSwitchWorkspace({ listening: true }), false, 'cannot hot-switch while listening')
eq(canSwitchWorkspace({ listening: false, paused: true }), false, 'cannot hot-switch while paused')
eq(showLiveTranslation({ translateOn: true, last: true }), true, 'latest line can show the notes language')
eq(showLiveTranslation({ translateOn: true, last: false }), false, 'older lines stay original only')
eq(showLiveTranslation({ translateOn: false, last: true }), false, 'more-accurate off hides the notes line')
eq(sameSpokenLine('if 75% of their profits go', 'if 75% of their profits go'), true, 'same English is one line')
eq(sameSpokenLine('if 75% of their profits go', '如果利润的 75% 流向那里'), false, 'a real translation stays visible')
eq(
  showLineTranslation({
    translateOn: true,
    native: true,
    original: 'significantly. So, but also having a PE of 6',
    translation: 'significantly. So, but also having a PE of 6',
  }),
  false,
  'Transcript does not paint the same language twice',
)
eq(
  showLineTranslation({
    translateOn: true,
    native: true,
    original: 'significantly. So, but also having a PE of 6',
    translation: '而且市盈率只有 6 也有帮助',
  }),
  true,
  'a different notes language still shows under the transcript',
)
eq(IPHONE_COPY.emptyTranscript, 'Waiting for speech…', 'Transcript empty waits for speech')
eq(IPHONE_COPY.fullTranscript, 'Full transcript', 'Transcript header title')
eq(IPHONE_COPY.allCapturedSpeech, 'All captured speech', 'Transcript header subtitle')
eq(IPHONE_COPY.backToLatest, 'Back to latest', 'Transcript jump capsule')
eq(IPHONE_COPY.emptyNotes, 'Start listening', 'Notes empty stays Start listening')
eq(speakerSuggestText('Host', 'Tom'), 'Host is Tom?', 'speaker chip asks to confirm the spoken name')
eq(IPHONE_COPY.listeningEmpty, 'Listening…', 'listening empty stage title is Listening…')
eq(IPHONE_COPY.listeningEmptyHelp, "We'll show what's said here.", 'listening empty stage explains the feed')
eq(IPHONE_COPY.askConversation, 'Ask about this conversation…', 'Live ask placeholder is about this conversation')
eq(IPHONE_COPY.askFollowUp, 'Ask a follow-up…', 'after the first answer the box invites a follow-up')
eq(IPHONE_COPY.askThinking, 'Thinking…', 'pending Live ask card says Thinking…')
eq(IPHONE_COPY.askCouldntAnswer, "Couldn't answer.", 'failed Live ask card names the miss')
eq(IPHONE_COPY.askRetry, 'Retry', 'failed Live ask card offers Retry')
eq(IPHONE_COPY.quickSummarize, 'Summarize so far', 'first chip writes notes so far')
eq(IPHONE_COPY.quickActionItems, 'List the action items so far, with who owns each.', 'action-item chip asks with owners')
eq(IPHONE_COPY.quickActionItemsChip, 'List action items', 'Meeting second chip is List action items')
eq(IPHONE_COPY.quickKeyConcepts, 'List the key concepts so far.', 'Lecture chip asks for key concepts')
eq(IPHONE_COPY.quickKeyConceptsChip, 'Key concepts so far', 'Lecture second chip is Key concepts so far')
eq(IPHONE_COPY.readyHelp, 'Tap start to capture, transcribe, and organize your conversation in real time.', 'help stays under Ready to listen')
eq(IPHONE_COPY.readyTitleShort, 'Ready to listen', 'ready stage title has no trailing period')
eq(IPHONE_COPY.readyHelpCapture, "Capture your conversation. We'll organize the rest.", 'ready stage help is the capture line')
eq(IPHONE_COPY.recordingSetup, 'Recording setup', 'scene sheet title')
eq(IPHONE_COPY.notesSheetHelp, 'Notes are written in this language only', 'notes sheet help stays')
eq(spokenSettingsValue('auto'), 'Auto-detect', 'ready spoken row shows Auto-detect')
eq(spokenSettingsValue('zh'), 'Chinese', 'ready spoken row shows the language name')
eq(notesSettingsValue('auto'), 'Auto', 'ready notes row shows Auto')
eq(notesSettingsValue('zh'), 'Chinese', 'ready notes row shows the language name')
eq(IPHONE_COPY.aiNote, 'Your AI listening assistant, ready when you are.', 'closing line is the product line')
eq(IPHONE_COPY.autoNotes, 'Auto notes', 'meta line auto notes segment')
eq(IPHONE_COPY.appliesToNextRecording, 'Applies to next recording', 'ended settings help')
eq(IPHONE_COPY.settingsLocked, 'Settings are locked while recording', 'locked settings toast')
eq(IPHONE_COPY.settingsReadonlyAria, 'Session settings (read-only while recording)', 'meta line aria')
eq(IPHONE_COPY.leaveTitle, 'Start a new session?', 'leave sheet title')
eq(IPHONE_COPY.leaveSubRecording, 'Recording will end first. Your notes stay until you choose.', 'leave sheet while recording')
eq(IPHONE_COPY.leaveSubEnded, "This session isn't saved yet.", 'leave sheet after End')
eq(IPHONE_COPY.leaveSave, 'Save and start new', 'leave save action')
eq(IPHONE_COPY.leaveDiscard, 'Discard and start new', 'leave discard action')
eq(IPHONE_COPY.leaveDiscardHelp, 'This cannot be undone.', 'leave discard is irreversible')
eq(IPHONE_COPY.leaveWaitAnswer, 'Wait for the answer to finish', 'leave save waits for Ask')
eq(IPHONE_COPY.leaveSavedStatus, 'Saved · new session', 'leave save success toast')
eq(
  listenMetaLine({ scene: 'meeting', speakersId: '2', speechLang: 'auto', notesLang: 'zh' }),
  'Meeting · Auto-detect · Chinese notes',
  'Meeting 2 drops the speaker badge',
)
eq(
  listenMetaLine({ scene: 'meeting', speakersId: '3-4', speechLang: 'auto', notesLang: 'zh' }),
  'Meeting · 3–4 · Auto-detect · Chinese notes',
  'Meeting 3–4 keeps the speaker badge',
)
eq(
  listenMetaLine({ scene: 'meeting', speakersId: '5+', speechLang: 'en', notesLang: 'auto' }),
  'Meeting · 5+ · English · Auto notes',
  'auto notes language is Auto notes',
)
eq(
  listenMetaLine({ scene: 'lecture', speakersId: '5+', speechLang: 'auto', notesLang: 'en' }),
  'Lecture · Auto-detect · English notes',
  'Lecture ignores the speaker badge',
)
eq(
  listenMetaLine({ scene: 'interview', speakersId: '2', speechLang: 'auto', notesLang: 'zh', qa: true }),
  'Live Q&A · Auto-detect',
  'Live Q&A omits the notes segment',
)

const readyBase = { phone: true, listening: false, paused: false, ended: false, lines: 0, partial: false }
eq(isListenReadyView(readyBase), true, 'phone idle empty session is ready')
eq(isListenReadyView({ ...readyBase, listening: true }), false, 'listening is not ready')
eq(isListenReadyView({ ...readyBase, paused: true }), false, 'paused is not ready')
eq(isListenReadyView({ ...readyBase, ended: true }), true, 'ended with no lines is ready')
eq(isListenReadyView({ ...readyBase, ended: true, lines: 1 }), false, 'ended with a line is not ready')
eq(isListenReadyView({ ...readyBase, lines: 1 }), false, 'lines are not ready')
eq(isListenReadyView({ ...readyBase, partial: true }), false, 'partial is not ready')
eq(isListenReadyView({ ...readyBase, phone: false }), false, 'desktop is not the ready page')
eq(IPHONE_COPY.pausedStatus, 'Paused', 'paused status stays Paused')
eq(IPHONE_COPY.endedStatus, 'Ended', 'ended status is Ended')
eq(listenControlMode({ listening: true, paused: false, ended: true, hasContent: true }), 'recording', 'live chrome wins over ended')
eq(listenControlMode({ listening: false, paused: true, ended: false, hasContent: true }), 'paused', 'paused chrome stays paused')
eq(listenControlMode({ listening: false, paused: false, ended: true, hasContent: true }), 'ended', 'ended with content shows Ended + Start')
eq(listenControlMode({ listening: false, paused: false, ended: true, hasContent: false }), 'ready', 'ended without content stays Start')
eq(listenControlMode({ listening: false, paused: false, ended: true, hasContent: true, variant: 'translate' }), 'ready', 'Translate ignores ended')
eq(listenControlMode({ listening: false, paused: false, ended: false, hasContent: false }), 'ready', 'fresh session is Start')
eq(listenStatusDot({ listening: false, paused: false }), 'standby', 'idle uses the gray standby dot')
eq(listenStatusDot({ listening: true, paused: false }), 'recording', 'live uses the red recording dot')
eq(listenStatusDot({ listening: false, paused: true }), 'paused', 'pause uses the yellow paused dot')
eq(sessionListening({ capture: 'listening' }), true, 'backend listen keeps Listening chrome')
eq(sessionListening({ capture: 'recording' }), true, 'manual record keeps Listening chrome')
eq(sessionListening({ capture: 'off' }), false, 'stopped session shows Start')
eq(sessionListening({ capture: 'paused' }), false, 'Pause leaves the live chrome')

const idleMore = moreMenuEnabled({ hasContent: false, canSave: false })
eq(idleMore.pdf, false, 'idle More grays PDF')
eq(idleMore.save, false, 'idle More grays Save')
eq(idleMore.history, true, 'idle More keeps History on')
eq(idleMore.newSession, false, 'idle More grays New')

const liveMore = moreMenuEnabled({ hasContent: true, canSave: true })
eq(liveMore.pdf, true, 'content lights PDF')
eq(liveMore.save, true, 'unsaved content lights Save')
eq(liveMore.history, true, 'History stays on')
eq(liveMore.newSession, true, 'content lights New')

const savedMore = moreMenuEnabled({ hasContent: true, canSave: false })
eq(savedMore.pdf, true, 'saved session can still export')
eq(savedMore.save, false, 'already saved stays gray')
eq(savedMore.newSession, true, 'saved session can start New')

const liveSaveRow = moreSaveRow({ saved: false, canSave: false })
eq(liveSaveRow.label, 'Save', 'recording Save row stays Save')
eq(liveSaveRow.hint, 'Available after recording ends', 'recording Save row shows the after-end hint')
eq(liveSaveRow.trailing, '', 'recording Save row has no History trail')
eq(liveSaveRow.disabled, true, 'recording Save row stays disabled')

const readySaveRow = moreSaveRow({ saved: false, canSave: true })
eq(readySaveRow.label, 'Save', 'ended Save row stays Save')
eq(readySaveRow.hint, '', 'ended Save row has no hint')
eq(readySaveRow.disabled, false, 'ended Save row is enabled')

const keptSaveRow = moreSaveRow({ saved: true, canSave: false })
eq(keptSaveRow.label, 'Saved', 'kept Save row says Saved')
eq(keptSaveRow.hint, '', 'kept Save row does not keep the disabled hint')
eq(keptSaveRow.trailing, 'View in History', 'kept Save row trails View in History')
eq(keptSaveRow.disabled, false, 'kept Save row stays tappable')

console.log('iphoneCopy.test.ts ok')
