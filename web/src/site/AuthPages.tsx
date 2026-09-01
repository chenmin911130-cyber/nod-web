import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api, fetchMe, getToken, setToken } from '../auth'
import { isNativeApp, maybeReturnToNativeApp, nativeGo } from '../native'
import { track } from './track'
import './Site.css'
import { PRODUCT_NAME } from '../brand'
import NodMark from './NodMark'

const GoogleButton = lazy(() => import('./ClerkAuth').then((m) => ({ default: m.GoogleButton })))
const NativeGoogleButton = lazy(() => import('./ClerkAuth').then((m) => ({ default: m.NativeGoogleButton })))

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
          {PRODUCT_NAME}
        </a>
        <div className="header-actions">{extra}</div>
      </div>
    </header>
  )
}

function digitsOnly(value: string, max = 6) {
  return value.replace(/\D/g, '').slice(0, max)
}

function OtpCodeField({
  code,
  onChange,
  autoFocus,
}: {
  code: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  return (
    <label>
      6-digit code
      <input
        ref={ref}
        className="site-otp"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        value={code}
        onChange={(e) => onChange(digitsOnly(e.target.value))}
        required
      />
    </label>
  )
}

export function LoginPage({ clerkEnabled = false }: { clerkEnabled?: boolean }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const next = new URLSearchParams(location.search).get('next') || '/app'

  useEffect(() => {
    let cancelled = false
    void fetchMe().then((me) => {
      if (!cancelled && me && me.email !== 'local@nod.test') {
        if (maybeReturnToNativeApp(getToken())) return
        nativeGo(next, true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [next])

  const sendCode = async () => {
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ message: string; dev_code?: string }>('/api/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ email, intent: 'login' }),
      })
      setSent(true)
      if (out.dev_code) setCode(out.dev_code)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not send the code')
    } finally {
      setBusy(false)
    }
  }

  const requestCode = async (e: FormEvent) => {
    e.preventDefault()
    await sendCode()
  }

  const verify = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ token: string }>('/api/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code, intent: 'login' }),
      })
      setToken(out.token)
      if (maybeReturnToNativeApp(out.token)) return
      nativeGo(next)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Sign in failed')
      setBusy(false)
    }
  }

  return (
    <div className="nod-site-page">
      <Header extra={<a className="button button-cyan header-cta" href="/signup">Create account</a>} />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">ACCOUNT</div>
          <Funnel current="account" />
          <h1>Sign in to Nodpilot</h1>
          <p>
            Nodpilot needs an account before it can listen, translate, and summarize. Continue with Google, or we email
            you a one-time code. Google is optional.
          </p>
          {(clerkEnabled || isNativeApp()) && (
            <>
              <Suspense fallback={null}>
                {isNativeApp() ? <NativeGoogleButton /> : <GoogleButton next={next} />}
              </Suspense>
              <div className="site-or">or email a code</div>
            </>
          )}
          {!sent ? (
            <form className="site-form" onSubmit={requestCode}>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </label>
              {err && <div className="site-err">{err}</div>}
              <button className="button button-primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a code'}
              </button>
            </form>
          ) : (
            <form className="site-form" onSubmit={verify}>
              <p className="site-ok">We sent a code to {email}.</p>
              <OtpCodeField code={code} onChange={setCode} autoFocus />
              {err && <div className="site-err">{err}</div>}
              <button className="button button-primary" type="submit" disabled={busy || code.length !== 6}>
                {busy ? 'Opening workspace…' : 'Sign in and open workspace'}
              </button>
              <div className="site-links">
                <button type="button" className="site-text-btn" disabled={busy} onClick={() => void sendCode()}>
                  Resend code
                </button>
                <button
                  type="button"
                  className="site-text-btn"
                  onClick={() => {
                    setSent(false)
                    setCode('')
                    setErr('')
                  }}
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}
          <div className="site-links">
            <a href="/signup">Create an account — Google or email</a>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SignupPage({ clerkEnabled = false }: { clerkEnabled?: boolean }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchMe().then((me) => {
      if (!cancelled && me && me.email !== 'local@nod.test') {
        if (maybeReturnToNativeApp(getToken())) return
        nativeGo('/app', true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const requestCode = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    track('cta_signup_email')
    try {
      const out = await api<{ message: string; dev_code?: string }>('/api/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ email, name, consent, intent: 'signup' }),
      })
      setSent(true)
      if (out.dev_code) setCode(out.dev_code)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not send the code')
    } finally {
      setBusy(false)
    }
  }

  const verify = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ token: string }>('/api/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code, name, consent, intent: 'signup' }),
      })
      setToken(out.token)
      track('signup_success', { method: 'email' })
      if (maybeReturnToNativeApp(out.token)) return
      nativeGo('/app')
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not create account')
      setBusy(false)
    }
  }

  return (
    <div className="nod-site-page">
      <Header extra={<a className="button button-cyan header-cta" href="/login">Sign in</a>} />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">REGISTER</div>
          <Funnel current="account" />
          <h1>Create your Nodpilot account</h1>
          <p>Google or an email code — both start the same free public test. No password. No card.</p>
          {(clerkEnabled || isNativeApp()) && (
            <>
              <Suspense fallback={null}>
                {isNativeApp() ? <NativeGoogleButton /> : <GoogleButton next="/app" />}
              </Suspense>
              <div className="site-or">or email a code</div>
            </>
          )}
          {!sent ? (
            <form className="site-form" onSubmit={requestCode}>
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
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
                {busy ? 'Sending…' : 'Email me a code'}
              </button>
            </form>
          ) : (
            <form className="site-form" onSubmit={verify}>
              <p className="site-ok">We sent a code to {email}.</p>
              <OtpCodeField code={code} onChange={setCode} autoFocus />
              {err && <div className="site-err">{err}</div>}
              <button className="button button-primary" type="submit" disabled={busy || code.length !== 6}>
                {busy ? 'Opening workspace…' : 'Create account and open workspace'}
              </button>
              <div className="site-links">
                <button
                  type="button"
                  className="site-text-btn"
                  onClick={() => {
                    setSent(false)
                    setCode('')
                    setErr('')
                  }}
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}
          <div className="site-links">
            <a href="/login">Already have an account</a>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ForgotPage() {
  return (
    <div className="nod-site-page">
      <Header extra={<a className="button button-cyan header-cta" href="/login">Sign in</a>} />
      <div className="site-wrap">
        <div className="site-card">
          <div className="eyebrow">ACCOUNT</div>
          <h1>No password to reset</h1>
          <p>Email sign-in now uses a one-time code. Enter your email on the sign-in page and we will send a new code.</p>
          <div className="site-links">
            <a href="/login">Email me a sign-in code</a>
            <a href="/signup">Create an account</a>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ResetPage() {
  return <ForgotPage />
}
