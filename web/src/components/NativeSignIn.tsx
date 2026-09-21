import { useEffect, useRef, useState, type FormEvent, type TouchEvent } from 'react'
import { Capacitor } from '@capacitor/core'
import { NodAuth } from 'nod-auth'
import { accountDeletedNotice, deleteAccountCopy } from '../accountCopy'
import { api, setToken } from '../auth'
import { tokenFromAppUrl } from '../native'
import {
  NATIVE_APPLE_SIGN_IN_LABEL,
  NATIVE_SIGNIN_PRIVACY_URL,
  NATIVE_SIGNIN_TERMS_URL,
  appleSignInError,
  nativeSignInCopy,
} from '../nativeSignInCopy'
import { SIGN_COVERS, nextSignCover, prevSignCover, signCoverById, type SignCoverId } from '../signCovers'

const showAppleSignIn = Capacitor.getPlatform() === 'ios'

function googleError(ex: unknown): string {
  const err = ex as { message?: string; code?: string }
  const message = err?.message || ''
  if (err?.code === 'UNIMPLEMENTED' || /not implemented|NodAuth/i.test(message)) {
    return 'Google sign-in is not ready in this build. Close Nodpilot and reopen it, or use email.'
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
  const [cover, setCover] = useState<SignCoverId>('listen')
  const swipeX = useRef<number | null>(null)
  const coverManualAt = useRef(0)
  const deletedNotice = accountDeletedNotice(typeof location === 'undefined' ? '' : location.search)

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Date.now() - coverManualAt.current < 8000) return
      setCover((id) => nextSignCover(id))
    }, 5200)
    return () => window.clearInterval(timer)
  }, [])

  const pickCover = (id: SignCoverId) => {
    coverManualAt.current = Date.now()
    setCover(id)
  }

  const onCoverStart = (e: TouchEvent) => {
    swipeX.current = e.changedTouches[0]?.clientX ?? null
  }

  const onCoverEnd = (e: TouchEvent) => {
    const start = swipeX.current
    swipeX.current = null
    if (start == null) return
    const dx = (e.changedTouches[0]?.clientX ?? start) - start
    if (Math.abs(dx) < 40) return
    pickCover(dx < 0 ? nextSignCover(cover) : prevSignCover(cover))
  }

  const activeCover = signCoverById(cover)
  const copy = nativeSignInCopy(typeof navigator !== 'undefined' ? navigator.language : 'en-US')

  const openLegal = async (url: string) => {
    try {
      const { Browser } = await import('@capacitor/browser')
      await Browser.open({ url })
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const startApple = async () => {
    setBusy(true)
    setErr('')
    try {
      const nonce = crypto.randomUUID()
      const result = await NodAuth.apple({ nonce })
      const displayName = [result.givenName, result.familyName].filter(Boolean).join(' ').trim()
      const out = await api<{ token: string }>('/api/auth/apple', {
        method: 'POST',
        body: JSON.stringify({
          identity_token: result.identityToken,
          nonce,
          name: displayName,
        }),
      })
      setToken(out.token)
      onSignedIn()
    } catch (ex) {
      setErr(appleSignInError(ex))
    } finally {
      setBusy(false)
    }
  }

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
      <div className="native-sign-covers" onTouchStart={onCoverStart} onTouchEnd={onCoverEnd}>
        {SIGN_COVERS.map((item) => (
          <img
            key={item.id}
            src={item.src}
            alt={item.id === cover ? item.alt : ''}
            className={item.id === cover ? 'on' : ''}
          />
        ))}
        <div className="native-sign-cover-copy">
          <p className="native-sign-kicker">Nodpilot</p>
          <h1>{activeCover.title}</h1>
          <p>{activeCover.line}</p>
          <div className="native-sign-dots" role="tablist" aria-label="Login covers">
            {SIGN_COVERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-label={item.title}
                aria-selected={item.id === cover}
                className={item.id === cover ? 'on' : ''}
                onClick={() => pickCover(item.id)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="native-sign-card">
        {deletedNotice ? <p className="native-sign-ok">{deleteAccountCopy.notice}</p> : null}
        <p>
          {sent
            ? `We sent a code to ${email}.`
            : mode === 'in'
              ? 'Sign in with Google or an email code.'
              : 'Create an account with Google or an email code.'}
        </p>
        {showAppleSignIn ? (
          <button
            className="native-sign-apple"
            type="button"
            disabled={busy}
            onClick={() => void startApple()}
          >
            <AppleMark />
            {NATIVE_APPLE_SIGN_IN_LABEL}
          </button>
        ) : null}
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
            {mode === 'up' && (
              <p className="native-sign-legal">
                {copy.signupLegalLead}{' '}
                <button type="button" className="native-sign-link" onClick={() => void openLegal(NATIVE_SIGNIN_TERMS_URL)}>
                  {copy.termsLabel}
                </button>{' '}
                {copy.signupLegalJoin}{' '}
                <button
                  type="button"
                  className="native-sign-link"
                  onClick={() => void openLegal(NATIVE_SIGNIN_PRIVACY_URL)}
                >
                  {copy.privacyLabel}
                </button>
                .
              </p>
            )}
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

function AppleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.365 12.15c-.02-2.14 1.75-3.17 1.83-3.22-1-.14-1.98-.6-2.53-1.22-.57-.63-.88-1.45-.86-2.32-.02-1.24.72-2.39 1.84-2.96 1.54-.8 3.8-.3 4.75 1.16-1.35.82-1.08 2.94.27 3.54-.22.68-.52 1.35-.9 1.98-1.02 1.58-2.12 3.14-3.42 3.14-.65 0-1.05-.38-1.95-.38-.94 0-1.24.39-1.98.39-1.28.02-2.45-1.56-3.45-3.14ZM13.2 3.38c.7-.85 1.17-2.03 1.04-3.21-1 .04-2.21.67-2.93 1.52-.65.75-1.22 1.96-1.07 3.11 1.13.09 2.28-.58 2.96-1.42Z"
      />
    </svg>
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
