import { createRoot } from 'react-dom/client'
import { fetchMe } from './auth'

const rootEl = document.getElementById('root')

async function boot() {
  if (!rootEl) return
  const path = window.location.pathname + window.location.search
  const me = await fetchMe()
  if (!me) {
    window.location.replace(`/login?next=${encodeURIComponent(path || '/app')}`)
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
