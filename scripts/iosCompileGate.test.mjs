/**
 * Tests for the iOS/watchOS compile gate (issue #234).
 *
 * Plain node, hand-rolled asserts, no test framework, no xcodebuild, no real checkout:
 * every case uses a temp fixture and an injected command runner. Run with:
 *
 *   node scripts/iosCompileGate.test.mjs
 *   npm run test:ios-compile-gate
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CompileGateError,
  DEVICE_DESTINATION,
  SIMULATOR_DESTINATION,
  assertGatePreconditions,
  extractCompileErrors,
  gateDerivedData,
  pathPrefixes,
  runCommand,
  runCompileGate,
} from './iosCompileGate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'iosCompileGate.mjs')

let failures = 0
let checks = 0
const cleanups = []

function ok(condition, label) {
  checks += 1
  if (condition) {
    if (process.env.IOS_GATE_VERBOSE) process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stderr.write(`  FAIL ${label}\n`)
}

function eq(got, want, label) {
  checks += 1
  if (got === want) {
    if (process.env.IOS_GATE_VERBOSE) process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stderr.write(`  FAIL ${label}\n    expected: ${JSON.stringify(want)}\n    got:      ${JSON.stringify(got)}\n`)
}

function section(name) {
  process.stdout.write(`\n${name}\n`)
}

function tmpDir(prefix) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix))
  cleanups.push(dir)
  return dir
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A checkout shaped like the real one, minus everything the gate does not read. */
function fixture({ lockMismatch = false } = {}) {
  const root = tmpDir('ios-gate-fixture-')
  write(join(root, 'ios/App/App.xcworkspace/contents.xcworkspacedata'), '<?xml version="1.0"?><Workspace/>')
  write(join(root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'), '// pods')
  write(join(root, 'ios/App/Podfile.lock'), 'PODS:\n  - NodWatch\n')
  write(join(root, 'ios/App/Pods/Manifest.lock'), lockMismatch ? 'PODS:\n  - NodWatch\n  - NodSplash\n' : 'PODS:\n  - NodWatch\n')
  write(join(root, 'ios/App/App/public/index.html'), '<html></html>')
  write(join(root, 'ios/App/App/capacitor.config.json'), '{}')
  write(join(root, 'ios/App/App/config.xml'), '<widget/>')
  return root
}

function captureRun(result) {
  const calls = []
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { status: 0, stdout: '', stderr: '', error: null, ...result }
  }
  return { run, calls }
}

const REAL_FAILURE = `CompileSwift normal arm64 /repo/plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift
/repo/plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift:75:21: error: extra argument 'copyId' in call
/repo/plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift:75:21: error: extra argument 'copyId' in call
/repo/ios/App/WatchApp/WatchCopy.swift:12:9: warning: unused variable 'x'
** BUILD FAILED **
`

// ---------------------------------------------------------------------------

section('extractCompileErrors')
{
  const errors = extractCompileErrors(REAL_FAILURE, '/repo')
  eq(errors.length, 1, 'duplicate diagnostics collapse to one line')
  ok(errors[0].startsWith("plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift:75:21: error: extra argument 'copyId' in call"), 'checkout prefix is stripped from the error line')
  eq(extractCompileErrors('** BUILD SUCCEEDED **\n', '/repo').length, 0, 'a successful log has no errors')
  eq(extractCompileErrors('    |          `- warning: deprecated [#DeprecatedDeclaration]\n', '/repo').length, 0, 'warning-only output is not a failure')
  eq(extractCompileErrors('note: Using new build system\nerror: The sandbox is not in sync with the Podfile.lock\n', '/repo').length, 1, 'a pod-lock error is surfaced')
}

section('extractCompileErrors — symlinked roots')
{
  // $TMPDIR is /private/var/... on macOS, but xcodebuild may report the /var/... form.
  const root = fixture()
  const asTmp = root.replace(/^\/private/, '')
  ok(asTmp !== root, 'the fixture root really does have a /private alias')
  const stripped = extractCompileErrors(
    `${asTmp}/plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift:75:21: error: extra argument 'copyId' in call\n`,
    root,
  )
  eq(stripped.length, 1, 'a diagnostic printed under the alias form is still extracted')
  eq(
    stripped[0],
    "plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift:75:21: error: extra argument 'copyId' in call",
    'the alias form of the root is stripped, not only the exact realpath',
  )
  ok(pathPrefixes(root).length >= 2, 'both forms of the root are considered')
}

section('gateDerivedData')
{
  const a = gateDerivedData(fixture())
  const b = gateDerivedData(fixture())
  ok(a !== b, 'two checkouts never share a DerivedData cache')
  ok(a.startsWith(realpathSync(tmpdir())), 'the cache lives outside the checkout')
  eq(gateDerivedData(realpathSync(tmpdir())), gateDerivedData(realpathSync(tmpdir())), 'the same checkout reuses its own cache')
}

section('assertGatePreconditions')
{
  const root = fixture()
  eq(assertGatePreconditions(root).workspace, join(root, 'ios/App/App.xcworkspace'), 'a synced checkout passes and reports the workspace')

  const noWorkspace = fixture()
  rmSync(join(noWorkspace, 'ios/App/App.xcworkspace'), { recursive: true })
  try {
    assertGatePreconditions(noWorkspace)
    ok(false, 'missing workspace must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /cap:sync/.test(error.message), 'missing workspace tells you to run cap:sync')
  }

  try {
    assertGatePreconditions(fixture({ lockMismatch: true }))
    ok(false, 'a stale Pods project must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /pod install/.test(error.message), 'a stale Pods project tells you to run pod install')
  }

  const noPublic = fixture()
  rmSync(join(noPublic, 'ios/App/App/public'), { recursive: true })
  try {
    assertGatePreconditions(noPublic)
    ok(false, 'a missing web bundle must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /cap:sync/.test(error.message), 'a missing App/public tells you to run cap:sync')
  }

  const noCapConfig = fixture()
  rmSync(join(noCapConfig, 'ios/App/App/capacitor.config.json'))
  try {
    assertGatePreconditions(noCapConfig)
    ok(false, 'a missing capacitor.config.json must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /cap:sync/.test(error.message), 'a missing capacitor.config.json tells you to run cap:sync')
  }

  const noConfigXml = fixture()
  rmSync(join(noConfigXml, 'ios/App/App/config.xml'))
  try {
    assertGatePreconditions(noConfigXml)
    ok(false, 'a missing config.xml must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /cap:sync/.test(error.message), 'a missing config.xml tells you to run cap:sync')
  }

  const noPods = fixture()
  rmSync(join(noPods, 'ios/App/Pods'), { recursive: true })
  try {
    assertGatePreconditions(noPods)
    ok(false, 'a missing Pods project must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /pod install/.test(error.message), 'a missing Pods project tells you how to install pods')
  }

  // Pods present but half-installed: the comparison alone would have skipped these, because it
  // only ran when both halves existed. CocoaPods' "[CP] Check Pods Manifest.lock" phase fails
  // on a missing half, so passing them through means the long build failure comes back.
  const noManifestLock = fixture()
  rmSync(join(noManifestLock, 'ios/App/Pods/Manifest.lock'))
  try {
    assertGatePreconditions(noManifestLock)
    ok(false, 'a missing Pods/Manifest.lock must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /pod install/.test(error.message), 'a missing Pods/Manifest.lock tells you to run pod install')
  }

  const noPodfileLock = fixture()
  rmSync(join(noPodfileLock, 'ios/App/Podfile.lock'))
  try {
    assertGatePreconditions(noPodfileLock)
    ok(false, 'a missing Podfile.lock must refuse')
  } catch (error) {
    ok(error instanceof CompileGateError && /cap:sync/.test(error.message), 'a missing Podfile.lock tells you to run cap:sync')
  }
}

section('runCompileGate — arguments')
{
  const root = fixture()
  const { run, calls } = captureRun({ status: 0 })
  const result = runCompileGate({ root, run, derivedDataPath: join(root, 'dd') })
  eq(calls.length, 1, 'exactly one xcodebuild invocation')
  const [call] = calls
  eq(call.cmd, 'xcodebuild', 'invokes xcodebuild')
  const joined = call.args.join(' ')
  ok(joined.includes('-scheme App'), 'builds the real App scheme, whose target graph pulls in WatchApp and the local pods')
  ok(joined.includes(`-destination ${SIMULATOR_DESTINATION}`), 'defaults to the machine-independent simulator destination')
  ok(joined.includes('-configuration Debug'), 'defaults to Debug for a fast loop')
  ok(joined.includes('CODE_SIGNING_ALLOWED=NO'), 'needs no signing identity or team')
  eq(call.args[call.args.length - 1], 'build', 'runs build, not archive')
  ok(joined.includes(join(root, 'dd')), 'uses the DerivedData it was given')
  ok(result.seconds >= 0 && typeof result.logPath === 'string', 'reports timing and a log path')
  ok(result.logPath.startsWith(root), 'writes the log next to the given DerivedData')
}

section('runCompileGate — failure')
{
  const root = fixture()
  const { run } = captureRun({ status: 65, stdout: REAL_FAILURE })
  try {
    runCompileGate({ root, run, derivedDataPath: join(root, 'dd') })
    ok(false, 'a non-zero xcodebuild must throw')
  } catch (error) {
    ok(error instanceof CompileGateError, 'throws CompileGateError')
    eq(error.status, 65, 'carries the xcodebuild exit status')
    eq(error.errors.length, 1, 'carries the extracted compile errors')
    ok(/does not compile/.test(error.message), 'the message says the real scheme does not compile')
    ok(error.logPath.endsWith('xcodebuild.log'), 'points at the full log')
  }

  const unreachable = captureRun({ status: null, error: 'spawnSync xcodebuild ENOENT' })
  try {
    runCompileGate({ root: fixture(), run: unreachable.run, derivedDataPath: join(fixture(), 'dd') })
    ok(false, 'a missing xcodebuild must throw')
  } catch (error) {
    ok(error instanceof CompileGateError && error.status === null, 'a missing xcodebuild is reported as status null')
  }
}

section('runCommand — CLI')
{
  const root = fixture()
  const out = []
  const err = []
  const stdout = (text) => out.push(text)
  const stderr = (text) => err.push(text)

  const success = runCommand([], { root, run: captureRun({ status: 0 }).run, stdout, stderr })
  eq(success, 0, 'a clean compile exits 0')
  ok(out.some((line) => /ios compile gate: OK/.test(line)), 'a clean compile says so')

  const quiet = []
  eq(runCommand(['--quiet'], { root, run: captureRun({ status: 0 }).run, stdout: (t) => quiet.push(t), stderr }), 0, '--quiet still exits 0')
  eq(quiet.length, 0, '--quiet prints nothing on success')

  const failed = runCommand([], { root, run: captureRun({ status: 65, stdout: REAL_FAILURE }).run, stdout, stderr })
  eq(failed, 1, 'a compile failure exits 1')
  ok(err.some((line) => /extra argument 'copyId' in call/.test(line)), 'the actual compiler error is printed, not just "BUILD FAILED"')

  const badFlag = runCommand(['--nope'], { root, run: captureRun({ status: 0 }).run, stdout, stderr })
  eq(badFlag, 2, 'an unknown flag is a usage error')

  const noPods = fixture()
  rmSync(join(noPods, 'ios/App/Pods'), { recursive: true })
  eq(runCommand([], { root: noPods, run: captureRun({ status: 0 }).run, stdout, stderr }), 2, 'a precondition failure exits 2, not 1')

  // The gap this guards: a half-installed Pods project used to pass the precondition check and
  // reach xcodebuild, which then failed with the 3000-line [CP] Check Pods Manifest.lock error.
  const halfPods = fixture()
  rmSync(join(halfPods, 'ios/App/Pods/Manifest.lock'))
  const neverRun = captureRun({ status: 0 })
  eq(runCommand([], { root: halfPods, run: neverRun.run, stdout, stderr }), 2, 'a missing Pods/Manifest.lock exits 2')
  eq(neverRun.calls.length, 0, 'xcodebuild is never invoked when a precondition is unsatisfied')
  ok(err.some((line) => /pod install/.test(line)), 'the refusal names the command that fixes it')

  const unsynced = fixture()
  rmSync(join(unsynced, 'ios/App/App/capacitor.config.json'))
  const neverRunUnsynced = captureRun({ status: 0 })
  eq(runCommand([], { root: unsynced, run: neverRunUnsynced.run, stdout, stderr }), 2, 'a missing capacitor.config.json exits 2')
  eq(neverRunUnsynced.calls.length, 0, 'xcodebuild is never invoked when cap:sync outputs are missing')

  const device = captureRun({ status: 0 })
  eq(runCommand(['--device'], { root, run: device.run, stdout, stderr }), 0, '--device is accepted')
  ok(device.calls[0].args.join(' ').includes(DEVICE_DESTINATION), '--device compiles the device destination')

  const help = runCommand(['--help'], { root, run: captureRun({ status: 0 }).run, stdout, stderr })
  eq(help, 0, '--help exits 0')
}

for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures) {
  process.stderr.write(`${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write(`ios-compile-gate tests passed (${SCRIPT})\n`)
