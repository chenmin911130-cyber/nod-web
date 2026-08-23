import { lazy, Suspense } from 'react'

const GoogleButton = lazy(() => import('../site/ClerkAuth').then((m) => ({ default: m.GoogleButton })))

type Props = {
  clerkEnabled?: boolean
}

export default function GuestGate({ clerkEnabled = false }: Props) {
  return (
    <div className="consent-mask guest-gate-mask">
      <div className="consent-card guest-gate-card">
        <div className="guest-gate-eyebrow">GUEST TRIAL ENDED</div>
        <h2>Your 1-minute preview is up</h2>
        <p>
          Sign in to keep listening, save history, and unlock the full free trial — 20 minutes of live
          transcription per month. No credit card required.
        </p>
        <div className="guest-gate-actions">
          {clerkEnabled ? (
            <Suspense fallback={null}>
              <GoogleButton next="/app" />
            </Suspense>
          ) : null}
          <a className="button button-primary" href="/signup?next=/app">
            Continue with email
          </a>
          <a className="button button-ghost" href="/login?next=/app">
            Already have an account? Sign in
          </a>
        </div>
      </div>
    </div>
  )
}
