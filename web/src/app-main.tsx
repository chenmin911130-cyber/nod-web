import { createRoot } from 'react-dom/client'
import { ensureGuestSession, fetchMe } from './auth'
import type { WorkspaceMode } from './types'

const rootEl = document.getElementById('root')

function parseInitialMode(): WorkspaceMode | undefined {
  const raw = new URLSearchParams(window.location.search).get('mode')
  if (raw === 'interview' || raw === 'meeting' || raw === 'translate') return raw
  return undefined
}

async function boot() {
  if (!rootEl) return
  const me = await fetchMe()
  let guestMode = false
  let guestUsage = null
  if (!me) {
    const guest = await ensureGuestSession()
    if (!guest) {
      const path = window.location.pathname + window.location.search
      window.location.replace(`/login?next=${encodeURIComponent(path || '/app')}`)
      return
    }
    guestMode = true
    guestUsage = guest.usage
  }
  document.documentElement.classList.add('nod-web')
  document.title = 'Nod'
  const [{ default: App }, { installWebApi }] = await Promise.all([import('./App'), import('./bridge')])
  await import('./App.css')
  installWebApi()
  let clerkKey = ''
  try {
    const cfg = (await fetch('/api/config').then((res) => res.json())) as { clerk_publishable_key?: string }
    clerkKey = cfg.clerk_publishable_key || ''
  } catch {
    clerkKey = ''
  }
  const appProps = {
    guestMode,
    guestUsage,
    initialMode: guestMode ? (parseInitialMode() ?? 'translate') : parseInitialMode(),
    clerkEnabled: Boolean(clerkKey),
  }
  const app = <App {...appProps} />
  if (guestMode && clerkKey) {
    const { ClerkProvider } = await import('@clerk/clerk-react')
    createRoot(rootEl).render(
      <ClerkProvider
        publishableKey={clerkKey}
        afterSignOutUrl="/"
        signInFallbackRedirectUrl="/login?next=/app"
        signUpFallbackRedirectUrl="/signup?next=/app"
        appearance={{
          variables: {
            colorPrimary: '#2bb7a8',
            colorBackground: '#0a1728',
            colorText: '#f2f6fb',
            colorInputBackground: '#071321',
            colorInputText: '#eff8ff',
            borderRadius: '12px',
          },
        }}
      >
        {app}
      </ClerkProvider>,
    )
    return
  }
  createRoot(rootEl).render(app)
}

void boot()
