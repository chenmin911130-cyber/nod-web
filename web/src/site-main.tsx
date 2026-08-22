import { createRoot } from 'react-dom/client'

const rootEl = document.getElementById('root')

async function boot() {
  if (!rootEl) return
  document.documentElement.classList.add('nod-site')
  const { default: Site } = await import('./site/Site')
  createRoot(rootEl).render(<Site />)
}

void boot()
