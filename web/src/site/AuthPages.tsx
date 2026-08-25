import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, fetchMe, setToken } from '../auth'
import { track } from './track'
import './Site.css'
import NodMark from './NodMark'

const GoogleButton = lazy(() => import('./ClerkAuth').then((m) => ({ default: m.GoogleButton })))

function Funnel({ current }: { current: 'product' | 'account' | 'workspace' }) {
  const steps = [
    { id: 'product', n: '01', label: 'Product', href: '/' },
    { id: 'account', n: '02', label: 'Register', href: '/signup' },
    { id: 'workspace', n: '03', label: 'Workspace', href: '/login?next=/app' },
  ] as const
  return (
    <ol className="funnel">
      {steps.map((s) => (
        <li key={s.id} className={s.id === current ? 'on' : ''}>
          <a href={s.href}>
            <b>{s.n}</b> {s.label}
          </a>
        </li>
      ))}
    </ol>
  )
}

function Header({ extra }: { extra?: ReactNode }) {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <a className="brand" href="/">
          <NodMark />
          Nod
        </a>
        <div className="header-actions">{extra}</div>
      </div>
    </header>
  )
}

export function LoginPage({ clerkEnabled = false }: { clerkEnabled?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const next = new URLSearchParams(location.search).get('next') || '/app'

  useEffect(() => {
    let cancelled = false
    void fetchMe().then((me) => {
      if (!cancelled && me) location.replace(next)
    })
    return () => {
      cancelled = true
    }
  }, [next])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      setToken(out.token)
      location.href = next
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Sign in failed')
      setBusy(false)
    }
  }

  return (
    <div className="nod-site-page">
      <Header extra={<a className="button button-ghost" href="/signup">Create account</a>} />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">ACCOUNT</div>
          <Funnel current="account" />
          <h1>Sign in to Nod</h1>
          <p>Interview, Meeting, and Translate need an account. Continue with Google, or use email. Google is optional.</p>
          {clerkEnabled && (
            <>
              <Suspense fallback={null}>
                <GoogleButton next={next} />
              </Suspense>
              <div className="site-or">or email</div>
            </>
          )}
          <form className="site-form" onSubmit={submit}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </label>
            {err && <div className="site-err">{err}</div>}
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Opening workspace…' : 'Sign in and start listening'}
            </button>
          </form>
          <div className="site-links">
            <a href="/forgot">Forgot password</a>
            <a href="/signup">Start free — Google or email</a>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SignupPage({ clerkEnabled = false }: { clerkEnabled?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchMe().then((me) => {
      if (!cancelled && me) location.replace('/app')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    track('cta_signup_email')
    try {
      const out = await api<{ token: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, consent }),
      })
      setToken(out.token)
      track('signup_success', { method: 'email' })
      location.href = '/app'
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not create account')
      setBusy(false)
    }
  }

  return (
    <div className="nod-site-page">
      <Header extra={<a className="button button-ghost" href="/login">Sign in</a>} />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">REGISTER</div>
          <Funnel current="account" />
          <h1>Create your account</h1>
          <p>Continue with Google, or use email. Same free trial. No card required. 20 minutes of transcription included.</p>
          {clerkEnabled && (
            <>
              <Suspense fallback={null}>
                <GoogleButton next="/app" />
              </Suspense>
              <div className="site-or">or email</div>
            </>
          )}
          <form className="site-form" onSubmit={submit}>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
            </label>
            <label className="site-check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
              <span>
                I agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>. You will confirm
                microphone and data use again before recording starts.
              </span>
            </label>
            {err && <div className="site-err">{err}</div>}
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Opening workspace…' : 'Create account and start listening'}
            </button>
          </form>
          <div className="site-links">
            <a href="/login">Already have an account</a>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ForgotPage() {
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ message: string }>('/api/auth/forgot', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      setMsg(out.message)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not send reset')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nod-site-page">
      <Header />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">PASSWORD</div>
          <h1>Reset your password</h1>
          <p>We will email a link if that address is registered. The link expires in two hours.</p>
          <form className="site-form" onSubmit={submit}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            {err && <div className="site-err">{err}</div>}
            {msg && <div className="site-ok">{msg}</div>}
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

export function ResetPage() {
  const token = new URLSearchParams(location.search).get('token') || ''
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ token: string }>('/api/auth/reset', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      })
      setToken(out.token)
      location.href = '/account'
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Reset failed')
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!token) setErr('Missing reset token')
  }, [token])

  return (
    <div className="nod-site-page">
      <Header />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">PASSWORD</div>
          <h1>Choose a new password</h1>
          <form className="site-form" onSubmit={submit}>
            <label>
              New password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </label>
            {err && <div className="site-err">{err}</div>}
            <button className="button button-primary" type="submit" disabled={busy || !token}>
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
