import {
  IPHONE_COPY,
  canSwitchWorkspace,
  listenChipLabel,
  listenChipParts,
  moreMenuEnabled,
  moreSaveRow,
  nativeListenChipOrder,
  notesPageTitle,
  notesChipLabel,
  notesChipParts,
  listenClock,
  listenShowsRecClock,
  listenDetectChip,
  listenStatusDot,
  sessionListening,
  notesInChip,
  recClock,
  sameSpokenLine,
  showLineTranslation,
  showLiveTranslation,
  translateFromChip,
  translateSourceName,
  translateSourceTag,
  translateSwapAffordance,
  translateTargetChip,
  translateToChip,
} from './iphoneCopy'

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
eq(IPHONE_COPY.emptyNotes, 'Start listening', 'Notes empty stays Start listening')
eq(IPHONE_COPY.readyHelp, 'Tap start to capture, transcribe, and organize your conversation in real time.', 'help stays under Ready to listen')
eq(IPHONE_COPY.aiNote, 'Your AI listening assistant, ready when you are.', 'closing line is the product line')
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
