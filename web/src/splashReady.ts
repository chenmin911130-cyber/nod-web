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

/**
 * Resolve the native splash plugin lazily so the web bundle has no hard
 * dependency on the optional `nod-splash` package. The specifier stays opaque to
 * the bundler and Capacitor's own registry is the fallback, so a build without
 * the package still reaches the same native `NodSplash` plugin.
 */
async function loadNodSplash(): Promise<NodSplashPlugin | null> {
  const specifier = 'nod-splash'
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as { NodSplash?: NodSplashPlugin }
    if (mod?.NodSplash) return mod.NodSplash
  } catch {
    /* the package is optional; fall back to the native bridge */
  }
  try {
    return registerPlugin<NodSplashPlugin>('NodSplash')
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
