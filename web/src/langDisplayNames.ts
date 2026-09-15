import type { PairLang } from './types'
import type { UiLang } from './uiLang'
import { resolveUiLang } from './uiLang'

const EN: Record<PairLang, string> = {
  zh: 'Chinese',
  ja: 'Japanese',
  en: 'English',
  it: 'Italian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
}

const ZH: Record<PairLang, string> = {
  zh: '中文',
  ja: '日语',
  en: '英语',
  it: '意大利语',
  es: '西班牙语',
  fr: '法语',
  de: '德语',
  pt: '葡萄牙语',
}

const BY_UI: Partial<Record<UiLang, Record<PairLang, string>>> = {
  en: EN,
  zh: ZH,
}

export function translateLangDisplayName(id: PairLang, uiLang: UiLang = resolveUiLang()): string {
  const table = BY_UI[uiLang] ?? EN
  return table[id] ?? EN[id]
}
