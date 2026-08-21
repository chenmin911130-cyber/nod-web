import { useEffect, useRef, useState } from 'react'
import type { MeetingLine } from '../types'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import { AnswerContent } from './AnswerContent'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'

interface Props {
  lines: MeetingLine[]
  partial: string
  summary: string
  busy: boolean
  elapsedLabel: string
  listening: boolean
  onGenerate: (note?: string, files?: AttachPayload[]) => void
}

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
      <path d="M15.6 11.6l.5 2.05 2.05.5-2.05.5-.5 2.05-.5-2.05-2.05-.5 2.05-.5.5-2.05z" />
    </svg>
  )
}

export default function MeetingPane({ lines, partial, summary, busy, elapsedLabel, listening, onGenerate }: Props) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [lines, partial])

  const submit = () => {
    if (busy) return
    const t = input.trim()
    if (!t && files.length === 0) {
      onGenerate()
      return
    }
    onGenerate(t || undefined, files.length ? toPayload(files) : undefined)
    setInput('')
    setFiles([])
  }

  const empty = lines.length === 0 && !partial

  return (
    <div className="main meeting-main">
      <div className="meet-transcript">
        <div className="kicker-row">
          <div className="kicker">Transcript</div>
          <div className="meet-timer">{listening ? elapsedLabel : elapsedLabel === '00:00:00' ? '' : elapsedLabel}</div>
        </div>
        <div className="meet-scroll" ref={scrollRef}>
          {empty ? (
            <EmptyState
              compact
              title="No transcript yet"
              sub="Click Start Meeting to capture the call"
              shortcuts={[{ key: 'F3', label: 'Start' }]}
            />
          ) : (
            lines.map((ln) => (
              <div key={ln.id} className={`meet-line${ln.marked ? ' marked' : ''}`}>
                <span className="meet-ts">{ln.ts}</span>
                <span className="meet-text">
                  {ln.marked && <span className="meet-flag">Action · </span>}
                  {ln.text}
                </span>
              </div>
            ))
          )}
          {partial && (
            <div className="meet-line live">
              <span className="meet-ts">live</span>
              <span className="meet-text">{partial}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="meet-summary">
        <div className="kicker">Summary</div>
        <div className="meet-summary-body">
          {summary ? (
            <AnswerContent answer={summary} base="ms" />
          ) : (
            <div className="answer-empty">
              {busy ? 'Generating summary…' : 'Generate a bullet summary from the transcript.'}
            </div>
          )}
        </div>
      </div>

      <PromptAttach files={files} onChange={setFiles} disabled={busy}>
        <input
          className="prompt-input"
          placeholder="Add note or ask anything"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="gen-btn" onClick={submit} disabled={busy}>
          <Sparkle />
          Generate
        </button>
      </PromptAttach>
    </div>
  )
}
