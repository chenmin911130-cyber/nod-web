import { useState } from 'react'
import { qaAnswerParts, qaDetectedLine } from '../qaCard'
import { IPHONE_COPY } from '../iphoneCopy'

export function QaAnswerCard({
  question,
  answer,
  listening = false,
  generating = false,
  failed = false,
  retryDisabled = false,
  msAgo,
  onFollowUp,
  onRetry,
}: {
  question: string
  answer: string
  listening?: boolean
  generating?: boolean
  failed?: boolean
  retryDisabled?: boolean
  msAgo: number
  onFollowUp?: () => void
  onRetry?: () => void
}) {
  const [open, setOpen] = useState(false)
  const parts = qaAnswerParts(answer)
  const pending = !failed && (generating || listening || !answer.trim())
  const status = listening ? 'Listening…' : generating ? 'Generating answer…' : ''

  return (
    <article className={`qa-result${listening || generating ? ' live' : ''}`}>
      <p className="qa-detected">
        <span className="qa-detected-dot" aria-hidden="true" />
        {qaDetectedLine({ listening, generating, msAgo })}
      </p>
      <h2 className="qa-question">{question}</h2>
      <div className="qa-ai-card">
        <p className="qa-ai-label">
          <Sparkle />
          AI Answer
        </p>
        {failed && !answer.trim() ? (
          <div className="iphone-live-a-fail">
            <p>{IPHONE_COPY.askCouldntAnswer}</p>
            {onRetry ? (
              <button type="button" className="iphone-ask-retry" disabled={retryDisabled} onClick={onRetry}>
                {IPHONE_COPY.askRetry}
              </button>
            ) : null}
          </div>
        ) : pending ? (
          <p className="qa-summary pending">{status}</p>
        ) : (
          <>
            {parts.hero ? <p className="qa-hero">{parts.hero}</p> : null}
            <p className="qa-summary">{parts.summary}</p>
            {open && parts.more ? <p className="qa-more-body">{parts.more}</p> : null}
          </>
        )}
        <div className="qa-ai-foot">
          <button type="button" className="qa-ai-link" onClick={onFollowUp}>
            Ask follow-up
            <span aria-hidden="true"> →</span>
          </button>
          {parts.more && !pending ? (
            <button type="button" className="qa-ai-link" onClick={() => setOpen((v) => !v)}>
              More
              <span aria-hidden="true">{open ? ' ∧' : ' ∨'}</span>
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>
    </article>
  )
}

function Sparkle() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
    </svg>
  )
}
