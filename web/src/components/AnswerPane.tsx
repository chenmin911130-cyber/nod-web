import { useEffect, useRef, useState } from 'react'
import type { Turn } from '../types'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import { AnswerContent, QuestionBlock } from './AnswerContent'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'

interface Props {
  currentQ: string
  partial: string
  turns: Turn[]
  busy: boolean
  onAsk: (text: string, files?: AttachPayload[]) => void
  onCompose?: (on: boolean) => void
}

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
      <path d="M15.6 11.6l.5 2.05 2.05.5-2.05.5-.5 2.05-.5-2.05-2.05-.5 2.05-.5.5-2.05z" />
    </svg>
  )
}

export default function AnswerPane({ currentQ, partial, turns, busy, onAsk, onCompose }: Props) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pinned) return
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [turns, pinned])

  const submit = () => {
    const t = input.trim()
    if (busy || (!t && files.length === 0)) return
    onAsk(t || 'Please review the attached files.', files.length ? toPayload(files) : undefined)
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

  const isEmpty = turns.length === 0 && !partial && !busy
  const answer = turns.length > 0 ? turns[turns.length - 1].a : ''
  const showQ = currentQ && currentQ !== 'Waiting for the next question…'

  return (
    <div className="main">
      <div className="kicker">Question</div>
      {isEmpty ? (
        <EmptyState
          title="Waiting for the next question"
          sub="Type a question to open the sidebar, or hover the left edge to start listening"
          shortcuts={[
            { key: 'F2', label: 'Record' },
            { key: 'F3', label: 'Listen' },
            { key: 'F4', label: 'Clear' },
          ]}
        />
      ) : (
        <div className="ap-question">
          <QuestionBlock q={showQ ? currentQ : (partial ? 'Listening…' : '')} partial={partial} />
        </div>
      )}
      <div className="answer-card">
        <div className="kicker">Answer</div>
        <div className="answer-scroll" ref={scrollRef} onScroll={handleScroll}>
          {answer ? (
            <AnswerContent answer={answer} base="ap" />
          ) : (
            <div className="answer-empty">
              {busy ? 'Generating answer…' : 'Your answer will appear here.'}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {pinned && (
        <button className="ap-jump-btn" onClick={jumpLatest}>
          Jump to latest
        </button>
      )}

      <PromptAttach
        files={files}
        onChange={(next) => {
          setFiles(next)
          onCompose?.(input.trim().length > 0 || next.length > 0)
        }}
        disabled={busy}
      >
        <input
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
