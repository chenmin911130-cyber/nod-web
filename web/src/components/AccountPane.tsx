import { useEffect, useState } from 'react'
import { api, fetchMe, type Me } from '../auth'
import {
  accountInitials,
  deleteAccountCopy,
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

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 4.5h9M6 4.5V3.2A1.2 1.2 0 0 1 7.2 2h1.6A1.2 1.2 0 0 1 10 3.2v1.3M5.2 4.5l.4 8.1A1.2 1.2 0 0 0 6.8 13.7h2.4a1.2 1.2 0 0 0 1.2-1.1l.4-8.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function DeleteAccountSheet({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open) return null
  return (
    <div className="account-delete-sheet" role="dialog" aria-label={deleteAccountCopy.title}>
      <div className="account-delete-card">
        <h3>{deleteAccountCopy.title}</h3>
        {deleteAccountCopy.body.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {error ? (
          <div className="account-error">
            <span>{error}</span>
            <button type="button" className="account-retry" disabled={busy} onClick={onConfirm}>
              {deleteAccountCopy.retry}
            </button>
          </div>
        ) : null}
        <div className="account-sheet-actions">
          <button type="button" className="account-sheet-cancel" disabled={busy} onClick={onCancel}>
            {deleteAccountCopy.cancel}
          </button>
          <button type="button" className="account-delete-confirm" disabled={busy} onClick={onConfirm}>
            {busy ? deleteAccountCopy.deleting : deleteAccountCopy.confirm}
          </button>
        </div>
      </div>
    </div>
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
  deleteOpen,
  deleting,
  deleteError,
  onOpenDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  open: boolean
  onClose: () => void
  me: Me | null
  onMe: (me: Me | null) => void
  signOutGate: SignOutGate
  signOutError: string
  onSignOut: () => void
  deleteOpen: boolean
  deleting: boolean
  deleteError: string
  onOpenDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
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
    ? IPHONE_COPY.stopListeningFirst
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
      setFeedbackMsg(IPHONE_COPY.feedbackThanks)
    } catch (ex) {
      setFeedbackErr(ex instanceof Error ? ex.message : IPHONE_COPY.feedbackFailed)
    } finally {
      setFeedbackBusy(false)
    }
  }

  return (
    <div className="account-root" role="dialog" aria-label={IPHONE_COPY.accountTitle}>
      <header className="account-head">
        <button type="button" className="account-back" onClick={onClose} aria-label={IPHONE_COPY.accountBack}>
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

        <div className="account-group-label">{IPHONE_COPY.accountHelpAbout}</div>
        <div className="account-group">
          <button type="button" className="account-row" onClick={() => setFeedbackOpen(true)}>
            <span>{IPHONE_COPY.accountHelpFeedback}</span>
            <Chevron />
          </button>
          <button type="button" className="account-row" onClick={() => void openLegal('/privacy')}>
            <span>{IPHONE_COPY.accountPrivacy}</span>
            <Chevron />
          </button>
          <button type="button" className="account-row" onClick={() => void openLegal('/terms')}>
            <span>{IPHONE_COPY.accountTerms}</span>
            <Chevron />
          </button>
        </div>

        <button
          type="button"
          className={`account-signout${blocked || waiting ? ' dim' : ''}`}
          aria-disabled={blocked || waiting}
          onClick={onSignOut}
        >
          <span>{IPHONE_COPY.accountSignOut}</span>
          {signOutHint ? <span className="account-signout-hint">{signOutHint}</span> : null}
        </button>
        {signOutError ? (
          <div className="account-error">
            <span>{signOutError}</span>
            <button type="button" className="account-retry" onClick={onSignOut}>{IPHONE_COPY.accountRetry}</button>
          </div>
        ) : null}

        <button type="button" className="account-delete-row" onClick={onOpenDelete}>
          <span className="account-delete-label">
            <TrashIcon />
            {IPHONE_COPY.accountDeleteRow}
          </span>
          <Chevron />
        </button>

        {appVer ? (
          <div className="account-version">{PRODUCT_NAME} {appVer}</div>
        ) : null}
      </div>

      <DeleteAccountSheet
        open={deleteOpen}
        busy={deleting}
        error={deleteError}
        onCancel={onCancelDelete}
        onConfirm={onConfirmDelete}
      />

      {feedbackOpen ? (
        <div className="account-sheet" role="dialog" aria-label={IPHONE_COPY.accountHelpFeedback}>
          <div className="account-sheet-card">
            <h3>{IPHONE_COPY.accountHelpFeedback}</h3>
            <textarea
              className="account-feedback"
              rows={5}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={IPHONE_COPY.accountFeedbackPlaceholder}
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
                {feedbackBusy ? IPHONE_COPY.feedbackSending : IPHONE_COPY.feedbackSend}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
