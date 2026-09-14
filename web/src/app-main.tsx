import { createRoot } from 'react-dom/client'
import { PRODUCT_NAME } from './brand'
import { ensureLocalGuest, fetchMe, getToken, isLocalHost } from './auth'
import { nativeColdStartSurface } from './nativeColdStart'
import { installNativeShell, isNativeApp, maybeReturnToNativeApp, nativeGo, rememberNativeReturn } from './native'
import { signalSplashReady } from './splashReady'

const rootEl = document.getElementById('root')

async function mountWorkspace() {
  if (!rootEl) return
  document.documentElement.classList.add('nod-web')
  document.title = PRODUCT_NAME
  const [{ default: App }, { installWebApi }] = await Promise.all([import('./App'), import('./bridge')])
  await import('./App.css')
  installWebApi()
  createRoot(rootEl).render(<App />)
  void signalSplashReady()
}

async function mountNativeSignIn() {
  if (!rootEl) return
  document.documentElement.classList.add('nod-web')
  document.title = PRODUCT_NAME
  await import('./App.css')
  const { default: NativeSignIn } = await import('./components/NativeSignIn')
  const root = createRoot(rootEl)
  root.render(
    <NativeSignIn
      onSignedIn={() => {
        root.unmount()
        void mountWorkspace()
      }}
    />,
  )
  void signalSplashReady()
}

async function boot() {
  if (!rootEl) return
  rememberNativeReturn()
  installNativeShell()
  if (isLocalHost() && new URLSearchParams(location.search).get('preview') === 'signin') {
    document.documentElement.classList.add('nod-web', 'nod-native')
    document.title = PRODUCT_NAME
    await import('./App.css')
    const { default: NativeSignIn } = await import('./components/NativeSignIn')
    createRoot(rootEl).render(<NativeSignIn onSignedIn={() => location.replace('/app')} />)
    void signalSplashReady()
    return
  }
  if (isNativeApp()) {
    if (nativeColdStartSurface(getToken()) === 'workspace') await mountWorkspace()
    else await mountNativeSignIn()
    return
  }
  const path = window.location.pathname + window.location.search
  let me = await fetchMe()
  if (me && maybeReturnToNativeApp(getToken())) return
  if (isLocalHost()) me = (await ensureLocalGuest()) || me
  else if (!me) me = await ensureLocalGuest()
  if (!me) {
    nativeGo(`/login?next=${encodeURIComponent(path || '/app')}`, true)
    return
  }
  await mountWorkspace()
}

void boot()
