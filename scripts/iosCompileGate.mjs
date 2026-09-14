#!/usr/bin/env node
/**
 * ios-compile-gate — compile the real iOS + watchOS Xcode targets before archiving.
 *
 * Why this exists: the two local native gates each compiled a hand-written file list.
 *
 *   - scripts/test-watch-replay.sh compiles plugins/nod-watch/.../WatchBridge.swift and
 *     ios/App/WatchApp/*.swift;
 *   - the watchOS `swiftc -typecheck` compiles ios/App/WatchApp/*.swift only.
 *
 * Neither list contains plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift,
 * so a duplicate `copyId:` argument in that file passed both gates and only failed at the
 * first real `xcodebuild` — which used to be the archive, i.e. install time, on an already
 * merged main. The hand-written lists simply never named that file. This gate builds the
 * actual `App` scheme instead, which compiles the App target, the WatchApp target and every
 * local Pods target (NodAuth / NodMic / NodSplash / NodWatch) for iOS Simulator and watchOS
 * Simulator in a single pass.
 *
 * What the scheme does and does not cover: it is the real build dependency graph, so every
 * file that is in a target gets compiled, including a plugin newly added to the Podfile. It
 * cannot see a new source file that was never added to any target's membership — such a file
 * compiles to nothing, and this gate stays green. Adding a file to a target is still on the
 * author.
 *
 * Measured on this repo (Xcode 26.6, Apple silicon, `generic/platform=iOS Simulator`):
 * ~3 s warm after touching one plugin Swift file, ~25 s cold when the Xcode module cache is
 * already warm, and ~65 s from a genuinely empty cache. No signing is involved. Compare that
 * with the archive/export/install loop this gate runs ahead of.
 *
 * It does not replace `bash scripts/test-watch-replay.sh`: that gate runs behaviour tests.
 * This one only answers "do the real targets still compile?".
 *
 *   node scripts/iosCompileGate.mjs [--device] [--configuration Release] [--log <path>]
 *
 * Exit codes: 0 compiled, 1 compile failed, 2 usage error or precondition not met.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEME = 'App'
export const CONFIGURATION = 'Debug'

/**
 * `generic/platform=...` instead of a named simulator: a concrete device name ("iPhone 17")
 * is renamed by Xcode updates, and this gate must not fail for an unrelated reason.
 * The generic simulator destination still builds the watchOS half (Debug-watchsimulator).
 */
export const SIMULATOR_DESTINATION = 'generic/platform=iOS Simulator'
export const DEVICE_DESTINATION = 'generic/platform=iOS'

export class CompileGateError extends Error {
  constructor(message, { errors = [], logPath = null, status = null } = {}) {
    super(message)
    this.name = 'CompileGateError'
    this.errors = errors
    this.logPath = logPath
    this.status = status
  }
}

/** Never throws for a missing binary; callers decide what a null status means. */
export function runCapture(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts })
  return {
    status: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? res.error.message : null,
  }
}

/**
 * Per-checkout DerivedData. Two reasons it is not the shared Xcode default:
 *  1. object files from another checkout must never satisfy this build (issue #213);
 *  2. it must not appear in `git status`, or a delivery's clean-tree guard would refuse.
 * Keyed by the checkout's realpath so a worktree keeps its own warm cache.
 */
export function gateDerivedData(root, base = tmpdir()) {
  const key = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 12)
  // Canonicalise: on macOS tmpdir() is /var/... while the real path is /private/var/...,
  // and a path printed one way must compare equal to the same path read back the other way.
  const parent = existsSync(base) ? realpathSync(base) : base
  return join(parent, 'nod-ios-compile-gate', key, 'DerivedData')
}

/**
 * Every form the checkout root can appear as inside xcodebuild output.
 *
 * macOS resolves /tmp to /private/tmp (and $TMPDIR to /private/var/...), and xcodebuild does
 * not use the same form we passed in: a diagnostic for a root given as /private/tmp/wt-x can
 * come back as /tmp/wt-x. Stripping only the exact string we hold would leave absolute paths
 * in the one message a human is supposed to read at a glance.
 */
export function pathPrefixes(root) {
  const withSlash = new Set()
  const add = (value) => {
    if (value) withSlash.add(value.endsWith('/') ? value : `${value}/`)
  }
  add(root)
  try {
    add(realpathSync(root))
  } catch {
    // A root that does not exist yet is fine: only the literal form can match.
  }
  for (const value of [...withSlash]) {
    if (value.startsWith('/private/')) add(value.slice('/private'.length))
    else add(`/private${value}`)
  }
  // Longest first, so /private/tmp/x/ wins over a /tmp/x/ substring inside it.
  return [...withSlash].sort((a, b) => b.length - a.length)
}

/** `error:` lines only, deduped, with the checkout prefix removed. Warnings are not failures. */
export function extractCompileErrors(output, root) {
  const prefixes = root ? pathPrefixes(root) : []
  const errors = []
  const seen = new Set()
  for (const raw of String(output).split('\n')) {
    const line = raw.trimEnd()
    if (!/error:/.test(line)) continue
    if (/^\s*(warning|note):/.test(line)) continue
    let text = line
    for (const prefix of prefixes) text = text.split(prefix).join('')
    // xcodebuild repeats the same diagnostic in the per-target and the summary section.
    text = text.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    errors.push(text)
  }
  return errors
}

/**
 * Refuse with an actionable message instead of letting `xcodebuild` emit a 3000-line failure
 * for a precondition already known to be unsatisfied: no workspace, no Pods project, a Pods
 * project that disagrees with Podfile.lock (either half missing, or differing), no web bundle.
 *
 * This proves presence and Pods/lock *consistency*, not freshness. It does not compare
 * ios/App/App/public against the current web/dist, nor the Podfile against the current plugin
 * set, so it cannot tell that a `cap:sync` was skipped after a web or plugin change. Those
 * comparisons belong to the delivery path (`assertWebAssets` / `localPodFrameworks` in
 * scripts/ios-deliver.mjs); this gate only needs the real targets to be compilable.
 */
export function assertGatePreconditions(root) {
  const workspace = join(root, 'ios/App/App.xcworkspace')
  if (!existsSync(join(workspace, 'contents.xcworkspacedata'))) {
    throw new CompileGateError(`missing ${workspace} — run npm run cap:sync first`)
  }

  if (!existsSync(join(root, 'ios/App/Pods/Pods.xcodeproj'))) {
    throw new CompileGateError('ios/App/Pods/Pods.xcodeproj is missing — run npm run cap:sync (it runs pod install), or (cd ios/App && pod install)')
  }

  // The same precondition CocoaPods' own "[CP] Check Pods Manifest.lock" phase enforces, but
  // reported as one sentence instead of a build failure. Both halves have to be checked for
  // existence: a missing Manifest.lock (half-installed Pods, or Pods restored without it) and a
  // missing Podfile.lock both fail that phase, so skipping the comparison would let exactly the
  // long build failure this function exists to prevent through.
  const podfileLock = join(root, 'ios/App/Podfile.lock')
  const manifestLock = join(root, 'ios/App/Pods/Manifest.lock')
  if (!existsSync(podfileLock)) {
    throw new CompileGateError(`missing ${podfileLock} — run npm run cap:sync first (it runs pod install)`)
  }
  if (!existsSync(manifestLock)) {
    throw new CompileGateError(`missing ${manifestLock} — the Pods project is not installed, or was left half-installed; run (cd ios/App && pod install)`)
  }
  if (readFileSync(podfileLock, 'utf8') !== readFileSync(manifestLock, 'utf8')) {
    throw new CompileGateError('ios/App/Pods is out of sync with Podfile.lock — run (cd ios/App && pod install) before compiling')
  }

  if (!existsSync(join(root, 'ios/App/App/public'))) {
    throw new CompileGateError('missing ios/App/App/public — the App target copies that folder; run npm run cap:sync first')
  }

  return { workspace }
}

function persistLog(logPath, output) {
  writeFileSync(logPath, output)
  return logPath
}

/**
 * Build the real scheme. Returns { seconds, errors, derivedData, logPath } on success and
 * throws CompileGateError (carrying the extracted `error:` lines) on failure.
 */
export function runCompileGate({
  root,
  run = runCapture,
  scheme = SCHEME,
  configuration = CONFIGURATION,
  destination = SIMULATOR_DESTINATION,
  derivedDataPath,
  logPath,
  timeoutMs,
} = {}) {
  const cwd = resolve(root || process.cwd())
  const { workspace } = assertGatePreconditions(cwd)

  const derivedData = derivedDataPath || gateDerivedData(cwd)
  mkdirSync(derivedData, { recursive: true })
  const log = logPath || join(dirname(derivedData), 'xcodebuild.log')

  const args = [
    '-workspace', workspace,
    '-scheme', scheme,
    '-configuration', configuration,
    '-destination', destination,
    '-derivedDataPath', derivedData,
    // Compiling is the point; signing is not. Keeps this runnable with no team configured.
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ]

  const started = Date.now()
  const res = run('xcodebuild', args, { cwd, ...(timeoutMs ? { timeout: timeoutMs } : {}) })
  const seconds = (Date.now() - started) / 1000
  const output = `${res.stdout || ''}${res.stderr || ''}`
  const errors = extractCompileErrors(output, cwd)
  const saved = persistLog(log, output)

  if (res.status !== 0) {
    const detail = res.status === null ? 'xcodebuild could not be started' : `xcodebuild exited ${res.status}`
    throw new CompileGateError(`the real '${scheme}' scheme does not compile — ${detail}`, {
      errors,
      logPath: saved,
      status: res.status,
    })
  }

  return { seconds, errors, derivedData, logPath: saved }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function helpText() {
  return `ios-compile-gate — compile the real iOS + watchOS targets (issue #233).

  node scripts/iosCompileGate.mjs [--device] [--destination <d>] [--configuration <c>]
                                  [--derived-data <dir>] [--log <path>] [--quiet]

  Builds the '${SCHEME}' scheme, which compiles App + WatchApp + NodAuth / NodMic /
  NodSplash / NodWatch. Run it after editing Swift and before archive / install; it is
  the only gate that reads the real target membership instead of a hand-kept file list.

  --device            destination '${DEVICE_DESTINATION}' (Release-like device compile)
  --configuration     build configuration (default ${CONFIGURATION})
  --destination       any xcodebuild -destination (default '${SIMULATOR_DESTINATION}')
  --derived-data      reuse a specific DerivedData (default: per-checkout cache in tmp)
  --log               where to write the full xcodebuild log (default: next to the cache)
  --quiet             print nothing on success

Exit codes: 0 compiled, 1 compile failed, 2 usage error or precondition not met.`
}

export function parseArgs(argv) {
  const args = { _: [] }
  const value = new Set(['destination', 'configuration', 'derived-data', 'log'])
  const bool = new Set(['device', 'quiet', 'help'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    if (bool.has(name)) {
      args[name] = true
      continue
    }
    if (!value.has(name)) throw new CompileGateError(`unknown flag --${name}`)
    const next = eq === -1 ? argv[(i += 1)] : token.slice(eq + 1)
    if (next === undefined) throw new CompileGateError(`--${name} needs a value`)
    args[name] = next
  }
  return args
}

export function runCommand(argv, deps = {}) {
  const root = deps.root || process.cwd()
  const stdout = deps.stdout || ((text) => process.stdout.write(`${text}\n`))
  const stderr = deps.stderr || ((text) => process.stderr.write(`${text}\n`))

  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    stderr(`ios-compile-gate: ${error.message}`)
    stderr(helpText())
    return 2
  }
  if (args.help) {
    stdout(helpText())
    return 0
  }
  if (args._.length) {
    stderr(`ios-compile-gate: unexpected argument(s): ${args._.join(' ')}`)
    stderr(helpText())
    return 2
  }

  const destination = args.destination || (args.device ? DEVICE_DESTINATION : SIMULATOR_DESTINATION)
  try {
    const result = runCompileGate({
      root,
      run: deps.run,
      configuration: args.configuration || CONFIGURATION,
      destination,
      derivedDataPath: args['derived-data'],
      logPath: args.log,
      timeoutMs: deps.timeoutMs,
    })
    if (!args.quiet && !deps.quiet) {
      stdout(`ios compile gate: OK — scheme '${SCHEME}' (${destination}, ${args.configuration || CONFIGURATION}) compiled in ${result.seconds.toFixed(1)}s`)
    }
    return 0
  } catch (error) {
    if (error instanceof CompileGateError) {
      stderr(`ios-compile-gate: ${error.message}`)
      if (error.errors.length) {
        for (const line of error.errors.slice(0, 20)) stderr(`  ${line}`)
        if (error.errors.length > 20) stderr(`  … ${error.errors.length - 20} more error line(s)`)
      }
      if (error.logPath) stderr(`  full log: ${error.logPath}`)
      else if (error.status === null) stderr('  (no log written: xcodebuild never started)')
      // Precondition failures (exit 2) are fixable by the caller; a real compile failure is not.
      return error.status === null ? 2 : 1
    }
    stderr(`ios-compile-gate: ${error.stack || error.message}`)
    return 2
  }
}

const invokedDirectly =
  process.argv[1] &&
  (() => {
    try {
      return fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
    } catch {
      return false
    }
  })()

if (invokedDirectly) {
  process.exitCode = runCommand(process.argv.slice(2))
}
