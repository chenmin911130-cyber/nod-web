import { localeFromSitePath } from './siteLocale'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(localeFromSitePath('/'), 'en', 'English landing')
eq(localeFromSitePath('/zh'), 'zh', '/zh is the Chinese landing')
eq(localeFromSitePath('/privacy'), 'en', 'legal pages stay English')
eq(localeFromSitePath('/zh/'), 'zh', 'trailing slash still Chinese')
