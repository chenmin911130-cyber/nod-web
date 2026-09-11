import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pinPodfile, assertPluginRoots, assertPodsProject } from './iosWorktreePods.mjs'
import {
  assertFullSha,
  assertCheckout,
  assertDependencies,
  assertExpectedBundle,
  assertOutputDir,
  buildManifest,
  writeManifest,
  loadManifest,
  assertManifestMatchesArtifacts,
  prepareInstall,
  hashPath,
  runCli,
} from './iosDeliver.mjs'

function eq(got, want, label) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
}

function throws(fn, re, label) {
  try {
    fn()
  } catch (err) {
    if (!re.test(err.message)) {
      throw new Error(`${label}: expected /${re}/, got ${err.message}`)
    }
    return
  }
  throw new Error(`${label}: expected throw`)
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return (result.stdout || '').trim()
}

function makeRoot() {
  const base = join(process.cwd(), '.tmp-deliver')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'r-'))
}

function writePbx(root, version = '88') {
  mkdirSync(join(root, 'ios/App/App.xcodeproj'), { recursive: true })
  writeFileSync(
    join(root, 'ios/App/App.xcodeproj/project.pbxproj'),
    `CURRENT_PROJECT_VERSION = ${version};\nCURRENT_PROJECT_VERSION = ${version};\n`,
  )
}

function writePlugins(root) {
  for (const name of ['nod-auth', 'nod-mic', 'nod-watch']) {
    mkdirSync(join(root, 'plugins', name), { recursive: true })
    writeFileSync(join(root, 'plugins', name, 'index.js'), `${name}\n`)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(join(root, 'plugins', name), join(root, 'node_modules', name))
  }
  mkdirSync(join(root, 'web/node_modules'), { recursive: true })
  writeFileSync(join(root, 'web/node_modules/.keep'), 'ok\n')
}

function makeRepo(extra) {
  const root = makeRoot()
  writePlugins(root)
  writePbx(root)
  writeFileSync(join(root, 'capacitor.config.json'), JSON.stringify({ webDir: 'web/dist', server: { iosScheme: 'capacitor' } }))
  extra?.(root)
  git(root, ['init', '-b', 'main', '--template='])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'init'])
  const sha = git(root, ['rev-parse', 'HEAD'])
  return { root, sha }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

// Reuse the existing Pods pin test so this file cannot drift away from it.
const escaped = `
require_relative '../../../../../Users/minchen/Projects/nod-web/node_modules/@capacitor/ios/scripts/pods_helpers'
pod 'NodMic', :path => '../../../../../Users/minchen/Projects/nod-web/plugins/nod-mic'
`
const pinned = pinPodfile(escaped)
if (pinned.includes('Projects/nod-web')) throw new Error('pinPodfile must not keep the dirty checkout path')

throws(() => assertFullSha('05e8e43'), /40-character/, 'short sha')
throws(() => assertFullSha('not-a-sha-not-a-sha-not-a-sha-not-a-sha-12'), /40-character/, 'non-hex sha')

{
  const { root, sha } = makeRepo()
  throws(() => assertCheckout({ root, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /does not match/, 'wrong sha')
  const ok = assertCheckout({ root, sha })
  eq(ok.sha, sha, 'matching sha')
  writeFileSync(join(root, 'secret.txt'), 'nope\n')
  throws(() => assertCheckout({ root, sha }), /unexpected changes/, 'dirty source')
  cleanup(root)
}

{
  const other = makeRoot()
  mkdirSync(join(other, 'plugins/nod-mic'), { recursive: true })
  writeFileSync(join(other, 'plugins/nod-mic/index.js'), 'old\n')
  const { root } = makeRepo()
  rmSync(join(root, 'node_modules/nod-mic'), { force: true })
  symlinkSync(join(other, 'plugins/nod-mic'), join(root, 'node_modules/nod-mic'))
  throws(() => assertPluginRoots(root), /resolves to/, 'plugin realpath escapes worktree')
  throws(() => assertDependencies(root), /resolves to/, 'dependencies reject cross-worktree plugin')
  cleanup(root)
  cleanup(other)
}

{
  const { root } = makeRepo()
  const outside = makeRoot()
  rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  symlinkSync(outside, join(root, 'node_modules'))
  throws(() => assertPluginRoots(root), /symlink/, 'node_modules symlink to another checkout')
  cleanup(root)
  cleanup(outside)
}

{
  const { root } = makeRepo()
  const outside = makeRoot()
  rmSync(join(root, 'web/node_modules'), { recursive: true, force: true })
  mkdirSync(join(outside, 'web-nm'), { recursive: true })
  symlinkSync(join(outside, 'web-nm'), join(root, 'web/node_modules'))
  throws(() => assertDependencies(root), /web\/node_modules is a symlink/, 'web node_modules symlink')
  cleanup(root)
  cleanup(outside)
}

{
  const { root } = makeRepo()
  rmSync(join(root, 'node_modules/nod-auth'), { force: true })
  rmSync(join(root, 'node_modules/nod-mic'), { force: true })
  rmSync(join(root, 'node_modules/nod-watch'), { force: true })
  throws(() => assertDependencies(root), /directory existence is not proof|missing nod-mic/, 'empty node_modules is not proof')
  cleanup(root)
}

{
  const { root } = makeRepo()
  mkdirSync(join(root, 'ios/App/Pods/Pods.xcodeproj'), { recursive: true })
  writeFileSync(
    join(root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'),
    `path = /Users/minchen/Projects/nod-web/plugins/nod-mic;\npath = /Users/minchen/Projects/nod-web/plugins/nod-watch;\npath = /Users/minchen/Projects/nod-web/plugins/nod-auth;\n`,
  )
  throws(() => assertPodsProject(root), /escaped this worktree/, 'Pods project points at another checkout')
  writeFileSync(
    join(root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'),
    `path = ${join(root, 'plugins/nod-mic')};\npath = ${join(root, 'plugins/nod-watch')};\npath = ${join(root, 'plugins/nod-auth')};\n`,
  )
  const pods = assertPodsProject(root)
  if (!pods.plugins.length) throw new Error('in-worktree Pods paths should pass')
  cleanup(root)
}

{
  const { root } = makeRepo()
  throws(() => assertExpectedBundle(root, '99'), /does not match --bundle 99/, 'bundle mismatch')
  eq(assertExpectedBundle(root, '88'), '88', 'bundle match')
  cleanup(root)
}

{
  const { root, sha } = makeRepo((dir) => {
    mkdirSync(join(dir, 'web/dist'), { recursive: true })
    writeFileSync(join(dir, 'web/dist/app.html'), 'app\n')
  })
  const out = join(root, 'out')
  mkdirSync(join(out, 'App.app'), { recursive: true })
  writeFileSync(join(out, 'App.app/Info.plist'), 'app-v1\n')
  const appPath = join(out, 'App.app')
  const manifest = buildManifest({
    root,
    targetSha: sha,
    actualSha: sha,
    bundle: '88',
    outDir: out,
    appPath,
    stages: { build: 'ok', install: 'not-authorized', device: 'unverified' },
    unverified: ['device install'],
  })
  const manifestPath = writeManifest(out, manifest)
  assertManifestMatchesArtifacts(loadManifest(manifestPath))

  writeFileSync(join(out, 'App.app/Info.plist'), 'app-v2-swapped\n')
  throws(() => assertManifestMatchesArtifacts(loadManifest(manifestPath)), /hash mismatch/, 'old artifact replaced')

  writeFileSync(join(out, 'App.app/Info.plist'), 'app-v1\n')
  const denied = prepareInstall({ manifestPath, installOk: false })
  eq(denied.status, 'not-authorized', 'install without authorization')

  throws(() => prepareInstall({ manifestPath: join(out, 'missing.json'), installOk: true }), /missing delivery manifest/, 'missing manifest')

  let installedPath = null
  const ok = prepareInstall({
    manifestPath,
    installOk: true,
    installer: (m) => {
      installedPath = m.artifacts.app.path
    },
    deviceReader: () => ({
      iphone: { bundleId: 'com.nodpilot.app', version: '88', build: '88', verified: true },
      watch: { bundleId: 'com.nodpilot.app.watchkitapp', version: '88', build: '88', verified: true },
    }),
  })
  eq(ok.status, 'installed', 'authorized install')
  eq(installedPath, appPath, 'install uses exact artifact path')
  eq(ok.manifest.devices.iphone.version, '88', 'phone version readback')
  eq(ok.manifest.devices.watch.version, '88', 'watch version readback')
  eq(hashPath(appPath), manifest.artifacts.app.sha256, 'happy path hash')
  cleanup(root)
}

{
  const { root, sha } = makeRepo()
  const out = join(root, 'deliver-a')
  assertOutputDir(out, sha)
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ actualSha: sha }))
  assertOutputDir(out, sha)
  throws(() => assertOutputDir(out, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), /already has manifest/, 'refuse mixing SHAs in one out dir')
  cleanup(root)
}

{
  const here = process.cwd()
  const unlocked = spawnSync('bash', ['scripts/package-ios.sh'], { cwd: here, encoding: 'utf8' })
  if (unlocked.status === 0) throw new Error('unlocked cap:ios must fail')
  if (!/not a delivery path/.test(unlocked.stderr)) throw new Error(`unlocked message: ${unlocked.stderr}`)
  const noSha = spawnSync('bash', ['scripts/package-ios.sh', '--archive', '--bundle', '88', '--out', '/tmp/nod-deliver-no-sha'], {
    cwd: here,
    encoding: 'utf8',
  })
  if (noSha.status === 0) throw new Error('archive without sha must fail')
  if (!/sha and --bundle are required/.test(noSha.stderr)) throw new Error(`no-sha message: ${noSha.stderr}`)
  throws(
    () => runCli(['install', '--manifest', join(here, 'no-such-manifest.json'), '--install-ok']),
    /missing delivery manifest/,
    'cli missing manifest',
  )
}

console.log('iosDeliver.test.mjs ok')
