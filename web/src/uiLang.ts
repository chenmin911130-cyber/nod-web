export type UiLang = 'zh' | 'en' | 'it' | 'es' | 'fr' | 'de' | 'pt' | 'ja'

const LANGS = new Set<UiLang>(['zh', 'en', 'it', 'es', 'fr', 'de', 'pt', 'ja'])

export function watchUiLang(locale: string): UiLang {
  const tag = locale.trim().toLowerCase().replace(/_/g, '-')
  const code = (tag.split('-')[0] || 'en') as UiLang
  return LANGS.has(code) ? code : 'en'
}

declare global {
  interface Window {
    __NOD_UI_LOCALE__?: string
  }
}

/** UI locale for copy tables. Node / tests / no injection → en. */
export function resolveUiLang(): UiLang {
  if (typeof window === 'undefined') return 'en'
  const injected = window.__NOD_UI_LOCALE__
  if (injected) return watchUiLang(injected)
  if (typeof navigator !== 'undefined') {
    const nav = navigator.languages?.[0] || navigator.language
    if (nav) return watchUiLang(nav)
  }
  return 'en'
}
