import { createRoot } from 'react-dom/client'
import { ensureLocalGuest, fetchMe, getToken, isLocalHost } from './auth'
import { installNativeShell, isNativeApp, maybeReturnToNativeApp, nativeGo, rememberNativeReturn } from './native'

const rootEl = document.getElementById('root')

async function mountWorkspace() {
  if (!rootEl) return
  document.documentElement.classList.add('nod-web')
  document.title = 'Nod'
  const [{ default: App }, { installWebApi }] = await Promise.all([import('./App'), import('./bridge')])
  await import('./App.css')
  installWebApi()
  createRoot(rootEl).render(<App />)
}

async function boot() {
  if (!rootEl) return
  rememberNativeReturn()
  installNativeShell()
  const path = window.location.pathname + window.location.search
  let me = await fetchMe()
  if (!isNativeApp() && me && maybeReturnToNativeApp(getToken())) return
  if (isLocalHost()) me = (await ensureLocalGuest()) || me
  else if (!me && !isNativeApp()) me = await ensureLocalGuest()
  if (!me && isNativeApp()) {
    document.documentElement.classList.add('nod-web')
    document.title = 'Nod'
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
    return
  }
  if (!me) {
    nativeGo(`/login?next=${encodeURIComponent(path || '/app')}`, true)
    return
  }
  await mountWorkspace()
}

void boot()
