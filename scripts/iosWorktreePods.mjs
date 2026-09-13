import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_PLUGINS = ['nod-auth', 'nod-mic', 'nod-splash', 'nod-watch']

const POD_PATHS = {
  Capacitor: '../../node_modules/@capacitor/ios',
  CapacitorCordova: '../../node_modules/@capacitor/ios',
  CapacitorApp: '../../node_modules/@capacitor/app',
  CapacitorBrowser: '../../node_modules/@capacitor/browser',
  CapacitorKeyboard: '../../node_modules/@capacitor/keyboard',
  CapacitorStatusBar: '../../node_modules/@capacitor/status-bar',
  NodAuth: '../../plugins/nod-auth',
  NodMic: '../../plugins/nod-mic',
  NodSplash: '../../plugins/nod-splash',
  NodWatch: '../../plugins/nod-watch',
}

export function pinPodfile(src) {
  let out = src.replace(
    /require_relative ['"][^'"]+pods_helpers['"]/,
    "require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'",
  )
  for (const [name, path] of Object.entries(POD_PATHS)) {
    out = out.replace(new RegExp(`pod '${name}', :path => '[^']+'`), `pod '${name}', :path => '${path}'`)
  }
  return out
}

export function assertPluginRoots(root = process.cwd()) {
  const rootReal = realpathSync(root)
  const nm = join(root, 'node_modules')
  if (!existsSync(nm)) {
    throw new Error(`ios worktree pods: missing node_modules — run npm ci in ${rootReal}`)
  }
  if (lstatSync(nm).isSymbolicLink()) {
    const nmReal = realpathSync(nm)
    if (nmReal !== join(rootReal, 'node_modules') && !nmReal.startsWith(`${rootReal}/`)) {
      throw new Error(
        `ios worktree pods: node_modules is a symlink to ${nmReal}. Pack from this worktree: rm node_modules && npm ci`,
      )
    }
  }
  for (const name of LOCAL_PLUGINS) {
    const pkg = join(root, 'node_modules', name)
    if (!existsSync(pkg)) {
      throw new Error(`ios worktree pods: missing ${name} — run npm ci`)
    }
    const real = realpathSync(pkg)
    const want = realpathSync(join(root, 'plugins', name))
    if (real !== want) {
      throw new Error(`ios worktree pods: ${name} resolves to ${real}, expected ${want}`)
    }
  }
}

function pluginPathEntries(pbx, podsDir) {
  const hits = []
  const re = /path = "?([^";]+)"?;/g
  let m
  while ((m = re.exec(pbx))) {
    const p = m[1]
    if (!/nod-(mic|watch|auth|splash)/.test(p)) continue
    const abs = resolve(podsDir, p)
    hits.push(existsSync(abs) ? realpathSync(abs) : abs)
  }
  return hits
}

export function assertPodsProject(root = process.cwd()) {
  const pbxPath = join(root, 'ios/App/Pods/Pods.xcodeproj/project.pbxproj')
  if (!existsSync(pbxPath)) {
    throw new Error('ios worktree pods: Pods.xcodeproj is missing — run pod install')
  }
  const pluginsRoot = realpathSync(join(root, 'plugins'))
  const hits = pluginPathEntries(readFileSync(pbxPath, 'utf8'), join(root, 'ios/App/Pods'))
  if (!hits.length) {
    throw new Error('ios worktree pods: Pods project has no nod-auth / nod-mic / nod-splash / nod-watch paths')
  }
  const bad = hits.filter((p) => !p.startsWith(pluginsRoot))
  if (bad.length) {
    throw new Error(`ios worktree pods: Pods project escaped this worktree:\n${bad.join('\n')}`)
  }
  for (const name of LOCAL_PLUGINS) {
    const want = realpathSync(join(root, 'plugins', name))
    if (!hits.some((p) => p === want || p.startsWith(`${want}/`))) {
      throw new Error(`ios worktree pods: Pods project does not compile ${want}`)
    }
  }
  return { plugins: hits }
}

function writePinnedPodfile(root) {
  const podfilePath = join(root, 'ios/App/Podfile')
  const before = readFileSync(podfilePath, 'utf8')
  const after = pinPodfile(before)
  if (after !== before) {
    writeFileSync(podfilePath, after)
    process.stdout.write('ios worktree pods: pinned Podfile to this checkout\n')
  }
}

function podInstall(root) {
  const result = spawnSync('pod', ['install'], { cwd: join(root, 'ios/App'), stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`ios worktree pods: pod install failed (${result.status})`)
  }
}

export function pinAndInstall(root = process.cwd()) {
  writePinnedPodfile(root)
  podInstall(root)
  writePinnedPodfile(root)
  assertPodsProject(root)
}

function main() {
  const cmd = process.argv[2] || 'assert-roots'
  if (cmd === 'assert-roots') {
    assertPluginRoots()
    process.stdout.write('ios worktree pods: plugins resolve inside this checkout\n')
    return
  }
  if (cmd === 'pin') {
    pinAndInstall()
    process.stdout.write('ios worktree pods: Pods project is this worktree\n')
    return
  }
  throw new Error(`ios worktree pods: unknown command ${cmd}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main()
}
