import { nativeColdStartSurface } from './nativeColdStart'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(nativeColdStartSurface('tok-1'), 'workspace', 'a stored token opens the workspace without waiting for /api/me')
eq(nativeColdStartSurface(''), 'signin', 'no token opens native sign-in without waiting for /api/me')

console.log('nativeColdStart.test.ts: ok')
