import { useEffect, useRef, useState } from 'react'
import type { Turn } from '../types'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import { QaAnswerCard } from './QaAnswerCard'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'

interface Props {
  currentQ: string
  partial: string
  turns: Turn[]
  busy: boolean
  listening?: boolean
  onAsk: (text: string, files?: AttachPayload[]) => void
  onCompose?: (on: boolean) => void
  /** #182: session Think switch — the toggle sits above the existing input. */
  think?: boolean
  onThink?: (on: boolean) => void
  /** #182: re-ask one answered question with the Think value it originally ran with. */
  onRetryTurn?: (id: string) => void
}

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
      <path d="M15.6 11.6l.5 2.05 2.05.5-2.05.5-.5 2.05-.5-2.05-2.05-.5 2.05-.5.5-2.05z" />
    </svg>
  )
}

export default function AnswerPane({ currentQ, partial, turns, busy, listening, onAsk, onCompose, think = false, onThink, onRetryTurn }: Props) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const [now, setNow] = useState(() => Date.now())
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const firstSeen = useRef(new Map<string, number>())
  const [pinned, setPinned] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const msAgo = (id: string) => {
    if (!firstSeen.current.has(id)) firstSeen.current.set(id, Date.now())
    return now - (firstSeen.current.get(id) || now)
  }

  const followUp = () => inputRef.current?.focus()

  useEffect(() => {
    if (pinned) return
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [turns, partial, pinned])

  const submit = () => {
    const t = input.trim()
    if (busy || (!t && files.length === 0)) return
    // #182: an attachment-only submit sends an EMPTY question. The placeholder is
    // only a display label — sending it as the question made the server treat it as
    // a real question and run a paid web search for "Please review the attached
    // files."; the server labels the card from the file names on its own.
    onAsk(t, files.length ? toPayload(files) : undefined)
    setInput('')
    setFiles([])
  }

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setPinned(!nearBottom)
  }

  const jumpLatest = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setPinned(false)
  }

  const last = turns[turns.length - 1]
  const liveQ = (partial || '').trim()
  const showLive = Boolean(liveQ) && (!last || last.q !== liveQ)
  const orphanQ = Boolean(
    currentQ
    && currentQ !== 'Waiting for the next question…'
    && currentQ !== liveQ
    && !turns.some((t) => t.q === currentQ),
  )
  const isEmpty = turns.length === 0 && !showLive && !orphanQ && !busy

  return (
    <div className="main translate-main interview-qa">
      <div className="kicker">
        Live Q&A
        <span className="kicker-hint"> · F2 Record · F3 Listen · F4 Clear</span>
      </div>
      <div className="tr-sheet">
        <div className="tr-body" ref={scrollRef} onScroll={handleScroll}>
          {isEmpty ? (
            <EmptyState compact title={listening ? 'Listening for the next question' : 'Waiting for the next question'} />
          ) : (
            <>
              {turns.map((t) => (
                <QaAnswerCard
                  key={t.id}
                  question={t.q}
                  answer={t.a}
                  generating={busy && t.id === last?.id && !t.a}
                  msAgo={msAgo(t.id)}
                  onFollowUp={followUp}
                  onRetry={onRetryTurn && t.live ? () => onRetryTurn(t.id) : undefined}
                  sources={t.sources}
                />
              ))}
              {orphanQ && (
                <QaAnswerCard
                  question={currentQ}
                  answer=""
                  generating={busy}
                  msAgo={msAgo('orphan')}
                  onFollowUp={followUp}
                />
              )}
              {showLive && (
                <QaAnswerCard
                  question={liveQ}
                  answer=""
                  listening
                  msAgo={msAgo('live')}
                  onFollowUp={followUp}
                />
              )}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      </div>
      {pinned && (
        <button className="ap-jump-btn" onClick={jumpLatest}>
          Jump to latest
        </button>
      )}

      {/* #219: Think label + iOS switch above the existing Q&A input.
          Toggling does not submit; the value belongs to the session. */}
      <div className="think-row">
        <button
          type="button"
          className={`think-toggle${think ? ' on' : ''}`}
          role="switch"
          aria-checked={think}
          aria-label="Think"
          onClick={() => onThink?.(!think)}
        >
          Think
          <span className="think-switch" aria-hidden="true">
            <span className="think-knob" />
          </span>
        </button>
      </div>

      <PromptAttach
        files={files}
        onChange={(next) => {
          setFiles(next)
          onCompose?.(input.trim().length > 0 || next.length > 0)
        }}
        disabled={busy}
      >
        <input
          ref={inputRef}
          className="prompt-input"
          placeholder="Type a question."
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            onCompose?.(e.target.value.trim().length > 0 || files.length > 0)
          }}
          onBlur={() => {
            if (!input.trim() && files.length === 0) onCompose?.(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="gen-btn" onClick={submit} disabled={busy || (!input.trim() && files.length === 0)}>
          <Sparkle />
          Answer
        </button>
      </PromptAttach>
    </div>
  )
}
