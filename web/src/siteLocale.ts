import type { Locale } from './landing/copy'

export function localeFromSitePath(path: string): Locale {
  return path === '/zh' || path.startsWith('/zh/') ? 'zh' : 'en'
}
