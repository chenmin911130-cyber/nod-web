import { formatAppBuild } from './native'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(formatAppBuild('1.0', '12'), '1.0 (12)', 'native label is marketing version plus bundle')
eq(formatAppBuild(' 1.0 ', ' 12 '), '1.0 (12)', 'trims version and build')
eq(formatAppBuild('', '12'), '12', 'build alone when marketing version is empty')
eq(formatAppBuild('1.0', ''), '1.0', 'version alone when build is empty')
eq(formatAppBuild('12', '12'), '12', 'does not duplicate identical values')
eq(formatAppBuild('', ''), '', 'empty when both missing')

console.log('native.test.ts: ok')
