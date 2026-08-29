import { createRoot } from 'react-dom/client'
import { ensureLocalGuest, fetchMe, isLocalHost } from './auth'
import { installNativeShell, isNativeApp, nativeGo } from './native'

const rootEl = document.getElementById('root')

async function boot() {
  if (!rootEl) return
  installNativeShell()
  const path = window.location.pathname + window.location.search
  let me = await fetchMe()
  if (isLocalHost()) me = (await ensureLocalGuest()) || me
  else if (!me && !isNativeApp()) me = await ensureLocalGuest()
  if (!me) {
    nativeGo(`/login?next=${encodeURIComponent(isNativeApp() ? '/app' : path || '/app')}`, true)
    return
  }
  document.documentElement.classList.add('nod-web')
  document.title = 'Nod'
  const [{ default: App }, { installWebApi }] = await Promise.all([import('./App'), import('./bridge')])
  await import('./App.css')
  installWebApi()
  createRoot(rootEl).render(<App />)
}

void boot()
