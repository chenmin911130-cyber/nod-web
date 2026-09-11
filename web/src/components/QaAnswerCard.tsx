import { useState } from 'react'
import { qaAnswerParts, qaDetectedLine } from '../qaCard'
import type { AnswerSources } from '../types'
import { hasSourceBlock, renderableSources } from '../qaSources'

export function QaAnswerCard({
  question,
  answer,
  listening = false,
  generating = false,
  msAgo,
  onFollowUp,
  onRetry,
  sources,
}: {
  question: string
  answer: string
  listening?: boolean
  generating?: boolean
  msAgo: number
  onFollowUp?: () => void
  /** #182: re-ask this question with the Think value it originally ran with. */
  onRetry?: () => void
  /** #182: real sources + the retrieval time, when Think answered this question. */
  sources?: AnswerSources
}) {
  const [open, setOpen] = useState(false)
  const parts = qaAnswerParts(answer)
  const pending = generating || listening || !answer.trim()
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
        {pending ? (
          <p className="qa-summary pending">{status}</p>
        ) : (
          <>
            {parts.hero ? <p className="qa-hero">{parts.hero}</p> : null}
            <p className="qa-summary">{parts.summary}</p>
            {open && parts.more ? <p className="qa-more-body">{parts.more}</p> : null}
          </>
        )}
        {!pending && hasSourceBlock(sources) ? <SourcesBlock sources={sources} /> : null}
        <div className="qa-ai-foot">
          <button type="button" className="qa-ai-link" onClick={onFollowUp}>
            Ask follow-up
            <span aria-hidden="true"> →</span>
          </button>
          <span className="qa-ai-actions">
            {onRetry && !pending ? (
              <button type="button" className="qa-ai-link" onClick={onRetry}>
                Retry
              </button>
            ) : null}
            {parts.more && !pending ? (
              <button type="button" className="qa-ai-link" onClick={() => setOpen((v) => !v)}>
                More
                <span aria-hidden="true">{open ? ' ∧' : ' ∨'}</span>
              </button>
            ) : null}
          </span>
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

/** #182: a short, clickable source list with the lookup time. Absent for a plain
 *  answer, so no empty section ever appears — and old records render unchanged. */
function SourcesBlock({ sources }: { sources?: AnswerSources }) {
  const links = renderableSources(sources)
  return (
    <div className="qa-sources">
      {links.length ? (
        <ul className="qa-sources-list">
          {links.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title}
              </a>
              {s.published_at ? <span className="qa-sources-date"> · {s.published_at}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {sources?.note ? <p className="qa-sources-note">{sources.note}</p> : null}
      {sources?.retrieved_at_text ? (
        <p className="qa-sources-time">检索时间：{sources.retrieved_at_text}</p>
      ) : null}
    </div>
  )
}
