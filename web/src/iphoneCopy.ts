import type { Lang, PairLang } from './types'
import { TRANSLATE_LANGS } from './types'
import type { ListenScene } from './listen'
import { translateLangDisplayName } from './langDisplayNames'
import { resolveUiLang, type UiLang } from './uiLang'
import { EN_IPHONE_COPY, iphoneCopyFor, type IphoneCopy } from './iphoneCopyLocales'

export type { IphoneCopy }
export { iphoneCopyFor, EN_IPHONE_COPY }

let cachedLang: UiLang | null = null
let cachedCopy: IphoneCopy | null = null

/** Picks the copy table on each read so a document-start locale injection wins. */
export function currentIphoneCopy(): IphoneCopy {
  const lang = resolveUiLang()
  if (cachedCopy && cachedLang === lang) return cachedCopy
  cachedLang = lang
  cachedCopy = iphoneCopyFor(lang)
  return cachedCopy
}

export const IPHONE_COPY: IphoneCopy = new Proxy({} as IphoneCopy, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined
    return currentIphoneCopy()[prop as keyof IphoneCopy]
  },
})

export function nativeListenChipOrder(scene: ListenScene): ReadonlyArray<'scene' | 'speech' | 'notes'> {
  return ['scene', 'speech', 'notes']
}

export function listenChipParts(lang: Lang): { title: string; sub: string } {
  if (lang === 'auto') return { title: IPHONE_COPY.notesAutoTitle, sub: '' }
  return { title: translateLangDisplayName(lang), sub: '' }
}

export function notesChipParts(lang: Lang, biTarget?: PairLang): { title: string; sub: string } {
  return { title: notesInChip(lang, biTarget), sub: '' }
}

export function listenDetectChip(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.notesAutoTitle
  return translateLangDisplayName(lang)
}

export function notesInChip(lang: Lang, _biTarget?: PairLang): string {
  if (lang === 'auto') return `${IPHONE_COPY.summaryTab} · ${IPHONE_COPY.notesAutoTitle}`
  return `${IPHONE_COPY.summaryTab} · ${translateLangDisplayName(lang)}`
}

export function bilingualButtonTitle(on: boolean, target: PairLang): string {
  const name = translateLangDisplayName(target)
  return on
    ? `Bilingual on → ${name} — tap to turn off`
    : `Bilingual off — translations in ${name}`
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
  return translateLangDisplayName(lang)
}

export function translateToChip(lang: PairLang): string {
  return translateLangDisplayName(lang)
}

export function translateSourceTag(input: { from?: string; locked?: string; heard?: string | null }): string {
  const raw = input.from || (input.locked && input.locked !== 'auto' ? input.locked : '') || input.heard || 'en'
  return TRANSLATE_LANGS.find((item) => item.id === raw)?.tag || 'EN'
}

export function translateSourceName(input: { from?: string; locked?: string; heard?: string | null }): string {
  const raw = input.from || (input.locked && input.locked !== 'auto' ? input.locked : '') || input.heard || ''
  if (!raw || raw === 'auto') return ''
  return translateLangDisplayName(raw as PairLang)
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

/** Transcript card tap: one open card may show translation even when bilingual is off. */
export function showCardTranslation(input: {
  open: boolean
  original: string
  translation: string
  pending?: boolean
}): boolean {
  if (!input.open) return false
  const tr = input.translation.trim()
  if (!tr) return Boolean(input.pending)
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

/** Reattach sends `ready` before `phase`; never clear an active capture axis. */
export function readyPreservesCapture(input: {
  capture: string
  autoOn: boolean
}): boolean {
  return input.capture !== 'off' || input.autoOn
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

export function speakerSuggestText(label: string, name: string): string {
  return IPHONE_COPY.speakerSuggestIs.replace('{label}', label).replace('{name}', name)
}

export function spokenSettingsValue(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.speechAutoTitle
  return translateLangDisplayName(lang)
}

export function notesSettingsValue(lang: Lang): string {
  if (lang === 'auto') return IPHONE_COPY.notesAutoTitle
  return translateLangDisplayName(lang)
}

export type AskEntryKind = 'ask' | 'keyboard'

/** Meeting Ask vs Translate keyboard: the round button's accessible name. */
export function askEntryLabel(kind: AskEntryKind, expanded = false): string {
  if (kind === 'keyboard') return expanded ? IPHONE_COPY.hideKeyboard : IPHONE_COPY.showKeyboard
  return IPHONE_COPY.askEntry
}

export function sceneHelpText(scene: ListenScene): string {
  if (scene === 'meeting') return IPHONE_COPY.sceneHelpMeeting
  if (scene === 'lecture') return IPHONE_COPY.sceneHelpLecture
  return IPHONE_COPY.sceneHelpQa
}

export function meetingSpeakerPeopleLabel(id: '2' | '3-4' | '5+'): string {
  if (id === '2') return IPHONE_COPY.speakerPeople2
  if (id === '3-4') return IPHONE_COPY.speakerPeople34
  return IPHONE_COPY.speakerPeople5
}

export function toastSpeechOnly(name: string): string {
  return IPHONE_COPY.toastSpeechOnly.replace('{name}', name)
}

export function speechChipTitle(input: { auto: boolean; heardTag?: string; name?: string }): string {
  if (input.auto) {
    return input.heardTag
      ? IPHONE_COPY.speechAutoHearing.replace('{tag}', input.heardTag)
      : IPHONE_COPY.speechAuto
  }
  return IPHONE_COPY.speechNamed.replace('{name}', input.name || '')
}

export function listenedTodayNoCap(hours: string): string {
  return IPHONE_COPY.listenedTodayNoCap.replace('{hours}', hours)
}

export function listeningLeftToday(hours: string): string {
  return IPHONE_COPY.listeningLeftToday.replace('{hours}', hours)
}
