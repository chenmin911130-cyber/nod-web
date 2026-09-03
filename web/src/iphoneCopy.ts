import type { Lang, PairLang } from './types'
import { TRANSLATE_LANGS } from './types'

export const IPHONE_COPY = {
  listenTab: 'Listen',
  translateTab: 'Translate',
  start: 'Start',
  startListening: 'Start Listening',
  more: 'More',
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  muted: 'Muted',
  readyStatus: 'Ready to listen',
  recordingStatus: 'Listening',
  listeningNow: 'Listening...',
  listeningNowLabel: 'Listening now',
  keyPoint: 'Key Point',
  actionItem: 'Action Item',
  aiInsight: 'AI Insight',
  meetingSummary: 'Meeting Summary',
  keyTakeaways: 'Key Takeaways',
  copyLine: 'Copy',
  shareSummary: 'Share',
  summarizeNow: 'Summarize',
  readyTitle: 'Ready to listen.',
  readyHelp: 'Tap start to capture, transcribe, and organize your conversation in real time.',
  aiNote: 'Your AI listening assistant, ready when you are.',
  pausedStatus: 'Paused',
  askReady: 'Ask anything after recording starts...',
  askLive: 'Ask anything about this conversation...',
  liveTab: 'Live',
  transcriptTab: 'Transcript',
  summaryTab: 'Summary',
  autoDetect: 'Auto Detect',
  emptyLive: 'Start listening. What was said stays here.',
  emptyNotes: 'Start listening',
  emptyTranslate: 'Speak any language.',
  histTitle: 'History',
  histDone: 'Done',
  histSearch: 'Search',
  histOpen: 'Open',
  histShare: 'Share notes',
  histPdf: 'Export PDF',
  histAudio: 'Save audio to Files',
  histDelete: 'Delete',
  askPlaceholder: 'Ask anything about this meeting…',
  askSend: 'Ask',
  typeToTranslate: 'Type to translate',
  morePdf: 'Export PDF',
  moreSave: 'Save',
  moreHistory: 'History',
  moreNew: 'New session',
  moreCancel: 'Cancel',
  saveTitle: 'Save to History?',
  saveBody: 'Keep this meeting so you can reopen it later.',
  saveYes: 'Save',
  saveNo: "Don't save",
  listenAny: 'Listen · Any language',
  notesSheetHelp: 'Notes are written in this language only',
  enhance: 'More accurate',
  confirmStatus: 'Confirming before translate',
  hearAnything: 'Hear anything',
} as const

export function nativeListenChipOrder(): ReadonlyArray<'scene' | 'speech' | 'notes'> {
  return ['scene', 'speech', 'notes']
}

export function listenChipParts(lang: Lang): { title: string; sub: string } {
  if (lang === 'auto') return { title: IPHONE_COPY.autoDetect, sub: '' }
  const name = TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
  return { title: name, sub: '' }
}

export function notesChipParts(lang: Lang): { title: string; sub: string } {
  return { title: notesInChip(lang), sub: '' }
}

export function listenDetectChip(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.autoDetect
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function notesInChip(lang: Lang): string {
  if (lang === 'auto') return 'Notes follow speech'
  const name = TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
  return `Notes in ${name}`
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
  if (lang === 'auto') return IPHONE_COPY.hearAnything
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function translateToChip(lang: PairLang): string {
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name || 'English'
}

export function translateSourceTag(input: { from?: string; locked?: string; heard?: string | null }): string {
  const raw = input.from || (input.locked && input.locked !== 'auto' ? input.locked : '') || input.heard || 'en'
  return TRANSLATE_LANGS.find((item) => item.id === raw)?.tag || 'EN'
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

/** Chrome stays on Listening while STT gaps or a translate/ask think. */
export function sessionListening(input: {
  run: string
  wanted?: boolean
  paused?: boolean
}): boolean {
  if (input.paused) return false
  if (input.run === 'listen' || input.run === 'record') return true
  if (input.wanted) return true
  return false
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
