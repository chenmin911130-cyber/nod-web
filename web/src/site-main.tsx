import { createRoot } from 'react-dom/client'
import Site from './site/Site'
import { fetchMe, getToken } from './auth'
import { CLERK_JS_URL } from './googleAuth'
import { apiUrl, installNativeShell, isNativeApp, maybeReturnToNativeApp, rememberNativeReturn } from './native'

const rootEl = document.getElementById('root')

async function boot() {
  if (!rootEl) return
  rememberNativeReturn()
  installNativeShell()
  const me = await fetchMe()
  if (me && maybeReturnToNativeApp(getToken())) return
  document.documentElement.classList.add('nod-site')
  const root = createRoot(rootEl)
  root.render(<Site />)

  try {
    const cfg = (await fetch(apiUrl('/api/config')).then((res) => res.json())) as { clerk_publishable_key?: string }
    const clerkKey = cfg.clerk_publishable_key || ''
    if (!clerkKey || isNativeApp()) return
    const { ClerkProvider } = await import('@clerk/clerk-react')
    root.render(
      <ClerkProvider
        publishableKey={clerkKey}
        clerkJSUrl={CLERK_JS_URL}
        afterSignOutUrl="/"
        signInFallbackRedirectUrl="/login"
        signUpFallbackRedirectUrl="/signup"
        appearance={{
          variables: {
            colorPrimary: '#00d2ff',
            colorBackground: '#080b10',
            colorText: '#f4f8fc',
            colorInputBackground: '#05070a',
            colorInputText: '#eff8ff',
            borderRadius: '12px',
          },
          layout: {
            logoImageUrl: '/logo.svg',
            logoLinkUrl: '/',
            logoPlacement: 'inside',
          },
        }}
        localization={{
          signIn: {
            start: {
              title: 'Sign in to Nodpilot',
              subtitle: 'Welcome back. Continue to Nodpilot.',
            },
          },
          signUp: {
            start: {
              title: 'Create your Nodpilot account',
              subtitle: 'Start listening with Nodpilot.',
            },
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
