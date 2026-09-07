import type { Lang, PairLang } from './types'
import { TRANSLATE_LANGS } from './types'
import type { ListenScene } from './listen'

export const IPHONE_COPY = {
  listenTab: 'Listen',
  translateTab: 'Translate',
  start: 'Start',
  startListening: 'Start listening',
  more: 'More',
  moreSession: 'This session',
  pause: 'Pause',
  resume: 'Resume',
  stop: 'End',
  translateStatus: 'Listening',
  translateStop: 'Stop',
  muted: 'Muted',
  readyStatus: 'Ready to listen',
  recordingStatus: 'Recording',
  listeningNow: 'Listening...',
  listeningNowLabel: 'Listening now',
  keyPoint: 'Key Point',
  actionItem: 'Action Item',
  aiInsight: 'AI Insight',
  copyLine: 'Copy',
  shareSummary: 'Share',
  summarizeNow: 'Summarize',
  readyTitle: 'Ready to listen.',
  readyTitleShort: 'Ready to listen',
  readyHelp: 'Tap start to capture, transcribe, and organize your conversation in real time.',
  readyHelpCapture: "Capture your conversation. We'll organize the rest.",
  recordingSetup: 'Recording setup',
  sceneRow: 'Scene',
  spokenLanguage: 'Spoken language',
  notesLanguage: 'Notes language',
  sceneSection: 'SCENE',
  participants: 'Participants',
  setupDone: 'Done',
  speechAutoTitle: 'Auto-detect',
  speechAutoHelp: 'Detect automatically',
  notesAutoTitle: 'Auto',
  notesAutoHelp: 'Follow speech',
  listeningEmpty: 'Listening…',
  listeningEmptyHelp: "We'll show what's said here.",
  askConversation: 'Ask about this conversation…',
  aiNote: 'Your AI listening assistant, ready when you are.',
  pausedStatus: 'Paused',
  endedStatus: 'Ended',
  liveTab: 'Live',
  transcriptTab: 'Transcript',
  summaryTab: 'Notes',
  autoDetect: 'Auto Detect',
  emptyLive: 'Start listening. What was said stays here.',
  emptyTranscript: 'Waiting for speech…',
  emptyNotes: 'Start listening',
  fullTranscript: 'Full transcript',
  allCapturedSpeech: 'All captured speech',
  backToLatest: 'Back to latest',
  emptyTranslateTitle: 'Ready to translate',
  emptyTranslateSub: 'Tap the mic below to speak, or type to translate.',
  histTitle: 'History',
  histDone: 'Done',
  histSearch: 'Search',
  histOpen: 'Open',
  histShare: 'Share notes',
  histPdf: 'Export PDF',
  histAudio: 'Save audio to Files',
  histDelete: 'Delete',
  accountTitle: 'Account',
  askPlaceholder: 'Ask anything about this meeting…',
  askSend: 'Ask',
  typeToTranslate: 'Type to translate',
  morePdf: 'Export PDF',
  moreSave: 'Save',
  moreSaveHint: 'Available after recording ends',
  moreSaved: 'Saved',
  moreViewHistory: 'View in History',
  moreHistory: 'History',
  moreNew: 'New session',
  moreCancel: 'Cancel',
  meetingNotes: 'Meeting notes',
  studyNotes: 'Study notes',
  saveTitle: 'Save to History?',
  saveBody: 'Keep this meeting so you can reopen it later.',
  saveYes: 'Save',
  saveNo: "Don't save",
  saveBannerTitle: 'Save this session?',
  saveNotNow: 'Not now',
  saveSaving: 'Saving…',
  saveFailed: "Couldn't save.",
  saveRetry: 'Retry save',
  saveSavedLine: 'Saved to History',
  saveCancel: 'Cancel',
  keepRecording: 'Keep recording',
  keepRecordingHelp: 'Audio stays on your account for 30 days. Uncheck to keep notes only.',
  listenAny: 'Listen · Any language',
  notesSheetHelp: 'Notes are written in this language only',
  enhance: 'More accurate',
  confirmStatus: 'Confirming before translate',
  autoDetectFrom: 'Auto-detect',
  startTranslate: 'Start voice translation',
  copyTranslation: 'Copy translation',
  autoNotes: 'Auto notes',
  appliesToNextRecording: 'Applies to next recording',
  settingsLocked: 'Settings are locked while recording',
  settingsReadonlyAria: 'Session settings (read-only while recording)',
  leaveTitle: 'Start a new session?',
  leaveSubRecording: 'Recording will end first. Your notes stay until you choose.',
  leaveSubEnded: "This session isn't saved yet.",
  leaveSave: 'Save and start new',
  leaveDiscard: 'Discard and start new',
  leaveDiscardHelp: 'This cannot be undone.',
  leaveWaitAnswer: 'Wait for the answer to finish',
  leaveSavedStatus: 'Saved · new session',
} as const

export function nativeListenChipOrder(scene: ListenScene): ReadonlyArray<'scene' | 'speech' | 'notes'> {
  return ['scene', 'speech', 'notes']
}

export function listenChipParts(lang: Lang): { title: string; sub: string } {
  if (lang === 'auto') return { title: 'Auto', sub: '' }
  const name = TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
  return { title: name, sub: '' }
}

export function notesChipParts(lang: Lang): { title: string; sub: string } {
  return { title: notesInChip(lang), sub: '' }
}

export function listenDetectChip(lang: Lang): string {
  if (lang === 'auto') return 'Auto'
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function notesInChip(lang: Lang): string {
  if (lang === 'auto') return 'Notes · Auto'
  const name = TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
  return `Notes · ${name}`
}

export function notesChipLabel(lang: Lang): string {
  const part = notesChipParts(lang)
  return part.sub ? `${part.title} · ${part.sub}` : part.title
}

export function listenChipLabel(lang: Lang): string {
  const part = listenChipParts(lang)
  return part.sub ? `${part.title} · ${part.sub}` : part.title
}

export function translateTargetChip(lang: PairLang): string {
  return `→ ${translateToChip(lang)}`
}

export function translateFromChip(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.autoDetectFrom
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function translateToChip(lang: PairLang): string {
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function translateSourceTag(input: { from?: string; locked?: string; heard?: string | null }): string {
  const raw = input.from || (input.locked && input.locked !== 'auto' ? input.locked : '') || input.heard || 'en'
  return TRANSLATE_LANGS.find((item) => item.id === raw)?.tag || 'EN'
}

export function translateSourceName(input: { from?: string; locked?: string; heard?: string | null }): string {
  const raw = input.from || (input.locked && input.locked !== 'auto' ? input.locked : '') || input.heard || ''
  if (!raw || raw === 'auto') return ''
  return TRANSLATE_LANGS.find((item) => item.id === raw)?.name || ''
}

export function translateSwapAffordance(input: { from: string; heardFrom?: string | null }): 'arrow' | 'swap' {
  if (input.from === 'auto' && !input.heardFrom) return 'arrow'
  return 'swap'
}

export function recClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `REC ${h}:${m}:${s}`
}

export function listenShowsRecClock(variant: 'listen' | 'translate' | 'interview'): boolean {
  return variant === 'listen'
}

export function listenClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = String(Math.floor(sec / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `${m}:${s}`
}

export function listenStatusDot(input: { listening: boolean; paused: boolean }): 'standby' | 'recording' | 'paused' {
  if (input.paused) return 'paused'
  if (input.listening) return 'recording'
  return 'standby'
}

export function listenControlMode(input: {
  listening: boolean
  paused: boolean
  ended: boolean
  hasContent: boolean
  variant?: 'listen' | 'translate' | 'interview'
}): 'recording' | 'paused' | 'ended' | 'ready' {
  if (input.listening) return 'recording'
  if (input.paused) return 'paused'
  if (input.variant !== 'translate' && input.ended && input.hasContent) return 'ended'
  return 'ready'
}

/** Mic is live while capture is listening/recording (ADR 0001). Paused/off is
 * not capturing. `run` no longer decides this — a generating model keeps
 * capture='listening' so the mic stays up mid-answer. */
export function sessionListening(input: { capture: string }): boolean {
  return input.capture === 'listening' || input.capture === 'recording'
}

export function canSwitchWorkspace(input: { listening: boolean; paused?: boolean }): boolean {
  return !input.listening && !input.paused
}

export function showLiveTranslation(input: { translateOn: boolean; last: boolean }): boolean {
  return input.translateOn && input.last
}

export function sameSpokenLine(original: string, translation: string): boolean {
  const src = original.replace(/\s+/g, ' ').trim().toLowerCase()
  const dst = translation.replace(/\s+/g, ' ').trim().toLowerCase()
  return Boolean(src && dst && src === dst)
}

export function showLineTranslation(input: {
  translateOn: boolean
  original: string
  translation: string
  last?: boolean
  native?: boolean
  pending?: boolean
}): boolean {
  if (!input.translateOn) return false
  if (!input.native && !input.last) return false
  const tr = input.translation.trim()
  if (!tr) return Boolean(input.native && input.pending)
  return !sameSpokenLine(input.original, tr)
}

export function moreMenuEnabled(input: { hasContent: boolean; canSave: boolean }): {
  pdf: boolean
  save: boolean
  history: boolean
  newSession: boolean
} {
  return {
    pdf: input.hasContent,
    save: input.canSave,
    history: true,
    newSession: input.hasContent,
  }
}

export function moreSaveRow(input: { saved: boolean; canSave: boolean }): {
  label: string
  hint: string
  trailing: string
  disabled: boolean
} {
  if (input.saved) {
    return {
      label: IPHONE_COPY.moreSaved,
      hint: '',
      trailing: IPHONE_COPY.moreViewHistory,
      disabled: false,
    }
  }
  return {
    label: IPHONE_COPY.moreSave,
    hint: input.canSave ? '' : IPHONE_COPY.moreSaveHint,
    trailing: '',
    disabled: !input.canSave,
  }
}

export function notesPageTitle(scene: ListenScene): string | null {
  if (scene === 'interview') return null
  if (scene === 'lecture') return IPHONE_COPY.studyNotes
  return IPHONE_COPY.meetingNotes
}

export function isListenReadyView(input: {
  phone: boolean
  listening: boolean
  paused: boolean
  ended: boolean
  lines: number
  partial: boolean
}): boolean {
  return (
    input.phone &&
    !input.listening &&
    !input.paused &&
    input.lines === 0 &&
    !input.partial
  )
}

export function spokenSettingsValue(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.speechAutoTitle
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function notesSettingsValue(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.notesAutoTitle
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}
