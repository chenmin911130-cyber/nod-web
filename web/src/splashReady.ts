import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './native'

/** Upper bound on waiting for a backgrounded page: it must never keep the mask up forever. */
export const SPLASH_HIDDEN_FALLBACK_MS = 1500

export type NodSplashPlugin = {
  splashReady(): Promise<void>
}

export type SplashReadyDeps = {
  isNative: () => boolean
  loadPlugin: () => Promise<NodSplashPlugin | null>
}

export type NodSplashSources = {
  importPackage: () => Promise<{ NodSplash?: NodSplashPlugin }>
  register: () => NodSplashPlugin
}

const defaultSources: NodSplashSources = {
  importPackage: () => {
    const specifier = 'nod-splash'
    return import(/* @vite-ignore */ specifier) as Promise<{ NodSplash?: NodSplashPlugin }>
  },
  register: () => registerPlugin<NodSplashPlugin>('NodSplash'),
}

/**
 * A Capacitor plugin is a Proxy that answers every property, `then` included, so it must
 * never be the value a promise resolves with: it is adopted as a thenable and never settles.
 */
function plain(plugin: NodSplashPlugin): NodSplashPlugin {
  return { splashReady: () => plugin.splashReady() }
}

/**
 * Resolve the native splash plugin lazily so the web bundle has no hard
 * dependency on the optional `nod-splash` package. The specifier stays opaque to
 * the bundler and Capacitor's own registry is the fallback, so a build without
 * the package still reaches the same native `NodSplash` plugin.
 */
export async function loadNodSplash(sources: NodSplashSources = defaultSources): Promise<NodSplashPlugin | null> {
  try {
    const mod = await sources.importPackage()
    if (mod?.NodSplash) return plain(mod.NodSplash)
  } catch {
    /* the package is optional; fall back to the native bridge */
  }
  try {
    return plain(sources.register())
  } catch {
    return null
  }
}

export function createSplashReadySignal(deps: SplashReadyDeps): () => void {
  let started = false
  let sent = false

  const send = async () => {
    if (sent) return
    sent = true
    try {
      const plugin = await deps.loadPlugin()
      if (plugin) await plugin.splashReady()
    } catch {
      // A failed handshake must never break boot; the native side has its own timeout.
    }
  }

  // Two frames: React commits, then the browser paints. Only then may the mask fade,
  // otherwise the cross-fade uncovers a blank page.
  const sendAfterPaint = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void send()
      })
    })
  }

  return () => {
    if (started) return
    started = true
    if (!deps.isNative()) return
    if (document.hidden) {
      const onVisible = () => {
        if (document.hidden) return
        document.removeEventListener('visibilitychange', onVisible)
        sendAfterPaint()
      }
      document.addEventListener('visibilitychange', onVisible)
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisible)
        sendAfterPaint()
      }, SPLASH_HIDDEN_FALLBACK_MS)
      return
    }
    sendAfterPaint()
  }
}

const defaultSignal = createSplashReadySignal({
  isNative: isNativeApp,
  loadPlugin: loadNodSplash,
})

export function signalSplashReady(): void {
  defaultSignal()
}
