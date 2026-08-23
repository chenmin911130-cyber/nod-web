import { useEffect, useRef, useState } from 'react'
import {
  AuthenticateWithRedirectCallback,
  GoogleOneTap,
  useAuth,
  useSignIn,
} from '@clerk/clerk-react'
import { api, getToken, setToken } from '../auth'
import { track } from './track'
import './Site.css'

async function exchangeClerkSession(sessionToken: string) {
  const out = await api<{ token: string; user?: { created_at?: string | null } }>('/api/auth/clerk', {
    method: 'POST',
    body: JSON.stringify({ token: sessionToken }),
  })
  setToken(out.token)
  const created = out.user?.created_at ? Date.parse(out.user.created_at) : 0
  if (created && Date.now() - created < 120_000) {
    track('signup_success', { method: 'google' })
  }
}

export function ClerkChrome() {
  return (
    <>
      <ClerkExchange />
      <ClerkOneTap />
    </>
  )
}

export function ClerkExchange() {
  const { isLoaded, isSignedIn, getToken: getClerkToken } = useAuth()
  const ran = useRef(false)

  useEffect(() => {
    if (!isLoaded || !isSignedIn || ran.current) return
    if (getToken()) {
      ran.current = true
      return
    }
    ran.current = true
    void (async () => {
      const sessionToken = await getClerkToken()
      if (!sessionToken) return
      await exchangeClerkSession(sessionToken)
      const path = window.location.pathname.replace(/\/+$/, '') || '/'
      if (path === '/login' || path === '/signup' || path === '/sso-callback') {
        const next = new URLSearchParams(window.location.search).get('next') || '/app'
        window.location.replace(next)
      }
    })()
  }, [getClerkToken, isLoaded, isSignedIn])

  return null
}

export function ClerkOneTap() {
  return (
    <GoogleOneTap
      signInForceRedirectUrl="/login?next=/app"
      signUpForceRedirectUrl="/login?next=/app"
    />
  )
}

export function GoogleButton({ next = '/app' }: { next?: string }) {
  const { isLoaded, signIn } = useSignIn()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const start = async () => {
    if (!signIn) return
    track('cta_google')
    setBusy(true)
    setErr('')
    const complete = `/login?next=${encodeURIComponent(next)}`
    try {
      if (typeof signIn.authenticateWithRedirect === 'function') {
        await signIn.authenticateWithRedirect({
          strategy: 'oauth_google',
          redirectUrl: '/sso-callback',
          redirectUrlComplete: complete,
        })
        return
      }
      const sso = (signIn as { sso?: (opts: Record<string, string>) => Promise<unknown> }).sso
      if (sso) {
        await sso({
          strategy: 'oauth_google',
          redirectUrl: complete,
          redirectCallbackUrl: '/sso-callback',
        })
        return
      }
      setErr('Google sign-in is unavailable in this build')
      setBusy(false)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Google sign-in failed')
      setBusy(false)
    }
  }

  return (
    <div className="google-auth">
      <button className="button google-btn" type="button" onClick={() => void start()} disabled={!isLoaded || busy}>
        <GoogleMark />
        {busy ? 'Opening Google…' : 'Continue with Google'}
      </button>
      {err && <div className="site-err">{err}</div>}
    </div>
  )
}

export function SSOCallbackPage() {
  return (
    <div className="nod-site-page">
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">GOOGLE</div>
          <h1>Finishing sign-in…</h1>
          <p>Hold on — Nod is opening the workspace.</p>
          <AuthenticateWithRedirectCallback />
        </div>
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.8-6.7 7.5l.1.1 6.3 5.3C36.9 41.5 44 36 44 24c0-1.3-.1-2.5-.4-3.5z" />
    </svg>
  )
}
