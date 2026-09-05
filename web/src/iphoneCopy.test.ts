import {
  IPHONE_COPY,
  canSwitchWorkspace,
  listenChipLabel,
  listenChipParts,
  moreMenuEnabled,
  nativeListenChipOrder,
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
  translateSourceTag,
  translateTargetChip,
  translateToChip,
  speakersChipParts,
} from './iphoneCopy'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(IPHONE_COPY.startListening, 'Start Listening', 'Listen ready CTA is Start Listening')
eq(IPHONE_COPY.start, 'Start', 'Translate ready CTA is Start')
eq(IPHONE_COPY.recordingStatus, 'Listening', 'live status is Listening')
eq(IPHONE_COPY.more, 'More', 'PDF/Save/History live in More')
eq(IPHONE_COPY.saveTitle, 'Save to History?', 'Stop asks save only')
eq(IPHONE_COPY.keepRecording, 'Keep recording', 'Save can keep the WAV')
eq(
  IPHONE_COPY.keepRecordingHelp.includes('30 days'),
  true,
  'Keep recording must say audio stays 30 days',
)
eq(listenDetectChip('auto'), 'Auto Detect', 'speech chip is Auto Detect')
eq(listenChipLabel('auto'), 'Auto Detect', 'do not use Auto → CH')
eq(listenChipLabel('en'), 'English', 'pinned listen language')
eq(notesInChip('en'), 'Notes in English', 'notes chip says Notes in English')
eq(notesChipLabel('en'), 'Notes in English', 'default notes language is English')
eq(listenChipParts('auto').title, 'Auto Detect', 'listen chip title stays English')
eq(notesChipParts('en').title, 'Notes in English', 'notes chip title stays English')
eq(listenChipLabel('auto').includes('听'), false, 'iPhone chrome stays English')
eq(notesChipLabel('en').includes('纪要'), false, 'notes chip stays English')
eq(listenClock(8000), '00:08', 'Listen clock is mm:ss')
eq(listenShowsRecClock('listen'), true, 'Meeting / Lecture keep the recording clock')
eq(listenShowsRecClock('translate'), false, 'Translate is not a recording')
eq(listenShowsRecClock('interview'), false, 'Live Q&A is not a recording')
eq(nativeListenChipOrder('meeting')[0], 'scene', 'Meeting sits on the far left')
eq(nativeListenChipOrder('meeting').join(','), 'scene,speakers,speech,notes', 'meeting chips add the people-count chip')
eq(nativeListenChipOrder('lecture').join(','), 'scene,speech,notes', 'lecture has no people-count chip')
eq(speakersChipParts('2').title, '2 people', 'speakers chip labels 2 people')
eq(speakersChipParts('3-4').title, '3-4 people', 'speakers chip labels 3-4')
eq(IPHONE_COPY.liveTab, 'Live', 'Live is the stage tab')
eq(IPHONE_COPY.transcriptTab, 'Transcript', 'Transcript keeps the words')
eq(IPHONE_COPY.summaryTab, 'Summary', 'Summary is the notes tab')
eq(IPHONE_COPY.listeningNowLabel, 'Listening now', 'Live content says Listening now')
eq(IPHONE_COPY.keyPoint, 'Key Point', 'Summary still names Key Point')
eq(IPHONE_COPY.actionItem, 'Action Item', 'Summary still names Action Item')
eq(translateTargetChip('en'), '→ English', 'Translate target follows notes')
eq(translateFromChip('auto'), 'Hear anything', 'Translate from starts unlocked')
eq(translateFromChip('zh'), 'Chinese', 'pinned From uses the language name')
eq(translateToChip('en'), 'English', 'Translate to chip is the language only')
eq(IPHONE_COPY.emptyTranslate, 'Speak any language.', 'Translate empty stays Speak any language')
eq(translateSourceTag({ from: 'en' }), 'EN', 'card badge uses the heard language')
eq(translateSourceTag({ locked: 'zh', heard: 'en' }), 'CH', 'locked From wins the badge')
eq(translateSourceTag({ heard: 'ja' }), 'JA', 'auto From falls back to what was heard')
eq(translateSourceTag({}), 'EN', 'unknown source still shows EN')
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
