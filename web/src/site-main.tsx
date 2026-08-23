import { createRoot } from 'react-dom/client'
import Site from './site/Site'

const rootEl = document.getElementById('root')

async function boot() {
  if (!rootEl) return
  document.documentElement.classList.add('nod-site')
  const root = createRoot(rootEl)
  root.render(<Site />)

  try {
    const cfg = (await fetch('/api/config').then((res) => res.json())) as { clerk_publishable_key?: string }
    const clerkKey = cfg.clerk_publishable_key || ''
    if (!clerkKey) return
    const { ClerkProvider } = await import('@clerk/clerk-react')
    root.render(
      <ClerkProvider
        publishableKey={clerkKey}
        afterSignOutUrl="/"
        signInFallbackRedirectUrl="/login"
        signUpFallbackRedirectUrl="/signup"
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
        <Site clerkEnabled />
      </ClerkProvider>,
    )
  } catch {
    /* stay on the first paint */
  }
}

void boot()
