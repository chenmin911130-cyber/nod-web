import { formatAppBuild, safeNextPath } from './native'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(formatAppBuild('1.0', '12'), '1.0 (12)', 'native label is marketing version plus bundle')
eq(formatAppBuild(' 1.0 ', ' 12 '), '1.0 (12)', 'trims version and build')
eq(formatAppBuild('', '12'), '12', 'build alone when marketing version is empty')
eq(formatAppBuild('1.0', ''), '1.0', 'version alone when build is empty')
eq(formatAppBuild('12', '12'), '12', 'does not duplicate identical values')
eq(formatAppBuild('', ''), '', 'empty when both missing')

eq(safeNextPath('/app'), '/app', 'workspace next')
eq(safeNextPath('/account'), '/account', 'account next')
eq(safeNextPath('/login?next=/app'), '/login?next=/app', 'keeps same-origin query')
eq(safeNextPath('/?signout=1'), '/?signout=1', 'keeps sign-out query')
eq(safeNextPath('https://evil.example/phish'), '/app', 'rejects absolute http')
eq(safeNextPath('//evil.example/phish'), '/app', 'rejects protocol-relative')
eq(safeNextPath('/\\evil.example'), '/app', 'rejects backslash protocol-relative')
eq(safeNextPath('javascript:alert(1)'), '/app', 'rejects javascript URL')
eq(safeNextPath(''), '/app', 'empty falls back')
eq(safeNextPath(null), '/app', 'null falls back')

console.log('native.test.ts: ok')
