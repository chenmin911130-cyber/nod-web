import { createRoot } from 'react-dom/client'

const rootEl = document.getElementById('root')

async function boot() {
  if (!rootEl) return
  document.documentElement.classList.add('nod-site')
  const { default: Site } = await import('./site/Site')
  let clerkKey = ''
  try {
    const cfg = (await fetch('/api/config').then((res) => res.json())) as { clerk_publishable_key?: string }
    clerkKey = cfg.clerk_publishable_key || ''
  } catch {
    clerkKey = ''
  }
  if (clerkKey) {
    const { ClerkProvider } = await import('@clerk/clerk-react')
    createRoot(rootEl).render(
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
    return
  }
  createRoot(rootEl).render(<Site />)
}

void boot()
