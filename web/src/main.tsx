import { createRoot } from 'react-dom/client'
import { fetchMe } from './auth'

const rootEl = document.getElementById('root')
const path = window.location.pathname
const isApp = path === '/app' || path.startsWith('/app/')

async function boot() {
  if (!rootEl) return

  if (isApp) {
    const me = await fetchMe()
    if (!me) {
      window.location.replace(`/login?next=${encodeURIComponent(path + window.location.search)}`)
      return
    }
    document.documentElement.classList.add('nod-web')
    document.title = 'Nod'
    const [{ default: App }, { installWebApi }] = await Promise.all([import('./App'), import('./bridge')])
    await import('./App.css')
    installWebApi()
    createRoot(rootEl).render(<App />)
    return
  }

  document.documentElement.classList.add('nod-site')
  const { default: Site } = await import('./site/Site')
  createRoot(rootEl).render(<Site />)
}

void boot()
