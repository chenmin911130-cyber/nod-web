/**
 * Tests for the iOS delivery / install provenance entry point (issue #213).
 *
 * Plain node, hand-rolled asserts, no test framework. Run by hand with:
 *
 *   node scripts/ios-deliver.test.mjs
 *   npm run test:ios-deliver
 *
 * Every case uses an isolated fixture checkout in a temp dir plus a local bare
 * "origin". Nothing here touches a real device, a real signing identity, the
 * network, or the real repository.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDeviceId, matchGlob, parseArgs, parsePorcelain, runCapture, runCommand } from './ios-deliver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'ios-deliver.mjs')
const PREPARE = join(HERE, 'prepare-ios-web.mjs')

const REAL_TMP = realpathSync(tmpdir())

let failures = 0
let checks = 0
const cleanups = []

function ok(condition, label) {
  checks += 1
  if (condition) {
    if (process.env.IOS_DELIVER_VERBOSE) process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stderr.write(`  FAIL ${label}\n`)
}

function eq(got, want, label) {
  checks += 1
  if (got === want) {
    if (process.env.IOS_DELIVER_VERBOSE) process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stderr.write(`  FAIL ${label}\n    expected: ${JSON.stringify(want)}\n    got:      ${JSON.stringify(got)}\n`)
}

function section(name) {
  process.stdout.write(`\n${name}\n`)
}

function tmpDir(prefix) {
  const dir = mkdtempSync(join(REAL_TMP, prefix))
  cleanups.push(dir)
  return dir
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(cwd, args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`)
  }
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() }
}

function cli(root, args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
}

/** Run the CLI in-process with an injected command runner (no child processes). */
function runInProcess(root, argv, run) {
  const out = []
  const err = []
  const status = runCommand(argv, { root, run, stdout: (t) => out.push(t), stderr: (t) => err.push(t) })
  return { status, stdout: out.join('\n'), stderr: err.join('\n') }
}

/**
 * A stub `run` for the pinned-bundle flow: it observes the environment of
 * `npm run cap:sync`, optionally lets NOD_IOS_BUNDLE take effect, and fabricates the
 * archive app so the rest of the delivery path can run. No npm/xcodebuild executes.
 */
function pinnedRun(fixture, { honorPin = true } = {}) {
  const state = { syncCalls: [], archiveCalls: 0, pinned: null }
  state.run = (cmd, cmdArgs, opts = {}) => {
    if (cmd === 'npm' && cmdArgs[0] === 'run' && cmdArgs[1] === 'cap:sync') {
      state.syncCalls.push({ argv: cmdArgs, env: opts.env || {} })
      write(join(fixture.root, 'ios/App/App.xcworkspace/contents.xcworkspacedata'), '<?xml version="1.0"?><Workspace/>\n')
      if (honorPin) {
        const pbxPath = join(fixture.root, 'ios/App/App.xcodeproj/project.pbxproj')
        const src = readFileSync(pbxPath, 'utf8')
        state.pinned = opts.env.NOD_IOS_BUNDLE
        writeFileSync(pbxPath, src.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${state.pinned};`))
      }
      return { status: 0, stdout: '', stderr: '', error: null }
    }
    if (cmd === 'xcodebuild' && cmdArgs.includes('archive')) {
      state.archiveCalls += 1
      const archivePath = cmdArgs[cmdArgs.indexOf('-archivePath') + 1]
      const appDir = join(archivePath, 'Products/Applications/App.app')
      cpSync(fixture.appPath, appDir, { recursive: true })
      writeFileSync(join(appDir, 'Info.plist'), PLIST('com.nodpilot.app', '1.0', state.pinned ?? '91'))
      return { status: 0, stdout: '', stderr: '', error: null }
    }
    return runCapture(cmd, cmdArgs, opts)
  }
  return state
}

function expectReject(label, root, args, needle) {
  const res = cli(root, args)
  const text = `${res.stdout}\n${res.stderr}`
  ok(res.status !== 0, `${label}: expected non-zero exit (got ${res.status})\n${text}`)
  if (needle) ok(text.toLowerCase().includes(needle.toLowerCase()), `${label}: message should mention ${JSON.stringify(needle)}\n${text}`)
  return res
}

function expectAccept(label, root, args) {
  const res = cli(root, args)
  ok(res.status === 0, `${label}: expected exit 0, got ${res.status}\n${res.stdout}\n${res.stderr}`)
  return res
}

const PLIST = (bundleId, version, build) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${build}</string>
</dict>
</plist>
`

const PODFILE = `require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'

platform :ios, '14.0'
use_frameworks!

def capacitor_pods
  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'
  pod 'NodAuth', :path => '../../plugins/nod-auth'
  pod 'NodMic', :path => '../../plugins/nod-mic'
  pod 'NodWatch', :path => '../../plugins/nod-watch'
end

target 'App' do
  capacitor_pods
end
`

const PBXPROJ = `// fixture project
CURRENT_PROJECT_VERSION = 91;
MARKETING_VERSION = 1.0;
PRODUCT_BUNDLE_IDENTIFIER = com.nodpilot.app;
PRODUCT_NAME = "$(TARGET_NAME)";
`

function podsPbx(entries) {
  return `// fixture Pods project\n${entries.map((entry) => `\t\t\t\t${entry}`).join('\n')}\n`
}

const DEFAULT_POD_ENTRIES = [
  'path = "../../../plugins/nod-auth";',
  'path = "../../../plugins/nod-mic";',
  'path = "../../../plugins/nod-watch";',
]

const PLUGINS = ['nod-auth', 'nod-mic', 'nod-watch']

/**
 * Build an isolated checkout. Everything is committed so `git status` is clean
 * before a test deliberately dirties it.
 */
function makeFixture({
  pluginTargets = {}, // name -> absolute path the node_modules symlink points at
  podEntries = DEFAULT_POD_ENTRIES,
  appBuild = '91',
  appVersion = '1.0',
  frameworks = ['NodAuth', 'NodMic', 'NodWatch'],
  webMismatch = false,
  watchApp = true,
} = {}) {
  const base = tmpDir('ios-deliver-fx-')
  const root = join(base, 'checkout')
  const other = join(base, 'other-checkout')
  mkdirSync(root, { recursive: true })

  write(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2))
  write(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, name: 'fixture' }))
  write(join(root, 'web/package-lock.json'), JSON.stringify({ lockfileVersion: 3, name: 'fixture-web' }))
  write(join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'com.nodpilot.app', webDir: 'web/dist' }))
  write(join(root, 'ios/App/Podfile'), PODFILE)
  write(join(root, 'ios/App/Podfile.lock'), 'PODS:\n  - NodAuth\n')
  write(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), PBXPROJ)
  write(join(root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'), podsPbx(podEntries))
  write(join(root, 'web/dist/index.html'), '<!doctype html><title>fixture</title>\n')
  write(join(root, 'web/dist/app.js'), 'window.fixture = 1\n')
  write(join(root, 'ios/App/App/public/index.html'), '<!doctype html><title>fixture</title>\n')
  write(join(root, 'ios/App/App/public/app.js'), 'window.fixture = 1\n')

  for (const name of PLUGINS) write(join(root, 'plugins', name, 'package.json'), JSON.stringify({ name }))
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  for (const name of PLUGINS) {
    const target = pluginTargets[name] || join(root, 'plugins', name)
    symlinkSync(target, join(root, 'node_modules', name), 'dir')
  }

  // A second checkout, used to prove cross-worktree dependency rejection.
  for (const name of PLUGINS) write(join(other, 'plugins', name, 'package.json'), JSON.stringify({ name }))

  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'fixture@example.com'])
  git(root, ['config', 'user.name', 'fixture'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'fixture base'])
  const baseSha = git(root, ['rev-parse', 'HEAD']).stdout

  // main moves on so we have a commit origin has that is not HEAD.
  git(root, ['commit', '-q', '--allow-empty', '-m', 'fixture head'])
  const headSha = git(root, ['rev-parse', 'HEAD']).stdout

  const origin = join(base, 'origin.git')
  git(base, ['init', '-q', '--bare', origin])
  git(root, ['remote', 'add', 'origin', origin])
  git(root, ['push', '-q', 'origin', 'main'])
  git(root, ['checkout', '-q', baseSha])
  git(root, ['fetch', '-q', 'origin'])

  // The built app lives OUTSIDE the checkout, exactly like an archive output dir.
  const appPath = join(base, 'built', 'App.app')
  write(join(appPath, 'Info.plist'), PLIST('com.nodpilot.app', appVersion, appBuild))
  const embeddedJs = webMismatch ? 'window.fixture = "stale"\n' : 'window.fixture = 1\n'
  write(join(appPath, 'public/index.html'), '<!doctype html><title>fixture</title>\n')
  write(join(appPath, 'public/app.js'), embeddedJs)
  for (const name of frameworks) {
    write(join(appPath, 'Frameworks', `${name}.framework/Info.plist`), PLIST(`com.nodpilot.${name.toLowerCase()}`, '1.0', '1'))
    write(join(appPath, 'Frameworks', `${name}.framework/${name}`), `binary ${name}\n`)
  }
  if (watchApp) {
    write(join(appPath, 'Watch/WatchApp.app/Info.plist'), PLIST('com.nodpilot.app.watchkitapp', appVersion, appBuild))
  }

  return { base, root, other, origin, appPath, baseSha, headSha }
}

function buildArgs(fixture, extra = [], outName = 'out') {
  return [
    'build',
    '--sha', fixture.baseSha,
    '--bundle', 'com.nodpilot.app',
    '--version', '1.0',
    '--build', '91',
    '--out', join(fixture.base, outName),
    '--app', fixture.appPath,
    '--skip-sync',
    '--test-evidence', 'fixture: node scripts/ios-deliver.test.mjs => pass',
    ...extra,
  ]
}

function readManifest(fixture) {
  return JSON.parse(readFileSync(join(fixture.base, 'out', 'delivery-manifest.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// unit checks
// ---------------------------------------------------------------------------

section('unit: glob matching and porcelain parsing')
ok(matchGlob('ios/App/Pods/Manifest.lock', 'ios/App/Pods/**'), 'Pods/** matches a nested file')
ok(matchGlob('ios/App/Pods', 'ios/App/Pods/**'), 'Pods/** matches the directory entry itself')
ok(matchGlob('ios/App/Podfile', 'ios/App/Podfile'), 'exact path matches')
ok(!matchGlob('web/src/app.ts', 'web/dist/**'), 'web/src is not allowed')
ok(!matchGlob('ios/App/Pods/../Podfile', 'ios/App/Pods/**'), 'traversal is not matched')
ok(matchGlob('anything.log', '*.log'), 'single-star matches a basename')
ok(!matchGlob('nested/anything.log', '*.log'), 'single-star is segment-scoped')

eq(parsePorcelain(' M ios/App/Podfile\n?? web/dist/app.js\nR  old -> new\n').length, 3, 'porcelain line count')
eq(parsePorcelain('R  old.js -> new.js\n')[0].path, 'new.js', 'rename target is the path')
eq(parseArgs(['build', '--sha', 'a'.repeat(40), '--allow-dirty=x/**', '--allow-dirty', 'y/**']).allowDirty.length, 2, 'repeatable flags collect')

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

section('happy path: manifest is produced and validated')
{
  const fixture = makeFixture()
  expectAccept('build happy path', fixture.root, buildArgs(fixture))
  const manifestPath = join(fixture.base, 'out', 'delivery-manifest.json')
  ok(existsSync(manifestPath), 'manifest file written')
  const manifest = readManifest(fixture)

  eq(manifest.schema, 'nod-web/ios-delivery-manifest@1', 'manifest schema')
  eq(manifest.target.sha, fixture.baseSha, 'target SHA recorded')
  eq(manifest.actualSha, fixture.baseSha, 'actual SHA recorded')
  eq(manifest.checkout.realpath, fixture.root, 'checkout realpath recorded')
  eq(manifest.app.build, '91', 'app build recorded')
  eq(manifest.app.version, '1.0', 'app version recorded')
  eq(manifest.app.bundleId, 'com.nodpilot.app', 'app bundle id recorded')
  eq(manifest.app.buildSource, 'artifact', 'a reused --app reports buildSource=artifact, not pinned')
  eq(manifest.artifact.path, fixture.appPath, 'artifact resolved by exact path')
  eq(manifest.artifact.digest, manifest.app.digest, 'artifact digest equals app digest')
  eq(manifest.webAssets.embedded.digest, manifest.webAssets.synced.digest, 'embedded web assets equal cap:sync output')
  eq(typeof manifest.lockfiles['package-lock.json'], 'string', 'root lockfile digest recorded')
  eq(typeof manifest.lockfiles['web/package-lock.json'], 'string', 'web lockfile digest recorded')
  eq(manifest.tools.node, process.version, 'node version recorded')
  eq(manifest.deviceTargets.phone.bundleId, 'com.nodpilot.app', 'phone target recorded')
  eq(manifest.deviceTargets.watch.bundleId, 'com.nodpilot.app.watchkitapp', 'watch target recorded')
  eq(Object.keys(manifest.frameworks).sort().join(','), 'NodAuth,NodMic,NodWatch', 'embedded frameworks recorded')
  eq(manifest.readback.status, 'not-installed', 'read-back starts as not-installed')
  eq(manifest.secretsIncluded, false, 'manifest declares no secrets')
  ok(manifest.unverified.some((line) => line.includes('archive')), 'fixture run records archive as unverified')
  ok(!JSON.stringify(manifest).includes('PRIVATE KEY'), 'manifest has no key material')
  process.stdout.write(`  sample manifest: ${manifestPath}\n`)

  expectAccept('verify happy path', fixture.root, ['verify', '--manifest', manifestPath])

  // Dry-run install gate: authorised + verified, but records unverified read-back.
  expectAccept('install dry run', fixture.root, ['install', '--manifest', manifestPath, '--authorize', '--dry-run'])
  const afterDryRun = readManifest(fixture)
  eq(afterDryRun.readback.status, 'unverified', 'dry run marks read-back unverified')
  eq(afterDryRun.readback.phone, null, 'dry run records no phone read-back')
  ok(afterDryRun.unverified.some((line) => line.includes('device read-back')), 'dry run records unverified read-back reason')
}

// ---------------------------------------------------------------------------
// rejection paths
// ---------------------------------------------------------------------------

section('reject: wrong SHA')
{
  const fixture = makeFixture()
  expectReject('head is not the requested SHA', fixture.root, buildArgs(fixture, ['--sha', fixture.headSha]), 'HEAD')
  expectReject('sha unknown to origin', fixture.root, buildArgs(fixture, ['--sha', '0'.repeat(40)]), 'does not have commit')
  expectReject('sha not a full 40-hex', fixture.root, buildArgs(fixture, ['--sha', 'deadbeef']), '40-character')
  ok(!existsSync(join(fixture.base, 'out')), 'no output directory created when the SHA guard fails')
}

section('reject: dependencies / plugins / Pods outside this checkout')
{
  const fixture = makeFixture()
  const outside = join(fixture.other, 'plugins', 'nod-watch')
  rmSync(join(fixture.root, 'node_modules/nod-watch'))
  symlinkSync(outside, join(fixture.root, 'node_modules/nod-watch'), 'dir')
  git(fixture.root, ['add', '-A'])
  git(fixture.root, ['commit', '-q', '--amend', '--no-edit'])
  const amended = git(fixture.root, ['rev-parse', 'HEAD']).stdout
  git(fixture.root, ['push', '-q', '-f', 'origin', 'HEAD:main'])
  git(fixture.root, ['fetch', '-q', 'origin'])
  expectReject('plugin resolves to another worktree', fixture.root, buildArgs(fixture, ['--sha', amended]), 'resolves to')
}
{
  const fixture = makeFixture()
  const foreign = join(fixture.other, 'plugins/nod-mic')
  rmSync(join(fixture.root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'))
  write(
    join(fixture.root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'),
    podsPbx([DEFAULT_POD_ENTRIES[0], `path = "${foreign}";`, DEFAULT_POD_ENTRIES[2]]),
  )
  git(fixture.root, ['add', '-A'])
  git(fixture.root, ['commit', '-q', '--amend', '--no-edit'])
  const amended = git(fixture.root, ['rev-parse', 'HEAD']).stdout
  git(fixture.root, ['push', '-q', '-f', 'origin', 'HEAD:main'])
  git(fixture.root, ['fetch', '-q', 'origin'])
  expectReject('Pods project escaped the worktree', fixture.root, buildArgs(fixture, ['--sha', amended]), 'escaped this worktree')
}

section('reject: uncommitted changes outside the allowed set')
{
  const fixture = makeFixture()
  write(join(fixture.root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dirty: true }, null, 2))
  expectReject('reviewed source file modified', fixture.root, buildArgs(fixture), 'uncommitted changes outside the allowed delivery set')
  expectReject('unknown flag is refused', fixture.root, buildArgs(fixture, ['--nope']), 'unknown flag')
  const allowed = cli(fixture.root, buildArgs(fixture, ['--allow-dirty', 'package.json', '--out', join(fixture.base, 'out-allowed')]))
  eq(allowed.status, 0, `--allow-dirty permits a deliberate diff\n${allowed.stdout}\n${allowed.stderr}`)
  const manifest = JSON.parse(readFileSync(join(fixture.base, 'out-allowed', 'delivery-manifest.json'), 'utf8'))
  ok(manifest.actualDirty.includes('package.json'), 'allowed diff is recorded in the manifest')
  ok(manifest.allowedDiff.includes('package.json'), 'allowed set is recorded in the manifest')
}

section('reject: build version mismatch')
{
  const fixture = makeFixture()
  expectReject('app build does not match --build', fixture.root, buildArgs(fixture, ['--build', '999'], 'out-build'), 'CFBundleVersion')
  expectReject('app version does not match --version', fixture.root, buildArgs(fixture, ['--version', '9.9'], 'out-version'), 'CFBundleShortVersionString')
  expectReject('bundle id does not match --bundle', fixture.root, buildArgs(fixture, ['--bundle', 'com.example.other'], 'out-bundle'), 'CFBundleIdentifier')
}

section('bundle is explicitly specified and pinned (NOD_IOS_BUNDLE)')
{
  const fixture = makeFixture()

  // 1) --build itself is a required, explicit non-negative integer.
  expectReject(
    'missing --build is refused',
    fixture.root,
    ['build', '--sha', fixture.baseSha, '--bundle', 'com.nodpilot.app', '--version', '1.0', '--out', join(fixture.base, 'out-missing'), '--app', fixture.appPath, '--skip-sync'],
    '--build is required',
  )
  expectReject(
    'non-integer --build is refused',
    fixture.root,
    buildArgs(fixture, ['--build', 'abc'], 'out-abc'),
    'non-negative integer',
  )
  expectReject(
    'fractional --build is refused',
    fixture.root,
    buildArgs(fixture, ['--build', '1.5'], 'out-frac'),
    'non-negative integer',
  )
  expectReject(
    'negative --build is refused',
    fixture.root,
    buildArgs(fixture, ['--build', '-1'], 'out-neg'),
    'non-negative integer',
  )

  // 2) The guarded build passes NOD_IOS_BUNDLE to cap:sync and archives exactly that
  //    bundle. The stub run observes the env; it is not a real npm/xcodebuild call.
  const pinned = pinnedRun(fixture)
  const built = runInProcess(
    fixture.root,
    ['build', '--sha', fixture.baseSha, '--bundle', 'com.nodpilot.app', '--version', '1.0', '--build', '300', '--out', join(fixture.base, 'out-pinned'), '--team-id', 'TESTTEAM'],
    pinned.run,
  )
  eq(built.status, 0, `pinned build succeeds\n${built.stdout}\n${built.stderr}`)
  eq(pinned.syncCalls.length, 1, 'cap:sync was invoked exactly once')
  eq(pinned.syncCalls[0].env.NOD_IOS_BUNDLE, '300', 'cap:sync receives the requested bundle in its environment')
  const pinnedManifest = JSON.parse(readFileSync(join(fixture.base, 'out-pinned', 'delivery-manifest.json'), 'utf8'))
  eq(pinnedManifest.app.build, '300', 'the manifest records the requested bundle')
  eq(pinnedManifest.app.buildSource, 'pinned', 'the manifest says the bundle was pinned, not incremented')
  ok(pinnedManifest.verified.some((line) => line.includes('NOD_IOS_BUNDLE=300')), 'verified[] records the pin')
  eq(pinnedManifest.target.sha, fixture.baseSha, 'pinned build keeps the SHA provenance')

  // 3) If the pin does not take effect, the post-sync assertion refuses before archive.
  //    A fresh fixture keeps the "left behind" value unambiguous.
  const ignoredFixture = makeFixture()
  const ignored = pinnedRun(ignoredFixture, { honorPin: false })
  const refused = runInProcess(
    ignoredFixture.root,
    ['build', '--sha', ignoredFixture.baseSha, '--bundle', 'com.nodpilot.app', '--version', '1.0', '--build', '301', '--out', join(ignoredFixture.base, 'out-unpinned'), '--team-id', 'TESTTEAM'],
    ignored.run,
  )
  eq(refused.status, 2, `a sync that ignores the pin is refused\n${refused.stderr}`)
  ok(refused.stderr.includes('NOD_IOS_BUNDLE=301 did not take effect'), `refusal names the pin\n${refused.stderr}`)
  ok(refused.stderr.includes('CURRENT_PROJECT_VERSION = 91'), `refusal shows the value that was left behind\n${refused.stderr}`)
  eq(ignored.archiveCalls, 0, 'no archive is attempted when the pin did not take effect')
}

section('prepare-ios-web pins NOD_IOS_BUNDLE instead of incrementing')
{
  const fixture = makeFixture()
  const pbxPath = join(fixture.root, 'ios/App/App.xcodeproj/project.pbxproj')
  const readBundle = () => /CURRENT_PROJECT_VERSION = (\d+);/.exec(readFileSync(pbxPath, 'utf8'))[1]
  const runPrepare = (env) => {
    const merged = { ...process.env }
    if (env === undefined) delete merged.NOD_IOS_BUNDLE
    else merged.NOD_IOS_BUNDLE = env
    return spawnSync(process.execPath, [PREPARE], { cwd: fixture.root, env: merged, encoding: 'utf8' })
  }

  const unset = runPrepare(undefined)
  eq(unset.status, 0, 'prepare-ios-web succeeds with no NOD_IOS_BUNDLE')
  eq(readBundle(), '92', 'without the env var the historical increment is kept')

  const pinnedPrepare = runPrepare('300')
  eq(pinnedPrepare.status, 0, 'prepare-ios-web succeeds with NOD_IOS_BUNDLE')
  eq(readBundle(), '300', 'NOD_IOS_BUNDLE writes exactly the requested bundle')
  ok(pinnedPrepare.stdout.includes('pinned by NOD_IOS_BUNDLE'), 'the pinned write is stated in the output')

  eq(runPrepare('0').status, 0, 'a zero bundle is allowed')
  eq(readBundle(), '0', 'zero is written exactly, not treated as unset')

  const bad = runPrepare('1.5')
  ok(bad.status !== 0, 'a non-integer NOD_IOS_BUNDLE is refused')
  ok(`${bad.stderr}${bad.stdout}`.includes('NOD_IOS_BUNDLE must be a non-negative integer'), 'the refusal explains the requirement')
  eq(readBundle(), '0', 'a refused pin leaves the project untouched')

  const negative = runPrepare('-1')
  ok(negative.status !== 0, 'a negative NOD_IOS_BUNDLE is refused')
}

section('reject: missing embedded framework')
{
  const fixture = makeFixture({ frameworks: ['NodAuth', 'NodWatch'] })
  expectReject('NodMic.framework missing from the app', fixture.root, buildArgs(fixture), 'NodMic')
}

section('reject: web assets do not match cap:sync output')
{
  const fixture = makeFixture({ webMismatch: true })
  expectReject('embedded JS is stale', fixture.root, buildArgs(fixture), 'do not match')
}

section('reject: stale / replaced artifact and missing manifest')
{
  const fixture = makeFixture()
  expectAccept('build for stale-artifact case', fixture.root, buildArgs(fixture))
  const manifestPath = join(fixture.base, 'out', 'delivery-manifest.json')
  expectAccept('verify before replacement', fixture.root, ['verify', '--manifest', manifestPath])

  const older = join(fixture.base, 'built-old', 'App.app')
  cpSync(fixture.appPath, older, { recursive: true })
  write(join(older, 'Info.plist'), PLIST('com.nodpilot.app', '1.0', '90'))
  rmSync(fixture.appPath, { recursive: true, force: true })
  cpSync(older, fixture.appPath, { recursive: true })

  expectReject('verify rejects an older artifact at the same path', fixture.root, ['verify', '--manifest', manifestPath], 'digest mismatch')
  expectReject('install rejects an older artifact at the same path', fixture.root, ['install', '--manifest', manifestPath, '--authorize', '--dry-run'], 'digest mismatch')

  expectReject('missing manifest', fixture.root, ['verify', '--manifest', join(fixture.base, 'out', 'nope.json')], 'not found')
  expectReject('install without a manifest', fixture.root, ['install', '--manifest', join(fixture.base, 'out', 'nope.json'), '--authorize'], 'not found')

  const tampered = JSON.parse(readFileSync(manifestPath, 'utf8'))
  tampered.checkout.realpath = fixture.other
  const tamperedPath = join(fixture.base, 'out', 'tampered.json')
  write(tamperedPath, JSON.stringify(tampered, null, 2))
  expectReject('manifest from another checkout', fixture.root, ['verify', '--manifest', tamperedPath], 'not this checkout')
}

section('reject: install gating and artifact identity')
{
  const fixture = makeFixture()
  expectAccept('build for install-gate case', fixture.root, buildArgs(fixture))
  const manifestPath = join(fixture.base, 'out', 'delivery-manifest.json')

  expectReject('install without explicit authorisation', fixture.root, ['install', '--manifest', manifestPath], 'authorisation')

  const decoy = join(fixture.base, 'decoy', 'App.app')
  cpSync(fixture.appPath, decoy, { recursive: true })
  expectReject(
    'artifact is not the one this run produced',
    fixture.root,
    ['install', '--manifest', manifestPath, '--authorize', '--dry-run', '--artifact', decoy],
    'is not the artifact this run produced',
  )

  // install without --artifact still resolves the exact manifest path, never newest-file.
  const dry = cli(fixture.root, ['install', '--manifest', manifestPath, '--authorize', '--dry-run'])
  eq(dry.status, 0, 'authorised dry-run install passes preflight')
  ok(dry.stdout.includes(fixture.appPath), 'dry run prints the exact artifact path')
  ok(!dry.stdout.includes('decoy'), 'dry run never selects a different file')
}

section('unit: install target resolution never guesses')
{
  const iphone = { identifier: 'IPHONE-UUID', hardwareProperties: { udid: '00008150-0001', platform: 'iOS', deviceType: 'iPhone' }, deviceProperties: { name: 'iPhone' }, connectionProperties: { pairingState: 'paired', tunnelState: 'unavailable' } }
  const iphone2 = { identifier: 'IPHONE-2', hardwareProperties: { platform: 'iOS', deviceType: 'iPhone' }, deviceProperties: { name: 'iPhone 2' } }
  const watch = { identifier: 'WATCH-UUID', hardwareProperties: { platform: 'watchOS', deviceType: 'appleWatch' }, deviceProperties: { name: 'Watch' } }
  eq(findDeviceId({ result: { devices: [iphone, watch] } }).id, 'IPHONE-UUID', 'a single iPhone resolves')
  eq(findDeviceId({ result: { devices: [iphone, iphone2] } }).id, null, 'two iPhones are ambiguous, not guessed')
  eq(findDeviceId({ result: { devices: [watch] } }).id, null, 'a Watch is not the phone install target')
  eq(findDeviceId({}).id, null, 'an unreadable device list never resolves an id')
}

section('install + read-back against a fake devicectl (no real device)')
{
  // A fake `xcrun devicectl` so the install/read-back path is exercised end to end
  // without a device, a signing identity, or the network.
  const fakeDeviceRun = ({ apps = [], devices = [], readStatus = 0, installStatus = 0 } = {}) => (cmd, cmdArgs, opts = {}) => {
    if (cmd === 'xcrun' && cmdArgs[0] === 'devicectl') {
      if (cmdArgs[1] === 'list' && cmdArgs[2] === 'devices') {
        const flag = cmdArgs.indexOf('--json-output')
        writeFileSync(cmdArgs[flag + 1], JSON.stringify({ result: { devices } }))
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      if (cmdArgs[1] === 'device' && cmdArgs[2] === 'install') {
        return { status: installStatus, stdout: '', stderr: installStatus ? 'install refused by device' : '', error: null }
      }
      if (cmdArgs[1] === 'device' && cmdArgs[2] === 'info' && cmdArgs[3] === 'apps') {
        if (readStatus !== 0) return { status: readStatus, stdout: '', stderr: 'device is locked', error: null }
        const flag = cmdArgs.indexOf('--json-output')
        writeFileSync(cmdArgs[flag + 1], JSON.stringify({ result: { apps } }))
        return { status: 0, stdout: '', stderr: '', error: null }
      }
    }
    return runCapture(cmd, cmdArgs, opts)
  }
  const phoneApp = { bundleIdentifier: 'com.nodpilot.app', shortVersion: '1.0', bundleVersion: '91' }
  const watchApp = { bundleIdentifier: 'com.nodpilot.app.watchkitapp', shortVersion: '1.0', bundleVersion: '91' }

  const fixture = makeFixture()
  expectAccept('build before install', fixture.root, buildArgs(fixture))
  const manifestPath = join(fixture.base, 'out', 'delivery-manifest.json')

  const good = runInProcess(fixture.root, ['install', '--manifest', manifestPath, '--device', 'FAKE-UDID', '--authorize'], fakeDeviceRun({ apps: [phoneApp, watchApp], devices: [{ identifier: 'FAKE-UDID', hardwareProperties: { platform: 'iOS', deviceType: 'iPhone' }, deviceProperties: { name: 'Fake iPhone' } }] }))
  eq(good.status, 0, `install + matching read-back exits 0\n${good.stdout}\n${good.stderr}`)
  let manifest = readManifest(fixture)
  eq(manifest.readback.status, 'verified', 'matching read-back is recorded as verified')
  eq(manifest.readback.phone.status, 'verified', 'phone read-back verified')
  eq(manifest.readback.watch.status, 'verified', 'watch read-back verified')
  eq(manifest.readback.phone.observed.build, '91', 'read-back records the observed build')
  eq(manifest.readback.device, 'FAKE-UDID', 'read-back records the device')
  eq(manifest.readback.devices.length, 1, 'read-back records the devicectl device list')

  const stale = runInProcess(
    fixture.root,
    ['install', '--manifest', manifestPath, '--device', 'FAKE-UDID', '--authorize'],
    fakeDeviceRun({ apps: [{ ...phoneApp, bundleVersion: '77' }, watchApp] }),
  )
  eq(stale.status, 3, 'installed-but-older build exits non-zero')
  manifest = readManifest(fixture)
  eq(manifest.readback.status, 'mismatch', 'older installed build is recorded as mismatch')
  ok(manifest.unverified.some((line) => line.includes('device read-back')), 'mismatch is also listed under unverified')

  const locked = runInProcess(
    fixture.root,
    ['install', '--manifest', manifestPath, '--device', 'FAKE-UDID', '--authorize'],
    fakeDeviceRun({ readStatus: 70 }),
  )
  eq(locked.status, 3, 'locked device exits non-zero')
  manifest = readManifest(fixture)
  eq(manifest.readback.status, 'unverified', 'locked device is recorded as unverified, never success')
  ok(manifest.readback.phone.reason.includes('locked or unreadable'), 'locked device records the reason')
}

section('reject: output directory must be unique')
{
  const fixture = makeFixture()
  expectAccept('first build', fixture.root, buildArgs(fixture))
  expectReject('output directory must be unique', fixture.root, buildArgs(fixture), 'already exists')
}

// ---------------------------------------------------------------------------

// Set IOS_DELIVER_KEEP_TMP=1 to inspect the fixtures (used to capture a sample manifest).
if (!process.env.IOS_DELIVER_KEEP_TMP) {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures) {
  process.stderr.write(`ios-deliver.test.mjs: ${failures} check(s) failed\n`)
  process.exitCode = 1
} else {
  process.stdout.write('ios-deliver.test.mjs ok\n')
}
