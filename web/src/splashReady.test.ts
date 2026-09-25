import { SPLASH_HIDDEN_FALLBACK_MS, createSplashReadySignal, loadNodSplash } from './splashReady'
import type { NodSplashPlugin } from './splashReady'

const realSetTimeout = globalThis.setTimeout

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A macrotask turn; unhandled rejections are only reported once the microtask queue drains. */
async function tick() {
  await new Promise((resolve) => (globalThis as any).setImmediate(resolve))
}

function recorder() {
  const calls: string[] = []
  return {
    calls,
    loadPlugin: async () => {
      calls.push('loadPlugin')
      return {
        splashReady: async () => {
          calls.push('splashReady')
        },
      }
    },
  }
}

function installFakeEnv(hidden: boolean) {
  const saved = {
    document: (globalThis as any).document,
    requestAnimationFrame: (globalThis as any).requestAnimationFrame,
    setTimeout: (globalThis as any).setTimeout,
  }
  const frames: FrameRequestCallback[] = []
  const timers: Array<() => void> = []
  const listeners = new Map<string, () => void>()
  const doc = {
    hidden,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener)
    },
    removeEventListener(type: string) {
      listeners.delete(type)
    },
  }
  ;(globalThis as any).document = doc
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb)
  ;(globalThis as any).setTimeout = (cb: () => void) => timers.push(cb)

  return {
    doc,
    timerCount: () => timers.length,
    pumpFrame() {
      const frame = frames.shift()
      if (frame) frame(0)
    },
    async drainFrames() {
      while (frames.length) frames.shift()!(0)
      await flush()
    },
    async runTimer() {
      const timer = timers.shift()
      if (timer) timer()
      await flush()
    },
    async becomeVisible() {
      doc.hidden = false
      listeners.get('visibilitychange')?.()
      await flush()
    },
    teardown() {
      ;(globalThis as any).document = saved.document
      ;(globalThis as any).requestAnimationFrame = saved.requestAnimationFrame
      ;(globalThis as any).setTimeout = saved.setTimeout
    },
  }
}

// A browser has no native mask to lift; the plugin must stay untouched and nothing may throw.
{
  const plugin = recorder()
  const signal = createSplashReadySignal({ isNative: () => false, loadPlugin: plugin.loadPlugin })
  signal()
  signal()
  await flush()
  eq(plugin.calls.length, 0, 'browser never loads or calls the plugin')
}

// Many calls, one handshake: the mask may only be asked to fade once per document.
{
  const env = installFakeEnv(false)
  const plugin = recorder()
  const signal = createSplashReadySignal({ isNative: () => true, loadPlugin: plugin.loadPlugin })
  signal()
  signal()
  signal()
  eq(plugin.calls.length, 0, 'nothing is sent before the first paint')
  env.pumpFrame()
  await flush()
  eq(plugin.calls.length, 0, 'one frame is React commit, not a painted page')
  await env.drainFrames()
  eq(
    plugin.calls.filter((c) => c === 'splashReady').length,
    1,
    'repeated signals still call splashReady exactly once',
  )
  env.teardown()
}

// A missing package is not a boot failure and must not surface as an unhandled rejection.
{
  const env = installFakeEnv(false)
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown) => rejections.push(reason)
  ;(globalThis as any).process.on('unhandledRejection', onUnhandled)
  const signal = createSplashReadySignal({
    isNative: () => true,
    loadPlugin: () => Promise.reject(new Error('nod-splash unavailable')),
  })
  signal()
  await env.drainFrames()
  await tick()
  ;(globalThis as any).process.off('unhandledRejection', onUnhandled)
  eq(rejections.length, 0, 'a rejected plugin import is swallowed')
  env.teardown()
}

// Signalling into a backgrounded app would lift the mask over a page nobody sees.
{
  const env = installFakeEnv(true)
  const plugin = recorder()
  const signal = createSplashReadySignal({ isNative: () => true, loadPlugin: plugin.loadPlugin })
  signal()
  await env.drainFrames()
  eq(plugin.calls.length, 0, 'a hidden page waits for visibility')
  eq(env.timerCount(), 1, 'a hidden page arms the bounded fallback')

  await env.becomeVisible()
  await env.drainFrames()
  eq(
    plugin.calls.filter((c) => c === 'splashReady').length,
    1,
    'becoming visible sends the signal once',
  )

  await env.runTimer()
  await env.drainFrames()
  eq(
    plugin.calls.filter((c) => c === 'splashReady').length,
    1,
    'the fallback firing later does not signal twice',
  )
  env.teardown()
}

// A page that never becomes visible again must still complete the handshake.
{
  const env = installFakeEnv(true)
  const plugin = recorder()
  const signal = createSplashReadySignal({ isNative: () => true, loadPlugin: plugin.loadPlugin })
  eq(SPLASH_HIDDEN_FALLBACK_MS, 1500, 'the fallback is bounded')
  signal()
  await env.drainFrames()
  eq(plugin.calls.length, 0, 'still hidden')
  await env.runTimer()
  await env.drainFrames()
  eq(
    plugin.calls.filter((c) => c === 'splashReady').length,
    1,
    'the bounded fallback sends the signal without visibility',
  )
  env.teardown()
}

/** Same get() shape as @capacitor/core registerPlugin: every unknown property, `then`
 * included, is a native method wrapper that rejects when the method does not exist. */
function capacitorProxy(calls: string[]): NodSplashPlugin {
  return new Proxy({} as NodSplashPlugin, {
    get(_, prop) {
      if (prop === '$$typeof') return undefined
      if (prop === 'toJSON') return () => ({})
      return () => {
        calls.push(String(prop))
        if (prop === 'splashReady') return Promise.resolve()
        return Promise.reject(new Error(`"NodSplash.${String(prop)}()" is not implemented on ios`))
      }
    },
  })
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((resolve) => realSetTimeout(() => resolve('pending'), ms))])
}

// The registry fallback hands back a Capacitor proxy; the loader must still settle.
{
  const calls: string[] = []
  const got = await within(
    loadNodSplash({
      importPackage: () => Promise.reject(new Error('bare specifier')),
      register: () => capacitorProxy(calls),
    }),
    500,
  )
  eq(got === 'pending', false, 'loadNodSplash settles when register() returns a Capacitor proxy')
  if (got && got !== 'pending') await got.splashReady()
  eq(calls.includes('splashReady'), true, 'the wrapper reaches the native splashReady')
  eq(calls.includes('then'), false, 'the proxy is never probed as a thenable')
}

// The package path returns the same kind of proxy.
{
  const calls: string[] = []
  const got = await within(
    loadNodSplash({
      importPackage: async () => ({ NodSplash: capacitorProxy(calls) }),
      register: () => {
        throw new Error('not reached')
      },
    }),
    500,
  )
  eq(got === 'pending', false, 'loadNodSplash settles when the package exports a Capacitor proxy')
}

// End to end: a native cold start with the real loader must reach splashReady after paint.
{
  const env = installFakeEnv(false)
  const calls: string[] = []
  const signal = createSplashReadySignal({
    isNative: () => true,
    loadPlugin: () =>
      loadNodSplash({
        importPackage: () => Promise.reject(new Error('bare specifier')),
        register: () => capacitorProxy(calls),
      }),
  })
  signal()
  await env.drainFrames()
  env.teardown()
  await within(
    (async () => {
      while (!calls.includes('splashReady')) await new Promise((r) => realSetTimeout(r, 5))
    })(),
    500,
  )
  eq(calls.filter((c) => c === 'splashReady').length, 1, 'cold start sends the handshake once')
}

console.log('splashReady.test.ts: ok')
