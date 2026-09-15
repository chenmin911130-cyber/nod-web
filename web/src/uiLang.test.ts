import { resolveUiLang, watchUiLang } from './uiLang'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(watchUiLang('zh-Hans-CN'), 'zh', 'Simplified Chinese maps to zh')
eq(watchUiLang('ko-KR'), 'en', 'unsupported locale falls back to en')
eq(resolveUiLang(), 'en', 'Node / tests without injection stay en')

console.log('uiLang.test.ts ok')
