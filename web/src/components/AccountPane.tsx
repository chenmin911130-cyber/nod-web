import { useEffect, useState } from 'react'
import { api, fetchMe, type Me } from '../auth'
import {
  accountInitials,
  listeningLeftLine,
  signInLine,
  type SignOutGate,
} from '../accountCopy'
import { IPHONE_COPY } from '../iphoneCopy'
import { isNativeApp, readNativeAppBuild } from '../native'
import { PRODUCT_NAME } from '../brand'

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5 11 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M12.5 4.5 6.5 10l6 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

async function openLegal(path: string): Promise<void> {
  const url = isNativeApp() ? `https://nodpilot.com${path}` : path
  if (isNativeApp()) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export default function AccountPane({
  open,
  onClose,
  me,
  onMe,
  signOutGate,
  signOutError,
  onSignOut,
}: {
  open: boolean
  onClose: () => void
  me: Me | null
  onMe: (me: Me | null) => void
  signOutGate: SignOutGate
  signOutError: string
  onSignOut: () => void
}) {
  const [appVer, setAppVer] = useState('')
  const [usageLine, setUsageLine] = useState<string | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [feedbackMsg, setFeedbackMsg] = useState('')
  const [feedbackErr, setFeedbackErr] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setFeedbackOpen(false)
      setFeedback('')
      setFeedbackMsg('')
      setFeedbackErr('')
      return
    }
    void readNativeAppBuild().then(setAppVer)
    void fetchMe().then((next) => {
      if (!next) {
        setUsageLine(null)
        return
      }
      onMe(next)
      setUsageLine(listeningLeftLine({
        daily_stt_seconds: next.usage?.daily_stt_seconds,
        daily_stt_limit: next.usage?.daily_stt_limit,
        quota_disabled: next.quota_disabled || next.usage?.quota_disabled,
      }))
    })
  }, [open, onMe])

  if (!open) return null

  const initials = accountInitials(me?.name || '', me?.email || '')
  const blocked = signOutGate === 'blocked-listening'
  const waiting = signOutGate === 'wait-saving'
  const signOutHint = blocked
    ? 'Stop listening first'
    : waiting
      ? IPHONE_COPY.saveSaving
      : ''

  const sendFeedback = async () => {
    const message = feedback.trim()
    if (!message || feedbackBusy) return
    setFeedbackBusy(true)
    setFeedbackErr('')
    setFeedbackMsg('')
    try {
      await api('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ email: me?.email || '', message }),
      })
      setFeedback('')
      setFeedbackMsg('Thanks — we have the note.')
    } catch (ex) {
      setFeedbackErr(ex instanceof Error ? ex.message : 'Could not send feedback')
    } finally {
      setFeedbackBusy(false)
    }
  }

  return (
    <div className="account-root" role="dialog" aria-label={IPHONE_COPY.accountTitle}>
      <header className="account-head">
        <button type="button" className="account-back" onClick={onClose} aria-label="Back">
          <BackIcon />
        </button>
        <h2>{IPHONE_COPY.accountTitle}</h2>
        <span className="account-head-spacer" aria-hidden="true" />
      </header>
      <div className="account-body">
        <section className="account-card">
          <div className="account-avatar" aria-hidden="true">{initials}</div>
          {me?.name ? <div className="account-name">{me.name}</div> : null}
          {me?.email ? <div className="account-email">{me.email}</div> : null}
          <div className="account-signin">{signInLine(me?.sign_in)}</div>
          {usageLine ? <div className="account-usage">{usageLine}</div> : null}
        </section>

        <div className="account-group-label">HELP & ABOUT</div>
        <div className="account-group">
          <button type="button" className="account-row" onClick={() => setFeedbackOpen(true)}>
            <span>Help & feedback</span>
            <Chevron />
          </button>
          <button type="button" className="account-row" onClick={() => void openLegal('/privacy')}>
            <span>Privacy policy</span>
            <Chevron />
          </button>
          <button type="button" className="account-row" onClick={() => void openLegal('/terms')}>
            <span>Terms of service</span>
            <Chevron />
          </button>
        </div>

        <button
          type="button"
          className={`account-signout${blocked || waiting ? ' dim' : ''}`}
          aria-disabled={blocked || waiting}
          onClick={onSignOut}
        >
          <span>Sign out</span>
          {signOutHint ? <span className="account-signout-hint">{signOutHint}</span> : null}
        </button>
        {signOutError ? (
          <div className="account-error">
            <span>{signOutError}</span>
            <button type="button" className="account-retry" onClick={onSignOut}>Retry</button>
          </div>
        ) : null}

        {appVer ? (
          <div className="account-version">{PRODUCT_NAME} {appVer}</div>
        ) : null}
      </div>

      {feedbackOpen ? (
        <div className="account-sheet" role="dialog" aria-label="Help & feedback">
          <div className="account-sheet-card">
            <h3>Help & feedback</h3>
            <textarea
              className="account-feedback"
              rows={5}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What’s going on?"
            />
            {feedbackMsg ? <p className="account-ok">{feedbackMsg}</p> : null}
            {feedbackErr ? <p className="account-error-text">{feedbackErr}</p> : null}
            <div className="account-sheet-actions">
              <button type="button" className="account-sheet-cancel" onClick={() => setFeedbackOpen(false)}>
                {IPHONE_COPY.moreCancel}
              </button>
              <button
                type="button"
                className="account-sheet-send"
                disabled={feedbackBusy || !feedback.trim()}
                onClick={() => void sendFeedback()}
              >
                {feedbackBusy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
