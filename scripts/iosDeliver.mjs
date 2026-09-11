import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPluginRoots, assertPodsProject } from './iosWorktreePods.mjs'

export const MANIFEST_SCHEMA = 'nod.ios.deliver.v1'
export const PHONE_BUNDLE_ID = 'com.nodpilot.app'
export const WATCH_BUNDLE_ID = 'com.nodpilot.app.watchkitapp'

export const GENERATED_DIFF_PREFIXES = [
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App/public/',
  'ios/App/App/capacitor.config.json',
  'ios/App/App/config.xml',
  'ios/App/Podfile',
  'ios/App/Podfile.lock',
  'ios/App/Pods/',
]

const FULL_SHA = /^[0-9a-f]{40}$/

export function assertFullSha(sha, label = 'sha') {
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
    throw new Error(`ios deliver: ${label} must be a full 40-character commit SHA`)
  }
  return sha
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`ios deliver: git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return (result.stdout || '').trim()
}

export function parsePorcelain(text) {
  const paths = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const body = line.slice(3)
    if (line[0] === 'R' || line[1] === 'R') {
      const parts = body.split(' -> ')
      paths.push(parts[parts.length - 1])
      continue
    }
    paths.push(body)
  }
  return paths
}

export function isAllowedDiff(path, allowed) {
  return allowed.some((rule) => {
    if (path === rule) return true
    const prefix = rule.endsWith('/') ? rule : `${rule}/`
    return path.startsWith(prefix)
  })
}

export function assertCheckout({ root, sha, allowedDiff = [], requireClean = true } = {}) {
  const rootReal = realpathSync(root)
  const expected = assertFullSha(sha)
  const head = git(root, ['rev-parse', 'HEAD'])
  assertFullSha(head, 'HEAD')
  if (head !== expected) {
    throw new Error(`ios deliver: HEAD ${head} does not match --sha ${expected}`)
  }
  const dirty = parsePorcelain(git(root, ['status', '--porcelain']))
  if (requireClean) {
    const bad = dirty.filter((p) => !isAllowedDiff(p, allowedDiff))
    if (bad.length) {
      throw new Error(`ios deliver: checkout has unexpected changes:\n${bad.join('\n')}`)
    }
  }
  return { root: rootReal, sha: head, dirty }
}

export function hashPath(target) {
  const st = statSync(target)
  if (st.isFile()) {
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  }
  const files = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(p).isDirectory()) walk(p, r)
      else files.push([r, readFileSync(p)])
    }
  }
  walk(target, '')
  const h = createHash('sha256')
  for (const [r, buf] of files) {
    h.update(r)
    h.update('\0')
    h.update(buf)
    h.update('\0')
  }
  return h.digest('hex')
}

function hashIfExists(path) {
  return existsSync(path) ? hashPath(path) : null
}

export function assertDependencies(root) {
  const rootReal = realpathSync(root)
  const nm = join(root, 'node_modules')
  if (existsSync(nm) && lstatSync(nm).isDirectory() && !existsSync(join(nm, 'nod-mic'))) {
    throw new Error(`ios deliver: node_modules exists at ${nm} but plugins are missing — directory existence is not proof`)
  }
  assertPluginRoots(root)
  const webNm = join(root, 'web/node_modules')
  if (!existsSync(webNm)) {
    throw new Error(`ios deliver: missing web/node_modules — run npm ci in ${join(rootReal, 'web')}`)
  }
  if (lstatSync(webNm).isSymbolicLink()) {
    const real = realpathSync(webNm)
    if (real !== join(rootReal, 'web/node_modules') && !real.startsWith(`${rootReal}/web/`)) {
      throw new Error(`ios deliver: web/node_modules is a symlink to ${real}`)
    }
  }
  return {
    root: rootReal,
    plugins: Object.fromEntries(
      ['nod-auth', 'nod-mic', 'nod-watch'].map((name) => [name, realpathSync(join(root, 'plugins', name))]),
    ),
  }
}

export function readBundleVersion(root) {
  const src = readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
  const matches = [...src.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1])
  if (!matches.length) {
    throw new Error('ios deliver: CURRENT_PROJECT_VERSION not found')
  }
  if (new Set(matches).size !== 1) {
    throw new Error(`ios deliver: CURRENT_PROJECT_VERSION is inconsistent: ${matches.join(', ')}`)
  }
  return matches[0]
}

export function assertExpectedBundle(root, expected) {
  const want = String(expected)
  if (!/^\d+$/.test(want)) {
    throw new Error('ios deliver: --bundle must be an integer')
  }
  const actual = readBundleVersion(root)
  if (actual !== want) {
    throw new Error(`ios deliver: bundle ${actual} does not match --bundle ${want}`)
  }
  return actual
}

export function readWebServing(root) {
  const cfgPath = join(root, 'capacitor.config.json')
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
  return {
    webDir: cfg.webDir || null,
    serverUrl: cfg.server?.url || null,
    iosScheme: cfg.server?.iosScheme || null,
  }
}

export function assertOutputDir(out, sha) {
  const dir = resolve(out)
  mkdirSync(dir, { recursive: true })
  const existing = join(dir, 'manifest.json')
  if (existsSync(existing)) {
    const prev = JSON.parse(readFileSync(existing, 'utf8'))
    if (prev.actualSha && sha && prev.actualSha !== sha) {
      throw new Error(`ios deliver: ${dir} already has manifest for ${prev.actualSha}, not ${sha}`)
    }
  }
  return realpathSync(dir)
}

export function artifactRecord(path) {
  if (!path) return null
  if (!existsSync(path)) {
    throw new Error(`ios deliver: missing artifact ${path}`)
  }
  const real = realpathSync(path)
  return { path: real, sha256: hashPath(real) }
}

export function buildManifest({
  root,
  targetSha,
  actualSha,
  allowedDiff = [],
  dirty = [],
  bundle,
  outDir,
  archivePath,
  appPath,
  ipaPath,
  pods,
  railwaySha = null,
  tools = {},
  stages = {},
  unverified = [],
} = {}) {
  const rootReal = realpathSync(root)
  const web = readWebServing(root)
  const publicDir = join(root, 'ios/App/App/public')
  const distDir = join(root, 'web/dist')
  const webRoot = existsSync(publicDir) ? publicDir : existsSync(distDir) ? distDir : null
  const plugins = Object.fromEntries(
    ['nod-auth', 'nod-mic', 'nod-watch'].map((name) => {
      const p = join(root, 'plugins', name)
      return [name, existsSync(p) ? realpathSync(p) : null]
    }),
  )
  const lock = (rel) => {
    const p = join(root, rel)
    return existsSync(p) ? hashPath(p) : null
  }
  return {
    schema: MANIFEST_SCHEMA,
    targetSha,
    actualSha,
    rootRealpath: rootReal,
    allowedDiff,
    dirty,
    tools,
    lockfiles: {
      'package-lock.json': lock('package-lock.json'),
      'web/package-lock.json': lock('web/package-lock.json'),
    },
    plugins,
    pods: pods || null,
    web: {
      ...web,
      path: webRoot ? realpathSync(webRoot) : null,
      sha256: webRoot ? hashPath(webRoot) : null,
    },
    bundle: {
      expected: String(bundle),
      actual: String(bundle),
      phoneBundleId: PHONE_BUNDLE_ID,
      watchBundleId: WATCH_BUNDLE_ID,
    },
    artifacts: {
      outDir: outDir ? realpathSync(outDir) : null,
      archive: archivePath ? artifactRecord(archivePath) : null,
      app: appPath ? artifactRecord(appPath) : null,
      ipa: ipaPath ? artifactRecord(ipaPath) : null,
    },
    devices: {
      iphone: { bundleId: PHONE_BUNDLE_ID, version: null, build: null, verified: false },
      watch: { bundleId: WATCH_BUNDLE_ID, version: null, build: null, verified: false },
    },
    deploy: {
      railwaySha: railwaySha || null,
      compatible: railwaySha ? 'recorded' : null,
      healthOk: null,
    },
    stages: {
      build: stages.build || 'ok',
      install: stages.install || 'not-authorized',
      device: stages.device || 'unverified',
    },
    unverified,
  }
}

export function writeManifest(outDir, manifest) {
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error('ios deliver: refusing to write unknown manifest schema')
  }
  const dir = assertOutputDir(outDir, manifest.actualSha)
  const path = join(dir, 'manifest.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

export function loadManifest(path) {
  if (!path || !existsSync(path)) {
    throw new Error('ios deliver: missing delivery manifest')
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(`ios deliver: unsupported manifest schema ${manifest.schema}`)
  }
  return manifest
}

function assertRecord(record, label) {
  if (!record || !record.path || !record.sha256) {
    throw new Error(`ios deliver: manifest is missing ${label}`)
  }
  if (!existsSync(record.path)) {
    throw new Error(`ios deliver: ${label} ${record.path} is missing`)
  }
  const real = realpathSync(record.path)
  if (real !== record.path) {
    throw new Error(`ios deliver: ${label} path changed: ${record.path} -> ${real}`)
  }
  const got = hashPath(real)
  if (got !== record.sha256) {
    throw new Error(`ios deliver: ${label} hash mismatch (artifact replaced or stale)`)
  }
}

export function assertManifestMatchesArtifacts(manifest) {
  if (!manifest?.artifacts) {
    throw new Error('ios deliver: missing delivery manifest')
  }
  const { archive, app, ipa } = manifest.artifacts
  if (!archive && !app && !ipa) {
    throw new Error('ios deliver: manifest has no artifacts')
  }
  if (archive) assertRecord(archive, 'archive')
  if (app) assertRecord(app, 'app')
  if (ipa) assertRecord(ipa, 'ipa')
  if (manifest.bundle?.expected && manifest.bundle.actual && manifest.bundle.expected !== manifest.bundle.actual) {
    throw new Error(`ios deliver: bundle mismatch ${manifest.bundle.actual} != ${manifest.bundle.expected}`)
  }
  return true
}

export function prepareInstall({ manifestPath, installOk = false, installer = null, deviceReader = null } = {}) {
  const manifest = loadManifest(manifestPath)
  assertManifestMatchesArtifacts(manifest)
  if (!installOk) {
    manifest.stages = { ...manifest.stages, install: 'not-authorized', device: 'unverified' }
    if (!manifest.unverified.includes('device install')) manifest.unverified.push('device install')
    return { status: 'not-authorized', manifest }
  }
  if (typeof installer === 'function') {
    installer(manifest)
    manifest.stages = { ...manifest.stages, install: 'ok' }
  } else {
    manifest.stages = { ...manifest.stages, install: 'authorized' }
  }
  if (typeof deviceReader === 'function') {
    const devices = deviceReader(manifest)
    manifest.devices = { ...manifest.devices, ...devices }
    const phoneOk = Boolean(manifest.devices?.iphone?.verified)
    const watchOk = Boolean(manifest.devices?.watch?.verified)
    manifest.stages.device = phoneOk && watchOk ? 'ok' : 'unverified'
    if (!phoneOk || !watchOk) {
      if (!manifest.unverified.includes('device version')) manifest.unverified.push('device version')
    }
  } else if (manifest.stages.install === 'ok') {
    manifest.stages.device = 'unverified'
    if (!manifest.unverified.includes('device version')) manifest.unverified.push('device version')
  }
  return { status: manifest.stages.install === 'ok' ? 'installed' : 'authorized', manifest }
}

export function collectTools() {
  const node = spawnSync('node', ['-v'], { encoding: 'utf8' })
  const xcode = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' })
  return {
    node: (node.stdout || '').trim() || null,
    xcodebuild: (xcode.status === 0 ? xcode.stdout : '').trim().split('\n')[0] || null,
  }
}

export function parseDeliverArgs(argv) {
  const out = {
    cmd: argv[0] || '',
    sha: null,
    bundle: null,
    out: null,
    root: process.cwd(),
    manifest: null,
    installOk: false,
    archive: null,
    app: null,
    ipa: null,
    railwaySha: null,
    allowedDiff: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sha') out.sha = argv[++i]
    else if (a === '--bundle') out.bundle = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--root') out.root = argv[++i]
    else if (a === '--manifest') out.manifest = argv[++i]
    else if (a === '--install-ok') out.installOk = true
    else if (a === '--archive') out.archive = argv[++i]
    else if (a === '--app') out.app = argv[++i]
    else if (a === '--ipa') out.ipa = argv[++i]
    else if (a === '--railway-sha') out.railwaySha = argv[++i]
    else if (a === '--allow-diff') out.allowedDiff.push(argv[++i])
  }
  return out
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseDeliverArgs(argv)
  const cmd = args.cmd
  if (cmd === 'checkout') {
    const checkout = assertCheckout({ root: args.root, sha: args.sha, allowedDiff: args.allowedDiff })
    process.stdout.write(`ios deliver: checkout ${checkout.sha} ${checkout.root}\n`)
    return checkout
  }
  if (cmd === 'preflight') {
    const checkout = assertCheckout({ root: args.root, sha: args.sha, allowedDiff: args.allowedDiff })
    const deps = assertDependencies(args.root)
    let pods = null
    if (existsSync(join(args.root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'))) {
      pods = assertPodsProject(args.root)
    }
    if (args.bundle) assertExpectedBundle(args.root, args.bundle)
    process.stdout.write(`ios deliver: preflight ok ${checkout.sha} ${deps.root}\n`)
    return { checkout, deps, pods }
  }
  if (cmd === 'manifest') {
    if (!args.out) throw new Error('ios deliver: --out is required to write a manifest')
    const checkout = assertCheckout({
      root: args.root,
      sha: args.sha,
      allowedDiff: [...GENERATED_DIFF_PREFIXES, ...args.allowedDiff],
    })
    const bundle = assertExpectedBundle(args.root, args.bundle)
    let pods = null
    if (existsSync(join(args.root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj'))) {
      pods = assertPodsProject(args.root)
    }
    const unverified = []
    if (!args.railwaySha) unverified.push('railway deploy')
    const manifest = buildManifest({
      root: args.root,
      targetSha: args.sha,
      actualSha: checkout.sha,
      allowedDiff: [...GENERATED_DIFF_PREFIXES, ...args.allowedDiff],
      dirty: checkout.dirty,
      bundle,
      outDir: args.out,
      archivePath: args.archive,
      appPath: args.app,
      ipaPath: args.ipa,
      pods,
      railwaySha: args.railwaySha,
      tools: collectTools(),
      stages: { build: 'ok', install: 'not-authorized', device: 'unverified' },
      unverified: [...unverified, 'device install'],
    })
    const path = writeManifest(args.out, manifest)
    process.stdout.write(`ios deliver: wrote ${path}\n`)
    return path
  }
  if (cmd === 'install') {
    const result = prepareInstall({
      manifestPath: args.manifest,
      installOk: args.installOk,
    })
    if (result.status === 'not-authorized') {
      throw new Error('ios deliver: install requires explicit --install-ok')
    }
    return result
  }
  throw new Error(`ios deliver: unknown command ${cmd}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    runCli()
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
}
