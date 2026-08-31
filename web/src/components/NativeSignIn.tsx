import { useState, type FormEvent } from 'react'
import { registerPlugin } from '@capacitor/core'
import { api, setToken } from '../auth'
import { tokenFromAppUrl } from '../native'

const NodAuth = registerPlugin<{ google: (opts: { url: string }) => Promise<{ url?: string; token?: string }> }>('NodAuth')

function googleError(ex: unknown): string {
  const err = ex as { message?: string; code?: string }
  const message = err?.message || ''
  if (err?.code === 'UNIMPLEMENTED' || /not implemented|NodAuth/i.test(message)) {
    return 'Google sign-in is not ready in this build. Close Nod and reopen it, or use email.'
  }
  if (/canceled/i.test(message)) return 'Google sign-in was canceled'
  return message || 'Google sign-in failed'
}

function digitsOnly(value: string, max = 6) {
  return value.replace(/\D/g, '').slice(0, max)
}

export default function NativeSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const startGoogle = async () => {
    setBusy(true)
    setErr('')
    try {
      const result = await NodAuth.google({ url: 'https://nodpilot.com/login?native_return=1' })
      const token = result.token || tokenFromAppUrl(result.url || '')
      if (!token) throw new Error('Google sign-in did not finish')
      setToken(token)
      onSignedIn()
    } catch (ex) {
      setErr(googleError(ex))
    } finally {
      setBusy(false)
    }
  }

  const sendCode = async () => {
    setBusy(true)
    setErr('')
    try {
      const out = await api<{ message?: string; dev_code?: string }>('/api/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({
          email,
          name,
          consent: mode === 'up',
          intent: mode === 'up' ? 'signup' : 'login',
        }),
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
        body: JSON.stringify({
          email,
          code,
          name,
          consent: mode === 'up',
          intent: mode === 'up' ? 'signup' : 'login',
        }),
      })
      setToken(out.token)
      onSignedIn()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not continue')
      setBusy(false)
    }
  }

  return (
    <div className="native-sign">
      <div className="native-sign-card">
        <svg className="native-sign-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
          <path
            d="M26 88 V32 A13 13 0 0 1 52 32 L78 58"
            stroke="#f4f8fc"
            strokeWidth="9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M58 38 Q66 29 81 34 V60" stroke="#f4f8fc" strokeWidth="9" strokeLinecap="round" />
          <circle cx="81" cy="70" r="4.5" fill="#00d2ff" />
        </svg>
        <h1>Nod</h1>
        <p>
          {sent
            ? `We sent a code to ${email}.`
            : mode === 'in'
              ? 'Sign in with Google or an email code.'
              : 'Create an account with Google or an email code.'}
        </p>
        <button
          className="native-sign-google"
          type="button"
          disabled={busy}
          onClick={() => void startGoogle()}
        >
          <GoogleMark />
          Continue with Google
        </button>
        <div className="native-sign-or">or email a code</div>
        {!sent ? (
          <form onSubmit={(e) => void requestCode(e)}>
            {mode === 'up' && (
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            {err && <div className="native-sign-err">{err}</div>}
            <button className="native-sign-go" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void verify(e)}>
            <label>
              6-digit code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(digitsOnly(e.target.value))}
                required
              />
            </label>
            {err && <div className="native-sign-err">{err}</div>}
            <button className="native-sign-go" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Opening…' : mode === 'in' ? 'Continue' : 'Create account'}
            </button>
          </form>
        )}
        <button
          className="native-sign-switch"
          type="button"
          onClick={() => {
            if (sent) {
              setSent(false)
              setCode('')
              setErr('')
              return
            }
            setMode(mode === 'in' ? 'up' : 'in')
            setErr('')
          }}
        >
          {sent ? 'Use a different email' : mode === 'in' ? 'Need an account?' : 'Already have an account?'}
        </button>
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
