#!/usr/bin/env node
/**
 * ios-deliver — the single recommended iOS delivery entry point (issue #213).
 *
 * It exists so that "the phone was installed with old files" cannot happen quietly:
 * every step is pinned to one commit, one checkout, one output directory and one
 * exact artifact path, and everything is written to a machine-readable manifest.
 *
 *   npm run cap:ios -- build  --sha <40-hex> --version <short> --build <n> [--ipa]
 *   npm run cap:ios -- verify --manifest <path>
 *   npm run cap:ios -- install --manifest <path> --device <udid> --authorize
 *   npm run cap:ios -- open   [--sha <40-hex>]
 *
 * The Pods / node_modules / local-plugin realpath protection is NOT reimplemented
 * here — it is imported from scripts/iosWorktreePods.mjs, so a delivery cannot
 * bypass it.
 *
 * Nothing in this file ever reads or writes signing key material. The manifest
 * records paths, digests, versions and identifiers only; `assertNoSecrets` refuses
 * to write a manifest that looks like it picked up a key or a token.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { assertPluginRoots, assertPodsProject } from './iosWorktreePods.mjs'

export const MANIFEST_SCHEMA = 'nod-web/ios-delivery-manifest@1'
export const MANIFEST_NAME = 'delivery-manifest.json'
export const FORTY_HEX = /^[0-9a-f]{40}$/

/** Local plugin package name -> CocoaPods framework name. Mirrors the Podfile. */
export const LOCAL_PLUGIN_PODS = {
  'nod-auth': 'NodAuth',
  'nod-mic': 'NodMic',
  'nod-watch': 'NodWatch',
}

/**
 * Generated files cap:sync / pod install are allowed to touch. Everything else in
 * `git status` means the delivery would not match the reviewed commit.
 */
export const DEFAULT_ALLOWED_DIRTY = [
  'ios/App/Podfile',
  'ios/App/Podfile.lock',
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App.xcodeproj/project.xcworkspace/**',
  'ios/App/Pods/**',
  'ios/App/App/public/**',
  'ios/App/App/capacitor.config.json',
  'web/dist/**',
  'ios/dist/**',
]

/** Never include these in a digest — they are OS noise, not delivery content. */
export const DIGEST_SKIP = new Set(['.DS_Store', '__MACOSX'])

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /PRIVATE KEY/,
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\b(password|passwd|secret|token)\s*[:=]\s*\S+/i,
]

export class DeliveryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DeliveryError'
  }
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

/** Never throws for a missing binary; callers decide what a null status means. */
export function runCapture(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return {
    status: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? res.error.message : null,
  }
}

function must(result, what) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error || '').trim()
    throw new DeliveryError(`${what} failed${result.status === null ? '' : ` (${result.status})`}${detail ? `: ${detail}` : ''}`)
  }
  return result
}

export function gitOutput(root, args, run = runCapture) {
  return must(run('git', args, { cwd: root }), `git ${args.join(' ')}`).stdout
}

// ---------------------------------------------------------------------------
// digests
// ---------------------------------------------------------------------------

export function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listTree(dir, skip = DIGEST_SKIP) {
  const out = []
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (skip.has(entry.name)) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        out.push(`${relPath}@link`)
      } else if (entry.isDirectory()) {
        walk(relPath)
      } else if (entry.isFile()) {
        out.push(relPath)
      }
    }
  }
  walk('')
  return out
}

/**
 * Deterministic digest of a directory tree: relative path + file sha256, in sorted
 * order. Symlinks are recorded by name only (they must not smuggle an outside file
 * into an "identical" comparison).
 */
export function digestTree(dir, skip = DIGEST_SKIP) {
  if (!existsSync(dir)) throw new DeliveryError(`cannot digest a missing path: ${dir}`)
  const files = listTree(dir, skip)
  const hash = createHash('sha256')
  for (const rel of files) {
    const digest = rel.endsWith('@link') ? 'symlink' : digestFile(join(dir, rel))
    hash.update(rel)
    hash.update('\0')
    hash.update(digest)
    hash.update('\n')
  }
  return { algorithm: 'sha256', digest: hash.digest('hex'), fileCount: files.length, files }
}

export function digestPath(path, skip = DIGEST_SKIP) {
  const isDir = statSync(path).isDirectory()
  if (isDir) return { kind: 'tree', ...digestTree(path, skip) }
  return { kind: 'file', algorithm: 'sha256', digest: digestFile(path), fileCount: 1, files: [] }
}

/** Compact digest record for the manifest (no per-file list — keeps it small). */
function digestSummary(digest, path) {
  const { algorithm, digest: value, fileCount } = digest
  return { path, algorithm, digest: value, fileCount }
}

// ---------------------------------------------------------------------------
// plist + git helpers
// ---------------------------------------------------------------------------

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read one `<string>` value out of an XML plist. Binary plists are converted with
 * plutil when available (macOS); on any other host they are reported as
 * unreadable rather than guessed.
 */
export function readPlistValue(plistPath, key, run = runCapture) {
  if (!existsSync(plistPath)) return undefined
  const buf = readFileSync(plistPath)
  let text
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') {
    const res = run('plutil', ['-convert', 'xml1', '-o', '-', plistPath])
    if (res.status !== 0) {
      throw new DeliveryError(`cannot read binary plist ${plistPath}: plutil ${res.status === null ? 'is unavailable' : 'failed'}`)
    }
    text = res.stdout
  } else {
    text = buf.toString('utf8')
  }
  const match = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([^<]*)</string>`).exec(text)
  return match ? decodeXml(match[1]) : undefined
}

export function matchGlob(path, pattern) {
  // An allow-list must never be widened by a traversal segment.
  if (path.split('/').includes('..')) return false
  const parts = pattern.split('/').map((segment) => {
    if (segment === '**') return '.*'
    return segment.split('*').map(escapeRegExp).join('[^/]*')
  })
  const source = parts.join('/').replace(/\/\.\*$/, '(?:/.*)?')
  return new RegExp(`^${source}$`).test(path)
}

export function parsePorcelain(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2)
      let path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      if (arrow !== -1) path = path.slice(arrow + 4)
      return { code, path: path.replace(/^"(.*)"$/, '$1') }
    })
}

/** 1) HEAD must be the requested SHA and origin must actually have that commit. */
export function checkTargetSha({ root, sha, run = runCapture, fetch = true }) {
  if (!sha || !FORTY_HEX.test(sha)) {
    throw new DeliveryError(`--sha must be a full 40-character lowercase commit SHA (got ${JSON.stringify(sha)})`)
  }
  if (fetch) must(run('git', ['fetch', '--quiet', 'origin'], { cwd: root }), 'git fetch origin')
  const hasObject = run('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: root })
  if (hasObject.status !== 0) {
    throw new DeliveryError(`origin does not have commit ${sha} (fetched, object not present). Refusing to deliver an unreviewed or unpushed SHA.`)
  }
  const head = gitOutput(root, ['rev-parse', 'HEAD'], run).trim()
  if (head !== sha) {
    throw new DeliveryError(`worktree HEAD is ${head}, but the requested target SHA is ${sha}. Refusing to deliver.`)
  }
  const contains = run('git', ['branch', '-r', '--contains', sha], { cwd: root })
  const refs = contains.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (contains.status !== 0 || refs.length === 0) {
    throw new DeliveryError(`commit ${sha} is not reachable from any origin remote ref — it is local-only. Push it (or pick the merged commit) before delivering.`)
  }
  return { head, remoteRefs: refs }
}

/** 2) No uncommitted changes outside the explicitly allowed generated set. */
export function checkCleanTree({ root, allowed = DEFAULT_ALLOWED_DIRTY, run = runCapture }) {
  const stdout = gitOutput(root, ['status', '--porcelain', '--untracked-files=all'], run)
  const dirty = parsePorcelain(stdout)
  const unexpected = dirty.filter((entry) => !allowed.some((pattern) => matchGlob(entry.path, pattern)))
  if (unexpected.length) {
    throw new DeliveryError(
      `uncommitted changes outside the allowed delivery set:\n${unexpected.map((e) => `  ${e.code} ${e.path}`).join('\n')}\n` +
        `Commit them, stash them, or add the path with --allow-dirty <glob>. Refusing to build an unreviewed tree.`,
    )
  }
  return { allowed, dirty: dirty.map((e) => e.path), unexpected }
}

/** 3) node_modules / Pods / local plugins must resolve inside this checkout. */
export function assertDeliveryRoots(root) {
  const rootReal = realpathSync(root)
  try {
    assertPluginRoots(root)
    const podsDir = join(root, 'ios/App/Pods')
    if (existsSync(podsDir)) {
      const podsReal = realpathSync(podsDir)
      if (podsReal !== join(rootReal, 'ios/App/Pods') && !podsReal.startsWith(`${rootReal}${sep}`)) {
        throw new DeliveryError(`ios worktree pods: ios/App/Pods resolves to ${podsReal}, outside this checkout ${rootReal}`)
      }
    }
    // A fresh checkout has no Pods yet: the guarded cap:sync below installs them.
    // Verify an existing Pods project here (and require one after the sync) rather
    // than demanding it before the step that creates it.
    const podsProject = join(root, 'ios/App/Pods/Pods.xcodeproj')
    const hasPods = existsSync(podsProject)
    return { realpath: rootReal, pods: hasPods ? assertPodsProject(root) : null, podsPending: !hasPods }
  } catch (error) {
    // iosWorktreePods.mjs raises plain Errors; surface them as a clean refusal, not a stack trace.
    if (error instanceof DeliveryError) throw error
    throw new DeliveryError(error.message)
  }
}

// ---------------------------------------------------------------------------
// artifact checks
// ---------------------------------------------------------------------------

export function readAppInfo(appPath, run = runCapture) {
  const plist = join(appPath, 'Info.plist')
  if (!existsSync(plist)) throw new DeliveryError(`built app has no Info.plist: ${plist}`)
  return {
    bundleId: readPlistValue(plist, 'CFBundleIdentifier', run) ?? null,
    version: readPlistValue(plist, 'CFBundleShortVersionString', run) ?? null,
    build: readPlistValue(plist, 'CFBundleVersion', run) ?? null,
  }
}

/** 4) CFBundleVersion / CFBundleShortVersionString must match the expected values. */
export function assertAppVersions({ appPath, expected, run = runCapture }) {
  const info = readAppInfo(appPath, run)
  const problems = []
  if (String(info.build) !== String(expected.build)) {
    problems.push(`CFBundleVersion is ${info.build ?? '(missing)'}, expected ${expected.build}`)
  }
  if (String(info.version) !== String(expected.version)) {
    problems.push(`CFBundleShortVersionString is ${info.version ?? '(missing)'}, expected ${expected.version}`)
  }
  if (expected.bundle && info.bundleId !== expected.bundle) {
    problems.push(`CFBundleIdentifier is ${info.bundleId ?? '(missing)'}, expected ${expected.bundle}`)
  }
  if (problems.length) {
    throw new DeliveryError(`the built app does not match the intended bundle:\n  ${problems.join('\n  ')}`)
  }
  return info
}

/** Local plugin pods declared in this checkout's (pinned) Podfile. */
export function localPodFrameworks(root) {
  const podfile = join(root, 'ios/App/Podfile')
  if (!existsSync(podfile)) throw new DeliveryError(`missing ${podfile} — run npm run cap:sync`)
  const pluginsRoot = join(realpathSync(root), 'plugins')
  const found = {}
  const re = /pod\s+'([A-Za-z0-9_]+)'\s*,\s*:path\s*=>\s*'([^']+)'/g
  let match
  while ((match = re.exec(readFileSync(podfile, 'utf8')))) {
    const abs = resolve(join(root, 'ios/App'), match[2])
    if (abs === pluginsRoot || abs.startsWith(`${pluginsRoot}${sep}`)) found[match[1]] = abs
  }
  return found
}

/** 6) The built app must actually embed the local plugin frameworks. */
export function assertEmbeddedFrameworks({ appPath, required, extra = [], run = runCapture }) {
  const names = [...new Set([...Object.keys(required), ...extra])].sort()
  if (!names.length) {
    throw new DeliveryError('no local plugin frameworks were resolved from the Podfile — refusing to call the app complete')
  }
  const frameworksDir = join(appPath, 'Frameworks')
  const missing = names.filter((name) => !existsSync(join(frameworksDir, `${name}.framework`)))
  if (missing.length) {
    throw new DeliveryError(
      `built app is missing required embedded frameworks: ${missing.join(', ')} (looked in ${frameworksDir}). ` +
        `A pod that did not compile into the app means the phone would run old native code.`,
    )
  }
  const embedded = {}
  for (const name of names) {
    const path = join(frameworksDir, `${name}.framework`)
    embedded[name] = {
      path: realpathSync(path),
      identifier: readPlistValue(join(path, 'Info.plist'), 'CFBundleIdentifier', run) ?? null,
      digest: digestTree(path).digest,
    }
  }
  return embedded
}

/** 5) Web assets inside the built app must equal this checkout's cap:sync output. */
export function assertWebAssets({ root, appPath }) {
  const dist = join(root, 'web/dist')
  const synced = join(root, 'ios/App/App/public')
  const embeddedPath = join(appPath, 'public')
  if (!existsSync(synced)) {
    throw new DeliveryError(`cap:sync output is missing: ${synced} — run npm run cap:sync before delivering`)
  }
  if (!existsSync(embeddedPath)) {
    throw new DeliveryError(`the built app has no embedded web assets: ${embeddedPath}`)
  }
  const syncedDigest = digestTree(synced)
  const embeddedDigest = digestTree(embeddedPath)
  if (syncedDigest.digest !== embeddedDigest.digest) {
    const syncedPaths = new Set(syncedDigest.files)
    const embeddedPaths = new Set(embeddedDigest.files)
    const onlySynced = syncedDigest.files.filter((p) => !embeddedPaths.has(p))
    const onlyEmbedded = embeddedDigest.files.filter((p) => !syncedPaths.has(p))
    const changed = syncedDigest.files
      .filter((p) => embeddedPaths.has(p))
      .filter((p) => digestFile(join(synced, p)) !== digestFile(join(embeddedPath, p)))
    const detail = [
      onlySynced.length ? `  only in cap:sync output: ${onlySynced.slice(0, 5).join(', ')}` : '',
      onlyEmbedded.length ? `  only in built app: ${onlyEmbedded.slice(0, 5).join(', ')}` : '',
      changed.length ? `  content differs: ${changed.slice(0, 5).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    throw new DeliveryError(
      `web assets inside the built app do not match this checkout's cap:sync output ` +
        `(synced ${syncedDigest.digest}, embedded ${embeddedDigest.digest}). ` +
        `The app would ship stale JavaScript.\n${detail}`,
    )
  }
  return {
    dist: existsSync(dist)
      ? digestSummary(digestTree(dist), realpathSync(dist))
      : { path: dist, algorithm: 'sha256', digest: null, fileCount: 0 },
    synced: digestSummary(syncedDigest, realpathSync(synced)),
    embedded: digestSummary(embeddedDigest, realpathSync(embeddedPath)),
  }
}

/** The embedded Watch app, or an explicit reason it could not be resolved. */
export function findWatchApp(appPath, run = runCapture) {
  const dir = join(appPath, 'Watch')
  if (!existsSync(dir)) return { path: null, reason: `no Watch/ directory inside ${appPath}` }
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => join(dir, entry.name))
    .sort()
  if (candidates.length === 0) return { path: null, reason: `no .app bundle inside ${dir}` }
  if (candidates.length > 1) return { path: null, reason: `ambiguous Watch app bundles inside ${dir}: ${candidates.join(', ')}` }
  const info = readAppInfo(candidates[0], run)
  return { path: realpathSync(candidates[0]), ...info }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export function assertNoSecrets(manifest) {
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new DeliveryError(`refusing to write a manifest that looks like it contains key material (matched ${pattern})`)
    }
  }
  return true
}

function redactUrl(url) {
  return String(url).replace(/\/\/[^/@\s]*@/, '//<redacted>@')
}

function sanitizeError(text) {
  return String(text).replace(/\b(Bearer|token|password)=\S+/gi, '$1=<redacted>').slice(0, 400)
}

export function buildManifest({ root, args, run = runCapture, now = () => new Date() }) {
  const sha = args.sha
  const version = args.version
  const build = args.build
  if (!version) throw new DeliveryError('--version is required (expected CFBundleShortVersionString)')
  if (!build) throw new DeliveryError('--build is required (expected CFBundleVersion)')
  if (!args.bundle) throw new DeliveryError('--bundle is required (expected CFBundleIdentifier)')

  const out = resolve(root, args.out || join('ios/dist/delivery', `${sha.slice(0, 12)}-${build}`))
  if (existsSync(out)) {
    throw new DeliveryError(`output directory already exists: ${out}\nDelivery runs need a unique --out directory; nothing may be reused from an earlier run.`)
  }

  // 1) target SHA, 2) clean tree, 3) dependency realpaths — before anything runs.
  const shaInfo = checkTargetSha({ root, sha, run, fetch: !args.skipFetch })
  const tree = checkCleanTree({ root, allowed: [...DEFAULT_ALLOWED_DIRTY, ...(args.allowDirty || [])], run })
  const roots = assertDeliveryRoots(root)

  // scripts/prepare-ios-web.mjs bumps CURRENT_PROJECT_VERSION by one on every
  // cap:sync. Validate --build against that known outcome BEFORE creating anything,
  // so a wrong number refuses without mutating the checkout.
  const syncPlanned = !args.app && !args.skipSync
  if (syncPlanned) {
    const before = currentProjectVersion(root)
    const next = String(Number(before) + 1)
    if (String(build) !== next) {
      throw new DeliveryError(
        `--build ${build} is not this run's bundle: HEAD carries CURRENT_PROJECT_VERSION = ${before} and the ` +
          `guarded cap:sync bumps it to ${next} before the archive is built. Re-run with --build ${next}. ` +
          `(Nothing was changed — this check runs before cap:sync.)`,
      )
    }
  }

  mkdirSync(out, { recursive: true })
  const verified = [`HEAD is the target SHA ${sha}`, 'working tree clean outside the allowed generated set', 'node_modules / Pods / local plugins resolve inside this checkout']
  const unverified = []

  const tools = collectTools(root, run)
  const lockfiles = {}
  for (const rel of ['package-lock.json', 'web/package-lock.json']) {
    const path = join(root, rel)
    lockfiles[rel] = existsSync(path) ? digestFile(path) : null
  }

  let archive = null
  let ipa = null
  if (args.app) {
    unverified.push(`archive/IPA not produced: this run reused the supplied app at ${resolve(root, args.app)}`)
  } else {
    if (syncPlanned) {
      must(run('npm', ['run', 'cap:sync'], { cwd: root, stdio: 'inherit' }), 'npm run cap:sync')
      verified.push('ran the guarded npm run cap:sync for this checkout')
      roots.pods = assertPodsProject(root)
      roots.podsPending = false
      verified.push('Pods project compiles the local plugins from this checkout')
      const after = currentProjectVersion(root)
      if (after !== String(build)) {
        throw new DeliveryError(`cap:sync left CURRENT_PROJECT_VERSION = ${after}, expected ${build} — refusing to archive an unexpected bundle`)
      }
    }
    const archivePath = resolve(root, args.archivePath || join(out, 'Nod.xcarchive'))
    if (!args.noArchive) {
      runArchive({ root, run, archivePath, teamId: args.teamId, scheme: args.scheme || 'App', derivedDataPath: join(out, 'DerivedData') })
      verified.push(`xcodebuild archive -> ${archivePath}`)
      archive = { path: realpathSync(archivePath), digest: digestTree(archivePath).digest, derivedData: join(out, 'DerivedData') }
      if (args.ipa) {
        const ipaPath = exportIpa({ root, run, out, archivePath, teamId: args.teamId })
        ipa = { path: ipaPath, digest: digestFile(ipaPath) }
        verified.push(`xcodebuild -exportArchive -> ${ipaPath}`)
      } else {
        unverified.push('IPA not exported (archive only); use --ipa to export a development IPA')
      }
    } else {
      unverified.push('no archive produced (--no-archive)')
    }
  }

  const appPath = args.app
    ? realpathSync(resolve(root, args.app))
    : join(resolve(root, args.archivePath || join(out, 'Nod.xcarchive')), 'Products/Applications', `${phoneProductName(root)}.app`)
  if (!existsSync(appPath)) throw new DeliveryError(`built app not found at the exact expected path: ${appPath}`)

  // 4) versions, 5) web assets, 6) embedded frameworks.
  const expected = { bundle: args.bundle, version, build }
  const appInfo = assertAppVersions({ appPath, expected, run })
  verified.push(`app CFBundleVersion=${appInfo.build} CFBundleShortVersionString=${appInfo.version} CFBundleIdentifier=${appInfo.bundleId}`)
  const webAssets = assertWebAssets({ root, appPath })
  verified.push(`embedded web assets match cap:sync output (${webAssets.embedded.digest})`)
  const requiredFrameworks = localPodFrameworks(root)
  const frameworks = assertEmbeddedFrameworks({ appPath, required: requiredFrameworks, extra: args.requireFramework || [], run })
  verified.push(`embedded frameworks present: ${Object.keys(frameworks).join(', ')}`)

  const watch = findWatchApp(appPath, run)
  if (!watch.path) {
    unverified.push(`watch app could not be resolved: ${watch.reason}`)
  } else if (!watch.version || !watch.build) {
    unverified.push(`watch app version/build could not be read from ${watch.path}`)
  }
  if (!args.deploymentSha) unverified.push('backend/deployment SHA not supplied (--deployment-sha)')
  if (!(args.testEvidence || []).length) unverified.push('no test evidence recorded (--test-evidence)')

  const artifact = { kind: 'app', path: appPath, realpath: appPath, digest: digestTree(appPath).digest }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: now().toISOString(),
    secretsIncluded: false,
    target: { sha },
    actualSha: shaInfo.head,
    checkout: {
      realpath: roots.realpath,
      remoteRefs: shaInfo.remoteRefs,
      origin: redactUrl(gitOutput(root, ['remote', 'get-url', 'origin'], run).trim()),
      describe: gitOutput(root, ['describe', '--always', '--dirty', '--tags'], run).trim(),
    },
    allowedDiff: tree.allowed,
    actualDirty: tree.dirty,
    tools,
    lockfiles,
    dependencies: {
      nodeModules: existsSync(join(root, 'node_modules')) ? realpathSync(join(root, 'node_modules')) : null,
      plugins: Object.fromEntries(
        Object.keys(LOCAL_PLUGIN_PODS).map((name) => [name, existsSync(join(root, 'node_modules', name)) ? realpathSync(join(root, 'node_modules', name)) : null]),
      ),
      podsProject: roots.pods ? roots.pods.plugins : null,
      podsDir: existsSync(join(root, 'ios/App/Pods')) ? realpathSync(join(root, 'ios/App/Pods')) : null,
    },
    webAssets,
    archive,
    ipa,
    app: { ...digestSummary(digestTree(appPath), appPath), ...appInfo },
    artifact,
    frameworks,
    declaredPods: Object.keys(requiredFrameworks),
    deviceTargets: {
      phone: { bundleId: appInfo.bundleId, version: appInfo.version, build: appInfo.build },
      watch: watch.path ? { bundleId: watch.bundleId, version: watch.version, build: watch.build, appPath: watch.path } : null,
    },
    deployment: { backendSha: args.deploymentSha || null, note: args.deploymentSha ? 'supplied by --deployment-sha' : 'not supplied' },
    testEvidence: { commands: args.testEvidence || [], supplied: Boolean((args.testEvidence || []).length) },
    readback: { at: null, phone: null, watch: null, status: 'not-installed' },
    verified,
    unverified,
  }
  assertNoSecrets(manifest)
  return { manifest, out }
}

function currentProjectVersion(root) {
  const pbx = readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
  const match = /CURRENT_PROJECT_VERSION = (\d+);/.exec(pbx)
  if (!match) throw new DeliveryError('CURRENT_PROJECT_VERSION not found in ios/App/App.xcodeproj/project.pbxproj')
  return match[1]
}

export function phoneProductName(root) {
  const pbxPath = join(root, 'ios/App/App.xcodeproj/project.pbxproj')
  if (!existsSync(pbxPath)) throw new DeliveryError(`missing ${pbxPath} — run npm run cap:sync first`)
  const pbx = readFileSync(pbxPath, 'utf8')
  const match = /PRODUCT_NAME = "?([^";]+)"?;/.exec(pbx)
  if (!match) return 'App'
  const value = match[1].trim()
  return value === '$(TARGET_NAME)' ? 'App' : value
}

function readAppId(root) {
  try {
    const config = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'))
    return typeof config.appId === 'string' ? config.appId : null
  } catch {
    return null
  }
}

function collectTools(root, run) {
  const version = (cmd, cmdArgs) => {
    const res = run(cmd, cmdArgs, { cwd: root })
    if (res.status !== 0) return null
    const first = res.stdout.trim().split('\n')[0].trim()
    return first || null
  }
  return {
    node: process.version,
    npm: version('npm', ['--version']),
    git: version('git', ['--version']),
    xcodebuild: version('xcodebuild', ['-version']),
    pod: version('pod', ['--version']),
    devicectl: version('xcrun', ['devicectl', '--version']),
  }
}

function runArchive({ root, run, archivePath, teamId, scheme, derivedDataPath }) {
  if (!teamId) throw new DeliveryError('--team-id (or TEAM_ID) is required to archive')
  const workspace = join(root, 'ios/App/App.xcworkspace')
  if (!existsSync(join(workspace, 'contents.xcworkspacedata'))) {
    throw new DeliveryError(`missing ${workspace} — run npm run cap:sync first`)
  }
  must(
    run(
      'xcodebuild',
      [
        '-workspace', workspace,
        '-scheme', scheme,
        '-configuration', 'Release',
        '-destination', 'generic/platform=iOS',
        // This run's own DerivedData: a shared cache is how a stale object file
        // from another checkout ends up inside the artifact (issue #213).
        '-derivedDataPath', derivedDataPath,
        '-archivePath', archivePath,
        `DEVELOPMENT_TEAM=${teamId}`,
        'CODE_SIGN_STYLE=Automatic',
        'archive',
      ],
      { cwd: root, stdio: 'inherit' },
    ),
    'xcodebuild archive',
  )
}

function exportIpa({ root, run, out, archivePath, teamId }) {
  if (!teamId) throw new DeliveryError('--team-id (or TEAM_ID) is required to export an IPA')
  const plistPath = join(out, 'ExportOptions.plist')
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>development</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>${teamId}</string>
	<key>compileBitcode</key>
	<false/>
	<key>destination</key>
	<string>export</string>
</dict>
</plist>
`,
  )
  const exportDir = join(out, 'ipa')
  must(
    run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportDir, '-exportOptionsPlist', plistPath], { cwd: root, stdio: 'inherit' }),
    'xcodebuild -exportArchive',
  )
  const produced = readdirSync(exportDir).filter((name) => name.endsWith('.ipa')).sort()
  if (produced.length !== 1) {
    throw new DeliveryError(`expected exactly one .ipa in the run's own export dir ${exportDir}, found ${produced.length}`)
  }
  return realpathSync(join(exportDir, produced[0]))
}

// ---------------------------------------------------------------------------
// verify / install
// ---------------------------------------------------------------------------

/**
 * Validate a manifest against the artifact on disk. Every path is exact — there is
 * no "newest file" selection anywhere in this function.
 */
export function verifyManifest({ root, manifest, manifestPath = null, artifact = null, run = runCapture }) {
  if (!manifest || typeof manifest !== 'object') throw new DeliveryError('manifest is empty')
  if (manifest.schema !== MANIFEST_SCHEMA) throw new DeliveryError(`unsupported manifest schema: ${JSON.stringify(manifest.schema)}`)
  const rootReal = realpathSync(root)
  if (manifest.checkout?.realpath !== rootReal) {
    throw new DeliveryError(`manifest was produced from ${manifest.checkout?.realpath}, not this checkout ${rootReal}`)
  }

  const appPath = manifest.app?.path
  if (!appPath || !existsSync(appPath)) throw new DeliveryError(`manifest app path does not exist: ${appPath ?? '(missing)'}`)
  const appDigest = digestTree(appPath).digest
  if (appDigest !== manifest.app.digest) {
    throw new DeliveryError(`app digest mismatch: ${appPath} is ${appDigest}, manifest says ${manifest.app.digest}. The artifact is not the one this manifest was produced from (stale or replaced).`)
  }

  const embeddedPath = join(appPath, 'public')
  const embeddedDigest = existsSync(embeddedPath) ? digestTree(embeddedPath).digest : null
  if (embeddedDigest !== manifest.webAssets?.embedded?.digest) {
    throw new DeliveryError(`embedded web asset digest mismatch inside ${appPath} — the app carries stale JavaScript`)
  }

  const info = assertAppVersions({
    appPath,
    expected: { bundle: manifest.app.bundleId, version: manifest.app.version, build: manifest.app.build },
    run,
  })

  for (const [name, record] of Object.entries(manifest.frameworks || {})) {
    const frameworkPath = join(appPath, 'Frameworks', `${name}.framework`)
    if (!existsSync(frameworkPath)) throw new DeliveryError(`required embedded framework is missing from the artifact: ${frameworkPath}`)
    if (record.digest && digestTree(frameworkPath).digest !== record.digest) {
      throw new DeliveryError(`embedded framework ${name} does not match the manifest digest (${frameworkPath})`)
    }
    if (record.identifier) {
      const identifier = readPlistValue(join(frameworkPath, 'Info.plist'), 'CFBundleIdentifier', run)
      if (identifier !== record.identifier) throw new DeliveryError(`embedded framework ${name} identifier is ${identifier}, manifest says ${record.identifier}`)
    }
  }

  const artifactPath = manifest.artifact?.path
  if (!artifactPath || !existsSync(artifactPath)) throw new DeliveryError(`manifest artifact path does not exist: ${artifactPath ?? '(missing)'}`)
  if (artifact) {
    const asked = realpathSync(resolve(root, artifact))
    const recorded = realpathSync(artifactPath)
    if (asked !== recorded) {
      throw new DeliveryError(`--artifact ${asked} is not the artifact this run produced (${recorded}). Refusing to install a different file.`)
    }
  }
  const artifactDigest = digestPath(artifactPath).digest
  if (artifactDigest !== manifest.artifact.digest) {
    throw new DeliveryError(`artifact digest mismatch: ${artifactPath} is ${artifactDigest}, manifest recorded ${manifest.artifact.digest}`)
  }

  return { manifest, manifestPath, appPath, artifactPath, info }
}

export function loadManifest(manifestPath) {
  if (!manifestPath || !existsSync(manifestPath)) throw new DeliveryError(`delivery manifest not found: ${manifestPath ?? '(missing)'} — build one first with: npm run cap:ios -- build ...`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new DeliveryError(`delivery manifest is not valid JSON (${manifestPath}): ${error.message}`)
  }
  return parsed
}

function writeManifest(manifestPath, manifest) {
  assertNoSecrets(manifest)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Resolve exactly one device, or refuse. Never "pick the only-ish one" silently.
 */
export function listDevices(run = runCapture) {
  const jsonPath = tempJsonPath('devices')
  const res = run('xcrun', ['devicectl', 'list', 'devices', '--json-output', jsonPath])
  if (res.status !== 0) return { ok: false, reason: sanitizeError(res.stderr || res.stdout || res.error || 'devicectl list devices failed') }
  try {
    return { ok: true, data: JSON.parse(readFileSync(jsonPath, 'utf8')) }
  } catch (error) {
    return { ok: false, reason: `could not parse devicectl device list: ${error.message}` }
  } finally {
    rmSync(jsonPath, { force: true })
  }
}

/** Flatten `xcrun devicectl list devices --json-output` into plain records. */
export function listDeviceRecords(data) {
  const devices = data?.result?.devices
  if (!Array.isArray(devices)) return []
  return devices.map((device) => ({
    identifier: device.identifier ?? null,
    udid: device.hardwareProperties?.udid ?? null,
    name: device.deviceProperties?.name ?? null,
    platform: device.hardwareProperties?.platform ?? null,
    deviceType: device.hardwareProperties?.deviceType ?? null,
    pairingState: device.connectionProperties?.pairingState ?? null,
    tunnelState: device.connectionProperties?.tunnelState ?? null,
  }))
}

/**
 * Resolve exactly one install target, or refuse. The Watch is a separate
 * devicectl device, so auto-detection only considers iOS (phone) platforms and
 * never picks one out of several.
 */
export function findDeviceId(data, { platforms = ['iOS'] } = {}) {
  const candidates = listDeviceRecords(data).filter((device) => platforms.includes(device.platform))
  const ids = [...new Set(candidates.map((device) => device.identifier).filter(Boolean))]
  if (ids.length === 1) return { id: ids[0], count: 1, candidates }
  return { id: null, count: ids.length, ids, candidates, platforms }
}

/** Read the installed-app list back from the device. */
export function readDeviceApps(deviceId, run = runCapture) {
  const jsonPath = tempJsonPath('apps')
  const res = run('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', deviceId, '--json-output', jsonPath])
  if (res.status !== 0) {
    rmSync(jsonPath, { force: true })
    return { ok: false, reason: sanitizeError(res.stderr || res.stdout || res.error || `devicectl device info apps failed`) }
  }
  try {
    return { ok: true, data: JSON.parse(readFileSync(jsonPath, 'utf8')) }
  } catch (error) {
    return { ok: false, reason: `could not parse devicectl app list: ${error.message}` }
  } finally {
    rmSync(jsonPath, { force: true })
  }
}

function tempJsonPath(tag) {
  return join(tmpdir(), `ios-deliver-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
}

/** Find the single installed app record for a bundle id, without guessing. */
export function findInstalledApp(data, bundleId) {
  const hits = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') {
      const id = node.bundleIdentifier || node.appIdentifier || node.CFBundleIdentifier
      if (typeof id === 'string' && id === bundleId) hits.push(node)
      for (const value of Object.values(node)) walk(value)
    }
  }
  walk(data)
  if (hits.length !== 1) return null
  const app = hits[0]
  return {
    bundleId,
    version: app.shortVersion ?? app.CFBundleShortVersionString ?? app.version ?? null,
    build: app.bundleVersion ?? app.CFBundleVersion ?? app.buildVersion ?? null,
  }
}

export function compareReadback(expected, observed) {
  if (!expected) return { status: 'unverified', reason: 'manifest has no expected target for this device' }
  if (!observed) return { status: 'unverified', reason: `installed app ${expected.bundleId} was not present in the device read-back` }
  if (!observed.version || !observed.build) {
    return { status: 'unverified', reason: `device read-back for ${expected.bundleId} had no version/build`, observed }
  }
  const match = String(observed.version) === String(expected.version) && String(observed.build) === String(expected.build)
  return {
    status: match ? 'verified' : 'mismatch',
    expected: { version: expected.version, build: expected.build },
    observed: { version: observed.version, build: observed.build },
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function requireArg(args, name) {
  if (!args[name]) throw new DeliveryError(`--${name} is required`)
  return args[name]
}

export function cmdBuild(args, deps) {
  const root = deps.root
  const { manifest, out } = buildManifest({ root, args, run: deps.run, now: deps.now })
  const manifestPath = join(out, MANIFEST_NAME)
  writeManifest(manifestPath, manifest)
  deps.stdout(`delivery manifest: ${manifestPath}`)
  deps.stdout(`app: ${manifest.app.path}`)
  if (manifest.unverified.length) deps.stdout(`unverified:\n  ${manifest.unverified.join('\n  ')}`)
  return 0
}

export function cmdOpen(args, deps) {
  const root = deps.root
  const run = deps.run
  assertDeliveryRoots(root)
  if (args.sha) checkTargetSha({ root, sha: args.sha, run, fetch: !args.skipFetch })
  checkCleanTree({ root, allowed: [...DEFAULT_ALLOWED_DIRTY, ...(args.allowDirty || [])], run })
  if (!args.skipSync) must(run('npm', ['run', 'cap:sync'], { cwd: root, stdio: 'inherit' }), 'npm run cap:sync')
  deps.stdout('opening Xcode (development only — this is not a delivery: no manifest, no install)')
  must(run('npx', ['cap', 'open', 'ios'], { cwd: root, stdio: 'inherit' }), 'npx cap open ios')
  return 0
}

export function cmdVerify(args, deps) {
  const root = deps.root
  const manifestPath = resolve(root, requireArg(args, 'manifest'))
  const manifest = loadManifest(manifestPath)
  const result = verifyManifest({ root, manifest, manifestPath, artifact: args.artifact, run: deps.run })
  deps.stdout(`manifest verified against artifact: ${result.artifactPath}`)
  return 0
}

export function cmdInstall(args, deps) {
  const root = deps.root
  const run = deps.run
  const authorized = Boolean(args.authorize) || process.env.IOS_DELIVER_INSTALL === '1'
  if (!authorized) {
    throw new DeliveryError(
      'refusing to install without explicit authorisation: pass --authorize (or set IOS_DELIVER_INSTALL=1). Nothing was installed.',
    )
  }
  const manifestPath = resolve(root, requireArg(args, 'manifest'))
  const manifest = loadManifest(manifestPath)
  const { artifactPath } = verifyManifest({ root, manifest, manifestPath, artifact: args.artifact, run })

  if (args.dryRun) {
    deps.stdout(`dry run: would install ${artifactPath}`)
    deps.stdout(`  xcrun devicectl device install app --device <${args.device || 'device'}> ${artifactPath}`)
    manifest.readback = {
      at: new Date().toISOString(),
      status: 'unverified',
      reason: 'dry run: install was not executed',
      phone: null,
      watch: null,
      authorizedBy: 'dry-run',
    }
    if (!manifest.unverified.some((line) => line.startsWith('device read-back'))) {
      manifest.unverified.push('device read-back was not performed (dry run)')
    }
    writeManifest(manifestPath, manifest)
    return 0
  }

  let deviceId = args.device || null
  if (!deviceId) {
    const listed = listDevices(run)
    if (!listed.ok) throw new DeliveryError(`cannot list devices to resolve --device: ${listed.reason}`)
    const found = findDeviceId(listed.data)
    if (!found.id) {
      const names = found.candidates.map((device) => `${device.name ?? '?'} (${device.platform ?? '?'}, ${device.identifier ?? '?'})`)
      throw new DeliveryError(`--device is required: devicectl reported ${found.count} iOS candidate device(s)${names.length ? `: ${names.join(', ')}` : ''}`)
    }
    deviceId = found.id
  }

  const install = run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', deviceId, artifactPath], { cwd: root, stdio: 'inherit' })
  const readback = { at: new Date().toISOString(), device: deviceId, authorizedBy: args.authorize ? '--authorize' : 'IOS_DELIVER_INSTALL=1', status: 'unverified', devices: null, phone: null, watch: null }
  if (install.status !== 0) {
    readback.reason = sanitizeError(install.stderr || install.stdout || install.error || `devicectl install app failed (${install.status})`)
    manifest.readback = readback
    manifest.unverified.push(`device read-back: ${readback.reason}`)
    writeManifest(manifestPath, manifest)
    throw new DeliveryError(`install failed on ${deviceId}: ${readback.reason}`)
  }

  const listed = listDevices(run)
  readback.devices = listed.ok ? listDeviceRecords(listed.data) : { error: listed.reason }
  if (!listed.ok) manifest.unverified.push(`device list could not be read: ${listed.reason}`)

  const phoneExpected = manifest.deviceTargets?.phone || null
  const watchExpected = manifest.deviceTargets?.watch || null
  const watchDeviceId = args.watchDevice || deviceId
  readback.watchDevice = watchDeviceId

  const phoneApps = readDeviceApps(deviceId, run)
  const watchApps = watchDeviceId === deviceId ? phoneApps : readDeviceApps(watchDeviceId, run)

  const phone = phoneExpected
    ? phoneApps.ok
      ? compareReadback(phoneExpected, findInstalledApp(phoneApps.data, phoneExpected.bundleId))
      : { status: 'unverified', reason: `device locked or unreadable (${deviceId}): ${phoneApps.reason}` }
    : { status: 'unverified', reason: 'no phone target in manifest' }
  const watch = watchExpected
    ? watchApps.ok
      ? compareReadback(watchExpected, findInstalledApp(watchApps.data, watchExpected.bundleId))
      : { status: 'unverified', reason: `device locked or unreadable (${watchDeviceId}): ${watchApps.reason}` }
    : { status: 'unverified', reason: 'no watch target in manifest' }
  readback.phone = phone
  readback.watch = watch
  const problems = [phone, watch].filter((r) => r.status !== 'verified')
  readback.status = problems.length ? (problems.some((r) => r.status === 'mismatch') ? 'mismatch' : 'unverified') : 'verified'
  manifest.readback = readback
  for (const problem of problems) manifest.unverified.push(`device read-back: ${problem.reason || `${problem.status} ${JSON.stringify(problem.observed ?? {})}`}`)
  writeManifest(manifestPath, manifest)
  deps.stdout(`read-back: ${readback.status}`)
  return readback.status === 'verified' ? 0 : 3
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const VALUE_FLAGS = new Set([
  'sha', 'bundle', 'version', 'build', 'out', 'app', 'archive-path', 'artifact', 'manifest',
  'team-id', 'device', 'watch-device', 'deployment-sha', 'test-evidence', 'allow-dirty',
  'require-framework', 'scheme', 'root',
])
export const BOOL_FLAGS = new Set(['help', 'skip-fetch', 'skip-sync', 'no-archive', 'ipa', 'archive', 'open', 'authorize', 'dry-run'])

const CAMEL = {
  'archive-path': 'archivePath',
  'team-id': 'teamId',
  'watch-device': 'watchDevice',
  'deployment-sha': 'deploymentSha',
  'test-evidence': 'testEvidence',
  'allow-dirty': 'allowDirty',
  'require-framework': 'requireFramework',
  'skip-fetch': 'skipFetch',
  'skip-sync': 'skipSync',
  'no-archive': 'noArchive',
  'dry-run': 'dryRun',
}

const REPEATABLE = new Set(['test-evidence', 'allow-dirty', 'require-framework'])

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const rawName = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim()
    const name = CAMEL[rawName] || rawName
    if (BOOL_FLAGS.has(rawName)) {
      args[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(rawName)) throw new DeliveryError(`unknown flag --${rawName}`)
    const value = eq === -1 ? argv[(i += 1)] : token.slice(eq + 1)
    if (value === undefined) throw new DeliveryError(`--${rawName} needs a value`)
    if (REPEATABLE.has(rawName)) args[name] = [...(args[name] || []), value]
    else args[name] = value
  }
  return args
}

export function helpText() {
  return `ios-deliver — the one recommended iOS delivery entry point (issue #213).

  npm run cap:ios -- build   --sha <40-hex> --version <short> --build <n> [--ipa] [--team-id <ID>]
      Guard (SHA/clean tree/realpaths) -> cap:sync -> archive -> export -> manifest.
      --build is the bundle this run will carry: HEAD's CURRENT_PROJECT_VERSION + 1,
      because the guarded cap:sync bumps it once. A wrong value refuses before syncing.
      Writes <out>/${MANIFEST_NAME}; refuses to reuse an existing --out directory.

  npm run cap:ios -- verify  --manifest <path> [--artifact <exact path>]
      Re-checks a manifest against the exact artifact on disk. No device needed.

  npm run cap:ios -- install --manifest <path> [--artifact <exact path>] --device <udid> --authorize
      Verifies manifest-vs-artifact, installs, reads the phone (and --watch-device) back
      and records the result in the manifest. --dry-run stops before touching a device.

  npm run cap:ios -- open    [--sha <40-hex>]
      Development only (opens Xcode). Not a delivery: no manifest, no install.

Options: --out <dir> --app <built .app> (fixture reuse) --archive-path <dir> --no-archive
         --allow-dirty <glob> (repeatable) --require-framework <Name> (repeatable)
         --deployment-sha <sha> --test-evidence "<cmd => result>" (repeatable)
         --skip-fetch --skip-sync

The manifest never contains signing keys or tokens; anything not checked is listed
under "unverified" instead of being guessed.`
}

export function runCommand(argv, deps = {}) {
  const root = deps.root || process.cwd()
  const run = deps.run || runCapture
  const stdout = deps.stdout || ((text) => process.stdout.write(`${text}\n`))
  const stderr = deps.stderr || ((text) => process.stderr.write(`${text}\n`))
  const context = { root, run, stdout, stderr, now: deps.now }

  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    stderr(`ios-deliver: ${error.message}`)
    stderr(helpText())
    return 2
  }
  if (args.root) context.root = resolve(root, args.root)
  if (args.help) {
    stdout(helpText())
    return 0
  }

  const positional = args._.filter((token) => token !== 'build' && token !== 'verify' && token !== 'install' && token !== 'open' && token !== 'help') 
  if (positional.length) {
    stderr(`ios-deliver: unexpected argument(s): ${positional.join(' ')}`)
    stderr(helpText())
    return 2
  }
  let command = args._.find((token) => ['build', 'verify', 'install', 'open', 'help'].includes(token))
  if (!command) {
    if (args.open) command = 'open'
    else if (args.archive || args.ipa) command = 'build'
  }
  if (!command) {
    if (argv.length === 0) {
      stdout(helpText())
      return 0
    }
    stderr(helpText())
    return 2
  }
  if (command === 'help') {
    stdout(helpText())
    return 0
  }
  if (!args.bundle) args.bundle = readAppId(context.root) || args.bundle
  if (!args.version) args.version = currentVersionOrNull(context.root) || args.version
  if (!args.teamId) args.teamId = process.env.TEAM_ID || process.env.DEVELOPMENT_TEAM || null

  try {
    if (command === 'build') return cmdBuild(args, context)
    if (command === 'verify') return cmdVerify(args, context)
    if (command === 'install') return cmdInstall(args, context)
    if (command === 'open') return cmdOpen(args, context)
    throw new DeliveryError(`unknown command ${command}`)
  } catch (error) {
    if (error instanceof DeliveryError) {
      stderr(`ios-deliver: ${error.message}`)
      return 2
    }
    stderr(`ios-deliver: ${error.stack || error.message}`)
    return 1
  }
}

function currentVersionOrNull(root) {
  try {
    const pbx = readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    return /MARKETING_VERSION = ([0-9][^;]*);/.exec(pbx)?.[1] ?? null
  } catch {
    return null
  }
}

const invokedDirectly =
  process.argv[1] && (() => {
    try {
      return fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
    } catch {
      return false
    }
  })()

if (invokedDirectly) {
  process.exitCode = runCommand(process.argv.slice(2))
}
